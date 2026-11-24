/**
 * Local-first SQLite storage for 剪藏.
 *
 * The schema mirrors ``backend/app/db.py`` one-to-one and adds the columns the
 * mobile client needs for two-way sync:
 *
 * - ``clips.sync_dirty`` / ``clips.server_sync_version``
 * - ``media.sync_uploaded``
 * - ``review_logs.sync_uploaded``
 * - ``sync_state`` key/value store
 *
 * Search uses FTS5 with the trigram tokenizer when the device SQLite build
 * supports it. Otherwise every operation silently degrades to ``LIKE`` search;
 * opening the database must never fail because of an optional tokenizer.
 */

import * as FileSystem from 'expo-file-system';
import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';

import type {
  AIStatus,
  ClipDetail,
  ClipListQuery,
  ClipListResponse,
  ClipStatus,
  ClipSummary,
  MediaItem,
  Platform,
  ReviewActionType,
  ReviewState,
  SyncClipPayload,
  SyncClipRecord,
  SyncMediaPayload,
  SyncReviewLogPayload,
  TagListResponse,
} from '../types';
import { normalizeTag, normalizeTags, nowIso, toIsoUtc } from './reviewLogic';

export const LOCAL_DB_NAME = 'jiancang.db';

const SCHEMA_VERSION = 1;
const ACTIVE_DECK_SQL = "c.review_state = 'active' AND c.status IN ('ready', 'partial')";
const MAX_LIST_LIMIT = 100;
const ID_CHARS = '0123456789abcdef';

const PLATFORMS: readonly Platform[] = ['wechat', 'x', 'xiaohongshu', 'web'];
const CLIP_STATUSES: readonly ClipStatus[] = ['pending', 'processing', 'ready', 'partial', 'failed'];
const AI_STATUSES: readonly AIStatus[] = ['pending', 'done', 'skipped', 'failed'];
const REVIEW_STATES: readonly ReviewState[] = ['active', 'archived', 'deleted'];
const REVIEW_ACTIONS: readonly ReviewActionType[] = ['snooze', 'archive', 'delete'];

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    raw_input TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    normalized_url TEXT,
    platform TEXT NOT NULL DEFAULT 'web',
    status TEXT NOT NULL DEFAULT 'pending',
    ai_status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    content_markdown TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    cover_media_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    key_points_json TEXT NOT NULL DEFAULT '[]',
    user_note TEXT NOT NULL DEFAULT '',
    review_state TEXT NOT NULL DEFAULT 'active',
    review_count INTEGER NOT NULL DEFAULT 0,
    review_interval_days INTEGER NOT NULL DEFAULT 0,
    next_review_at TEXT,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sync_dirty INTEGER NOT NULL DEFAULT 1,
    server_sync_version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_clips_normalized_url ON clips(normalized_url);
CREATE INDEX IF NOT EXISTS idx_clips_review ON clips(review_state, status, next_review_at);
CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at);
CREATE INDEX IF NOT EXISTS idx_clips_dirty ON clips(sync_dirty);

CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    original_url TEXT NOT NULL DEFAULT '',
    local_path TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    sync_uploaded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_media_clip ON media(clip_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_media_pending ON media(sync_uploaded);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS clip_tags (
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (clip_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_clip_tags_tag ON clip_tags(tag_id);

CREATE TABLE IF NOT EXISTS review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    sync_uploaded INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_logs_dedupe
    ON review_logs(clip_id, action, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_review_logs_time ON review_logs(reviewed_at);
CREATE INDEX IF NOT EXISTS idx_review_logs_pending ON review_logs(sync_uploaded);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(
    clip_id UNINDEXED,
    title,
    summary,
    content_text,
    user_note,
    author,
    tags_text,
    tokenize='trigram'
);
`;

// ---------------------------------------------------------------------------
// public input types
// ---------------------------------------------------------------------------

export interface CreateClipInput {
  id?: string;
  clip_id?: string;
  raw_input?: string;
  url?: string;
  normalized_url?: string | null;
  platform?: Platform;
  status?: ClipStatus;
  ai_status?: AIStatus;
  error_message?: string | null;
  title?: string;
  author?: string;
  published_at?: string | null;
  content_markdown?: string;
  content_text?: string;
  cover_media_id?: string | null;
  summary?: string;
  key_points?: string[];
  user_note?: string;
  review_state?: ReviewState;
  review_count?: number;
  review_interval_days?: number;
  next_review_at?: string | null;
  last_reviewed_at?: string | null;
  tags?: string[];
  sync_dirty?: boolean | number;
  server_sync_version?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ClipUpdateFields {
  raw_input?: string;
  url?: string;
  normalized_url?: string | null;
  platform?: Platform;
  status?: ClipStatus;
  ai_status?: AIStatus;
  error_message?: string | null;
  title?: string;
  author?: string;
  published_at?: string | null;
  content_markdown?: string;
  content_text?: string;
  cover_media_id?: string | null;
  summary?: string;
  key_points?: string[];
  user_note?: string;
  review_state?: ReviewState;
  review_count?: number;
  review_interval_days?: number;
  next_review_at?: string | null;
  last_reviewed_at?: string | null;
  tags?: string[];
}

export interface UpdateClipOptions {
  /** Mark the row dirty for the next push. Defaults to true for local edits. */
  markDirty?: boolean;
  /** Override the `updated_at` stamp (useful for deterministic tests/sync). */
  updatedAt?: string;
}

export interface MediaInput {
  id?: string;
  original_url?: string;
  local_path?: string;
  mime_type?: string;
  size_bytes?: number;
  sha256?: string;
  sort_order?: number;
  created_at?: string;
  sync_uploaded?: boolean | number;
}

export interface LocalMediaRecord {
  id: string;
  clip_id: string;
  original_url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  sort_order: number;
  created_at: string;
  sync_uploaded: number;
}

export interface PendingReviewLog extends SyncReviewLogPayload {
  id: number;
}

// ---------------------------------------------------------------------------
// internal row types
// ---------------------------------------------------------------------------

interface ClipRow {
  id: string;
  raw_input: string;
  url: string;
  normalized_url: string | null;
  platform: string;
  status: string;
  ai_status: string;
  error_message: string | null;
  title: string;
  author: string;
  published_at: string | null;
  content_markdown: string;
  content_text: string;
  cover_media_id: string | null;
  summary: string;
  key_points_json: string;
  user_note: string;
  review_state: string;
  review_count: number;
  review_interval_days: number;
  next_review_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  sync_dirty: number;
  server_sync_version: number;
}

interface MediaRow {
  id: string;
  clip_id: string;
  original_url: string;
  local_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  sort_order: number;
  created_at: string;
  sync_uploaded: number;
}

interface ReviewLogRow {
  id: number;
  clip_id: string;
  action: string;
  reviewed_at: string;
  sync_uploaded: number;
}

const CLIP_COLUMNS: readonly (keyof ClipRow)[] = [
  'id',
  'raw_input',
  'url',
  'normalized_url',
  'platform',
  'status',
  'ai_status',
  'error_message',
  'title',
  'author',
  'published_at',
  'content_markdown',
  'content_text',
  'cover_media_id',
  'summary',
  'key_points_json',
  'user_note',
  'review_state',
  'review_count',
  'review_interval_days',
  'next_review_at',
  'last_reviewed_at',
  'created_at',
  'updated_at',
  'sync_dirty',
  'server_sync_version',
];

const MEDIA_COLUMNS: readonly (keyof MediaRow)[] = [
  'id',
  'clip_id',
  'original_url',
  'local_path',
  'mime_type',
  'size_bytes',
  'sha256',
  'sort_order',
  'created_at',
  'sync_uploaded',
];

// ---------------------------------------------------------------------------
// singleton + migrations
// ---------------------------------------------------------------------------

let dbPromise: Promise<SQLiteDatabase> | null = null;
let ftsAvailable = false;

/**
 * Open and migrate the singleton database.
 *
 * The initialization promise is cached so concurrent callers cannot race the
 * migrations or open two connections.
 */
export function getLocalDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const database = await openDatabaseAsync(LOCAL_DB_NAME);
      try {
        await initializeDatabase(database);
      } catch (error) {
        try {
          await database.closeAsync();
        } catch {
          // The open/migration failure below is the one worth surfacing.
        }
        throw error;
      }
      return database;
    })().catch((error) => {
      dbPromise = null;
      ftsAvailable = false;
      throw error;
    });
  }
  return dbPromise;
}

/** Close the singleton (mainly useful when the app resets local data). */
export async function closeLocalDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  ftsAvailable = false;
  if (!pending) return;
  try {
    const database = await pending;
    await database.closeAsync();
  } catch {
    // Closing is best effort.
  }
}

/** Whether the FTS5 trigram index is available for this database session. */
export function isFtsEnabled(): boolean {
  return ftsAvailable;
}

async function initializeDatabase(database: SQLiteDatabase): Promise<void> {
  await database.execAsync('PRAGMA journal_mode = WAL;');
  await database.execAsync('PRAGMA foreign_keys = ON;');
  await database.execAsync(BASE_SCHEMA);

  // Idempotent migrations for databases created by an older local build.
  await ensureColumn(database, 'clips', 'sync_dirty', 'sync_dirty INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(
    database,
    'clips',
    'server_sync_version',
    'server_sync_version INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(database, 'media', 'sync_uploaded', 'sync_uploaded INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(
    database,
    'review_logs',
    'sync_uploaded',
    'sync_uploaded INTEGER NOT NULL DEFAULT 0',
  );

  await initializeFts(database);
  await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

async function ensureColumn(
  database: SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const rows = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (rows.some((row) => row.name === column)) return;
  await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
}

async function initializeFts(database: SQLiteDatabase): Promise<void> {
  try {
    await database.execAsync(FTS_SCHEMA);
    await database.getFirstAsync<{ clip_id: string }>('SELECT clip_id FROM clips_fts LIMIT 1', []);
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
    return;
  }

  try {
    const clips = await scalarNumber(database, 'SELECT COUNT(*) AS value FROM clips');
    const indexed = await scalarNumber(database, 'SELECT COUNT(*) AS value FROM clips_fts');
    if (clips !== indexed) {
      await reindexFts(database);
    }
  } catch {
    ftsAvailable = false;
  }
}

async function reindexFts(database: SQLiteDatabase): Promise<void> {
  await database.execAsync('DELETE FROM clips_fts;');
  const rows = await database.getAllAsync<{ id: string }>('SELECT id FROM clips', []);
  for (const row of rows) {
    await syncClipFts(database, row.id);
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function generateId(): string {
  let id = '';
  for (let index = 0; index < 32; index += 1) {
    id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return id;
}

function asString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value : String(value);
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = asString(value);
  return text.length ? text : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter((item) => item.length > 0);
}

function parseJsonList(value: unknown): string[] {
  if (Array.isArray(value)) return asStringArray(value);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return asStringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function canonicalOr(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    try {
      return toIsoUtc(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function canonicalNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return toIsoUtc(value);
  } catch {
    return null;
  }
}

function asPlatform(value: unknown): Platform {
  return PLATFORMS.includes(value as Platform) ? (value as Platform) : 'web';
}

function asClipStatus(value: unknown): ClipStatus {
  return CLIP_STATUSES.includes(value as ClipStatus) ? (value as ClipStatus) : 'pending';
}

function asAiStatus(value: unknown): AIStatus {
  return AI_STATUSES.includes(value as AIStatus) ? (value as AIStatus) : 'pending';
}

function asReviewState(value: unknown): ReviewState {
  return REVIEW_STATES.includes(value as ReviewState) ? (value as ReviewState) : 'active';
}

function asReviewAction(value: unknown): ReviewActionType | null {
  return REVIEW_ACTIONS.includes(value as ReviewActionType)
    ? (value as ReviewActionType)
    : null;
}

function asSyncFlag(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return asNumber(value, fallback) ? 1 : 0;
}

function normalizeLimit(limit: unknown, fallback = 20): number {
  const numeric = asNumber(limit, fallback);
  return Math.max(1, Math.min(numeric, MAX_LIST_LIMIT));
}

function normalizeOffset(offset: unknown): number {
  return Math.max(0, asNumber(offset, 0));
}

function mediaFileUrl(row: MediaRow): string {
  const localPath = asString(row.local_path);
  if (localPath.startsWith('file://')) return localPath;
  return `/api/media/${row.id}`;
}

function coverUrl(coverMediaId: string | null, localPath: string | null | undefined): string | null {
  if (!coverMediaId) return null;
  const path = asString(localPath);
  return path.startsWith('file://') ? path : `/api/media/${coverMediaId}`;
}

async function scalarNumber(
  database: SQLiteDatabase,
  sql: string,
  params: readonly SQLiteBindValue[] = [],
): Promise<number> {
  const row = await database.getFirstAsync<{ value: number | null }>(sql, [...params]);
  return asNumber(row?.value, 0);
}

async function localFileExists(localPath: string): Promise<boolean> {
  if (!asString(localPath).startsWith('file://')) return false;
  try {
    const info = await FileSystem.getInfoAsync(localPath);
    return Boolean(info?.exists);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// row -> API mapping
// ---------------------------------------------------------------------------

function rowToMediaItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    clip_id: row.clip_id,
    original_url: asString(row.original_url),
    url: mediaFileUrl(row),
    mime_type: asString(row.mime_type),
    size_bytes: asNumber(row.size_bytes),
    sort_order: asNumber(row.sort_order),
  };
}

function rowToLocalMedia(row: MediaRow): LocalMediaRecord {
  return {
    id: row.id,
    clip_id: row.clip_id,
    original_url: asString(row.original_url),
    local_path: asString(row.local_path),
    mime_type: asString(row.mime_type),
    size_bytes: asNumber(row.size_bytes),
    sha256: asString(row.sha256),
    sort_order: asNumber(row.sort_order),
    created_at: asString(row.created_at),
    sync_uploaded: asNumber(row.sync_uploaded),
  };
}

function rowToSummary(
  row: ClipRow,
  tags: readonly string[],
  coverLocalPath?: string | null,
): ClipSummary {
  return {
    id: row.id,
    url: asString(row.url),
    platform: asPlatform(row.platform),
    status: asClipStatus(row.status),
    ai_status: asAiStatus(row.ai_status),
    error_message: row.error_message ?? null,
    title: asString(row.title),
    author: asString(row.author),
    summary: asString(row.summary),
    cover_media_url: coverUrl(row.cover_media_id, coverLocalPath),
    tags: [...tags],
    review_state: asReviewState(row.review_state),
    review_count: asNumber(row.review_count),
    next_review_at: row.next_review_at ?? null,
    last_reviewed_at: row.last_reviewed_at ?? null,
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  };
}

function rowToDetail(
  row: ClipRow,
  tags: readonly string[],
  media: readonly MediaRow[],
  coverLocalPath?: string | null,
): ClipDetail {
  return {
    ...rowToSummary(row, tags, coverLocalPath),
    raw_input: asString(row.raw_input),
    published_at: row.published_at ?? null,
    content_markdown: asString(row.content_markdown),
    key_points: parseJsonList(row.key_points_json),
    user_note: asString(row.user_note),
    media: media.map(rowToMediaItem),
  };
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

async function getClipTags(database: SQLiteDatabase, clipId: string): Promise<string[]> {
  const rows = await database.getAllAsync<{ name: string }>(
    'SELECT t.name AS name FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id '
      + 'WHERE ct.clip_id = ? ORDER BY t.name COLLATE NOCASE ASC',
    [clipId],
  );
  return rows.map((row) => row.name);
}

async function getTagsMap(
  database: SQLiteDatabase,
  clipIds: readonly string[],
): Promise<Map<string, string[]>> {
  const mapping = new Map<string, string[]>();
  for (const clipId of clipIds) mapping.set(clipId, []);
  if (clipIds.length === 0) return mapping;

  for (let start = 0; start < clipIds.length; start += 500) {
    const chunk = clipIds.slice(start, start + 500);
    const rows = await database.getAllAsync<{ clip_id: string; name: string }>(
      `SELECT ct.clip_id AS clip_id, t.name AS name `
        + `FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id `
        + `WHERE ct.clip_id IN (${placeholders(chunk.length)}) `
        + `ORDER BY t.name COLLATE NOCASE ASC`,
      chunk,
    );
    for (const row of rows) {
      const list = mapping.get(row.clip_id);
      if (list) list.push(row.name);
      else mapping.set(row.clip_id, [row.name]);
    }
  }
  return mapping;
}

async function addClipTagsInternal(
  database: SQLiteDatabase,
  clipId: string,
  tags: Iterable<string>,
): Promise<string[]> {
  const names = normalizeTags(tags);
  for (const name of names) {
    const existing = await database.getFirstAsync<{ id: number }>(
      'SELECT id FROM tags WHERE name = ? COLLATE NOCASE',
      [name],
    );
    let tagId = existing ? asNumber(existing.id) : 0;
    if (!tagId) {
      const result = await database.runAsync('INSERT INTO tags (name) VALUES (?)', [name]);
      tagId = asNumber(result.lastInsertRowId);
    }
    if (tagId) {
      await database.runAsync(
        'INSERT OR IGNORE INTO clip_tags (clip_id, tag_id) VALUES (?, ?)',
        [clipId, tagId],
      );
    }
  }
  return getClipTags(database, clipId);
}

async function setClipTagsInternal(
  database: SQLiteDatabase,
  clipId: string,
  tags: Iterable<string>,
): Promise<string[]> {
  const names = normalizeTags(tags);
  await database.runAsync('DELETE FROM clip_tags WHERE clip_id = ?', [clipId]);
  if (names.length === 0) return [];
  return addClipTagsInternal(database, clipId, names);
}

async function touchClip(database: SQLiteDatabase, clipId: string): Promise<void> {
  await database.runAsync(
    'UPDATE clips SET sync_dirty = 1, updated_at = ? WHERE id = ?',
    [nowIso(), clipId],
  );
}

/** Replace all tags for a clip, marking it dirty for the next sync. */
export async function setClipTags(clipId: string, tags: readonly string[]): Promise<string[]> {
  const database = await getLocalDb();
  const names = await setClipTagsInternal(database, clipId, tags);
  await touchClip(database, clipId);
  await syncClipFts(database, clipId);
  return names;
}

/** Add tags to a clip without removing the existing ones. */
export async function addClipTags(clipId: string, tags: readonly string[]): Promise<string[]> {
  const database = await getLocalDb();
  const names = await addClipTagsInternal(database, clipId, tags);
  await touchClip(database, clipId);
  await syncClipFts(database, clipId);
  return names;
}

export async function listClipTags(clipId: string): Promise<string[]> {
  const database = await getLocalDb();
  return getClipTags(database, clipId);
}

// ---------------------------------------------------------------------------
// FTS
// ---------------------------------------------------------------------------

function ftsPhrase(term: string): string {
  const cleaned = term.trim().split(/\s+/).filter(Boolean).join(' ');
  return `"${cleaned.replace(/"/g, '""')}"`;
}

async function syncClipFts(database: SQLiteDatabase, clipId: string): Promise<void> {
  if (!ftsAvailable) return;
  try {
    await database.runAsync('DELETE FROM clips_fts WHERE clip_id = ?', [clipId]);
    const row = await database.getFirstAsync<ClipRow>('SELECT * FROM clips WHERE id = ?', [clipId]);
    if (!row) return;
    const tagsText = (await getClipTags(database, clipId)).join(' ');
    await database.runAsync(
      'INSERT INTO clips_fts (clip_id, title, summary, content_text, user_note, author, tags_text) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        clipId,
        asString(row.title),
        asString(row.summary),
        asString(row.content_text),
        asString(row.user_note),
        asString(row.author),
        tagsText,
      ],
    );
  } catch {
    // A missing/unsupported FTS table must never break writes.
    ftsAvailable = false;
  }
}

