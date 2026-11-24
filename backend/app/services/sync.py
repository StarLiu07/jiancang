"""Bidirectional incremental sync for the Local-First mobile client.

The phone is the source of truth for *text*, but the NUC keeps owning expensive
artifacts it produced on its own (scraped body, media binaries and AI summaries).
Merging therefore is last-write-wins on ``updated_at`` **plus** a few targeted
protections:

* a mobile record that only knows ``ai_status = pending`` must not erase a
  server-side ``done`` AI result (summary / key points / extra tags are kept);
* a mobile record without ``content_markdown`` must not erase a body the NUC
  already scraped.

Every accepted clip gets a fresh ``sync_version``; clients page through
``GET /api/sync/pull`` with the highest version they have already seen.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Sequence
from enum import StrEnum
from pathlib import Path
from typing import Any, TypeVar

from app.config import Settings
from app.db import (
    Database,
    merge_tags,
    normalize_tags,
    parse_iso,
    to_iso,
)
from app.models import (
    AIStatus,
    ClipStatus,
    Platform,
    ReviewAction,
    ReviewState,
    SyncClipPayload,
    SyncClipRecord,
    SyncMediaPayload,
    SyncMediaUploadResponse,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
    SyncReviewLogPayload,
)
from app.services.ingest import markdown_to_text
from app.services.media import _extension_for, _resolve_mime

logger = logging.getLogger(__name__)

#: Incoming AI states that must never downgrade a finished server-side summary.
_AI_STATES_THAT_YIELD = frozenset(
    {AIStatus.SKIPPED.value, AIStatus.PENDING.value, AIStatus.FAILED.value}
)
_READY_STATES = frozenset({ClipStatus.READY.value, ClipStatus.PARTIAL.value})
_PENDING_STATES = frozenset({ClipStatus.PENDING.value, ClipStatus.FAILED.value})

EnumT = TypeVar("EnumT", bound=StrEnum)


# ---------------------------------------------------------------------------
# errors (mapped to HTTP status codes by the router)
# ---------------------------------------------------------------------------


class SyncError(RuntimeError):
    """Base class for sync failures that map onto client errors."""


class SyncClipMissingError(SyncError):
    """The clip a media upload belongs to does not exist."""


class SyncMediaTooLargeError(SyncError):
    """The uploaded media body exceeds ``settings.max_media_bytes``."""


class SyncMediaUnsupportedError(SyncError):
    """The uploaded payload is empty or not a supported image type."""


# ---------------------------------------------------------------------------
# small coercion helpers
# ---------------------------------------------------------------------------


def _iso_or_raw(value: str | None) -> str:
    text = (value or "").strip()
    parsed = parse_iso(text)
    return to_iso(parsed) if parsed is not None else text


def _coerce_enum(enum_cls: type[EnumT], value: Any, default: EnumT) -> EnumT:
    try:
        return enum_cls(str(value))
    except (TypeError, ValueError):
        return default


def _key_points(raw: Any) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if str(item).strip()]


def _is_strictly_older(incoming: str | None, server: str | None) -> bool:
    incoming_dt = parse_iso(incoming)
    server_dt = parse_iso(server)
    if incoming_dt is None or server_dt is None:
        return False
    return incoming_dt < server_dt


# ---------------------------------------------------------------------------
# merging
# ---------------------------------------------------------------------------


def _payload_fields(payload: SyncClipPayload) -> dict[str, Any]:
    """Map a sync payload onto the ``clips`` columns the server stores."""
    return {
        "id": payload.id,
        "raw_input": payload.raw_input or "",
        "url": payload.url or "",
        "normalized_url": payload.normalized_url,
        "platform": str(payload.platform),
        "status": str(payload.status),
        "ai_status": str(payload.ai_status),
        "error_message": payload.error_message,
        "title": payload.title or "",
        "author": payload.author or "",
        "published_at": payload.published_at,
        "content_markdown": payload.content_markdown or "",
        "content_text": payload.content_text or "",
        "cover_media_id": payload.cover_media_id,
        "summary": payload.summary or "",
        "key_points_json": json.dumps(
            [str(item) for item in payload.key_points], ensure_ascii=False
        ),
        "user_note": payload.user_note or "",
        "review_state": str(payload.review_state),
        "review_count": int(payload.review_count or 0),
        "review_interval_days": int(payload.review_interval_days or 0),
        "next_review_at": payload.next_review_at,
        "last_reviewed_at": payload.last_reviewed_at,
        "created_at": _iso_or_raw(payload.created_at),
        "updated_at": _iso_or_raw(payload.updated_at),
    }


def merge_clip(
    existing: Any | None,
    payload: SyncClipPayload,
    existing_tags: Sequence[str] = (),
) -> tuple[dict[str, Any], list[str]]:
    """Merge a pushed clip with the server row (``None`` = brand new clip)."""
    fields = _payload_fields(payload)
    tags = normalize_tags(payload.tags)
    if not fields["content_text"] and fields["content_markdown"]:
        fields["content_text"] = markdown_to_text(str(fields["content_markdown"]))
    if existing is None:
        return fields, tags

    server_status = str(existing["status"] or "")
    server_ai = str(existing["ai_status"] or "")
    incoming_status = str(payload.status)
    incoming_ai = str(payload.ai_status)

    # -- body protection: never replace a scraped body with "nothing" --------
    server_markdown = str(existing["content_markdown"] or "")
    if server_markdown.strip() and not str(payload.content_markdown or "").strip():
        fields["content_markdown"] = server_markdown
        fields["content_text"] = str(existing["content_text"] or "") or markdown_to_text(
            server_markdown
        )
        if server_status == ClipStatus.READY.value and incoming_status in _PENDING_STATES:
            fields["status"] = server_status
            fields["error_message"] = existing["error_message"]

    # -- AI protection: mobile "pending/skipped/failed" must not wipe "done" --
    if server_ai == AIStatus.DONE.value and incoming_ai in _AI_STATES_THAT_YIELD:
        fields["ai_status"] = AIStatus.DONE.value
        if not str(payload.summary or "").strip() and str(existing["summary"] or "").strip():
            fields["summary"] = str(existing["summary"])
        if not payload.key_points:
            fields["key_points_json"] = str(existing["key_points_json"] or "[]")
        # AI generated tags must survive a stale mobile tag list.
        tags = merge_tags(tags, existing_tags)

    # -- keep server-only metadata when the payload is silent about it -------
    if not fields.get("cover_media_id") and existing["cover_media_id"]:
        fields["cover_media_id"] = str(existing["cover_media_id"])
    if not fields.get("normalized_url") and existing["normalized_url"]:
        fields["normalized_url"] = str(existing["normalized_url"])
    if not fields.get("url") and existing["url"]:
        fields["url"] = str(existing["url"])

    return fields, tags


def merge_media_rows(
    clip_id: str,
    existing_rows: Sequence[Any],
    payloads: Sequence[SyncMediaPayload],
) -> list[dict[str, Any]]:
    """Merge pushed media *metadata* with rows already stored on the server.

    Binaries are never part of the push payload: the server keeps a
    ``local_path`` it already owns and reports anything missing through
    ``missing_media_ids`` so the client can ``PUT /api/sync/media/{id}``.
    """
    server_rows = {str(row["id"]): row for row in existing_rows}
    merged: list[dict[str, Any]] = []
    for payload in payloads:
        media_id = (payload.id or "").strip()
        if not media_id:
            continue
        row = server_rows.get(media_id)
        merged.append(
            {
                "id": media_id,
                "clip_id": clip_id,
                "original_url": payload.original_url
                or (str(row["original_url"] or "") if row is not None else ""),
                "local_path": str(row["local_path"] or "") if row is not None else "",
                "mime_type": payload.mime_type
                or (str(row["mime_type"] or "") if row is not None else ""),
                "size_bytes": int(payload.size_bytes or 0)
                or (int(row["size_bytes"] or 0) if row is not None else 0),
                "sha256": payload.sha256
                or (str(row["sha256"] or "") if row is not None else ""),
                "sort_order": int(payload.sort_order or 0),
                "created_at": payload.created_at
                or (str(row["created_at"] or "") if row is not None else ""),
            }
        )
    return merged


def _needs_ai(row: Any, settings: Settings) -> bool:
    """Should the NUC backfill an AI summary for this (merged) clip?"""
    if not settings.ai_enabled:
        return False
    if str(row["review_state"]) == ReviewState.DELETED.value:
        return False
    if str(row["status"]) not in _READY_STATES:
        return False
    if str(row["ai_status"]) not in _AI_STATES_THAT_YIELD:
        return False
    return bool(
        str(row["content_text"] or "").strip()
        or str(row["content_markdown"] or "").strip()
        or str(row["title"] or "").strip()
    )


# ---------------------------------------------------------------------------
# media files
# ---------------------------------------------------------------------------


def _resolve_media_file(settings: Settings, local_path: str) -> Path | None:
    """Resolve a stored media path inside ``data_dir``/``media_dir``."""
    if not local_path:
        return None
    raw = Path(local_path)
    candidates = [raw] if raw.is_absolute() else [
        settings.data_dir / raw,
        settings.media_dir / raw,
        raw,
    ]
    roots = (settings.data_dir, settings.media_dir)
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:  # pragma: no cover - permission/loop edge cases
            continue
        try:
            inside = any(resolved.is_relative_to(root.resolve()) for root in roots)
        except (OSError, ValueError):  # pragma: no cover - odd roots
            inside = False
        if inside and resolved.is_file():
            return resolved
    return None


def _media_file_on_disk(settings: Settings, local_path: str) -> bool:
    return _resolve_media_file(settings, local_path) is not None


# ---------------------------------------------------------------------------
# push
# ---------------------------------------------------------------------------


def apply_push(
    db: Database, settings: Settings, request: SyncPushRequest
) -> SyncPushResponse:
    """Apply a push batch; the response is also the router's return value."""
    response = SyncPushResponse()
    missing: list[str] = []
    seen_missing: set[str] = set()

    for payload in request.clips:
        existing = db.get_clip(payload.id)
        if existing is not None and _is_strictly_older(
            payload.updated_at, str(existing["updated_at"] or "")
        ):
            response.skipped_ids.append(payload.id)
            continue

        existing_tags = db.get_clip_tags(payload.id) if existing is not None else []
        existing_media = db.list_media(payload.id) if existing is not None else []
        fields, tags = merge_clip(existing, payload, existing_tags)
        media = merge_media_rows(payload.id, existing_media, payload.media)
        db.upsert_clip_from_sync(fields, tags=tags, media=media)
        response.accepted_ids.append(payload.id)

        for row in db.list_media(payload.id):
            media_id = str(row["id"])
            if media_id in seen_missing:
                continue
            if not _media_file_on_disk(settings, str(row["local_path"] or "")):
                seen_missing.add(media_id)
                missing.append(media_id)

        merged = db.get_clip(payload.id)
        if merged is not None and _needs_ai(merged, settings):
            response.queued_ai_ids.append(payload.id)

    for log in request.review_logs:
        db.add_review_log_if_missing(
            log.clip_id, str(log.action), log.reviewed_at
        )

    response.missing_media_ids = missing
    response.server_version = db.current_sync_version()
    return response


