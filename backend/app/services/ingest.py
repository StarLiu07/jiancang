"""Ingestion pipeline: extract -> store media -> AI enrich -> persist.

``process_clip`` is designed to run inside a FastAPI ``BackgroundTasks`` worker.
It never raises: every failure marks the clip ``failed`` with an
``error_message`` so the user keeps the raw input and can retry later.

The extractor/media implementation lives in sibling modules owned by another
worker (``app.services.extractors`` / ``app.services.media``), so imports are
lazy and arguments are adapted to whatever signature those modules expose.
That keeps this module importable (and unit-testable) before they land.
"""

from __future__ import annotations

import inspect
import json
import logging
import re
from collections.abc import Sequence
from typing import Any

import httpx

from app.config import Settings
from app.db import Database, merge_tags
from app.models import AIStatus, ClipStatus, ReviewState
from app.services.ai import enrich_clip

logger = logging.getLogger(__name__)

_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_HTML_RE = re.compile(r"<[^>]+>")
_MD_MARKS_RE = re.compile(r"[*_`~]+")
_MD_LEAD_RE = re.compile(r"^\s*(#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+)", re.MULTILINE)


# ---------------------------------------------------------------------------
# adaptive calling helpers (sibling modules are written concurrently)
# ---------------------------------------------------------------------------


def _invoke(fn: Any, values: dict[str, Any]) -> Any:
    """Call ``fn`` passing only the parameters it actually declares."""
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):  # builtins / partials
        return fn(values.get("url") or values.get("image_urls"))
    args: list[Any] = []
    kwargs: dict[str, Any] = {}
    for name, param in signature.parameters.items():
        if param.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        if name in values:
            if param.kind is inspect.Parameter.POSITIONAL_ONLY:
                args.append(values[name])
            else:
                kwargs[name] = values[name]
        elif param.default is inspect.Parameter.empty:
            raise TypeError(f"cannot satisfy parameter {name!r} of {fn!r}")
    return fn(*args, **kwargs)


async def _invoke_async(fn: Any, value_sets: Sequence[dict[str, Any]]) -> Any:
    last_error: Exception | None = None
    for values in value_sets:
        try:
            result = _invoke(fn, values)
        except TypeError as exc:
            last_error = exc
            continue
        if inspect.isawaitable(result):
            result = await result
        return result
    raise RuntimeError(f"could not call {getattr(fn, '__name__', fn)!r}: {last_error}")


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(obj, dict) and name in obj:
            value = obj[name]
        else:
            value = getattr(obj, name, None)
        if value not in (None, ""):
            return value
    return default


# ---------------------------------------------------------------------------
# markdown helpers
# ---------------------------------------------------------------------------


def markdown_to_text(markdown: str) -> str:
    """Very light markdown -> plain text conversion, used for FTS and AI input."""
    if not markdown:
        return ""
    text = _MD_IMAGE_RE.sub("", markdown)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _MD_HTML_RE.sub(" ", text)
    text = _MD_MARKS_RE.sub("", text)
    text = _MD_LEAD_RE.sub("", text)
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _first_line(text: str, limit: int = 80) -> str:
    for line in (text or "").splitlines():
        candidate = " ".join(line.split())
        if candidate:
            return candidate[:limit]
    return ""


# ---------------------------------------------------------------------------
# pipeline
# ---------------------------------------------------------------------------


def _should_skip_overwrite(db: Database, clip_id: str) -> bool:
    """Avoid clobbering a clip that was manually completed or deleted in flight."""
    latest = db.get_clip(clip_id)
    if latest is None:
        return True
    if str(latest["review_state"]) == ReviewState.DELETED.value:
        return True
    if (
        str(latest["status"]) == ClipStatus.READY.value
        and str(latest["content_markdown"] or "").strip()
    ):
        return True
    return False


async def process_clip(clip_id: str, db: Database, settings: Settings) -> None:
    """Run the full ingestion pipeline for ``clip_id`` (never raises)."""
    clip = db.get_clip(clip_id)
    if clip is None:
        logger.warning("process_clip: unknown clip %s", clip_id)
        return

    db.update_clip(
        clip_id,
        status=ClipStatus.PROCESSING.value,
        error_message=None,
        sync_fts=False,
    )

    async with _http_client(settings) as client:
        try:
            extracted = await _extract(clip, settings, client=client)
        except Exception as exc:  # noqa: BLE001 - extractor failure is terminal
            logger.warning("process_clip: extraction failed for %s: %s", clip_id, exc)
            if not _should_skip_overwrite(db, clip_id):
                db.update_clip(
                    clip_id,
                    status=ClipStatus.FAILED.value,
                    error_message=f"抓取失败: {exc}"[:500],
                    ai_status=AIStatus.SKIPPED.value,
                )
            return

        fields = await _extract_fields(extracted, clip)
        if _should_skip_overwrite(db, clip_id):
            return
        updates = await _store_media(fields, extracted, clip_id, db, settings, client)
        fields.update(updates)

    if _should_skip_overwrite(db, clip_id):
        return
    fields.update(await _enrich(db=db, clip_id=clip_id, settings=settings, fields=fields))
    if not _should_skip_overwrite(db, clip_id):
        db.update_clip(clip_id, **fields)


