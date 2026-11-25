"""Incremental bidirectional sync endpoints for the Local-First mobile client.

* ``POST /api/sync/push``   - mobile -> NUC (clips, tags, tombstones, review logs)
* ``GET  /api/sync/pull``   - NUC -> mobile (everything newer than a cursor)
* ``PUT  /api/sync/media/{id}`` - raw image bytes for a media row

The NUC backfills missing AI summaries in the background: clips queued by the
push handler are enriched after the response is sent. Clips the phone could not
scrape itself (platform risk control) are queued for a server-side re-extraction
instead, which also runs after the response is sent.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request

from app.config import Settings
from app.db import Database
from app.models import (
    SyncMediaUploadResponse,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
)
from app.routers import get_db, get_settings
from app.services.ingest import enrich_existing_clip, process_clip
from app.services.sync import (
    SyncClipMissingError,
    SyncMediaTooLargeError,
    SyncMediaUnsupportedError,
    apply_push,
    pull_changes,
    store_media_upload,
)

router = APIRouter(prefix="/api/sync", tags=["sync"])

DbDep = Annotated[Database, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.post("/push", response_model=SyncPushResponse)
def push_sync(
    payload: SyncPushRequest,
    background_tasks: BackgroundTasks,
    db: DbDep,
    settings: SettingsDep,
) -> SyncPushResponse:
    """Merge a batch of client changes and queue server-side backfills."""
    result = apply_push(db, settings, payload)
    for clip_id in result.queued_extract_ids:
        background_tasks.add_task(process_clip, clip_id, db, settings)
    for clip_id in result.queued_ai_ids:
        background_tasks.add_task(enrich_existing_clip, clip_id, db, settings)
    return result


@router.get("/pull", response_model=SyncPullResponse)
def pull_sync(
    db: DbDep,
    since_version: int = Query(default=0, ge=0, description="Last seen sync version"),
    limit: int = Query(default=100, ge=1, le=200),
) -> SyncPullResponse:
    """Return clips (tombs included) and review logs newer than ``since_version``."""
    return pull_changes(db, since_version, limit)


def _header_int(request: Request, name: str) -> int | None:
    raw = (request.headers.get(name) or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


@router.put("/media/{media_id}", response_model=SyncMediaUploadResponse)
async def upload_sync_media(
    media_id: str,
    request: Request,
    db: DbDep,
    settings: SettingsDep,
) -> SyncMediaUploadResponse:
    """Store raw image bytes so ``GET /api/media/{media_id}`` can serve them."""
    limit = int(settings.max_media_bytes)
    declared = (request.headers.get("content-length") or "").strip()
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"Media exceeds the {limit} byte limit",
        )

    data = await request.body()
    try:
        return store_media_upload(
            db,
            settings,
            media_id,
            data=data,
            clip_id=request.headers.get("x-clip-id"),
            content_type=request.headers.get("content-type"),
            original_url=request.headers.get("x-original-url"),
            sort_order=_header_int(request, "x-sort-order"),
        )
    except SyncMediaTooLargeError as exc:
        raise HTTPException(
            status_code=413, detail=f"Media exceeds the {limit} byte limit"
        ) from exc
    except SyncMediaUnsupportedError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except SyncClipMissingError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


__all__ = ["router"]