# ---------------------------------------------------------------------------
# pull
# ---------------------------------------------------------------------------


def _media_payload(row: Any) -> SyncMediaPayload:
    return SyncMediaPayload(
        id=str(row["id"]),
        clip_id=str(row["clip_id"]),
        original_url=str(row["original_url"] or ""),
        mime_type=str(row["mime_type"] or ""),
        size_bytes=int(row["size_bytes"] or 0),
        sha256=str(row["sha256"] or ""),
        sort_order=int(row["sort_order"] or 0),
        created_at=str(row["created_at"] or ""),
    )


def _clip_record(
    row: Any, tags: Sequence[str], media_rows: Sequence[Any]
) -> SyncClipRecord:
    return SyncClipRecord(
        id=str(row["id"]),
        raw_input=str(row["raw_input"] or ""),
        url=str(row["url"] or ""),
        normalized_url=row["normalized_url"],
        platform=_coerce_enum(Platform, row["platform"], Platform.WEB),
        status=_coerce_enum(ClipStatus, row["status"], ClipStatus.PENDING),
        ai_status=_coerce_enum(AIStatus, row["ai_status"], AIStatus.PENDING),
        error_message=row["error_message"],
        title=str(row["title"] or ""),
        author=str(row["author"] or ""),
        published_at=row["published_at"],
        content_markdown=str(row["content_markdown"] or ""),
        content_text=str(row["content_text"] or ""),
        cover_media_id=row["cover_media_id"],
        summary=str(row["summary"] or ""),
        key_points=_key_points(row["key_points_json"]),
        user_note=str(row["user_note"] or ""),
        review_state=_coerce_enum(
            ReviewState, row["review_state"], ReviewState.ACTIVE
        ),
        review_count=int(row["review_count"] or 0),
        review_interval_days=int(row["review_interval_days"] or 0),
        next_review_at=row["next_review_at"],
        last_reviewed_at=row["last_reviewed_at"],
        created_at=str(row["created_at"] or ""),
        updated_at=str(row["updated_at"] or ""),
        tags=list(tags),
        media=[_media_payload(item) for item in media_rows],
        sync_version=int(row["sync_version"] or 0),
    )