def _http_client(settings: Settings) -> httpx.AsyncClient:
    """Shared client so extractor + media downloads reuse one UA / proxy pool."""
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.http_timeout_seconds),
        follow_redirects=True,
        headers={"User-Agent": settings.user_agent},
    )


async def _extract_fields(extracted: Any, clip: Any) -> dict[str, Any]:
    """Map :class:`ExtractedContent` onto clip columns."""
    markdown = str(getattr(extracted, "content_markdown", "") or "")
    content_text = str(getattr(extracted, "content_text", "") or "")
    if not content_text:
        content_text = markdown_to_text(markdown)

    partial = bool(getattr(extracted, "partial", False))
    title = str(getattr(extracted, "title", "") or clip["title"] or "")
    return {
        "status": (ClipStatus.PARTIAL if partial else ClipStatus.READY).value,
        "error_message": getattr(extracted, "error_message", None),
        "platform": str(getattr(extracted, "platform", "") or clip["platform"] or "web"),
        "url": str(getattr(extracted, "url", "") or clip["url"] or ""),
        "title": title or _first_line(content_text),
        "author": str(getattr(extracted, "author", "") or clip["author"] or ""),
        "published_at": getattr(extracted, "published_at", None) or clip["published_at"],
        "content_markdown": markdown,
        "content_text": content_text,
    }


