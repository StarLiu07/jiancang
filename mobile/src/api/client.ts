import type {
  ApiConfig,
  ClipCreateInput,
  ClipCreateResponse,
  ClipDetail,
  ClipListQuery,
  ClipListResponse,
  ClipUpdateInput,
  DeleteResponse,
  HealthResponse,
  ReviewActionInput,
  ReviewActionResponse,
  ReviewTodayResponse,
  SyncMediaUploadResponse,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  TagListResponse,
} from '../types';
import { joinApiPath, normalizeBaseUrl } from '../utils/url';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_HEALTH_TIMEOUT_MS = 8000;
const SYNC_PULL_LIMIT = 100;
/** Device-local URIs that must never be routed through the backend. */
const LOCAL_URI_RE = /^(?:file|content|data):/i;

type FileSystemModule = typeof import('expo-file-system');

let cachedFileSystem: FileSystemModule | null = null;

/** Lazily load expo-file-system so pure helpers stay importable in plain Node. */
function loadFileSystem(): FileSystemModule {
  if (!cachedFileSystem) {
    cachedFileSystem = require('expo-file-system') as FileSystemModule;
  }
  return cachedFileSystem;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status = 0, detail = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Bearer header for the configured token (empty object when no token). */
export function buildAuthHeaders(config: ApiConfig): Record<string, string> {
  const token = config.token.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildQuery(query: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function describeDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item && typeof (item as { msg?: unknown }).msg === 'string') {
          return (item as { msg: string }).msg;
        }
        return typeof item === 'string' ? item : '';
      })
      .filter(Boolean)
      .join('；');
  }
  return '';
}

/** Turn an HTTP error body into a human readable detail line. */
function describeBodyDetail(raw: string, status: number): string {
  const text = (raw || '').trim();
  if (!text) return `请求失败（HTTP ${status}）`;
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === 'object') {
      if ('detail' in payload) {
        const detail = describeDetail((payload as { detail?: unknown }).detail);
        if (detail) return detail;
      }
      if ('message' in payload && typeof (payload as { message?: unknown }).message === 'string') {
        return (payload as { message: string }).message;
      }
    }
  } catch {
    // Not JSON: fall through and use raw text.
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function readErrorDetail(response: Response): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
  return describeBodyDetail(raw, response.status);
}

function timeoutError(): ApiError {
  return new ApiError('请求超时，请检查后端地址、网络或 Tailscale 状态', 0);
}

function networkError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && error.name === 'AbortError') return timeoutError();
  const detail = error instanceof Error ? error.message : String(error);
  return new ApiError('连接失败，请检查后端地址、网络或 Tailscale 状态', 0, detail);
}

