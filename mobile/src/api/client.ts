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
  TagListResponse,
} from '../types';
import { joinApiPath, normalizeBaseUrl } from '../utils/url';

const DEFAULT_TIMEOUT_MS = 15000;

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

function authHeaders(config: ApiConfig): Record<string, string> {
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

async function readErrorDetail(response: Response): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
  if (!raw) return `请求失败（HTTP ${response.status}）`;
  try {
    const payload = JSON.parse(raw) as unknown;
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
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
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
        ...authHeaders(config),
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

/** Turns a relative `/api/media/{id}` path into an absolute, token-aware URL. */
export function mediaUrl(config: ApiConfig, path: string | null | undefined): string | null {
  if (!path) return null;
  const absolute = /^https?:\/\//i.test(path);
  const url = joinApiPath(config.baseUrl, path);
  const token = config.token.trim();
  if (!token) return url;
  if (absolute && !url.startsWith(normalizeBaseUrl(config.baseUrl))) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export const api = {
  health(config: ApiConfig): Promise<HealthResponse> {
    return request<HealthResponse>(config, '/health', { timeoutMs: 8000 });
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
};
