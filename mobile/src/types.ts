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