async function request<T>(config: ApiConfig, path: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new ApiError('请先在设置里填写后端地址', 0);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetch(joinApiPath(baseUrl, path), {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...buildAuthHeaders(config),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new ApiError(detail || `请求失败（HTTP ${response.status}）`, response.status, detail);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (error) {
    throw networkError(error);
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export function pickErrorMessage(error: unknown, fallback = '操作失败，请稍后再试'): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

/**
 * Turns a relative `/api/media/{id}` path into an absolute, token-aware URL.
 * Device-local URIs (`file://`, `content://`, `data:`) are returned untouched.
 */
export function mediaUrl(config: ApiConfig, path: string | null | undefined): string | null {
  if (!path) return null;
  if (LOCAL_URI_RE.test(path)) return path;
  const absolute = /^https?:\/\//i.test(path);
  const url = joinApiPath(config.baseUrl, path);
  const token = config.token.trim();
  if (!token) return url;
  if (absolute && !url.startsWith(normalizeBaseUrl(config.baseUrl))) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export interface SyncMediaUploadMeta {
  clipId: string;
  mimeType?: string;
  originalUrl?: string;
  sortOrder?: number;
}

export const api = {
  health(config: ApiConfig, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HealthResponse> {
    return request<HealthResponse>(config, '/health', { timeoutMs });
  },

  createClip(config: ApiConfig, input: ClipCreateInput): Promise<ClipCreateResponse> {
    return request<ClipCreateResponse>(config, '/api/clips', { method: 'POST', body: input });
  },

  listClips(config: ApiConfig, query: ClipListQuery = {}): Promise<ClipListResponse> {
    const qs = buildQuery({
      q: query.q,
      platform: query.platform,
      tag: query.tag,
      review_state: query.review_state,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    return request<ClipListResponse>(config, `/api/clips${qs}`);
  },

  getClip(config: ApiConfig, id: string): Promise<ClipDetail> {
    return request<ClipDetail>(config, `/api/clips/${encodeURIComponent(id)}`);
  },

  updateClip(config: ApiConfig, id: string, patch: ClipUpdateInput): Promise<ClipDetail> {
    return request<ClipDetail>(config, `/api/clips/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  },

  deleteClip(config: ApiConfig, id: string, permanent = false): Promise<DeleteResponse> {
    return request<DeleteResponse>(config, `/api/clips/${encodeURIComponent(id)}?permanent=${permanent ? 'true' : 'false'}`, {
      method: 'DELETE',
    });
  },

  retryClip(config: ApiConfig, id: string): Promise<ClipDetail> {
    return request<ClipDetail>(config, `/api/clips/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },

  reviewToday(config: ApiConfig, limit = 5): Promise<ReviewTodayResponse> {
    return request<ReviewTodayResponse>(config, `/api/review/today${buildQuery({ limit })}`);
  },

  reviewAction(config: ApiConfig, id: string, input: ReviewActionInput): Promise<ReviewActionResponse> {
    return request<ReviewActionResponse>(config, `/api/review/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: input,
    });
  },

  listTags(config: ApiConfig): Promise<TagListResponse> {
    return request<TagListResponse>(config, '/api/tags');
  },

  syncPush(
    config: ApiConfig,
    payload: SyncPushRequest,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<SyncPushResponse> {
    return request<SyncPushResponse>(config, '/api/sync/push', {
      method: 'POST',
      body: payload,
      timeoutMs,
    });
  },

  syncPull(
    config: ApiConfig,
    sinceVersion: number,
    limit = SYNC_PULL_LIMIT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<SyncPullResponse> {
    const since = Number.isFinite(sinceVersion) && sinceVersion > 0 ? Math.trunc(sinceVersion) : 0;
    const qs = buildQuery({ since_version: since, limit });
    return request<SyncPullResponse>(config, `/api/sync/pull${qs}`, { timeoutMs });
  },

  /** Raw binary upload for one media row (`PUT /api/sync/media/{id}`). */
  async syncUploadMedia(
    config: ApiConfig,
    mediaId: string,
    fileUri: string,
    meta: SyncMediaUploadMeta,
  ): Promise<SyncMediaUploadResponse> {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    if (!baseUrl) throw new ApiError('请先在设置里填写后端地址', 0);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Clip-Id': meta.clipId,
      ...buildAuthHeaders(config),
    };
    if (meta.mimeType) headers['Content-Type'] = meta.mimeType;
    if (meta.originalUrl) headers['X-Original-Url'] = meta.originalUrl;
    if (typeof meta.sortOrder === 'number' && Number.isFinite(meta.sortOrder)) {
      headers['X-Sort-Order'] = String(Math.trunc(meta.sortOrder));
    }

    const fileSystem = loadFileSystem();
    let result: Awaited<ReturnType<FileSystemModule['uploadAsync']>>;
    try {
      result = await fileSystem.uploadAsync(
        joinApiPath(baseUrl, `/api/sync/media/${encodeURIComponent(mediaId)}`),
        fileUri,
        {
          httpMethod: 'PUT',
          uploadType: fileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers,
        },
      );
    } catch (error) {
      throw networkError(error);
    }

    if (result.status < 200 || result.status >= 300) {
      const detail = describeBodyDetail(result.body, result.status);
      throw new ApiError(detail, result.status, detail);
    }

    try {
      const payload = JSON.parse(result.body) as SyncMediaUploadResponse;
      if (!payload || typeof payload.id !== 'string' || !payload.id) {
        throw new Error('unexpected upload payload');
      }
      return payload;
    } catch {
      throw new ApiError(
        `图片上传成功但返回体异常（HTTP ${result.status}）`,
        result.status,
        result.body.slice(0, 200),
      );
    }
  },
};