async def _store_media(
    fields: dict[str, Any],
    extracted: Any,
    clip_id: str,
    db: Database,
    settings: Settings,
    client: httpx.AsyncClient,
) -> dict[str, Any]:
    """Download images, rewrite markdown links and persist media rows.

    Media problems are logged but never abort an otherwise good clip.
    """
    image_urls = [
        str(item) for item in (getattr(extracted, "image_urls", None) or []) if item
    ]
    if not image_urls:
        return {}

    updates: dict[str, Any] = {}
    try:
        stored = await _download_media(
            image_urls,
            clip_id=clip_id,
            settings=settings,
            db=db,
            referer=str(
                getattr(extracted, "referer", None)
                or getattr(extracted, "url", "")
                or fields.get("url")
                or ""
            ),
            client=client,
        )
    except Exception as exc:  # noqa: BLE001 - media is optional
        logger.warning("process_clip: media failed for %s: %s", clip_id, exc)
        return {}

    if not stored:
        return {}

    try:
        rewritten = await _rewrite_images(
            str(fields.get("content_markdown") or ""),
            stored,
            clip_id=clip_id,
            settings=settings,
            db=db,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("process_clip: image rewrite failed for %s: %s", clip_id, exc)
        rewritten = ""
    if isinstance(rewritten, str) and rewritten.strip():
        updates["content_markdown"] = rewritten
        if not str(fields.get("content_text") or "").strip():
            updates["content_text"] = markdown_to_text(rewritten)

    items = [_media_row(item, clip_id, index) for index, item in enumerate(stored)]
    try:
        ids = db.replace_media(clip_id, items)
    except Exception as exc:  # noqa: BLE001
        logger.warning("process_clip: media persist failed for %s: %s", clip_id, exc)
        return updates
    if ids:
        updates["cover_media_id"] = ids[0]
    return updates


async def _extract(
    clip: Any, settings: Settings, client: httpx.AsyncClient | None = None
) -> Any:
    from app.services.extractors import extract_content  # noqa: PLC0415

    url = str(clip["url"] or "")
    raw_input = str(clip["raw_input"] or "")
    value_sets: list[dict[str, Any]] = []
    for shared in (client, None):
        value_sets.append(
            {"url": url, "raw_input": raw_input, "client": shared, "settings": settings}
        )
    return await _invoke_async(extract_content, value_sets)


async def _download_media(
    image_urls: list[str],
    *,
    clip_id: str,
    settings: Settings,
    db: Database,
    referer: str,
    client: httpx.AsyncClient | None = None,
) -> list[Any]:
    from app.services.media import download_and_store_images  # noqa: PLC0415

    value_sets: list[dict[str, Any]] = []
    for key in ("image_urls", "urls", "images"):
        value_sets.append(
            {
                key: image_urls,
                "clip_id": clip_id,
                "settings": settings,
                "db": db,
                "client": client,
                "media_dir": settings.media_dir,
                "data_dir": settings.data_dir,
                "referer": referer,
                "user_agent": settings.user_agent,
                "max_bytes": settings.max_media_bytes,
                "timeout": settings.http_timeout_seconds,
            }
        )
    result = await _invoke_async(download_and_store_images, value_sets)
    return list(result or [])


async def _rewrite_images(
    markdown: str,
    stored: list[Any],
    *,
    clip_id: str,
    settings: Settings,
    db: Database,
) -> str:
    from app.services.media import rewrite_markdown_images  # noqa: PLC0415

    value_sets: list[dict[str, Any]] = []
    for key in ("markdown", "content_markdown", "text"):
        for store_key in ("media", "stored", "items", "images"):
            value_sets.append(
                {
                    key: markdown,
                    store_key: stored,
                    "clip_id": clip_id,
                    "settings": settings,
                    "db": db,
                    "media_dir": settings.media_dir,
                }
            )
    result = await _invoke_async(rewrite_markdown_images, value_sets)
    return result if isinstance(result, str) else ""


def _media_row(stored: Any, clip_id: str, index: int) -> dict[str, Any]:
    return {
        "id": _attr(stored, "id", "media_id"),
        "clip_id": clip_id,
        "original_url": str(_attr(stored, "original_url", "url", "source_url", default="")),
        "local_path": str(
            _attr(stored, "local_path", "path", "file_path", "filename", default="")
        ),
        "mime_type": str(_attr(stored, "mime_type", "content_type", default="")),
        "size_bytes": int(_attr(stored, "size_bytes", "size", "bytes", default=0) or 0),
        "sha256": str(_attr(stored, "sha256", "hash", default="")),
        "sort_order": int(_attr(stored, "sort_order", "index", default=index) or index),
    }


async def _enrich(
    *,
    db: Database,
    clip_id: str,
    settings: Settings,
    fields: dict[str, Any],
) -> dict[str, Any]:
    """Run optional AI enrichment; returns the fields to persist."""
    title = str(fields.get("title") or "")
    content_text = str(fields.get("content_text") or "")
    if not settings.ai_enabled:
        return {"ai_status": AIStatus.SKIPPED.value}
    if not content_text.strip() and not title.strip():
        return {"ai_status": AIStatus.SKIPPED.value}

    clip_tags = db.get_clip_tags(clip_id)
    library_tags = [name for name, _ in db.list_tags()]
    prompt_tags = merge_tags(clip_tags, library_tags)
    try:
        enrichment = await enrich_clip(title, content_text, prompt_tags, settings)
    except Exception as exc:  # noqa: BLE001 - AI must never break ingestion
        logger.info("enrichment failed for %s: %s", clip_id, exc)
        return {"ai_status": AIStatus.FAILED.value}

    if enrichment is None:
        return {"ai_status": AIStatus.SKIPPED.value}

    updates: dict[str, Any] = {"ai_status": AIStatus.DONE.value}
    if enrichment.summary:
        updates["summary"] = enrichment.summary
    if enrichment.key_points:
        updates["key_points_json"] = json.dumps(
            enrichment.key_points[:5], ensure_ascii=False
        )
    if enrichment.tags:
        db.add_clip_tags(clip_id, merge_tags(clip_tags, enrichment.tags))
    if not (
        enrichment.summary or enrichment.key_points or enrichment.tags
    ):  # pragma: no cover - parse_enrichment already rejects empty payloads
        updates["ai_status"] = AIStatus.SKIPPED.value
    return updates


async def enrich_existing_clip(clip_id: str, db: Database, settings: Settings) -> None:
    """Backfill AI enrichment for a clip the mobile client pushed un-enriched.

    Only clips that already hold usable content are touched: a clip that is
    still ``pending``/``processing`` is left to the normal ingestion pipeline.
    Tag merges and the summary write both bump ``sync_version`` so the client
    picks the result up on its next pull. This coroutine never raises, because
    it runs inside a FastAPI ``BackgroundTasks`` worker.
    """
    try:
        clip = db.get_clip(clip_id)
        if clip is None:
            return
        if str(clip["review_state"]) == ReviewState.DELETED.value:
            return
        if str(clip["status"]) not in (
            ClipStatus.READY.value,
            ClipStatus.PARTIAL.value,
        ):
            return

        fields: dict[str, Any] = {
            "title": str(clip["title"] or ""),
            "content_markdown": str(clip["content_markdown"] or ""),
            "content_text": str(clip["content_text"] or ""),
        }
        if not fields["content_text"].strip() and fields["content_markdown"].strip():
            fields["content_text"] = markdown_to_text(fields["content_markdown"])

        updates = await _enrich(
            db=db, clip_id=clip_id, settings=settings, fields=fields
        )
        if not updates:
            return
        latest = db.get_clip(clip_id)
        if latest is None:
            return
        if str(latest["review_state"]) == ReviewState.DELETED.value:
            return
        db.update_clip(clip_id, **updates)
    except Exception as exc:  # noqa: BLE001 - background task must never crash
        logger.warning("enrich_existing_clip failed for %s: %s", clip_id, exc)


__all__ = ["enrich_existing_clip", "markdown_to_text", "process_clip"]
