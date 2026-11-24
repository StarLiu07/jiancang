/**
 * Bidirectional incremental sync between the phone and the NUC.
 *
 * Flow: ``health`` probe -> push local dirty clips + review logs -> upload any
 * missing media binaries -> pull every clip/review log newer than the stored
 * ``last_server_version`` cursor.
 *
 * Everything is best effort by design: a sync run never throws for connectivity
 * problems (it reports ``offline``), never deletes local rows, and never blocks
 * the UI. The pure helpers at the top stay dependency-free so they can be unit
 * tested in plain Node.
 */

import { ApiError, api, buildAuthHeaders, mediaUrl, pickErrorMessage } from '../api/client';
import { downloadRemoteMediaById, getLocalMediaDir, localMediaFileExists } from '../local/media';
import type { LocalMediaRecord } from '../local/db';
import type { ApiConfig, SyncPullResponse, SyncPushRequest, SyncReviewLogPayload } from '../types';

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'offline' | 'error';

export interface SyncRunResult {
  status: SyncStatus;
  /** Human readable reason for non-success states; '' when the stats speak. */
  message: string;
  pushed: number;
  pulled: number;
  uploadedMedia: number;
  downloadedMedia: number;
  queuedAi: number;
  /** Local changes still waiting after this run (failed uploads etc.). */
  pendingCount: number;
  /** Whether this run moved any data in either direction. */
  changed: boolean;
  lastSyncAt: string | null;
}

export interface SyncRunOptions {
  /** Background runs use shorter timeouts and must stay completely quiet. */
  silent?: boolean;
}

type LocalDbModule = typeof import('../local/db');

export const SYNC_PULL_PAGE_SIZE = 100;
export const SYNC_MAX_PULL_PAGES = 50;

const HEALTH_TIMEOUT_SILENT_MS = 3000;
const HEALTH_TIMEOUT_MANUAL_MS = 8000;
const TRANSFER_TIMEOUT_SILENT_MS = 10_000;
const TRANSFER_TIMEOUT_MANUAL_MS = 30_000;
const LAST_SERVER_VERSION_KEY = 'last_server_version';
const LAST_SYNC_AT_KEY = 'last_sync_at';

/** Required lazily so pure helpers never pull in expo-sqlite/native modules. */
function loadLocalDb(): LocalDbModule {
  return require('../local/db') as LocalDbModule;
}

function emptyResult(status: SyncStatus, message = ''): SyncRunResult {
  return {
    status,
    message,
    pushed: 0,
    pulled: 0,
    uploadedMedia: 0,
    downloadedMedia: 0,
    queuedAi: 0,
    pendingCount: 0,
    changed: false,
    lastSyncAt: null,
  };
}

/** Compact, Chinese, one-line summary for banners and toasts. */
export function formatSyncSummary(result: SyncRunResult): string {
  switch (result.status) {
    case 'syncing':
      return '正在同步…';
    case 'offline':
      return result.message || '离线：暂时连不上 NUC，稍后自动重试';
    case 'error':
      return result.message || '同步失败，请稍后重试';
    case 'idle':
      return result.message || '还没有同步过';
    case 'success':
      break;
  }

  const parts: string[] = [];
  if (result.pushed > 0) parts.push(`上传 ${result.pushed} 条`);
  if (result.pulled > 0) parts.push(`下载 ${result.pulled} 条`);
  if (result.uploadedMedia > 0) parts.push(`上传图片 ${result.uploadedMedia} 张`);
  if (result.downloadedMedia > 0) parts.push(`下载图片 ${result.downloadedMedia} 张`);
  if (result.queuedAi > 0) parts.push(`AI 补全排队 ${result.queuedAi} 条`);
  if (parts.length > 0) return `同步完成：${parts.join('，')}`;
  if (result.pendingCount > 0) return `已同步，还有 ${result.pendingCount} 项待重试`;
  return '已是最新状态';
}

