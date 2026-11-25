import type { Platform } from '../types';

/** Matches the first http(s) URL inside shared / pasted text. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》]+/i;
const TRAILING_JUNK = /[.,;:!?)\]}"'”’]+$/;
const BARE_DOMAIN_PATTERN = /(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s，。；：！？、（）【】《》]*)?)/i;

const XIAOHONGSHU_HOSTS = ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'xhs.cn'];
const WECHAT_HOSTS = ['mp.weixin.qq.com', 'weixin.qq.com'];
const X_HOSTS = [
  'x.com',
  'twitter.com',
  't.co',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
];

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Adds a missing scheme and removes trailing slashes. Returns '' for blank input. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function isValidHttpUrl(raw: string): boolean {
  const url = safeUrl(raw);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
}

export function joinApiPath(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!path) return base;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** First URL inside arbitrary share text (小红书口令、公众号分享语等). */
export function extractFirstUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const direct = URL_PATTERN.exec(text);
  if (direct) {
    const cleaned = direct[0].replace(TRAILING_JUNK, '');
    return isValidHttpUrl(cleaned) ? cleaned : null;
  }
  const bare = BARE_DOMAIN_PATTERN.exec(text);
  if (bare) {
    const cleaned = bare[1].replace(TRAILING_JUNK, '');
    const candidate = `https://${cleaned}`;
    if (isValidHttpUrl(candidate)) return candidate;
  }
  return null;
}

/**
 * Fast clipboard gate: only surface a banner when the clipboard actually holds
 * a link we know how to clip (小红书 / 公众号 / X / 普通网页).
 */
export function detectClipboardLink(text: string | null | undefined): string | null {
  if (!text) return null;
  const url = extractFirstUrl(text);
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  if (host === 'localhost') return null;
  return url;
}

export function hostOf(url: string): string {
  const parsed = safeUrl(url);
  return parsed?.hostname.toLowerCase() ?? '';
}

export function detectPlatformFromUrl(url: string): Platform {
  const host = hostOf(url);
  if (XIAOHONGSHU_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'xiaohongshu';
  if (WECHAT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'wechat';
  if (X_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'x';
  return 'web';
}

/**
 * Normalizes whatever the Android share sheet gave us into clip input text.
 *
 * The original caption is kept: 小红书/公众号 shares look like
 * `"我的笔记标题 http://xhslink.cn/o/xxx 复制后打开【小红书】"`, and dropping the
 * title would lose the only text the user ever sees when extraction degrades.
 */
export function buildSharePayload(webUrl: string | null | undefined, text: string | null | undefined): string {
  const shared = (webUrl ?? '').trim();
  const caption = (text ?? '').trim();
  const sharedUrl = extractFirstUrl(shared);
  const captionUrl = extractFirstUrl(caption);

  // The caption already carries a usable link: keep the whole 口令 verbatim.
  if (captionUrl) return caption;
  if (sharedUrl && caption) return `${caption}\n${sharedUrl}`;
  if (sharedUrl) return sharedUrl;
  return caption || shared;
}

export function truncateMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