// ---------------------------------------------------------------------------
// hydration helpers
// ---------------------------------------------------------------------------

async function getCoverPaths(
  database: SQLiteDatabase,
  mediaIds: readonly string[],
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  if (mediaIds.length === 0) return mapping;
  for (let start = 0; start < mediaIds.length; start += 500) {
    const chunk = mediaIds.slice(start, start + 500);
    const rows = await database.getAllAsync<{ id: string; local_path: string }>(
      `SELECT id, local_path FROM media WHERE id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) mapping.set(row.id, asString(row.local_path));
  }
  return mapping;
}

async function getAllMediaRows(
  database: SQLiteDatabase,
  clipId: string,
): Promise<MediaRow[]> {
  return database.getAllAsync<MediaRow>(
    'SELECT * FROM media WHERE clip_id = ? ORDER BY sort_order ASC, id ASC',
    [clipId],
  );
}

async function getMediaRowsMap(
  database: SQLiteDatabase,
  clipIds: readonly string[],
): Promise<Map<string, MediaRow[]>> {
  const mapping = new Map<string, MediaRow[]>();
  for (const clipId of clipIds) mapping.set(clipId, []);
  if (clipIds.length === 0) return mapping;

  for (let start = 0; start < clipIds.length; start += 500) {
    const chunk = clipIds.slice(start, start + 500);
    const rows = await database.getAllAsync<MediaRow>(
      `SELECT * FROM media WHERE clip_id IN (${placeholders(chunk.length)}) `
        + 'ORDER BY clip_id ASC, sort_order ASC, id ASC',
      chunk,
    );
    for (const row of rows) {
      const list = mapping.get(row.clip_id);
      if (list) list.push(row);
      else mapping.set(row.clip_id, [row]);
    }
  }
  return mapping;
}

async function rowsToSummaries(
  database: SQLiteDatabase,
  rows: readonly ClipRow[],
): Promise<ClipSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const coverIds = rows
    .map((row) => row.cover_media_id)
    .filter((value): value is string => Boolean(value));
  const [tagsMap, coverMap] = await Promise.all([
    getTagsMap(database, ids),
    getCoverPaths(database, coverIds),
  ]);
  return rows.map((row) =>
    rowToSummary(
      row,
      tagsMap.get(row.id) ?? [],
      row.cover_media_id ? coverMap.get(row.cover_media_id) : null,
    ),
  );
}

async function rowsToDetails(
  database: SQLiteDatabase,
  rows: readonly ClipRow[],
): Promise<ClipDetail[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const coverIds = rows
    .map((row) => row.cover_media_id)
    .filter((value): value is string => Boolean(value));
  const [tagsMap, coverMap, mediaMap] = await Promise.all([
    getTagsMap(database, ids),
    getCoverPaths(database, coverIds),
    getMediaRowsMap(database, ids),
  ]);
  return rows.map((row) =>
    rowToDetail(
      row,
      tagsMap.get(row.id) ?? [],
      mediaMap.get(row.id) ?? [],
      row.cover_media_id ? coverMap.get(row.cover_media_id) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// clips: write
// ---------------------------------------------------------------------------

/** Create a local clip (dirty by default so the next sync pushes it). */
export async function createClip(input: CreateClipInput = {}): Promise<ClipDetail> {
  const database = await getLocalDb();
  const raw = input as Record<string, unknown>;
  const read = (snake: string, camel: string): unknown =>
    raw[snake] !== undefined ? raw[snake] : raw[camel];

  const stamp = canonicalOr(read('created_at', 'createdAt'), nowIso());
  const updatedAt = canonicalOr(read('updated_at', 'updatedAt'), stamp);
  const id = asString(read('clip_id', 'id')) || generateId();

  const values: ClipRow = {
    id,
    raw_input: asString(read('raw_input', 'rawInput')),
    url: asString(read('url', 'url')),
    normalized_url: asNullableString(read('normalized_url', 'normalizedUrl')),
    platform: asPlatform(read('platform', 'platform')),
    status: asClipStatus(read('status', 'status')),
    ai_status: asAiStatus(read('ai_status', 'aiStatus')),
    error_message: asNullableString(read('error_message', 'errorMessage')),
    title: asString(read('title', 'title')),
    author: asString(read('author', 'author')),
    published_at: canonicalNullable(read('published_at', 'publishedAt')),
    content_markdown: asString(read('content_markdown', 'contentMarkdown')),
    content_text: asString(read('content_text', 'contentText')),
    cover_media_id: asNullableString(read('cover_media_id', 'coverMediaId')),
    summary: asString(read('summary', 'summary')),
    key_points_json: JSON.stringify(asStringArray(read('key_points', 'keyPoints'))),
    user_note: asString(read('user_note', 'userNote')),
    review_state: asReviewState(read('review_state', 'reviewState')),
    review_count: asNumber(read('review_count', 'reviewCount')),
    review_interval_days: asNumber(read('review_interval_days', 'reviewIntervalDays')),
    next_review_at: canonicalNullable(read('next_review_at', 'nextReviewAt')),
    last_reviewed_at: canonicalNullable(read('last_reviewed_at', 'lastReviewedAt')),
    created_at: stamp,
    updated_at: updatedAt,
    sync_dirty: asSyncFlag(read('sync_dirty', 'syncDirty'), 1),
    server_sync_version: asNumber(read('server_sync_version', 'serverSyncVersion')),
  };

  await database.runAsync(
    `INSERT INTO clips (${CLIP_COLUMNS.join(', ')}) VALUES (${placeholders(CLIP_COLUMNS.length)})`,
    CLIP_COLUMNS.map((column) => values[column]),
  );

  const tags = asStringArray(raw.tags);
  if (tags.length) await addClipTagsInternal(database, id, tags);
  await syncClipFts(database, id);

  const detail = await getClipDetail(id);
  if (!detail) throw new Error(`Failed to read back newly created clip ${id}`);
  return detail;
}

/** Patch a local clip. Returns the updated detail or null when missing. */
export async function updateClip(
  clipId: string,
  fields: ClipUpdateFields,
  options: UpdateClipOptions = {},
): Promise<ClipDetail | null> {
  const database = await getLocalDb();
  const source = fields as Record<string, unknown>;

  const aliasColumns: Record<string, string> = {
    raw_input: 'raw_input',
    rawInput: 'raw_input',
    url: 'url',
    normalized_url: 'normalized_url',
    normalizedUrl: 'normalized_url',
    platform: 'platform',
    status: 'status',
    ai_status: 'ai_status',
    aiStatus: 'ai_status',
    error_message: 'error_message',
    errorMessage: 'error_message',
    title: 'title',
    author: 'author',
    published_at: 'published_at',
    publishedAt: 'published_at',
    content_markdown: 'content_markdown',
    contentMarkdown: 'content_markdown',
    content_text: 'content_text',
    contentText: 'content_text',
    cover_media_id: 'cover_media_id',
    coverMediaId: 'cover_media_id',
    summary: 'summary',
    key_points: 'key_points_json',
    keyPoints: 'key_points_json',
    key_points_json: 'key_points_json',
    user_note: 'user_note',
    userNote: 'user_note',
    review_state: 'review_state',
    reviewState: 'review_state',
    review_count: 'review_count',
    reviewCount: 'review_count',
    review_interval_days: 'review_interval_days',
    reviewIntervalDays: 'review_interval_days',
    next_review_at: 'next_review_at',
    nextReviewAt: 'next_review_at',
    last_reviewed_at: 'last_reviewed_at',
    lastReviewedAt: 'last_reviewed_at',
  };

  const assignments = new Map<string, SQLiteBindValue>();
  let hasTags = false;
  let tags: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === 'tags') {
      hasTags = true;
      tags = asStringArray(value);
      continue;
    }
    const column = aliasColumns[key];
    if (!column) continue;

    if (column === 'key_points_json') {
      assignments.set(column, JSON.stringify(asStringArray(value)));
    } else if (column === 'review_count' || column === 'review_interval_days') {
      assignments.set(column, asNumber(value));
    } else if (
      column === 'next_review_at'
      || column === 'last_reviewed_at'
      || column === 'published_at'
    ) {
      assignments.set(column, canonicalNullable(value));
    } else if (
      column === 'normalized_url'
      || column === 'error_message'
      || column === 'cover_media_id'
    ) {
      assignments.set(column, value === null ? null : asString(value));
    } else if (column === 'platform') {
      assignments.set(column, asPlatform(value));
    } else if (column === 'status') {
      assignments.set(column, asClipStatus(value));
    } else if (column === 'ai_status') {
      assignments.set(column, asAiStatus(value));
    } else if (column === 'review_state') {
      assignments.set(column, asReviewState(value));
    } else {
      assignments.set(column, asString(value));
    }
  }

  const hasFields = assignments.size > 0 || hasTags;
  if (!hasFields && options.markDirty !== true && options.updatedAt === undefined) {
    return getClipDetail(clipId);
  }

  const stamp = canonicalOr(options.updatedAt, nowIso());
  const clauses = [...assignments.keys()].map((column) => `${column} = ?`);
  const params: SQLiteBindValue[] = [...assignments.values()];
  clauses.push('updated_at = ?');
  params.push(stamp);
  if (options.markDirty === true) {
    clauses.push('sync_dirty = 1');
  }
  params.push(clipId);

  const result = await database.runAsync(
    `UPDATE clips SET ${clauses.join(', ')} WHERE id = ?`,
    params,
  );
  if (result.changes === 0) return null;

  if (hasTags) await setClipTagsInternal(database, clipId, tags);
  await syncClipFts(database, clipId);
  return getClipDetail(clipId);
}

/**
 * Soft-delete a clip (tombstone) or permanently remove every local row.
 * Returns true when a clip row was affected.
 */
export async function deleteClip(clipId: string, permanent = false): Promise<boolean> {
  const database = await getLocalDb();

  if (!permanent) {
    const result = await database.runAsync(
      "UPDATE clips SET review_state = 'deleted', sync_dirty = 1, updated_at = ? WHERE id = ?",
      [nowIso(), clipId],
    );
    return result.changes > 0;
  }

  if (ftsAvailable) {
    try {
      await database.runAsync('DELETE FROM clips_fts WHERE clip_id = ?', [clipId]);
    } catch {
      ftsAvailable = false;
    }
  }
  await database.runAsync('DELETE FROM review_logs WHERE clip_id = ?', [clipId]);
  await database.runAsync('DELETE FROM clip_tags WHERE clip_id = ?', [clipId]);
  await database.runAsync('DELETE FROM media WHERE clip_id = ?', [clipId]);
  const result = await database.runAsync('DELETE FROM clips WHERE id = ?', [clipId]);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// clips: read / search
// ---------------------------------------------------------------------------

export async function getClip(clipId: string): Promise<ClipSummary | null> {
  const database = await getLocalDb();
  const row = await database.getFirstAsync<ClipRow>('SELECT * FROM clips WHERE id = ?', [clipId]);
  if (!row) return null;
  const [summary] = await rowsToSummaries(database, [row]);
  return summary ?? null;
}

export async function getClipDetail(clipId: string): Promise<ClipDetail | null> {
  const database = await getLocalDb();
  const row = await database.getFirstAsync<ClipRow>('SELECT * FROM clips WHERE id = ?', [clipId]);
  if (!row) return null;
  const [detail] = await rowsToDetails(database, [row]);
  return detail ?? null;
}

export async function findByNormalizedUrl(
  normalizedUrl: string | null | undefined,
): Promise<ClipSummary | null> {
  if (!normalizedUrl) return null;
  const database = await getLocalDb();
  const row = await database.getFirstAsync<ClipRow>(
    "SELECT * FROM clips WHERE normalized_url = ? AND review_state != 'deleted' "
      + 'ORDER BY created_at DESC, id DESC LIMIT 1',
    [normalizedUrl],
  );
  if (!row) return null;
  const [summary] = await rowsToSummaries(database, [row]);
  return summary ?? null;
}

function buildClipFilters(query: ClipListQuery): { where: string[]; params: SQLiteBindValue[] } {
  const where: string[] = [];
  const params: SQLiteBindValue[] = [];
  const reviewState = query.review_state as string | undefined;

  if (reviewState === undefined || reviewState === null) {
    where.push("c.review_state != 'deleted'");
  } else if (String(reviewState).toLowerCase() !== 'all') {
    where.push('c.review_state = ?');
    params.push(String(reviewState));
  }

  if (query.platform) {
    where.push('c.platform = ?');
    params.push(String(query.platform));
  }
  if (query.status) {
    where.push('c.status = ?');
    params.push(String(query.status));
  }
  if (query.tag) {
    where.push(
      'EXISTS (SELECT 1 FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id '
        + 'WHERE ct.clip_id = c.id AND t.name = ? COLLATE NOCASE)',
    );
    params.push(normalizeTag(query.tag));
  }

  return { where, params };
}

function likeClause(term: string): { sql: string; params: string[] } {
  const pattern = `%${term}%`;
  return {
    sql:
      '(c.title LIKE ? OR c.summary LIKE ? OR c.content_text LIKE ? '
      + 'OR c.user_note LIKE ? OR c.author LIKE ? '
      + 'OR EXISTS (SELECT 1 FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id '
      + 'WHERE ct.clip_id = c.id AND t.name LIKE ?))',
    params: [pattern, pattern, pattern, pattern, pattern, pattern],
  };
}

async function runClipList(
  database: SQLiteDatabase,
  where: string[],
  params: SQLiteBindValue[],
  limit: number,
  offset: number,
): Promise<{ rows: ClipRow[]; total: number }> {
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = await scalarNumber(
    database,
    `SELECT COUNT(*) AS value FROM clips c${whereSql}`,
    params,
  );
  const rows = await database.getAllAsync<ClipRow>(
    `SELECT c.* FROM clips c${whereSql} `
      + 'ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?',
    [...params, limit, offset],
  );
  return { rows, total };
}

/** List/search clips with the same filter semantics as `GET /api/clips`. */
export async function listClips(query: ClipListQuery = {}): Promise<ClipListResponse> {
  const database = await getLocalDb();
  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);
  const { where, params } = buildClipFilters(query);
  const term = (query.q ?? '').trim();

  let result: { rows: ClipRow[]; total: number };

  if (term) {
    let ftsResult: { rows: ClipRow[]; total: number } | null = null;

    // The trigram tokenizer only indexes runs of >= 3 characters; short
    // queries (e.g. "AI", "微信") must go straight to LIKE.
    if (ftsAvailable && term.length >= 3) {
      try {
        ftsResult = await runClipList(
          database,
          [
            ...where,
            'c.id IN (SELECT clip_id FROM clips_fts WHERE clips_fts MATCH ?)',
          ],
          [...params, ftsPhrase(term)],
          limit,
          offset,
        );
      } catch {
        ftsResult = null;
      }
    }

    if (ftsResult) {
      result = ftsResult;
    } else {
      const like = likeClause(term);
      result = await runClipList(
        database,
        [...where, like.sql],
        [...params, ...like.params],
        limit,
        offset,
      );
    }
  } else {
    result = await runClipList(database, where, params, limit, offset);
  }

  const items = await rowsToSummaries(database, result.rows);
  return { items, total: result.total, limit, offset };
}

export async function listTags(): Promise<TagListResponse> {
  const database = await getLocalDb();
  const rows = await database.getAllAsync<{ name: string; count: number }>(
    'SELECT t.name AS name, COUNT(ct.clip_id) AS count '
      + 'FROM tags t JOIN clip_tags ct ON ct.tag_id = t.id '
      + "JOIN clips c ON c.id = ct.clip_id WHERE c.review_state != 'deleted' "
      + 'GROUP BY t.id, t.name ORDER BY count DESC, t.name COLLATE NOCASE ASC',
    [],
  );
  return { tags: rows.map((row) => ({ name: row.name, count: asNumber(row.count) })) };
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

export async function listMedia(clipId: string): Promise<MediaItem[]> {
  const database = await getLocalDb();
  const rows = await getAllMediaRows(database, clipId);
  return rows.map(rowToMediaItem);
}

export async function listMediaRecords(clipId: string): Promise<LocalMediaRecord[]> {
  const database = await getLocalDb();
  const rows = await getAllMediaRows(database, clipId);
  return rows.map(rowToLocalMedia);
}

export async function getMedia(mediaId: string): Promise<LocalMediaRecord | null> {
  const database = await getLocalDb();
  const row = await database.getFirstAsync<MediaRow>('SELECT * FROM media WHERE id = ?', [mediaId]);
  return row ? rowToLocalMedia(row) : null;
}

async function writeMediaRows(
  database: SQLiteDatabase,
  clipId: string,
  items: readonly MediaInput[],
  markDirty: boolean,
): Promise<void> {
  const existingRows = await getAllMediaRows(database, clipId);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const existingByUrl = new Map<string, MediaRow>();
  for (const row of existingRows) {
    const url = asString(row.original_url);
    if (url && !existingByUrl.has(url)) existingByUrl.set(url, row);
  }

  const stamp = nowIso();
  const finalIds: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const raw = item as Record<string, unknown>;
    const read = (snake: string, camel: string): unknown =>
      raw[snake] !== undefined ? raw[snake] : raw[camel];

    let mediaId = asString(read('id', 'id')).trim();
    let existing = mediaId ? existingById.get(mediaId) : undefined;
    const originalUrl = asString(read('original_url', 'originalUrl'));
    if (!existing && originalUrl) existing = existingByUrl.get(originalUrl);
    if (!mediaId) mediaId = existing?.id ?? generateId();

    const hasLocalPath = read('local_path', 'localPath') !== undefined;
    const localPath = hasLocalPath
      ? asString(read('local_path', 'localPath'))
      : asString(existing?.local_path);
    const pathChanged = existing ? (hasLocalPath && localPath !== asString(existing.local_path)) : Boolean(localPath);

    const uploadedValue = read('sync_uploaded', 'syncUploaded');
    const uploaded = uploadedValue !== undefined
      ? asSyncFlag(uploadedValue, 0)
      : existing
        ? (pathChanged ? 0 : asNumber(existing.sync_uploaded))
        : 0;

    const createdAt = canonicalOr(
      read('created_at', 'createdAt'),
      asString(existing?.created_at) || stamp,
    );

    const values: MediaRow = {
      id: mediaId,
      clip_id: clipId,
      original_url: originalUrl,
      local_path: localPath,
      mime_type: asString(read('mime_type', 'mimeType')),
      size_bytes: asNumber(read('size_bytes', 'sizeBytes')),
      sha256: asString(read('sha256', 'sha256')),
      sort_order: asNumber(read('sort_order', 'sortOrder'), index),
      created_at: createdAt,
      sync_uploaded: uploaded,
    };

    await database.runAsync(
      `INSERT INTO media (${MEDIA_COLUMNS.join(', ')}) `
        + `VALUES (${placeholders(MEDIA_COLUMNS.length)}) `
        + 'ON CONFLICT(id) DO UPDATE SET '
        + 'clip_id = excluded.clip_id, original_url = excluded.original_url, '
        + 'local_path = excluded.local_path, mime_type = excluded.mime_type, '
        + 'size_bytes = excluded.size_bytes, sha256 = excluded.sha256, '
        + 'sort_order = excluded.sort_order, sync_uploaded = excluded.sync_uploaded',
      MEDIA_COLUMNS.map((column) => values[column]),
    );
    finalIds.push(mediaId);
  }

  if (finalIds.length) {
    await database.runAsync(
      `DELETE FROM media WHERE clip_id = ? AND id NOT IN (${placeholders(finalIds.length)})`,
      [clipId, ...finalIds],
    );
  } else {
    await database.runAsync('DELETE FROM media WHERE clip_id = ?', [clipId]);
  }

  if (markDirty) await touchClip(database, clipId);
}

/** Replace every media row for a clip (local re-extraction path). */
export async function replaceMedia(
  clipId: string,
  items: readonly MediaInput[],
): Promise<MediaItem[]> {
  const database = await getLocalDb();
  await writeMediaRows(database, clipId, items, true);
  return listMedia(clipId);
}

export async function updateMediaLocalPath(mediaId: string, localPath: string): Promise<boolean> {
  const database = await getLocalDb();
  const result = await database.runAsync(
    'UPDATE media SET local_path = ? WHERE id = ?',
    [asString(localPath), mediaId],
  );
  return result.changes > 0;
}

export async function markMediaUploaded(mediaId: string): Promise<void> {
  const database = await getLocalDb();
  await database.runAsync('UPDATE media SET sync_uploaded = 1 WHERE id = ?', [mediaId]);
}

export async function listPendingUploadMedia(): Promise<LocalMediaRecord[]> {
  const database = await getLocalDb();
  const rows = await database.getAllAsync<MediaRow>(
    "SELECT * FROM media WHERE sync_uploaded = 0 AND local_path != '' "
      + 'ORDER BY created_at ASC, id ASC',
    [],
  );
  return rows.map(rowToLocalMedia);
}

// ---------------------------------------------------------------------------
// review queue
// ---------------------------------------------------------------------------

function excludeClause(excludeIds: readonly string[]): { sql: string; params: string[] } {
  const ids = excludeIds.map((id) => asString(id)).filter(Boolean);
  if (ids.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND c.id NOT IN (${placeholders(ids.length)})`,
    params: ids,
  };
}

export async function pickDueCards(
  nowIsoValue: string,
  limit: number,
  excludeIds: readonly string[] = [],
): Promise<ClipDetail[]> {
  const requested = Math.floor(Number(limit));
  if (!Number.isFinite(requested) || requested <= 0) return [];

  const database = await getLocalDb();
  const exclusion = excludeClause(excludeIds);
  const stamp = canonicalOr(nowIsoValue, nowIso());
  const rows = await database.getAllAsync<ClipRow>(
    'SELECT c.* FROM clips c '
      + `WHERE ${ACTIVE_DECK_SQL} AND c.review_count > 0 `
      + 'AND c.next_review_at IS NOT NULL AND c.next_review_at <= ?'
      + exclusion.sql
      + ' ORDER BY c.next_review_at ASC, c.created_at ASC LIMIT ?',
    [stamp, ...exclusion.params, requested],
  );
  return rowsToDetails(database, rows);
}

export async function pickNewCards(
  limit: number,
  excludeIds: readonly string[] = [],
): Promise<ClipDetail[]> {
  const requested = Math.floor(Number(limit));
  if (!Number.isFinite(requested) || requested <= 0) return [];

  const database = await getLocalDb();
  const exclusion = excludeClause(excludeIds);
  const rows = await database.getAllAsync<ClipRow>(
    'SELECT c.* FROM clips c '
      + `WHERE ${ACTIVE_DECK_SQL} AND c.review_count = 0`
      + exclusion.sql
      + ' ORDER BY c.created_at DESC, c.id DESC LIMIT ?',
    [...exclusion.params, requested],
  );
  return rowsToDetails(database, rows);
}

export async function pickStaleCards(
  limit: number,
  excludeIds: readonly string[] = [],
): Promise<ClipDetail[]> {
  const requested = Math.floor(Number(limit));
  if (!Number.isFinite(requested) || requested <= 0) return [];

  const database = await getLocalDb();
  const exclusion = excludeClause(excludeIds);
  const rows = await database.getAllAsync<ClipRow>(
    'SELECT c.* FROM clips c '
      + `WHERE ${ACTIVE_DECK_SQL}`
      + exclusion.sql
      + ' ORDER BY COALESCE(c.last_reviewed_at, c.created_at) ASC, c.id ASC LIMIT ?',
    [...exclusion.params, requested],
  );
  return rowsToDetails(database, rows);
}

export async function countActiveDeck(): Promise<number> {
  const database = await getLocalDb();
  return scalarNumber(
    database,
    `SELECT COUNT(*) AS value FROM clips c WHERE ${ACTIVE_DECK_SQL}`,
  );
}

export async function countReviewsOn(day: string): Promise<number> {
  if (!day) return 0;
  const database = await getLocalDb();
  return scalarNumber(
    database,
    'SELECT COUNT(*) AS value FROM review_logs WHERE reviewed_at LIKE ?',
    [`${day}%`],
  );
}

export async function addReviewLog(
  clipId: string,
  action: ReviewActionType,
  reviewedAt?: string,
): Promise<void> {
  if (!asReviewAction(action)) throw new Error(`Unknown review action: ${String(action)}`);
  const database = await getLocalDb();
  const stamp = canonicalOr(reviewedAt, nowIso());
  await database.runAsync(
    'INSERT OR IGNORE INTO review_logs (clip_id, action, reviewed_at, sync_uploaded) '
      + 'VALUES (?, ?, ?, 0)',
    [clipId, action, stamp],
  );
}

export async function listPendingReviewLogs(): Promise<PendingReviewLog[]> {
  const database = await getLocalDb();
  const rows = await database.getAllAsync<ReviewLogRow>(
    'SELECT * FROM review_logs WHERE sync_uploaded = 0 ORDER BY reviewed_at ASC, id ASC',
    [],
  );
  const result: PendingReviewLog[] = [];
  for (const row of rows) {
    const action = asReviewAction(row.action);
    if (!action) continue;
    result.push({
      id: asNumber(row.id),
      clip_id: row.clip_id,
      action,
      reviewed_at: row.reviewed_at,
    });
  }
  return result;
}

/**
 * Mark review logs as uploaded. Pass the logs that were pushed, or omit the
 * argument to flush every pending log (used after a full sync response).
 */
export async function markReviewLogsSynced(
  logs?: readonly SyncReviewLogPayload[],
): Promise<void> {
  const database = await getLocalDb();
  if (!logs) {
    await database.runAsync('UPDATE review_logs SET sync_uploaded = 1 WHERE sync_uploaded = 0', []);
    return;
  }
  for (const log of logs) {
    await database.runAsync(
      'UPDATE review_logs SET sync_uploaded = 1 '
        + 'WHERE clip_id = ? AND action = ? AND reviewed_at = ?',
      [log.clip_id, log.action, log.reviewed_at],
    );
  }
}

/** Insert review logs pulled from the server without re-queueing them. */
export async function insertRemoteReviewLogs(
  logs: readonly SyncReviewLogPayload[],
): Promise<void> {
  if (logs.length === 0) return;
  const database = await getLocalDb();
  for (const log of logs) {
    const action = asReviewAction(log.action);
    if (!action || !log.clip_id || !log.reviewed_at) continue;
    try {
      await database.runAsync(
        'INSERT INTO review_logs (clip_id, action, reviewed_at, sync_uploaded) '
          + 'VALUES (?, ?, ?, 1) '
          + 'ON CONFLICT(clip_id, action, reviewed_at) DO UPDATE SET sync_uploaded = 1',
        [log.clip_id, action, log.reviewed_at],
      );
    } catch {
      // The clip may not be present locally yet; the next pull will retry.
    }
  }
}

// ---------------------------------------------------------------------------
// sync helpers
// ---------------------------------------------------------------------------

function rowToSyncMedia(row: MediaRow): SyncMediaPayload {
  return {
    id: row.id,
    clip_id: row.clip_id,
    original_url: asString(row.original_url),
    mime_type: asString(row.mime_type),
    size_bytes: asNumber(row.size_bytes),
    sha256: asString(row.sha256),
    sort_order: asNumber(row.sort_order),
    created_at: asString(row.created_at),
  };
}

function rowToSyncPayload(
  row: ClipRow,
  tags: readonly string[],
  media: readonly MediaRow[],
): SyncClipPayload {
  return {
    id: row.id,
    raw_input: asString(row.raw_input),
    url: asString(row.url),
    normalized_url: row.normalized_url ?? null,
    platform: asPlatform(row.platform),
    status: asClipStatus(row.status),
    ai_status: asAiStatus(row.ai_status),
    error_message: row.error_message ?? null,
    title: asString(row.title),
    author: asString(row.author),
    published_at: row.published_at ?? null,
    content_markdown: asString(row.content_markdown),
    content_text: asString(row.content_text),
    cover_media_id: row.cover_media_id ?? null,
    summary: asString(row.summary),
    key_points: parseJsonList(row.key_points_json),
    user_note: asString(row.user_note),
    review_state: asReviewState(row.review_state),
    review_count: asNumber(row.review_count),
    review_interval_days: asNumber(row.review_interval_days),
    next_review_at: row.next_review_at ?? null,
    last_reviewed_at: row.last_reviewed_at ?? null,
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    tags: [...tags],
    media: media.map(rowToSyncMedia),
  };
}

/** Every clip that needs to be pushed (including soft-delete tombstones). */
export async function listDirtyClips(): Promise<SyncClipPayload[]> {
  const database = await getLocalDb();
  const rows = await database.getAllAsync<ClipRow>(
    'SELECT * FROM clips WHERE sync_dirty = 1 ORDER BY updated_at ASC, id ASC',
    [],
  );
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [tagsMap, mediaMap] = await Promise.all([
    getTagsMap(database, ids),
    getMediaRowsMap(database, ids),
  ]);
  return rows.map((row) =>
    rowToSyncPayload(row, tagsMap.get(row.id) ?? [], mediaMap.get(row.id) ?? []),
  );
}

/** Total local changes waiting for the server (clips + review logs + media). */
export async function countPendingSync(): Promise<number> {
  const database = await getLocalDb();
  const [clips, logs, media] = await Promise.all([
    scalarNumber(database, 'SELECT COUNT(*) AS value FROM clips WHERE sync_dirty = 1'),
    scalarNumber(database, 'SELECT COUNT(*) AS value FROM review_logs WHERE sync_uploaded = 0'),
    scalarNumber(
      database,
      "SELECT COUNT(*) AS value FROM media WHERE sync_uploaded = 0 AND local_path != ''",
    ),
  ]);
  return clips + logs + media;
}

export async function markClipsSynced(ids: readonly string[]): Promise<void> {
  const cleaned = ids.map((id) => asString(id)).filter(Boolean);
  if (cleaned.length === 0) return;
  const database = await getLocalDb();
  for (let start = 0; start < cleaned.length; start += 500) {
    const chunk = cleaned.slice(start, start + 500);
    await database.runAsync(
      `UPDATE clips SET sync_dirty = 0 WHERE id IN (${placeholders(chunk.length)})`,
      chunk,
    );
  }
}

export async function getSyncState(key: string): Promise<string | null> {
  const database = await getLocalDb();
  const row = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_state WHERE key = ?',
    [key],
  );
  return row ? asString(row.value) : null;
}

