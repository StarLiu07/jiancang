/**
 * Local-first ingestion pipeline: extract -> store media -> AI enrich -> persist.
 *
 * This is the offline twin of `backend/app/services/ingest.py`:
 *
 * - it never throws — the user's raw clip row always survives, failures land in
 *   `status = 'failed'` / `error_message` so the clip can be retried;
 * - it never clobbers a clip that was deleted or manually completed while the
 *   background job was running;
 * - every persisted step notifies the UI (module level change bus + optional
 *   per-call `onChange` callback).
 *
 * The SQLite store is loaded lazily so this module (and its pure helpers) can be
 * imported in plain Node for unit tests. Metro resolves the `require` at bundle
 * time, exactly like `media.ts` does for `expo-file-system`.
 */

import type { ClipDetail, ClipStatus, LocalAiConfig, Platform } from '../types';
import type { ClipUpdateFields, MediaInput } from './db';
import { enrichClipLocally, isLocalAiConfigured } from './ai';
import type { LocalAiEnrichment } from './ai';
import { extractContent } from './extractors';
import { markdownToText } from './extractors/base';
import type { ExtractedContent } from './extractors/base';
import { downloadAndStoreImages, rewriteMarkdownImages } from './media';
import type { StoredMedia } from './media';
import { mergeTags } from './reviewLogic';

/** How many interrupted clips `resumePendingClips` runs at a time. */
export const INGEST_RESUME_CONCURRENCY = 2;

/** Maximum number of AI key points persisted (mirrors the backend). */
export const INGEST_MAX_KEY_POINTS = 5;

const MAX_ERROR_MESSAGE_CHARS = 500;

// ---------------------------------------------------------------------------
// change bus (re-exported by `repository.ts` as the single local event bus)
// ---------------------------------------------------------------------------

export type LocalChangeListener = () => void;

const changeListeners = new Set<LocalChangeListener>();

/**
 * Register a UI refresh callback. Returns an idempotent unsubscribe function.
 *
 * A listener must never break ingestion, so notifications are best effort.
 */
export function subscribeLocalChanges(listener: LocalChangeListener): () => void {
  if (typeof listener !== 'function') return () => undefined;
  changeListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    changeListeners.delete(listener);
  };
}

/** Notify every subscriber that local rows changed (cheap, synchronous). */
export function notifyLocalChange(): void {
  for (const listener of Array.from(changeListeners)) {
    try {
      listener();
    } catch {
      // A broken subscriber (e.g. unmounted screen) must not abort ingestion.
    }
  }
}

