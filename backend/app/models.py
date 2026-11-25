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


class SyncMediaPayload(BaseModel):
    id: str
    clip_id: str
    original_url: str = ""
    mime_type: str = ""
    size_bytes: int = 0
    sha256: str = ""
    sort_order: int = 0
    created_at: str = ""


class SyncClipPayload(BaseModel):
    id: str
    raw_input: str = ""
    url: str = ""
    normalized_url: str | None = None
    platform: Platform = Platform.WEB
    status: ClipStatus = ClipStatus.PENDING
    ai_status: AIStatus = AIStatus.PENDING
    error_message: str | None = None
    title: str = ""
    author: str = ""
    published_at: str | None = None
    content_markdown: str = ""
    content_text: str = ""
    cover_media_id: str | None = None
    summary: str = ""
    key_points: list[str] = Field(default_factory=list)
    user_note: str = ""
    review_state: ReviewState = ReviewState.ACTIVE
    review_count: int = 0
    review_interval_days: int = 0
    next_review_at: str | None = None
    last_reviewed_at: str | None = None
    created_at: str
    updated_at: str
    tags: list[str] = Field(default_factory=list)
    media: list[SyncMediaPayload] = Field(default_factory=list)


class SyncClipRecord(SyncClipPayload):
    sync_version: int = 0


class SyncReviewLogPayload(BaseModel):
    clip_id: str
    action: ReviewAction
    reviewed_at: str


class SyncPushRequest(BaseModel):
    clips: list[SyncClipPayload] = Field(default_factory=list)
    review_logs: list[SyncReviewLogPayload] = Field(default_factory=list)


class SyncPushResponse(BaseModel):
    accepted_ids: list[str] = Field(default_factory=list)
    skipped_ids: list[str] = Field(default_factory=list)
    missing_media_ids: list[str] = Field(default_factory=list)
    queued_ai_ids: list[str] = Field(default_factory=list)
    # Clips the server accepted but must (re-)extract itself, e.g. when the
    # mobile client's local extraction was blocked by platform risk control.
    queued_extract_ids: list[str] = Field(default_factory=list)
    server_version: int = 0


class SyncPullResponse(BaseModel):
    clips: list[SyncClipRecord] = Field(default_factory=list)
    review_logs: list[SyncReviewLogPayload] = Field(default_factory=list)
    latest_version: int = 0
    has_more: bool = False


class SyncMediaUploadResponse(BaseModel):
    id: str
    clip_id: str
    size_bytes: int
    sha256: str
    mime_type: str


# ---------------------------------------------------------------------------
# Stateless remote extraction
#
# Fallback used when the device-local extractor is blocked by a platform's
# risk control: the phone asks the NUC to fetch the page and mirrors back the
# same shape the local extractor produces (``services.extractors.base.
# ExtractedContent``).
# ---------------------------------------------------------------------------


class StatelessExtractRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=4096)
    raw_input: str = Field(default="", max_length=20000)


class StatelessExtractResponse(BaseModel):
    platform: Platform = Platform.WEB
    url: str
    title: str = ""
    author: str = ""
    published_at: str | None = None
    content_markdown: str = ""
    content_text: str = ""
    image_urls: list[str] = Field(default_factory=list)
    partial: bool = False
    error_message: str | None = None
    referer: str | None = None


# ---------------------------------------------------------------------------
# Article AI chat (shared client/server contract)
# ---------------------------------------------------------------------------


class ChatRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessageItem(BaseModel):
    id: str
    clip_id: str
    role: ChatRole
    content: str
    created_at: str


class ChatTurnInput(BaseModel):
    role: ChatRole
    content: str = Field(..., min_length=1, max_length=12000)


class ClipChatRequest(BaseModel):
    message: str = Field(
        ...,
        min_length=1,
        max_length=4000,
        description="User question about the clip",
    )


class ClipChatResponse(BaseModel):
    user_message: ChatMessageItem
    assistant_message: ChatMessageItem
    model: str = ""


class ClipChatHistoryResponse(BaseModel):
    clip_id: str
    messages: list[ChatMessageItem] = Field(default_factory=list)


class ArticleChatContext(BaseModel):
    title: str = ""
    author: str = ""
    platform: Platform = Platform.WEB
    url: str = ""
    summary: str = ""
    key_points: list[str] = Field(default_factory=list)
    content_text: str = ""
    user_note: str = ""


class StatelessChatRequest(BaseModel):
    article: ArticleChatContext
    messages: list[ChatTurnInput] = Field(..., min_length=1, max_length=40)


class StatelessChatResponse(BaseModel):
    reply: str
    model: str = ""