def pull_changes(
    db: Database, since_version: int = 0, limit: int = 100
) -> SyncPullResponse:
    """Everything that changed after ``since_version`` (soft deletes included)."""
    rows, has_more = db.list_clips_since_version(since_version, limit)
    clip_ids = [str(row["id"]) for row in rows]
    tag_map = db.get_tags_map(clip_ids)

    clips = [
        _clip_record(
            row,
            tag_map.get(str(row["id"]), []),
            db.list_media(str(row["id"])),
        )
        for row in rows
    ]

    logs: list[SyncReviewLogPayload] = []
    for row in db.list_review_logs_for_clips(clip_ids):
        try:
            action = ReviewAction(str(row["action"]))
        except ValueError:
            continue
        logs.append(
            SyncReviewLogPayload(
                clip_id=str(row["clip_id"]),
                action=action,
                reviewed_at=str(row["reviewed_at"]),
            )
        )

    return SyncPullResponse(
        clips=clips,
        review_logs=logs,
        latest_version=db.current_sync_version(),
        has_more=has_more,
    )


# ---------------------------------------------------------------------------
# media upload
# ---------------------------------------------------------------------------


def store_media_upload(
    db: Database,
    settings: Settings,
    media_id: str,
    *,
    data: bytes,
    clip_id: str | None = None,
    content_type: str | None = None,
    original_url: str | None = None,
    sort_order: int | None = None,
) -> SyncMediaUploadResponse:
    """Persist an uploaded binary under ``media_dir`` and upsert its media row."""
    media_id = (media_id or "").strip()
    if not media_id:
        raise SyncMediaUnsupportedError("media id is required")

    existing_row = db.get_media(media_id)
    resolved_clip = (clip_id or "").strip() or (
        str(existing_row["clip_id"]) if existing_row is not None else ""
    )
    if not resolved_clip:
        raise SyncClipMissingError("X-Clip-Id header is required for new media")
    if db.get_clip(resolved_clip) is None:
        raise SyncClipMissingError(f"clip {resolved_clip} does not exist")

    if len(data) > int(settings.max_media_bytes):
        raise SyncMediaTooLargeError(
            f"media is {len(data)} bytes, limit is {settings.max_media_bytes}"
        )
    if not data:
        raise SyncMediaUnsupportedError("empty media body")

    mime_type = _resolve_mime(content_type, data)
    if not mime_type:
        raise SyncMediaUnsupportedError(
            f"unsupported media type: {content_type or 'unknown'}"
        )

    sha256 = hashlib.sha256(data).hexdigest()
    extension = _extension_for(mime_type)
    relative = f"{sha256[:2]}/{sha256}{extension}"
    target = settings.media_dir / sha256[:2] / f"{sha256}{extension}"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    resolved_sort_order = (
        int(sort_order)
        if sort_order is not None
        else (int(existing_row["sort_order"] or 0) if existing_row is not None else 0)
    )
    resolved_original_url = (original_url or "").strip() or (
        str(existing_row["original_url"] or "") if existing_row is not None else ""
    )
    db.add_media(
        clip_id=resolved_clip,
        local_path=relative,
        original_url=resolved_original_url,
        media_id=media_id,
        mime_type=mime_type,
        size_bytes=len(data),
        sha256=sha256,
        sort_order=resolved_sort_order,
    )
    return SyncMediaUploadResponse(
        id=media_id,
        clip_id=resolved_clip,
        size_bytes=len(data),
        sha256=sha256,
        mime_type=mime_type,
    )


__all__ = [
    "SyncClipMissingError",
    "SyncError",
    "SyncMediaTooLargeError",
    "SyncMediaUnsupportedError",
    "apply_push",
    "merge_clip",
    "merge_media_rows",
    "pull_changes",
    "store_media_upload",
]
