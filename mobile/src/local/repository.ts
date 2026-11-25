/**
 * Unified local-first data repository.
 *
 * `localRepo` mirrors the remote `api.*` contract in `src/api/client.ts`, but
 * every call reads/writes the local SQLite database directly, so the app keeps
 * working offline (and always renders instantly from local state). Reads never
 * touch the network; `createClip` / `retryClip` / `resumePending` kick the local
 * ingestion pipeline off in the background.
 *
 * Every mutation calls `notifyLocalChange()` so subscribers can re-render.
 * SQLite is loaded lazily (see `ingest.ts`) which keeps the pure helpers in this
 * module unit-testable in plain Node.
 */

import type {
  ChatMessageItem,
  ClipCreateInput,
  ClipCreateResponse,
  ClipDetail,
  ClipListQuery,
  ClipListResponse,
  ClipStatus,
  ClipSummary,
  ClipUpdateInput,
  DeleteResponse,
  LocalAiConfig,
  ReviewActionInput,
  ReviewActionResponse,
  ReviewTodayResponse,
  TagListResponse,
} from '../types';
import type { SendClipChatOptions, SendClipChatResult } from './chat';
import type { ClipUpdateFields } from './db';
import { markdownToText } from './extractors/base';
import {
  notifyLocalChange,
  processClipLocally,
  resumePendingClips,
} from './ingest';
import type { RemoteExtractFallback } from './ingest';
import { deleteLocalMediaFile } from './media';
import { normalizeTags } from './reviewLogic';
import { detectPlatform, extractUrl, normalizeUrl } from './urlUtils';

export { notifyLocalChange, subscribeLocalChanges } from './ingest';
export type { LocalChangeListener, RemoteExtractFallback } from './ingest';

/** Error raised by the local repository (mirrors `ApiError` shape loosely). */
export class LocalRepositoryError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'LocalRepositoryError';
    this.status = status;
    Object.setPrototypeOf(this, LocalRepositoryError.prototype);
  }
}

/** Prefix of clip-scoped media directories (`media/clips/{clipId}/...`). */
export const LOCAL_CLIP_MEDIA_PREFIX = 'clips/';

const STATUS_READY = 'ready';
const READY_PROMOTION_SOURCES = new Set<string>([
  'pending',
  'processing',
  'partial',
  'failed',
]);

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function normalizeClipId(clipId: string | null | undefined): string {
  return String(clipId ?? '').trim();
}

function clipNotFound(clipId: string): LocalRepositoryError {
  return new LocalRepositoryError(`Clip not found: ${clipId}`, 404);
}

/**
 * Whether a manual body edit should complete an unfinished clip.
 *
 * Mirrors `PATCH /api/clips/{id}` on the backend: a non-empty Markdown body
 * promotes `pending` / `processing` / `partial` / `failed` to `ready` and clears
 * the stale error. Empty bodies never change the status.
 */
export function shouldPromoteManualContent(
  status: ClipStatus | string | null | undefined,
  markdown: string | null | undefined,
): boolean {
  if (!String(markdown ?? '').trim()) return false;
  return READY_PROMOTION_SOURCES.has(String(status ?? ''));
}

export interface ClipPatchPlan {
  fields: ClipUpdateFields;
  hasFields: boolean;
}

/**
 * Translate an API-shaped patch into SQLite fields.
 *
 * `content_markdown` also refreshes the plain-text search column and may
 * promote the clip to `ready`, exactly like the backend router does.
 */
export function buildClipPatch(
  currentStatus: ClipStatus | string | null | undefined,
  patch: ClipUpdateInput,
): ClipPatchPlan {
  const fields: ClipUpdateFields = {};

  if (patch.title !== undefined) fields.title = String(patch.title ?? '').trim();
  if (patch.summary !== undefined) fields.summary = String(patch.summary ?? '').trim();
  if (patch.user_note !== undefined) fields.user_note = patch.user_note;
  if (patch.review_state !== undefined) fields.review_state = patch.review_state;
  if (patch.tags !== undefined) fields.tags = normalizeTags(patch.tags ?? []);

  if (patch.content_markdown !== undefined) {
    const markdown = String(patch.content_markdown ?? '');
    fields.content_markdown = markdown;
    fields.content_text = markdownToText(markdown);
    if (shouldPromoteManualContent(currentStatus, markdown)) {
      fields.status = STATUS_READY;
      fields.error_message = null;
    }
  }

  return { fields, hasFields: Object.keys(fields).length > 0 };
}

