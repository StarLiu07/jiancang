"""Tag listing with usage counts."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.db import Database
from app.models import TagItem, TagListResponse
from app.routers import get_db

DbDep = Annotated[Database, Depends(get_db)]

router = APIRouter(prefix="/api/tags", tags=["tags"])


@router.get("", response_model=TagListResponse)
def list_tags(
    db: DbDep,
    include_deleted: bool = Query(default=False),
) -> TagListResponse:
    tags = db.list_tags(include_deleted=include_deleted)
    return TagListResponse(tags=[TagItem(name=name, count=count) for name, count in tags])


__all__ = ["router"]