export async function setSyncState(key: string, value: string | number | null): Promise<void> {
  const database = await getLocalDb();
  if (value === null) {
    await database.runAsync('DELETE FROM sync_state WHERE key = ?', [key]);
    return;
  }
  await database.runAsync(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)],
  );
}

/** Clips interrupted mid-ingest, so a restart can resume local extraction. */
export async function listPendingIngestClipIds(): Promise<string[]> {
  const database = await getLocalDb();
  const rows = await database.getAllAsync<{ id: string }>(
    "SELECT id FROM clips WHERE status IN ('pending', 'processing') "
      + "AND review_state != 'deleted' ORDER BY created_at ASC, id ASC",
    [],
  );
  return rows.map((row) => row.id);
}

/**
 * Merge one pulled server record using `updated_at` LWW.
 *
 * Local media `local_path` values are preserved for matching media ids. The
 * return value lists remote media whose file is not available locally, so the
 * caller can download them.
 */
export async function upsertFromRemoteSync(
  record: SyncClipRecord,
): Promise<SyncMediaPayload[]> {
  if (!record?.id) throw new Error('upsertFromRemoteSync requires a clip id');

  const database = await getLocalDb();
  const existing = await database.getFirstAsync<ClipRow>(
    'SELECT * FROM clips WHERE id = ?',
    [record.id],
  );
  const existingMedia = existing ? await getAllMediaRows(database, record.id) : [];

  const fallbackStamp = nowIso();
  const updatedAt = canonicalOr(record.updated_at, fallbackStamp);
  const createdAt = canonicalOr(record.created_at, updatedAt);

  if (existing) {
    const localStamp = canonicalOr(existing.updated_at, createdAt);
    if (localStamp > updatedAt) return [];
    // Equal timestamps are a tie: keep unsynced local work, otherwise accept
    // the server copy (mirrors the backend's "strictly older loses" rule).
    if (localStamp === updatedAt && asNumber(existing.sync_dirty) === 1) return [];
  }

  const values: ClipRow = {
    id: record.id,
    raw_input: asString(record.raw_input),
    url: asString(record.url),
    normalized_url: record.normalized_url ?? null,
    platform: asPlatform(record.platform),
    status: asClipStatus(record.status),
    ai_status: asAiStatus(record.ai_status),
    error_message: record.error_message ?? null,
    title: asString(record.title),
    author: asString(record.author),
    published_at: canonicalNullable(record.published_at),
    content_markdown: asString(record.content_markdown),
    content_text: asString(record.content_text),
    cover_media_id: record.cover_media_id ?? null,
    summary: asString(record.summary),
    key_points_json: JSON.stringify(asStringArray(record.key_points)),
    user_note: asString(record.user_note),
    review_state: asReviewState(record.review_state),
    review_count: asNumber(record.review_count),
    review_interval_days: asNumber(record.review_interval_days),
    next_review_at: canonicalNullable(record.next_review_at),
    last_reviewed_at: canonicalNullable(record.last_reviewed_at),
    created_at: createdAt,
    updated_at: updatedAt,
    sync_dirty: 0,
    server_sync_version: asNumber(record.sync_version),
  };

  await database.runAsync(
    `INSERT INTO clips (${CLIP_COLUMNS.join(', ')}) `
      + `VALUES (${placeholders(CLIP_COLUMNS.length)}) `
      + 'ON CONFLICT(id) DO UPDATE SET '
      + CLIP_COLUMNS.filter((column) => column !== 'id')
        .map((column) => `${column} = excluded.${column}`)
        .join(', '),
    CLIP_COLUMNS.map((column) => values[column]),
  );

  await setClipTagsInternal(database, record.id, asStringArray(record.tags));

  const localPathById = new Map(existingMedia.map((row) => [row.id, asString(row.local_path)]));
  const remoteIds: string[] = [];
  const missing: SyncMediaPayload[] = [];
  const missingIds = new Set<string>();

  for (const item of record.media ?? []) {
    const mediaId = asString(item.id) || generateId();
    remoteIds.push(mediaId);

    const payload: SyncMediaPayload = {
      id: mediaId,
      clip_id: asString(item.clip_id) || record.id,
      original_url: asString(item.original_url),
      mime_type: asString(item.mime_type),
      size_bytes: asNumber(item.size_bytes),
      sha256: asString(item.sha256),
      sort_order: asNumber(item.sort_order),
      created_at: canonicalOr(item.created_at, fallbackStamp),
    };

    await database.runAsync(
      'INSERT INTO media (id, clip_id, original_url, local_path, mime_type, size_bytes, '
        + 'sha256, sort_order, created_at, sync_uploaded) '
        + "VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 1) "
        + 'ON CONFLICT(id) DO UPDATE SET '
        + 'clip_id = excluded.clip_id, original_url = excluded.original_url, '
        + 'mime_type = excluded.mime_type, size_bytes = excluded.size_bytes, '
        + 'sha256 = excluded.sha256, sort_order = excluded.sort_order, '
        + 'sync_uploaded = 1',
      [
        mediaId,
        payload.clip_id,
        payload.original_url,
        payload.mime_type,
        payload.size_bytes,
        payload.sha256,
        payload.sort_order,
        payload.created_at,
      ],
    );

    const localPath = localPathById.get(mediaId) ?? '';
    const exists = await localFileExists(localPath);
    if (!exists && !missingIds.has(mediaId)) {
      missingIds.add(mediaId);
      missing.push(payload);
    }
  }

  if (remoteIds.length) {
    await database.runAsync(
      `DELETE FROM media WHERE clip_id = ? AND id NOT IN (${placeholders(remoteIds.length)})`,
      [record.id, ...remoteIds],
    );
  } else {
    await database.runAsync('DELETE FROM media WHERE clip_id = ?', [record.id]);
  }

  await syncClipFts(database, record.id);
  return missing;
}