/** Project a detail row onto the list/summary contract (drops body fields). */
export function toClipSummary(clip: ClipSummary | ClipDetail): ClipSummary {
  return {
    id: clip.id,
    url: clip.url,
    platform: clip.platform,
    status: clip.status,
    ai_status: clip.ai_status,
    error_message: clip.error_message,
    title: clip.title,
    author: clip.author,
    summary: clip.summary,
    cover_media_url: clip.cover_media_url,
    tags: [...(clip.tags ?? [])],
    review_state: clip.review_state,
    review_count: clip.review_count,
    next_review_at: clip.next_review_at,
    last_reviewed_at: clip.last_reviewed_at,
    created_at: clip.created_at,
    updated_at: clip.updated_at,
  };
}

/**
 * Local files that a permanent delete may remove.
 *
 * Only clip-scoped directories are collected: `remote/` files are
 * content-addressed and can be shared by several clips, so they are left alone.
 */
export function localMediaPathsToDelete(
  records: ReadonlyArray<{ local_path?: string | null }> | null | undefined,
): string[] {
  const paths = new Set<string>();
  for (const record of records ?? []) {
    const localPath = String(record?.local_path ?? '').trim();
    if (!localPath.startsWith(LOCAL_CLIP_MEDIA_PREFIX)) continue;
    if (localPath.split('/').includes('..')) continue;
    paths.add(localPath);
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// lazy native modules (keeps this module importable in Node unit tests)
// ---------------------------------------------------------------------------

type DbModule = typeof import('./db');
type ReviewModule = typeof import('./review');
type ChatModule = typeof import('./chat');

let cachedDb: DbModule | null = null;
let cachedReview: ReviewModule | null = null;
let cachedChat: ChatModule | null = null;

function localDb(): DbModule {
  if (!cachedDb) cachedDb = require('./db') as DbModule;
  return cachedDb;
}

function localReview(): ReviewModule {
  if (!cachedReview) cachedReview = require('./review') as ReviewModule;
  return cachedReview;
}

function localChat(): ChatModule {
  if (!cachedChat) cachedChat = require('./chat') as ChatModule;
  return cachedChat;
}

function triggerIngest(
  clipId: string,
  aiConfig: LocalAiConfig,
  remoteFallback?: RemoteExtractFallback,
): void {
  try {
    // `processClipLocally` never rejects; the extra catch keeps the caller safe.
    void processClipLocally(clipId, aiConfig, undefined, remoteFallback).catch(() => undefined);
  } catch {
    // Background work must never block the mutation the user asked for.
  }
}

async function loadClipDetail(clipId: string): Promise<ClipDetail> {
  const detail = await localDb().getClipDetail(clipId);
  if (!detail) throw clipNotFound(clipId);
  return detail;
}

async function cleanupClipMediaFiles(
  records: ReadonlyArray<{ local_path?: string | null }>,
): Promise<void> {
  for (const localPath of localMediaPathsToDelete(records)) {
    try {
      await deleteLocalMediaFile(localPath);
    } catch {
      // Deleting files is best effort; the DB rows are already gone.
    }
  }
}

// ---------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------

export const localRepo = {
  /**
   * Persist a clip instantly (status `pending`) and ingest it in the background.
   * Normalized-URL duplicates return the existing clip without re-ingesting.
   * `remoteFallback` lets the home NUC rescue a blocked local extraction.
   */
  async createClip(
    input: ClipCreateInput,
    aiConfig: LocalAiConfig,
    remoteFallback?: RemoteExtractFallback,
  ): Promise<ClipCreateResponse> {
    const rawInput = String(input?.input ?? '').trim();
    const url = (extractUrl(rawInput) ?? '').trim();
    if (!url) {
      throw new LocalRepositoryError('No valid URL found in the provided input', 422);
    }

    const platform = detectPlatform(url);
    const normalized = (normalizeUrl(url, platform) || url).trim();

    const db = localDb();
    const existing = await db.findByNormalizedUrl(normalized);
    if (existing) return { clip: existing, deduplicated: true };

    const created = await db.createClip({
      raw_input: rawInput,
      url,
      normalized_url: normalized,
      platform,
      status: 'pending',
      user_note: input?.user_note ?? '',
      tags: input?.tags ?? [],
    });
    notifyLocalChange();
    triggerIngest(created.id, aiConfig, remoteFallback);

    return { clip: toClipSummary(created), deduplicated: false };
  },

  listClips(query: ClipListQuery = {}): Promise<ClipListResponse> {
    return localDb().listClips(query);
  },

  async getClip(id: string): Promise<ClipDetail> {
    const clipId = normalizeClipId(id);
    if (!clipId) throw clipNotFound(clipId);
    return loadClipDetail(clipId);
  },

  async updateClip(id: string, patch: ClipUpdateInput): Promise<ClipDetail> {
    const clipId = normalizeClipId(id);
    const db = localDb();
    const current = await db.getClipDetail(clipId);
    if (!current) throw clipNotFound(clipId);

    const { fields, hasFields } = buildClipPatch(current.status, patch ?? {});
    if (!hasFields) return current;

    const updated = await db.updateClip(clipId, fields, { markDirty: true });
    if (!updated) throw clipNotFound(clipId);
    notifyLocalChange();
    return updated;
  },

  async deleteClip(id: string, permanent = false): Promise<DeleteResponse> {
    const clipId = normalizeClipId(id);
    const db = localDb();
    const current = await db.getClipDetail(clipId);
    if (!current) throw clipNotFound(clipId);

    const media = permanent ? await db.listMediaRecords(clipId) : [];
    const deleted = await db.deleteClip(clipId, permanent);
    if (deleted && permanent) await cleanupClipMediaFiles(media);

    notifyLocalChange();
    return { ok: deleted };
  },

  /** Reset a clip and re-run ingestion in the background. */
  async retryClip(
    id: string,
    aiConfig: LocalAiConfig,
    remoteFallback?: RemoteExtractFallback,
  ): Promise<ClipDetail> {
    const clipId = normalizeClipId(id);
    const db = localDb();
    const current = await db.getClipDetail(clipId);
    if (!current) throw clipNotFound(clipId);

    await db.updateClip(
      clipId,
      { status: 'pending', ai_status: 'pending', error_message: null },
      { markDirty: true },
    );
    const updated = (await db.getClipDetail(clipId)) ?? current;
    notifyLocalChange();
    triggerIngest(clipId, aiConfig, remoteFallback);
    return updated;
  },

  reviewToday(limit = 5): Promise<ReviewTodayResponse> {
    return localReview().getTodayReviewDeckLocal(limit);
  },

  async reviewAction(
    id: string,
    input: ReviewActionInput,
  ): Promise<ReviewActionResponse> {
    const result = await localReview().applyReviewActionLocal(id, input);
    notifyLocalChange();
    return result;
  },

  listTags(): Promise<TagListResponse> {
    return localDb().listTags();
  },

  /** Re-run clips that were interrupted mid-ingest (restart / reboot). */
  resumePending(
    aiConfig: LocalAiConfig,
    remoteFallback?: RemoteExtractFallback,
  ): Promise<number> {
    return resumePendingClips(aiConfig, undefined, remoteFallback);
  },

  countPendingSync(): Promise<number> {
    return localDb().countPendingSync();
  },

  /** Persisted chat turns for one clip, oldest first. */
  listChatMessages(clipId: string, limit = 100): Promise<ChatMessageItem[]> {
    return localDb().listChatMessages(normalizeClipId(clipId), limit);
  },

  countChatMessages(clipId: string): Promise<number> {
    return localDb().countChatMessages(normalizeClipId(clipId));
  },

  /** Drop every chat turn of one clip and notify subscribers. */
  async clearChatMessages(clipId: string): Promise<number> {
    const deleted = await localDb().clearChatMessages(normalizeClipId(clipId));
    notifyLocalChange();
    return deleted;
  },

  /** Run one article chat turn (local LLM or NUC fallback) and persist it. */
  sendChatMessage(
    clip: ClipDetail,
    message: string,
    options: SendClipChatOptions,
  ): Promise<SendClipChatResult> {
    return localChat().sendClipChatMessage(clip, message, options);
  },
};

export type LocalRepo = typeof localRepo;
