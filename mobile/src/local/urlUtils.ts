/**
 * URL extraction / platform detection / normalization helpers.
 *
 * 1:1 port of `backend/app/services/url_utils.py` so the mobile app can resolve
 * and normalize links completely offline. Everything here is pure TypeScript and
 * relies only on the WHATWG `URL` implementation available in React Native/Node,
 * so it can be unit tested without any native module.
 */

import type { Platform } from '../types';

export interface ParsedUrlParts {
  scheme: string;
  netloc: string;
  hostname: string;
  port: string;
  path: string;
  query: string;
  fragment: string;
}

/** Only RFC-3986-ish characters are considered part of a URL. */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/gi;

/** Punctuation that frequently sticks to the end of a URL inside share captions. */
const TRAILING_JUNK = '，。！？；：、…·,.!?;:\'"“”‘’<>》」』】}）';

const BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const WECHAT_HOSTS = new Set(['mp.weixin.qq.com', 'weixin.qq.com']);
const X_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'mobile.twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
]);
const XHS_HOSTS = new Set(['xiaohongshu.com', 'xhslink.com']);

/** Query parameters dropped during normalization. `utm_*` is handled by prefix. */
const TRACKING_PARAMS = new Set([
  'spm',
  'spm_id_from',
  'chksm',
  'scene',
  'poc_token',
  'from',
  'from_source',
  'isappinstalled',
  's',
  't',
  'xhs_g_s',
  'share_from_user_hidden',
  'share_id',
  'share_channel',
  'share_reduce_image_id',
  'share_source',
  'appuid',
  'apptime',
  'app_id',
  'wxshare_count',
  'sessionid',
  'clicktime',
  'enterid',
  'ref',
  'ref_src',
  'ref_url',
  'src',
  'source',
  'fbclid',
  'gclid',
]);

/** Parameters that must never be stripped even if they look like tracking params. */
const KEEP_PARAMS = new Set(['__biz', 'mid', 'idx', 'sn', 'xsec_token', 'xsec_source']);

