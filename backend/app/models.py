from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class Platform(StrEnum):
    WECHAT = "wechat"
    X = "x"
    XIAOHONGSHU = "xiaohongshu"
    WEB = "web"


class ClipStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    PARTIAL = "partial"
    FAILED = "failed"


class AIStatus(StrEnum):
    PENDING = "pending"
    DONE = "done"
    SKIPPED = "skipped"
    FAILED = "failed"


class ReviewState(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class ReviewAction(StrEnum):
    SNOOZE = "snooze"
    ARCHIVE = "archive"
    DELETE = "delete"


class MediaItem(BaseModel):
    id: str
    clip_id: str
    original_url: str
    url: str  # Relative API path, e.g. /api/media/{id}
    mime_type: str
    size_bytes: int
    sort_order: int = 0


class ClipCreateRequest(BaseModel):
    input: str = Field(..., min_length=1, description="Raw share text or URL")
    user_note: str = Field(default="", description="Optional personal note")
    tags: list[str] = Field(default_factory=list, description="Optional initial tags")


class ClipUpdateRequest(BaseModel):
    title: str | None = None
    content_markdown: str | None = None
    user_note: str | None = None
    summary: str | None = None
    tags: list[str] | None = None
    review_state: ReviewState | None = None


class ClipSummary(BaseModel):
    id: str
    url: str
    platform: Platform
    status: ClipStatus
    ai_status: AIStatus
    error_message: str | None = None
    title: str
    author: str
    summary: str
    cover_media_url: str | None = None
    tags: list[str] = Field(default_factory=list)
    review_state: ReviewState
    review_count: int
    next_review_at: str | None = None
    last_reviewed_at: str | None = None
    created_at: str
    updated_at: str


class ClipDetail(ClipSummary):
    raw_input: str
    published_at: str | None = None
    content_markdown: str
    key_points: list[str] = Field(default_factory=list)
    user_note: str
    media: list[MediaItem] = Field(default_factory=list)


class ClipCreateResponse(BaseModel):
    clip: ClipSummary
    deduplicated: bool = False


class ClipListResponse(BaseModel):
    items: list[ClipSummary]
    total: int
    limit: int
    offset: int


class ReviewActionRequest(BaseModel):
    action: ReviewAction
    snooze_days: int | None = Field(default=None, ge=1, le=365)


class ReviewActionResponse(BaseModel):
    clip: ClipSummary
    reviewed_today: int
    daily_target: int


class ReviewTodayResponse(BaseModel):
    items: list[ClipDetail]
    reviewed_today: int
    daily_target: int
    total_active: int


class TagItem(BaseModel):
    name: str
    count: int


class TagListResponse(BaseModel):
    tags: list[TagItem]


class HealthResponse(BaseModel):
    status: str = "ok"
    app: str
    ai_enabled: bool
    auth_enabled: bool
