/**
 * API contract shared with the FastAPI backend (backend/app/models.py).
 * Keep these definitions byte-for-byte aligned with the backend schemas.
 */

export type Platform = 'wechat' | 'x' | 'xiaohongshu' | 'web';

export type ClipStatus = 'pending' | 'processing' | 'ready' | 'partial' | 'failed';

export type AIStatus = 'pending' | 'done' | 'skipped' | 'failed';

export type ReviewState = 'active' | 'archived' | 'deleted';

export type ReviewActionType = 'snooze' | 'archive' | 'delete';

export interface MediaItem {
  id: string;
  clip_id: string;
  original_url: string;
  /** Relative API path, e.g. `/api/media/{id}`. */
  url: string;
  mime_type: string;
  size_bytes: number;
  sort_order: number;
}

export interface ClipSummary {
  id: string;
  url: string;
  platform: Platform;
  status: ClipStatus;
  ai_status: AIStatus;
  error_message: string | null;
  title: string;
  author: string;
  summary: string;
  cover_media_url: string | null;
  tags: string[];
  review_state: ReviewState;
  review_count: number;
  next_review_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClipDetail extends ClipSummary {
  raw_input: string;
  published_at: string | null;
  content_markdown: string;
  key_points: string[];
  user_note: string;
  media: MediaItem[];
}

export interface ClipCreateInput {
  input: string;
  user_note?: string;
  tags?: string[];
}

export interface ClipCreateResponse {
  clip: ClipSummary;
  deduplicated: boolean;
}

export interface ClipListResponse {
  items: ClipSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClipListQuery {
  q?: string;
  platform?: Platform;
  tag?: string;
  review_state?: ReviewState;
  status?: ClipStatus;
  limit?: number;
  offset?: number;
}

export interface ClipUpdateInput {
  title?: string;
  content_markdown?: string;
  user_note?: string;
  summary?: string;
  tags?: string[];
  review_state?: ReviewState;
}

export interface ReviewTodayResponse {
  items: ClipDetail[];
  reviewed_today: number;
  daily_target: number;
  total_active: number;
}

export interface ReviewActionInput {
  action: ReviewActionType;
  snooze_days?: number;
}

export interface ReviewActionResponse {
  clip: ClipSummary;
  reviewed_today: number;
  daily_target: number;
}

export interface TagItem {
  name: string;
  count: number;
}

export interface TagListResponse {
  tags: TagItem[];
}

export interface HealthResponse {
  status: string;
  app: string;
  ai_enabled: boolean;
  auth_enabled: boolean;
}

export interface DeleteResponse {
  ok: boolean;
}

export interface ApiConfig {
  baseUrl: string;
  token: string;
}

export interface LocalAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SyncMediaPayload {
  id: string;
  clip_id: string;
  original_url: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  sort_order: number;
  created_at: string;
}

export interface SyncClipPayload {
  id: string;
  raw_input: string;
  url: string;
  normalized_url: string | null;
  platform: Platform;
  status: ClipStatus;
  ai_status: AIStatus;
  error_message: string | null;
  title: string;
  author: string;
  published_at: string | null;
  content_markdown: string;
  content_text: string;
  cover_media_id: string | null;
  summary: string;
  key_points: string[];
  user_note: string;
  review_state: ReviewState;
  review_count: number;
  review_interval_days: number;
  next_review_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
  media: SyncMediaPayload[];
}

export interface SyncClipRecord extends SyncClipPayload {
  sync_version: number;
}

export interface SyncReviewLogPayload {
  clip_id: string;
  action: ReviewActionType;
  reviewed_at: string;
}

export interface SyncPushRequest {
  clips: SyncClipPayload[];
  review_logs: SyncReviewLogPayload[];
}

export interface SyncPushResponse {
  accepted_ids: string[];
  skipped_ids: string[];
  missing_media_ids: string[];
  queued_ai_ids: string[];
  server_version: number;
}

export interface SyncPullResponse {
  clips: SyncClipRecord[];
  review_logs: SyncReviewLogPayload[];
  latest_version: number;
  has_more: boolean;
}

export interface SyncMediaUploadResponse {
  id: string;
  clip_id: string;
  size_bytes: number;
  sha256: string;
  mime_type: string;
}