/** Characters left unescaped in query strings (mirrors Python `urlencode(safe=...)`). */
const QUERY_SAFE = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/@!$'()*,;+?=".split(''));

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function stripTrailing(url: string): string {
  let value = url;
  while (value) {
    const last = value[value.length - 1];
    if (Object.prototype.hasOwnProperty.call(BRACKETS, last)) {
      const opener = BRACKETS[last];
      if (countOccurrences(value, opener) >= countOccurrences(value, last)) {
        break;
      }
      value = value.slice(0, -1);
      continue;
    }
    if (TRAILING_JUNK.includes(last)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

/**
 * Tolerant `urlsplit` that also accepts scheme-less inputs such as `x.com/a/b`.
 * Mirrors the private `_split` helper in the Python module.
 */
export function splitUrlParts(raw: string): ParsedUrlParts {
  let candidate = (raw ?? '').trim();
  if (!candidate.includes('://')) {
    candidate = `//${candidate.replace(/^\/+/, '')}`;
  }

  let fragment = '';
  const hashAt = candidate.indexOf('#');
  if (hashAt >= 0) {
    fragment = candidate.slice(hashAt + 1);
    candidate = candidate.slice(0, hashAt);
  }

  let query = '';
  const queryAt = candidate.indexOf('?');
  if (queryAt >= 0) {
    query = candidate.slice(queryAt + 1);
    candidate = candidate.slice(0, queryAt);
  }

  let scheme = '';
  let rest = candidate;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(candidate);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = candidate.slice(schemeMatch[0].length);
  } else if (rest.startsWith('//')) {
    rest = rest.slice(2);
  }

  const slashAt = rest.indexOf('/');
  const authority = slashAt >= 0 ? rest.slice(0, slashAt) : rest;
  const path = slashAt >= 0 ? rest.slice(slashAt) : '';

  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  let hostname = '';
  let port = '';

  if (hostPort.startsWith('[')) {
    const closing = hostPort.indexOf(']');
    if (closing >= 0) {
      hostname = hostPort.slice(1, closing);
      const remainder = hostPort.slice(closing + 1);
      if (remainder.startsWith(':')) port = remainder.slice(1);
    } else {
      hostname = hostPort;
    }
  } else {
    const colonAt = hostPort.lastIndexOf(':');
    if (colonAt >= 0) {
      const candidatePort = hostPort.slice(colonAt + 1);
      if (/^\d+$/.test(candidatePort)) {
        hostname = hostPort.slice(0, colonAt);
        port = candidatePort;
      } else {
        hostname = hostPort;
      }
    } else {
      hostname = hostPort;
    }
  }

  return {
    scheme,
    netloc: authority,
    hostname: hostname.toLowerCase(),
    port,
    path,
    query,
    fragment,
  };
}

/** First usable http(s) URL found in a (possibly messy) share caption. */
export function extractUrl(rawInput: string): string | null {
  if (!rawInput) return null;
  const matches = rawInput.match(URL_RE);
  if (!matches) return null;
  for (const match of matches) {
    const candidate = stripTrailing(match);
    if (!candidate) continue;
    const parts = splitUrlParts(candidate);
    if ((parts.scheme === 'http' || parts.scheme === 'https') && parts.netloc) {
      return candidate;
    }
  }
  return null;
}

function hostOf(url: string): string {
  return splitUrlParts(url).hostname.replace(/\.+$/, '');
}

function hostMatches(host: string, candidates: Set<string>): boolean {
  if (!host) return false;
  for (const candidate of candidates) {
    if (host === candidate || host.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

/** Map a URL to the platform whose extractor should handle it. */
export function detectPlatform(url: string): Platform {
  const host = hostOf(url);
  if (hostMatches(host, WECHAT_HOSTS)) return 'wechat';
  if (hostMatches(host, X_HOSTS)) return 'x';
  if (hostMatches(host, XHS_HOSTS)) return 'xiaohongshu';
  return 'web';
}

function isTracking(key: string): boolean {
  const lowered = key.toLowerCase();
  return lowered.startsWith('utm_') || TRACKING_PARAMS.has(lowered);
}

function percentDecode(value: string): string {
  const prepared = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(prepared);
  } catch {
    return prepared;
  }
}

function percentEncode(value: string): string {
  let output = '';
  for (const char of value) {
    if (char === ' ') {
      output += '+';
      continue;
    }
    if (QUERY_SAFE.has(char)) {
      output += char;
      continue;
    }
    output += encodeURIComponent(char).replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => `%${hex.toUpperCase()}`);
  }
  return output;
}

function parseQueryPairs(query: string): Array<[string, string, boolean]> {
  const pairs: Array<[string, string, boolean]> = [];
  for (const chunk of query.split('&')) {
    if (!chunk) continue;
    const equalsAt = chunk.indexOf('=');
    const hasEquals = equalsAt >= 0;
    const rawKey = hasEquals ? chunk.slice(0, equalsAt) : chunk;
    const rawValue = hasEquals ? chunk.slice(equalsAt + 1) : '';
    pairs.push([percentDecode(rawKey), percentDecode(rawValue), hasEquals]);
  }
  return pairs;
}

/** Strip tracking noise, unify Twitter hosts to `x.com` and drop the fragment. */
export function normalizeUrl(url: string, platform?: Platform): string {
  let value = (url ?? '').trim();
  if (!value) return '';
  if (!value.includes('://')) {
    value = `https://${value.replace(/^\/+/, '')}`;
  }

  const parts = splitUrlParts(value);
  const scheme = (parts.scheme || 'https').toLowerCase();
  const host = parts.hostname.toLowerCase();
  if (!host) return value;

  let netloc = host;
  if (parts.port) netloc = `${host}:${parts.port}`;

  const resolved = platform || detectPlatform(value);
  if (resolved === 'x' && hostMatches(host, X_HOSTS)) {
    netloc = 'x.com';
  }

  const kept: Array<[string, string, boolean]> = [];
  for (const [key, queryValue, hasEquals] of parseQueryPairs(parts.query)) {
    if (KEEP_PARAMS.has(key)) {
      kept.push([key, queryValue, hasEquals]);
      continue;
    }
    if (isTracking(key)) continue;
    kept.push([key, queryValue, hasEquals]);
  }

  const query = kept
    .map(([key, queryValue, hasEquals]) =>
      hasEquals ? `${percentEncode(key)}=${percentEncode(queryValue)}` : percentEncode(key),
    )
    .join('&');
  let path = parts.path || '';
  if (path === '/' && !query) path = '';
  return `${scheme}://${netloc}${path}${query ? `?${query}` : ''}`;
}

const HEX_DIGITS = '0123456789abcdef';

/** Generate a lowercase 32-char hex id (UUID-shaped, no native crypto needed). */
export function generateHexId(): string {
  const chars: string[] = [];
  for (let index = 0; index < 32; index += 1) {
    chars.push(HEX_DIGITS[Math.floor(Math.random() * 16)]);
  }
  // Mark it as a v4 UUID so ids stay distinguishable from content hashes.
  chars[12] = '4';
  chars[16] = HEX_DIGITS[(8 + Math.floor(Math.random() * 4))];
  return chars.join('');
}