function toLocalFileUri(mediaDir: string, localPath: string): string {
  const value = (localPath || '').trim();
  if (/^(?:file|content):\/\//i.test(value)) return value;
  return `${mediaDir}${value.replace(/^\/+/, '')}`;
}

function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

async function safePendingCount(db: LocalDbModule, fallback: number): Promise<number> {
  try {
    return await db.countPendingSync();
  } catch {
    return fallback;
  }
}

async function readCursor(db: LocalDbModule): Promise<number> {
  try {
    const stored = await db.getSyncState(LAST_SERVER_VERSION_KEY);
    const parsed = Number.parseInt(stored ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

interface PushOutcome {
  pushed: number;
  queuedAi: number;
  missingMediaIds: string[];
}

/** Push dirty clips + pending review logs; skipped clips stay dirty. */
async function pushLocalChanges(
  db: LocalDbModule,
  config: ApiConfig,
  timeoutMs: number,
): Promise<PushOutcome> {
  const dirtyClips = await db.listDirtyClips();
  const pendingLogs = await db.listPendingReviewLogs();
  const reviewLogs: SyncReviewLogPayload[] = pendingLogs.map((log) => ({
    clip_id: log.clip_id,
    action: log.action,
    reviewed_at: log.reviewed_at,
  }));
  if (dirtyClips.length === 0 && reviewLogs.length === 0) {
    return { pushed: 0, queuedAi: 0, missingMediaIds: [] };
  }

  const payload: SyncPushRequest = { clips: dirtyClips, review_logs: reviewLogs };
  const response = await api.syncPush(config, payload, timeoutMs);

  await db.markClipsSynced(response.accepted_ids);
  if (reviewLogs.length > 0) await db.markReviewLogsSynced(reviewLogs);

  return {
    pushed: response.accepted_ids.length + reviewLogs.length,
    queuedAi: response.queued_ai_ids.length,
    missingMediaIds: response.missing_media_ids ?? [],
  };
}

interface MediaUploadOutcome {
  uploadedMedia: number;
}

/**
 * Upload binaries the server is missing plus every local-only media row.
 * A failed file stays pending so the next run retries it.
 */
async function uploadMissingMedia(
  db: LocalDbModule,
  config: ApiConfig,
  missingMediaIds: readonly string[],
): Promise<MediaUploadOutcome> {
  const candidates = new Map<string, LocalMediaRecord>();

  for (const mediaId of missingMediaIds) {
    const record = await db.getMedia(mediaId);
    if (record) candidates.set(record.id, record);
  }
  for (const record of await db.listPendingUploadMedia()) {
    if (!candidates.has(record.id)) candidates.set(record.id, record);
  }
  if (candidates.size === 0) return { uploadedMedia: 0 };

  let mediaDir = '';
  try {
    mediaDir = await getLocalMediaDir();
  } catch {
    return { uploadedMedia: 0 };
  }

  let uploadedMedia = 0;
  for (const record of candidates.values()) {
    if (!(await localMediaFileExists(record.local_path))) continue;
    try {
      await api.syncUploadMedia(config, record.id, toLocalFileUri(mediaDir, record.local_path), {
        clipId: record.clip_id,
        mimeType: record.mime_type || undefined,
        originalUrl: record.original_url || undefined,
        sortOrder: record.sort_order,
      });
      await db.markMediaUploaded(record.id);
      uploadedMedia += 1;
    } catch {
      // Retry on the next run; one broken image must not abort the sync.
    }
  }
  return { uploadedMedia };
}

interface PullOutcome {
  pulled: number;
  pulledLogs: number;
  downloadedMedia: number;
}

/** Pull all pages newer than the cursor, downloading missing remote images. */
async function pullRemoteChanges(
  db: LocalDbModule,
  config: ApiConfig,
  timeoutMs: number,
): Promise<PullOutcome> {
  let cursor = await readCursor(db);
  let pulled = 0;
  let pulledLogs = 0;
  let downloadedMedia = 0;
  const authHeaders = buildAuthHeaders(config);

  for (let page = 0; page < SYNC_MAX_PULL_PAGES; page += 1) {
    const response: SyncPullResponse = await api.syncPull(
      config,
      cursor,
      SYNC_PULL_PAGE_SIZE,
      timeoutMs,
    );

    let pageMax = cursor;
    for (const record of response.clips ?? []) {
      const missing = await db.upsertFromRemoteSync(record);
      pulled += 1;
      pageMax = Math.max(pageMax, Number(record.sync_version) || 0);

      for (const item of missing) {
        const remoteUrl = mediaUrl(config, `/api/media/${item.id}`);
        if (!remoteUrl) continue;
        const stored = await downloadRemoteMediaById(
          item.id,
          remoteUrl,
          authHeaders,
          item.mime_type,
        );
        if (!stored) continue;
        await db.updateMediaLocalPath(item.id, stored.local_path);
        downloadedMedia += 1;
      }
    }

    const remoteLogs = response.review_logs ?? [];
    await db.insertRemoteReviewLogs(remoteLogs);
    pulledLogs += remoteLogs.length;

    // Always advance to the newest version we actually received: jumping to
    // `latest_version` could skip a record written by another device mid-page.
    const nextCursor = pageMax;
    const advanced = nextCursor > cursor;
    if (advanced) {
      cursor = nextCursor;
      await db.setSyncState(LAST_SERVER_VERSION_KEY, cursor);
    }
    // Stop on the last page, or when a misbehaving server keeps claiming
    // `has_more` without advancing the version cursor (infinite-loop guard).
    if (!response.has_more || !advanced) break;
  }

  return { pulled, pulledLogs, downloadedMedia };
}

/**
 * Run one full bidirectional sync.
 *
 * Never throws for connectivity problems: an unreachable NUC resolves to
 * ``{ status: 'offline' }``. Unexpected local failures also resolve (with
 * ``status: 'error'``) so a background timer can always call this safely.
 */
export async function runBidirectionalSync(
  config: ApiConfig,
  options: SyncRunOptions = {},
): Promise<SyncRunResult> {
  const silent = options.silent === true;

  if (!config.baseUrl || !config.baseUrl.trim()) {
    // No network work at all, but still report the local backlog so the UI
    // does not show a misleading "0 pending" while sync is unconfigured.
    let pendingCount = 0;
    try {
      pendingCount = await safePendingCount(loadLocalDb(), 0);
    } catch {
      pendingCount = 0;
    }
    return {
      ...emptyResult('offline', '还没有填写 NUC 地址，请先到设置里配置'),
      pendingCount,
    };
  }

  let db: LocalDbModule;
  try {
    db = loadLocalDb();
  } catch (error) {
    return emptyResult('error', pickErrorMessage(error, '本地数据库不可用，无法同步'));
  }

  let pendingCount = await safePendingCount(db, 0);

  try {
    await api.health(config, silent ? HEALTH_TIMEOUT_SILENT_MS : HEALTH_TIMEOUT_MANUAL_MS);
  } catch (error) {
    return {
      ...emptyResult(
        'offline',
        pickErrorMessage(error, '连不上 NUC，稍后会自动重试'),
      ),
      pendingCount,
    };
  }

  const timeoutMs = silent ? TRANSFER_TIMEOUT_SILENT_MS : TRANSFER_TIMEOUT_MANUAL_MS;

  try {
    const push = await pushLocalChanges(db, config, timeoutMs);
    const media = await uploadMissingMedia(db, config, push.missingMediaIds);
    const pull = await pullRemoteChanges(db, config, timeoutMs);

    const lastSyncAt = new Date().toISOString();
    try {
      await db.setSyncState(LAST_SYNC_AT_KEY, lastSyncAt);
    } catch {
      // The timestamp is cosmetic; a write failure must not fail the sync.
    }
    pendingCount = await safePendingCount(db, pendingCount);

    return {
      status: 'success',
      message: '',
      pushed: push.pushed,
      pulled: pull.pulled,
      uploadedMedia: media.uploadedMedia,
      downloadedMedia: pull.downloadedMedia,
      queuedAi: push.queuedAi,
      pendingCount,
      changed:
        push.pushed > 0
        || pull.pulled > 0
        || pull.pulledLogs > 0
        || media.uploadedMedia > 0
        || pull.downloadedMedia > 0
        || push.queuedAi > 0,
      lastSyncAt,
    };
  } catch (error) {
    pendingCount = await safePendingCount(db, pendingCount);
    return {
      status: isUnreachable(error) ? 'offline' : 'error',
      message: pickErrorMessage(error, '同步失败，请稍后重试'),
      pushed: 0,
      pulled: 0,
      uploadedMedia: 0,
      downloadedMedia: 0,
      queuedAi: 0,
      pendingCount,
      changed: false,
      lastSyncAt: null,
    };
  }
}