/** Drop every subscriber. Intended for unit tests / app resets. */
export function resetLocalChangeListeners(): void {
  changeListeners.clear();
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** Minimal snapshot the pipeline needs to detect a concurrent user edit. */
export interface IngestSnapshot {
  status?: string | null;
  review_state?: string | null;
  content_markdown?: string | null;
}

/**
 * True when the pipeline must stop touching `clip`.
 *
 * Mirrors backend `_should_skip_overwrite`: the row may have been deleted
 * (tombstone) or the user may have manually completed the body while the
 * background job was running.
 */
export function shouldAbortIngest(
  clip: IngestSnapshot | null | undefined,
): boolean {
  if (!clip) return true;
  if (String(clip.review_state ?? '') === 'deleted') return true;
  return (
    String(clip.status ?? '') === 'ready'
    && String(clip.content_markdown ?? '').trim().length > 0
  );
}

/** First non-empty line, whitespace-collapsed and truncated (backend `_first_line`). */
export function firstContentLine(
  text: string | null | undefined,
  limit = 80,
): string {
  for (const line of String(text ?? '').split('\n')) {
    const collapsed = line.split(/\s+/).filter(Boolean).join(' ');
    if (collapsed) return collapsed.slice(0, Math.max(1, Math.floor(limit)));
  }
  return '';
}

/** Fallback values used when the extractor came back empty. */
export interface IngestClipDefaults {
  url?: string | null;
  platform?: Platform | null;
  title?: string | null;
  author?: string | null;
  published_at?: string | null;
}

/** Clip fields produced by a successful extraction (backend `_extract_fields`). */
export interface IngestFields extends ClipUpdateFields {
  status: ClipStatus;
  error_message: string | null;
  platform: Platform;
  url: string;
  title: string;
  author: string;
  published_at: string | null;
  content_markdown: string;
  content_text: string;
}

/** Map `ExtractedContent` onto clip columns without losing the user's raw input. */
export function buildIngestFields(
  extracted: ExtractedContent,
  clip: IngestClipDefaults = {},
): IngestFields {
  const markdown = String(extracted.content_markdown ?? '');
  let contentText = String(extracted.content_text ?? '');
  if (!contentText.trim()) contentText = markdownToText(markdown);

  const title =
    String(extracted.title ?? '').trim()
    || String(clip.title ?? '').trim()
    || firstContentLine(contentText);
  const platform = (extracted.platform || clip.platform || 'web') as Platform;
  const errorMessage = String(extracted.error_message ?? '').trim();

  return {
    status: extracted.partial ? 'partial' : 'ready',
    error_message: errorMessage || null,
    platform,
    url: String(extracted.url || clip.url || '').trim(),
    title,
    author: String(extracted.author || clip.author || '').trim(),
    published_at: extracted.published_at ?? clip.published_at ?? null,
    content_markdown: markdown,
    content_text: contentText,
  };
}

/** `StoredMedia` rows -> `replaceMedia` inputs (index doubles as sort order). */
export function buildMediaInputs(stored: readonly StoredMedia[]): MediaInput[] {
  return stored.map((item, index) => ({
    id: item.id,
    original_url: item.original_url,
    local_path: item.local_path,
    mime_type: item.mime_type,
    size_bytes: item.size_bytes,
    sha256: item.sha256,
    sort_order: index,
  }));
}

/** AI runs only when configured *and* there is something to summarise. */
export function shouldRunLocalAi(
  config: LocalAiConfig,
  title: string | null | undefined,
  contentText: string | null | undefined,
): boolean {
  if (!isLocalAiConfigured(config)) return false;
  return Boolean(String(title ?? '').trim() || String(contentText ?? '').trim());
}

/**
 * Merge an LLM enrichment into clip fields.
 *
 * Existing tags come first so the user's spelling wins; a partial/empty payload
 * degrades to `ai_status = 'skipped'` instead of wiping the body.
 */
export function buildAiUpdates(
  enrichment: LocalAiEnrichment | null | undefined,
  existingTags: readonly string[] = [],
): ClipUpdateFields {
  if (!enrichment) return { ai_status: 'skipped' };

  const summary = String(enrichment.summary ?? '').trim();
  const keyPoints = (Array.isArray(enrichment.key_points) ? enrichment.key_points : [])
    .map((point) => String(point ?? '').trim())
    .filter(Boolean)
    .slice(0, INGEST_MAX_KEY_POINTS);
  const aiTags = Array.isArray(enrichment.tags) ? enrichment.tags : [];

  if (!summary && keyPoints.length === 0 && aiTags.length === 0) {
    return { ai_status: 'skipped' };
  }

  const updates: ClipUpdateFields = { ai_status: 'done' };
  if (summary) updates.summary = summary;
  if (keyPoints.length) updates.key_points = keyPoints;
  if (aiTags.length) updates.tags = mergeTags(existingTags, aiTags);
  return updates;
}

/** Human readable `error_message` for a failed run (never empty). */
export function describeIngestError(error: unknown, limit = MAX_ERROR_MESSAGE_CHARS): string {
  const message =
    error instanceof Error
      ? String(error.message || error.name || '').trim()
      : String(error ?? '').trim();
  const label = message ? `抓取失败: ${message}` : '抓取失败: 未知错误';
  return label.slice(0, Math.max(1, Math.floor(limit)));
}

/**
 * Run `worker` over `items` with a bounded number of concurrent jobs.
 *
 * Items are claimed in order; a single rejected item is swallowed so a bulk
 * background run keeps going (the per-clip pipeline never throws anyway).
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = Array.from(items ?? []);
  if (!queue.length) return;

  const requested = Math.floor(Number(concurrency));
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, queue.length));
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor;
      if (index >= queue.length) return;
      cursor += 1;
      try {
        await worker(queue[index], index);
      } catch {
        // Bulk runner: one bad clip must not strand the rest.
      }
    }
  });

  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// SQLite module (lazy: keeps this file importable in Node unit tests)
// ---------------------------------------------------------------------------

type DbModule = typeof import('./db');

let cachedDb: DbModule | null = null;

function localDb(): DbModule {
  if (!cachedDb) {
    cachedDb = require('./db') as DbModule;
  }
  return cachedDb;
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<void>>();

function createEmitter(onChange?: () => void): () => void {
  return () => {
    notifyLocalChange();
    if (typeof onChange !== 'function') return;
    try {
      onChange();
    } catch {
      // UI callbacks are fire-and-forget; a throw must not break the pipeline.
    }
  };
}

async function userTookOver(db: DbModule, clipId: string): Promise<boolean> {
  return shouldAbortIngest(await db.getClipDetail(clipId));
}

async function storeExtractedMedia(
  db: DbModule,
  clipId: string,
  extracted: ExtractedContent,
  fields: IngestFields,
  emit: () => void,
): Promise<void> {
  const imageUrls = Array.isArray(extracted.image_urls) ? extracted.image_urls : [];
  if (imageUrls.length === 0) return;

  try {
    const stored = await downloadAndStoreImages(imageUrls, {
      clipId,
      referer: extracted.referer || extracted.url || '',
    });
    if (stored.length === 0) return;

    const rewritten = rewriteMarkdownImages(fields.content_markdown, stored);
    if (rewritten) fields.content_markdown = rewritten;
    if (!fields.content_text.trim()) {
      fields.content_text = markdownToText(fields.content_markdown);
    }

    const media = await db.replaceMedia(clipId, buildMediaInputs(stored));
    fields.cover_media_id = media.length > 0 ? media[0].id : null;
    emit();
  } catch {
    // Media is optional: a broken download must never abort an otherwise good clip.
  }
}

async function enrichFieldsWithAi(
  db: DbModule,
  clip: ClipDetail,
  fields: IngestFields,
  aiConfig: LocalAiConfig,
): Promise<ClipUpdateFields> {
  if (!isLocalAiConfigured(aiConfig)) return { ai_status: 'skipped' };
  if (!String(fields.title ?? '').trim() && !String(fields.content_text ?? '').trim()) {
    return { ai_status: 'skipped' };
  }

  const existingTags = Array.isArray(clip.tags) ? clip.tags : [];

  try {
    let promptTags: string[] = existingTags;
    try {
      const library = await db.listTags();
      promptTags = mergeTags(existingTags, library.tags.map((tag) => tag.name));
    } catch {
      promptTags = existingTags;
    }

    const enrichment = await enrichClipLocally(
      fields.title,
      fields.content_text,
      promptTags,
      aiConfig,
    );
    return buildAiUpdates(enrichment, existingTags);
  } catch {
    // AI is strictly best effort: keep the extracted body, flag the summary.
    return { ai_status: 'failed' };
  }
}

async function markIngestFailed(
  clipId: string,
  error: unknown,
  onChange?: () => void,
): Promise<void> {
  const emit = createEmitter(onChange);
  try {
    const db = localDb();
    if (await userTookOver(db, clipId)) return;
    await db.updateClip(
      clipId,
      { status: 'failed', error_message: describeIngestError(error), ai_status: 'skipped' },
      { markDirty: true },
    );
    emit();
  } catch {
    // Nothing left to update: the original raw clip row is already persisted.
  }
}

async function runIngest(
  clipId: string,
  aiConfig: LocalAiConfig,
  onChange?: () => void,
): Promise<void> {
  const db = localDb();
  const emit = createEmitter(onChange);

  try {
    const initial = await db.getClipDetail(clipId);
    if (shouldAbortIngest(initial)) return;

    const started = await db.updateClip(
      clipId,
      { status: 'processing', error_message: null },
      { markDirty: true },
    );
    if (!started) return;
    emit();

    const extracted = await extractContent(started.url, started.raw_input);
    if (await userTookOver(db, clipId)) return;

    const fields = buildIngestFields(extracted, {
      url: started.url,
      platform: started.platform,
      title: started.title,
      author: started.author,
      published_at: started.published_at,
    });

    await storeExtractedMedia(db, clipId, extracted, fields, emit);
    if (await userTookOver(db, clipId)) return;

    Object.assign(fields, await enrichFieldsWithAi(db, started, fields, aiConfig));

    if (await userTookOver(db, clipId)) return;
    const saved = await db.updateClip(clipId, fields, { markDirty: true });
    if (!saved) return;
    emit();
  } catch (error) {
    await markIngestFailed(clipId, error, onChange);
  }
}

/**
 * Run the full local ingestion pipeline for `clipId`.
 *
 * Concurrent calls for the same clip share one in-flight run (so a double tap
 * or a resume sweep cannot process a clip twice). Resolves — never rejects —
 * and every persisted step notifies `subscribeLocalChanges` plus `onChange`.
 */
export function processClipLocally(
  clipId: string,
  aiConfig: LocalAiConfig,
  onChange?: () => void,
): Promise<void> {
  const id = String(clipId ?? '').trim();
  if (!id) return Promise.resolve();

  const running = inFlight.get(id);
  if (running) return running;

  const task = runIngest(id, aiConfig, onChange)
    .catch(() => {
      // Final safety net: runIngest already degrades to `failed`.
    })
    .finally(() => {
      if (inFlight.get(id) === task) inFlight.delete(id);
    });

  inFlight.set(id, task);
  return task;
}

/**
 * Re-run every clip that was interrupted mid-ingest (app killed / reboot).
 *
 * Returns how many clip ids were attempted.
 */
export async function resumePendingClips(
  aiConfig: LocalAiConfig,
  onChange?: () => void,
): Promise<number> {
  let ids: string[] = [];
  try {
    ids = await localDb().listPendingIngestClipIds();
  } catch {
    return 0;
  }
  if (!ids.length) return 0;

  await runWithConcurrency(ids, INGEST_RESUME_CONCURRENCY, async (id) => {
    await processClipLocally(id, aiConfig, onChange);
  });
  return ids.length;
}
