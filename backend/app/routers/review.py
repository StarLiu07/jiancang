"""Daily review deck + spaced repetition actions."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings
from app.db import Database
from app.models import ReviewActionRequest, ReviewActionResponse, ReviewTodayResponse
from app.routers import get_db, get_settings
from app.services.review import (
    ClipNotFoundError,
    apply_review_action,
    get_today_review_deck,
)

DbDep = Annotated[Database, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

router = APIRouter(prefix="/api/review", tags=["review"])


@router.get("/today", response_model=ReviewTodayResponse)
def review_today(
    db: DbDep,
    settings: SettingsDep,
    limit: int | None = Query(default=None, ge=1, le=50),
) -> ReviewTodayResponse:
    return get_today_review_deck(db, settings, limit=limit)


@router.post("/{clip_id}/action", response_model=ReviewActionResponse)
def review_action(
    clip_id: str,
    payload: ReviewActionRequest,
    db: DbDep,
    settings: SettingsDep,
) -> ReviewActionResponse:
    try:
        return apply_review_action(db, settings, clip_id, payload)
    except ClipNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Clip not found") from exc


__all__ = ["router"]
