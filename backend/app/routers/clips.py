"""Clip CRUD, ingest trigger, retry and media serving."""

from __future__ import annotations

import json
import logging
import re
from datetime import timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from app.config import Settings
from app.db import (
    Database,
    row_to_chat_message,
    row_to_detail,
    row_to_summary,
    utcnow,
)
from app.models import (
    ArticleChatContext,
    ChatRole,
    ChatTurnInput,
    ClipChatHistoryResponse,
    ClipChatRequest,
    ClipChatResponse,
    ClipCreateRequest,
    ClipCreateResponse,
    ClipDetail,
    ClipListResponse,
    ClipStatus,
    ClipSummary,
    ClipUpdateRequest,
    Platform,
    ReviewState,
    StatelessChatRequest,
    StatelessChatResponse,
    StatelessExtractRequest,
    StatelessExtractResponse,
)
from app.routers import get_db, get_settings
from app.services.ai import (
    MAX_CHAT_HISTORY_MESSAGES,
    AIChatError,
    chat_with_article,
)
from app.services.extractors import ExtractedContent, extract_content
from app.services.ingest import markdown_to_text, process_clip

logger = logging.getLogger(__name__)

DbDep = Annotated[Database, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

router = APIRouter(prefix="/api/clips", tags=["clips"])
media_router = APIRouter(prefix="/api/media", tags=["media"])
ai_router = APIRouter(prefix="/api/ai", tags=["ai"])
extract_router = APIRouter(prefix="/api", tags=["extract"])

AI_DISABLED_DETAIL = (
    "后端未配置 AI 模型，请先在服务端 .env 中配置 LLM_BASE_URL 与 LLM_API_KEY"
)

_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _resolve_url(raw_input: str) -> tuple[str, str, str]:
    """Return ``(url, platform, normalized_url)`` for raw share text."""
    from app.services.url_utils import (  # noqa: PLC0415 - optional sibling module
        detect_platform,
        extract_url,
        normalize_url,
    )

    url = str(extract_url(raw_input) or "").strip()
    try:
        platform = detect_platform(url)
    except Exception:  # noqa: BLE001 - platform detection is cosmetic
        platform = "web"
    try:
        normalized = str(normalize_url(url) or url).strip()
    except Exception:  # noqa: BLE001
        normalized = url
    return url, str(platform), normalized


def _guess_url(raw_input: str) -> str:
    match = _URL_RE.search(raw_input or "")
    return match.group(0).rstrip(".,;:!?)") if match else ""


def _is_within(path: Path, root: Path) -> bool:
    try:
        return path.resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def resolve_media_path(settings: Settings, local_path: str) -> Path | None:
    """Resolve a stored media path, refusing anything outside the data dirs."""
    if not local_path:
        return None
    raw = Path(local_path)
    candidates: list[Path] = []
    if raw.is_absolute():
        candidates.append(raw)
    else:
        candidates.extend((settings.data_dir / raw, settings.media_dir / raw, raw))
    roots = (settings.data_dir, settings.media_dir)
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:  # pragma: no cover - permission/loop edge cases
            continue
        if resolved.is_file() and any(_is_within(resolved, root) for root in roots):
            return resolved
    return None


def _summary(db: Database, row: Any) -> ClipSummary:
    return row_to_summary(row, db.get_clip_tags(str(row["id"])))


def _detail(db: Database, row: Any) -> ClipDetail:
    clip_id = str(row["id"])
    return row_to_detail(row, db.get_clip_tags(clip_id), db.list_media(clip_id))


def _get_clip_or_404(db: Database, clip_id: str) -> Any:
    row = db.get_clip(clip_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Clip not found")
    return row


def _chat_context(row: Any) -> ArticleChatContext:
    """Build the article context for a chat turn from a clip row."""
    try:
        platform = Platform(str(row["platform"]))
    except (ValueError, TypeError):
        platform = Platform.WEB
    try:
        parsed = json.loads(str(row["key_points_json"] or "[]"))
    except (TypeError, ValueError):
        parsed = []
    key_points = (
        [str(item) for item in parsed if str(item).strip()]
        if isinstance(parsed, list)
        else []
    )
    markdown = str(row["content_markdown"] or "").strip()
    return ArticleChatContext(
        title=str(row["title"] or ""),
        author=str(row["author"] or ""),
        platform=platform,
        url=str(row["url"] or ""),
        summary=str(row["summary"] or ""),
        key_points=key_points,
        content_text=markdown or str(row["content_text"] or ""),
        user_note=str(row["user_note"] or ""),
    )


def _history_turns(db: Database, clip_id: str) -> list[ChatTurnInput]:
    turns: list[ChatTurnInput] = []
    rows = db.list_chat_messages(clip_id, limit=MAX_CHAT_HISTORY_MESSAGES)
    for row in rows:
        content = str(row["content"] or "").strip()
        if not content:
            continue
        try:
            role = ChatRole(str(row["role"]))
        except ValueError:
            continue
        turns.append(ChatTurnInput(role=role, content=content))
    return turns


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------


@router.post("", response_model=ClipCreateResponse, status_code=201)
def create_clip(
    payload: ClipCreateRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    db: DbDep,
    settings: SettingsDep,
) -> ClipCreateResponse:
    raw_input = payload.input.strip()
    try:
        url, platform, normalized = _resolve_url(raw_input)
    except ImportError:  # pragma: no cover - url_utils not installed yet
        url, platform, normalized = "", "web", ""

    if not url:
        url = _guess_url(raw_input)
        normalized = url
    if not url:
        raise HTTPException(
            status_code=422,
            detail="No valid URL found in the provided input",
        )

    existing = db.find_by_normalized_url(normalized or url)
    if existing is not None:
        response.status_code = 200
        return ClipCreateResponse(clip=_summary(db, existing), deduplicated=True)

    created = db.create_clip(
        raw_input=raw_input,
        url=url,
        normalized_url=normalized or url,
        platform=platform,
        status=ClipStatus.PENDING.value,
        user_note=payload.user_note,
        tags=payload.tags,
    )
    clip_id = str(created["id"])
    background_tasks.add_task(process_clip, clip_id, db, settings)
    return ClipCreateResponse(clip=_summary(db, created), deduplicated=False)


@router.get("", response_model=ClipListResponse)
def list_clips(
    db: DbDep,
    q: str | None = Query(default=None, description="Full-text or substring query"),
    platform: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    review_state: str | None = Query(
        default=None,
        description="active/archived/deleted/all (default: hide deleted)",
    ),
    status: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> ClipListResponse:
    rows, total = db.list_clips(
        q=q,
        platform=platform,
        tag=tag,
        review_state=review_state,
        status=status,
        limit=limit,
        offset=offset,
    )
    tag_map = db.get_tags_map([str(row["id"]) for row in rows])
    items = [
        row_to_summary(row, tag_map.get(str(row["id"]), [])) for row in rows
    ]
    return ClipListResponse(
        items=items, total=total, limit=limit, offset=offset
    )


@router.get("/{clip_id}", response_model=ClipDetail)
def get_clip(clip_id: str, db: DbDep) -> ClipDetail:
    return _detail(db, _get_clip_or_404(db, clip_id))


@router.patch("/{clip_id}", response_model=ClipDetail)
def update_clip(clip_id: str, payload: ClipUpdateRequest, db: DbDep) -> ClipDetail:
    row = _get_clip_or_404(db, clip_id)
    fields: dict[str, Any] = {}

    if payload.title is not None:
        fields["title"] = payload.title.strip()
    if payload.summary is not None:
        fields["summary"] = payload.summary.strip()
    if payload.user_note is not None:
        fields["user_note"] = payload.user_note
    if payload.review_state is not None:
        fields["review_state"] = str(payload.review_state)
    if payload.content_markdown is not None:
        markdown = payload.content_markdown
        fields["content_markdown"] = markdown
        fields["content_text"] = markdown_to_text(markdown)
        if markdown.strip() and str(row["status"]) in {
            ClipStatus.PENDING.value,
            ClipStatus.PROCESSING.value,
            ClipStatus.PARTIAL.value,
            ClipStatus.FAILED.value,
        }:
            fields["status"] = ClipStatus.READY.value
            fields["error_message"] = None

    if fields:
        db.update_clip(clip_id, **fields)
    if payload.tags is not None:
        db.set_clip_tags(clip_id, payload.tags)

    updated = db.get_clip(clip_id)
    if updated is None:  # pragma: no cover - deleted by a concurrent request
        raise HTTPException(status_code=404, detail="Clip not found")
    return _detail(db, updated)


@router.delete("/{clip_id}")
def delete_clip(
    clip_id: str,
    db: DbDep,
    settings: SettingsDep,
    permanent: bool = Query(default=False),
) -> dict[str, Any]:
    _get_clip_or_404(db, clip_id)
    if not permanent:
        db.update_clip(clip_id, review_state=ReviewState.DELETED.value)
        return {"ok": True, "status": "deleted", "permanent": False, "id": clip_id}

    for media in db.list_media(clip_id):
        local_path = str(media["local_path"] or "")
        if not local_path:
            continue
        if db.count_media_references(local_path, exclude_clip_id=clip_id) > 0:
            continue
        path = resolve_media_path(settings, local_path)
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:  # pragma: no cover - filesystem oddities
            logger.warning("failed to delete media %s: %s", path, exc)
    db.hard_delete_clip(clip_id)
    return {"ok": True, "status": "deleted", "permanent": True, "id": clip_id}


@router.post("/{clip_id}/retry", response_model=ClipDetail)
def retry_clip(
    clip_id: str,
    background_tasks: BackgroundTasks,
    db: DbDep,
    settings: SettingsDep,
) -> ClipDetail:
    _get_clip_or_404(db, clip_id)
    db.update_clip(
        clip_id,
        status=ClipStatus.PENDING.value,
        ai_status="pending",
        error_message=None,
    )
    background_tasks.add_task(process_clip, clip_id, db, settings)
    updated = db.get_clip(clip_id)
    if updated is None:  # pragma: no cover
        raise HTTPException(status_code=404, detail="Clip not found")
    return _detail(db, updated)


@router.get("/{clip_id}/chat", response_model=ClipChatHistoryResponse)
def get_chat_history(clip_id: str, db: DbDep) -> ClipChatHistoryResponse:
    _get_clip_or_404(db, clip_id)
    rows = db.list_chat_messages(clip_id)
    return ClipChatHistoryResponse(
        clip_id=clip_id,
        messages=[row_to_chat_message(row) for row in rows],
    )


@router.post("/{clip_id}/chat", response_model=ClipChatResponse)
async def chat_with_clip(
    clip_id: str,
    payload: ClipChatRequest,
    db: DbDep,
    settings: SettingsDep,
) -> ClipChatResponse:
    row = _get_clip_or_404(db, clip_id)
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Message must not be empty")
    if not settings.ai_enabled:
        raise HTTPException(status_code=503, detail=AI_DISABLED_DETAIL)

    article = _chat_context(row)
    turns = [
        *_history_turns(db, clip_id),
        ChatTurnInput(role=ChatRole.USER, content=message),
    ]
    try:
        reply, model = await chat_with_article(article, turns, settings)
    except AIChatError as exc:
        # Never persist a failed turn: retrying would duplicate the question.
        raise HTTPException(status_code=502, detail=f"AI 聊天请求失败：{exc}") from exc

    user_time = utcnow()
    user_row = db.add_chat_message(clip_id, ChatRole.USER, message, now=user_time)
    assistant_row = db.add_chat_message(
        clip_id,
        ChatRole.ASSISTANT,
        reply,
        now=user_time + timedelta(microseconds=1),
    )
    return ClipChatResponse(
        user_message=row_to_chat_message(user_row),
        assistant_message=row_to_chat_message(assistant_row),
        model=model,
    )


@router.delete("/{clip_id}/chat")
def clear_chat_history(clip_id: str, db: DbDep) -> dict[str, Any]:
    _get_clip_or_404(db, clip_id)
    deleted = db.clear_chat_messages(clip_id)
    return {"ok": True, "deleted": deleted}


@ai_router.post("/chat", response_model=StatelessChatResponse)
async def chat_stateless(
    payload: StatelessChatRequest,
    settings: SettingsDep,
) -> StatelessChatResponse:
    if not settings.ai_enabled:
        raise HTTPException(status_code=503, detail=AI_DISABLED_DETAIL)
    if not any(
        turn.role is ChatRole.USER and turn.content.strip()
        for turn in payload.messages
    ):
        raise HTTPException(
            status_code=422,
            detail="At least one non-empty user message is required",
        )
    try:
        reply, model = await chat_with_article(
            payload.article, payload.messages, settings
        )
    except AIChatError as exc:
        raise HTTPException(status_code=502, detail=f"AI 聊天请求失败：{exc}") from exc
    return StatelessChatResponse(reply=reply, model=model)


@extract_router.post("/extract", response_model=StatelessExtractResponse)
async def extract_stateless(
    payload: StatelessExtractRequest,
    settings: SettingsDep,
) -> StatelessExtractResponse:
    """Stateless remote extraction (the phone's risk-control fallback).

    Nothing is persisted: the mobile client owns the clip and mirrors the returned
    fields into its local database, exactly like its own local extractor would.
    """
    content: ExtractedContent = await extract_content(
        payload.url, raw_input=payload.raw_input, settings=settings
    )
    return StatelessExtractResponse(
        platform=content.platform,
        url=content.url or payload.url,
        title=content.title,
        author=content.author,
        published_at=content.published_at,
        content_markdown=content.content_markdown,
        content_text=content.content_text,
        image_urls=[url for url in content.image_urls or [] if url],
        partial=content.partial,
        error_message=content.error_message,
        referer=content.referer,
    )


@media_router.get("/{media_id}")
def get_media(media_id: str, request: Request, db: DbDep, settings: SettingsDep) -> FileResponse:
    row = db.get_media(media_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Media not found")
    path = resolve_media_path(settings, str(row["local_path"] or ""))
    if path is None:
        raise HTTPException(status_code=404, detail="Media file missing")
    auth_on = bool((settings.api_token or "").strip())
    headers = {
        "Cache-Control": ("private" if auth_on else "public") + ", max-age=86400",
        "Content-Disposition": f'inline; filename="{path.name}"',
    }
    return FileResponse(
        path,
        media_type=str(row["mime_type"] or "") or "application/octet-stream",
        headers=headers,
    )


__all__ = [
    "ai_router",
    "extract_router",
    "media_router",
    "resolve_media_path",
    "router",
]
