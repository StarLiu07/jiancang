/**
 * Xiaohongshu (RED) extractor with layered fallbacks.
 *
 * Strategy (mirrors `backend/app/services/extractors/xhs.py`):
 * 1. follow `xhslink.com` / `xhslink.cn` / `xhs.cn` short links to the note URL;
 * 2. parse `window.__INITIAL_STATE__` (falling back to `og:*` meta tags);
 * 3. self-heal with different URL + header profiles when the WAF answers with a
 *    login / 404 shell (see `extractXhs`);
 * 4. always degrade to a partial clip instead of raising, and never persist a
 *    `/login?...` or `/404?...` shell as the clip URL.
 *
 * The MediaCrawler MCP bridge is server-only and intentionally not ported:
 * offline mobile clipping must work without extra infrastructure.
 */

import { parse } from 'node-html-parser';

import type { ExtractedContent } from './base';
import {
  BROWSER_HEADERS,
  asArray,
  cleanText,
  composeMarkdown,
  degradedContent,
  errorLabel,
  fallbackTitle,
  fetchHtml,
  firstLine,
  htmlToMarkdown,
  isRecord,
  metaContent,
  ogImages,
} from './generic';
import { extractUrl, normalizeUrl, splitUrlParts } from '../urlUtils';
import type { ParsedUrlParts } from '../urlUtils';

export const XHS_REFERER = 'https://www.xiaohongshu.com/';
export const STATE_MARKER = 'window.__INITIAL_STATE__';

/**
 * XHS-only transport headers.
 *
 * The Xiaohongshu WAF 302s `/login?redirectPath=...` for any request whose
 * `Accept-Encoding` advertises a compressible coding: Android OkHttp sends
 * `gzip` by default and Node/Undici sends `br, gzip, deflate`. Manually
 * setting `gzip, deflate` in OkHttp *passes* the WAF but disables OkHttp's
 * transparent decompression, producing mojibake. Asking for `identity` only
 * (`gzip;q=0, deflate;q=0, identity`) satisfies both: 200 + plain UTF-8 HTML
 * with the full `window.__INITIAL_STATE__` payload.
 *
 * Never merge this into `BROWSER_HEADERS`: WeChat and friends ignore `q=0`
 * and still gzip, which OkHttp would then hand back compressed.
 */
export const XHS_HEADERS: Record<string, string> = {
  ...BROWSER_HEADERS,
  'Accept-Encoding': 'gzip;q=0, deflate;q=0, identity',
  // The WAF also fingerprints the navigation headers: a top-level browser
  // navigation never asks for a cached page and always announces itself.
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/** Android Chrome profile used by the `/explore/<noteId>` self-healing retry. */
export const XHS_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

/**
 * Second-chance transport profile.
 *
 * The login wall is usually served because the request looks like a desktop
 * scraper; the very same note is often readable through a plain Android Chrome
 * navigation (same `identity` encoding trick as `XHS_HEADERS`).
 */
export const XHS_EXPLORE_HEADERS: Record<string, string> = {
  ...XHS_HEADERS,
  'User-Agent': XHS_MOBILE_USER_AGENT,
};

/** Shown when the WAF/login wall is all we got back. */
export const XHS_LOGIN_BLOCK_MESSAGE =
  '小红书触发了登录/风控拦截，可能受 VPN/代理或 5G 出口 IP 影响；'
  + '建议关闭代理后重试，或在设置里开启家庭 NUC 兜底抓取';

const LOGIN_PATH_RE = /^\/(?:website-)?login(?:\/|$)/;
const NOT_FOUND_PATH_RE = /^\/404(?:\/|$)/;

/** `xiaohongshu.com` and every subdomain (redirect targets are upgraded to TLS). */
const XHS_HOST_RE = /(?:^|\.)xiaohongshu\.com$/i;

/** Share short-link hosts: the only URL that still self-heals on a retry. */
const XHS_SHORT_HOSTS = ['xhslink.cn', 'xhslink.com', 'xhs.cn'];

const SHORT_LINK_SCAN_RE =
  /https?:\/\/(?:[A-Za-z0-9-]+\.)*(?:xhslink\.cn|xhslink\.com|xhs\.cn)\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*/gi;

const ABSOLUTE_URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const BARE_HOST_RE = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#]|$)/;
const SITE_NAME_TITLES = new Set(['小红书', '小红书 - 你的生活兴趣社区']);
const XHSCDN_HTTP_RE = /^http:\/\/(?:[^/]*\.)?xhscdn\.com\//i;
const INLINE_SPACE_RE = /[ \t\u00a0\u3000]+/g;

const NOTE_ID_RE = /\/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]+)/;

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return Boolean(value);
}

function decodeQueryValue(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** True when the URL (or path) is the login / 404 shell XHS bounces us to. */
function isLoginLandingPage(url: string): boolean {
  const path = splitUrlParts(url).path || '';
  return LOGIN_PATH_RE.test(path) || NOT_FOUND_PATH_RE.test(path);
}

function isXhsHost(hostname: string): boolean {
  return Boolean(hostname) && XHS_HOST_RE.test(hostname);
}

/**
 * Normalize a Xiaohongshu URL: force TLS and drop redirect noise.
 *
 * The redirect chain appends `exSource=null`; it is pure noise and (being an
 * unencoded duplicate key) confuses the note API. `xsec_token` / `xsec_source`
 * and every other param are preserved verbatim because they are signed.
 */
export function cleanXhsUrl(url: string): string {
  const value = (url || '').trim();
  if (!value) return value;

  const parts = splitUrlParts(value);
  if (!isXhsHost(parts.hostname)) return value;

  const kept: string[] = [];
  for (const chunk of parts.query.split('&')) {
    if (!chunk) continue;
    const equalsAt = chunk.indexOf('=');
    const key = decodeQueryValue(equalsAt >= 0 ? chunk.slice(0, equalsAt) : chunk).toLowerCase();
    const paramValue = equalsAt >= 0 ? decodeQueryValue(chunk.slice(equalsAt + 1)) : '';
    if (key === 'exsource' && (!paramValue || paramValue.toLowerCase() === 'null')) continue;
    kept.push(chunk);
  }

  const netloc = parts.netloc || parts.hostname;
  const query = kept.length ? `?${kept.join('&')}` : '';
  const fragment = parts.fragment ? `#${parts.fragment}` : '';
  return `https://${netloc}${parts.path}${query}${fragment}`;
}

/** True when `url` is a Xiaohongshu share short link. */
export function isXhsShortLink(url: string): boolean {
  const host = splitUrlParts(url).hostname;
  if (!host) return false;
  return XHS_SHORT_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

/** First Xiaohongshu share short link inside the original share caption. */
export function extractXhsShortLink(rawInput: string): string | null {
  const matches = (rawInput || '').match(SHORT_LINK_SCAN_RE) || [];
  for (const match of matches) {
    const candidate = extractUrl(match);
    if (candidate && isXhsShortLink(candidate)) return candidate;
  }
  return null;
}

/** Resolve a `redirectPath` / `source` value against the shell that carries it. */
function absolutizeRedirect(target: string, base: ParsedUrlParts): string | null {
  let value = (target || '').trim();
  if (!value) return null;

  const origin = base.netloc || base.hostname;
  if (value.startsWith('//')) value = `https:${value}`;
  else if (value.startsWith('/')) value = `https://${origin}${value}`;
  else if (!ABSOLUTE_URL_RE.test(value)) {
    value = BARE_HOST_RE.test(value)
      ? `https://${value}`
      : `https://${origin}/${value.replace(/^\/+/, '')}`;
  }
  return /^https?:\/\//i.test(value) ? value : null;
}

/** First non-empty value of `names` inside a shell's query string. */
function readRedirectParam(url: string, names: readonly string[]): string {
  const parts = splitUrlParts(url);
  for (const chunk of parts.query.split('&')) {
    if (!chunk) continue;
    const equalsAt = chunk.indexOf('=');
    const key = decodeQueryValue(equalsAt >= 0 ? chunk.slice(0, equalsAt) : chunk).toLowerCase();
    if (!names.includes(key)) continue;
    const value = decodeQueryValue(equalsAt >= 0 ? chunk.slice(equalsAt + 1) : '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * Unwrap `/login?redirectPath=<real note>` and `/404?...` shells into the note
 * URL (max 5 hops).
 *
 * Needed three times: the WAF redirect itself, `parseXhsHtml` deciding whether
 * it only saw a shell, and old clips that already stored a `/login?...` URL
 * (re-fetching them must recover the real note). Handled shell flavours:
 *
 * - `/login?redirectPath=...`, `/website-login/*?redirectPath=...`
 * - `/404/sec_<id>?redirectPath=...`
 * - `/404?source=/404/sec_<id>?redirectPath=...` (nested, `source` hops first)
 *
 * Every result is TLS-upgraded and `exSource=null` is stripped, so the caller
 * never stores an `http://` note URL or a noise param.
 */
export function unwrapXhsRedirect(url: string): string {
  const original = cleanXhsUrl((url || '').trim());
  if (!original) return original;

  let current = original;
  // A dead-end shell (`/404?source=/404/sec_...` without `redirectPath`) has no
  // note to recover: keep the first non-shell candidate, else the input.
  let resolved = isLoginLandingPage(original) ? '' : original;

  for (let depth = 0; depth < 5; depth += 1) {
    const parts = splitUrlParts(current);
    const path = parts.path || '';
    if (!LOGIN_PATH_RE.test(path) && !NOT_FOUND_PATH_RE.test(path)) break;

    const rawTarget =
      readRedirectParam(current, ['redirectpath', 'redirect_path'])
      || readRedirectParam(current, ['source']);
    if (!rawTarget) break;

    const absolutized = absolutizeRedirect(rawTarget, parts);
    if (!absolutized) break;

    const next = cleanXhsUrl(absolutized);
    if (!next || next === current) break;

    current = next;
    if (!isLoginLandingPage(next)) {
      resolved = next;
      break;
    }
  }
  return resolved || original;
}

/** `<origin>/explore/<noteId>?<原 query>`：`xsec_token` 必须随行，否则必然 404。 */
function buildExploreUrl(url: string, noteId: string): string {
  const parts = splitUrlParts(url);
  const origin = isXhsHost(parts.hostname) && parts.netloc
    ? `https://${parts.netloc}`
    : 'https://www.xiaohongshu.com';
  const query = parts.query ? `?${parts.query}` : '';
  return `${origin}/explore/${noteId}${query}`;
}

/** Extract a note id from a canonical XHS URL (path or query string). */
export function extractNoteId(url: string): string | null {
  if (!url) return null;
  const parts = splitUrlParts(url);
  const match = NOTE_ID_RE.exec(parts.path);
  if (match) return match[1];

  for (const key of ['noteId', 'note_id', 'noteid']) {
    for (const chunk of parts.query.split('&')) {
      if (!chunk) continue;
      const equalsAt = chunk.indexOf('=');
      const rawKey = equalsAt >= 0 ? chunk.slice(0, equalsAt) : chunk;
      const rawValue = equalsAt >= 0 ? chunk.slice(equalsAt + 1) : '';
      if (rawKey !== key) continue;
      let decoded = rawValue;
      try {
        decoded = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      } catch {
        decoded = rawValue;
      }
      if (decoded.trim()) return decoded.trim();
    }
  }
  return null;
}

/** Return the balanced `{...}` object starting at `start` (string-aware). */
export function sliceJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function loadsLenient(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(raw.replace(/\bundefined\b/g, 'null'));
    } catch {
      return null;
    }
  }
  return isRecord(parsed) ? parsed : null;
}

/** Parse the `window.__INITIAL_STATE__` blob embedded in a note page. */
export function extractInitialState(html: string): Record<string, unknown> | null {
  const markerAt = html.indexOf(STATE_MARKER);
  if (markerAt < 0) return null;
  const assignAt = html.indexOf('=', markerAt + STATE_MARKER.length);
  if (assignAt < 0) return null;
  const start = html.indexOf('{', assignAt);
  if (start < 0) return null;
  const raw = sliceJsonObject(html, start);
  if (!raw) return null;
  return loadsLenient(raw);
}

function looksLikeNote(node: unknown): node is Record<string, unknown> {
  if (!isRecord(node)) return false;
  return truthy(node.imageList) || truthy(node.images) || truthy(node.desc) || truthy(node.title);
}

function deepFindNote(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 14) return null;
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = deepFindNote(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;

  if (
    looksLikeNote(node) &&
    ['user', 'imageList', 'noteId', 'note_id', 'images'].some((key) => truthy(node[key]))
  ) {
    return node;
  }
  for (const value of Object.values(node)) {
    const found = deepFindNote(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Locate the note object inside the (deeply nested) initial state. */
export function findNote(state: unknown): Record<string, unknown> | null {
  if (!isRecord(state)) return null;
  const noteBlock = state.note;
  if (isRecord(noteBlock)) {
    const detailMap = noteBlock.noteDetailMap;
    if (isRecord(detailMap)) {
      for (const value of Object.values(detailMap)) {
        const candidate = isRecord(value) ? value.note : null;
        if (looksLikeNote(candidate)) return candidate;
      }
    }
    for (const key of ['note', 'data', 'detail', 'serverRequestInfo']) {
      const candidate = noteBlock[key];
      if (looksLikeNote(candidate)) return candidate;
    }
  }
  return deepFindNote(state);
}

/** XHS CDN hosts are HTTP-only in the payload; force HTTPS so RN can load them. */
function upgradeToHttps(url: string): string {
  return XHSCDN_HTTP_RE.test(url) ? `https://${url.slice('http://'.length)}` : url;
}

/** Pick exactly one rendition for an `imageList` entry, best quality first. */
function preferredImageUrl(item: Record<string, unknown>): string {
  const infoList = asArray(item.infoList).filter(isRecord);
  const defaultScene = infoList.find((entry) => cleanText(entry.imageScene) === 'WB_DFT');
  const candidates: unknown[] = [
    item.urlDefault,
    item.masterUrl,
    item.master_url,
    item.url_default,
    defaultScene ? defaultScene.url : undefined,
    item.url,
    item.urlPre,
    ...infoList.map((entry) => entry.url),
  ];
  for (const candidate of candidates) {
    const url = upgradeToHttps(cleanText(candidate));
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
  }
  return '';
}

function noteImages(note: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const add = (value: unknown): void => {
    const url = upgradeToHttps(cleanText(value));
    if ((url.startsWith('http://') || url.startsWith('https://')) && !urls.includes(url)) {
      urls.push(url);
    }
  };

  for (const item of asArray(note.imageList)) {
    if (typeof item === 'string') {
      add(item);
      continue;
    }
    if (!isRecord(item)) continue;
    // Exactly one (best) rendition per imageList entry: XHS ships the same photo
    // under urlDefault/urlPre/url/masterUrl + infoList, which used to leak 3-4
    // duplicates of every picture into the clip.
    add(preferredImageUrl(item));
  }

  for (const key of ['images', 'image_list', 'imageUrls']) {
    for (const item of asArray(note[key])) {
      if (typeof item === 'string') {
        add(item);
      } else if (isRecord(item)) {
        add(preferredImageUrl(item));
      }
    }
  }

  const video = note.video;
  if (isRecord(video)) {
    const media = isRecord(video.media) ? video.media : video;
    for (const key of ['thumbnail', 'thumbnailUrl', 'thumbnail_url', 'cover', 'coverUrl']) {
      add(media[key]);
    }
  }
  return urls;
}

function noteTime(note: Record<string, unknown>): string | null {
  let raw = note.time || note.createTime || note.create_time;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    raw = Number.parseInt(raw.trim(), 10);
  }
  if (typeof raw === 'number' && raw > 0) {
    const seconds = raw > 1e11 ? raw / 1000 : raw;
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return null;
    const iso = date.toISOString();
    return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}+00:00` : iso.replace(/Z$/, '+00:00');
  }
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

/**
 * Collapse inline whitespace but keep the author's paragraph breaks.
 *
 * `cleanText` used to flatten multi-paragraph 小红书 notes into one line, which
 * destroyed every list and line break in the stored body.
 */
function normalizeParagraphs(value: unknown): string {
  if (typeof value !== 'string') return cleanText(value);
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(INLINE_SPACE_RE, ' ').trim());

  const kept: string[] = [];
  for (const line of lines) {
    if (!line) {
      // At most one blank line between paragraphs (=> `\n\n` when joined).
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
}

/** Prefer plain description; fall back to converting a rich-text body if present. */
function noteBodyText(note: Record<string, unknown>): string {
  const desc = normalizeParagraphs(note.desc ?? note.description);
  if (desc) return desc;
  for (const key of ['content', 'noteContent', 'body']) {
    const value = note[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    return htmlToMarkdown(value) || normalizeParagraphs(value);
  }
  return '';
}

function buildFromNote(
  note: Record<string, unknown>,
  finalUrl: string,
  rawInput: string,
): ExtractedContent {
  const user = isRecord(note.user) ? note.user : {};
  let title = cleanText(note.title) || cleanText(note.displayTitle);
  const body = noteBodyText(note);
  if (!title) title = firstLine(body, 60);
  title = title || fallbackTitle(rawInput, finalUrl);

  const author = cleanText(user.nickname || user.nickName || user.name);
  const imageUrls = noteImages(note);
  const publishedAt = noteTime(note);

  const metaLine = [author, publishedAt].filter(Boolean).join(' · ');
  const contentMarkdown = composeMarkdown({ title, metaLine, body, imageUrls });

  return {
    platform: 'xiaohongshu',
    url: finalUrl,
    title,
    author,
    published_at: publishedAt,
    content_markdown: contentMarkdown,
    content_text: body || title,
    image_urls: imageUrls,
    partial: false,
    error_message: null,
    referer: XHS_REFERER,
  };
}

function ogFallback(html: string): Record<string, string> {
  const root = parse(html);
  const data: Record<string, string> = {};
  const title = metaContent(root, 'og:title') || metaContent(root, 'twitter:title');
  const description = metaContent(root, 'og:description') || metaContent(root, 'description');
  if (title) data.title = title;
  if (description) data.description = description;

  const images = ogImages(root).filter(Boolean);
  if (images.length) {
    const normalized: string[] = [];
    for (const image of images) {
      const value = normalizeUrl(image);
      if (!normalized.includes(value)) normalized.push(value);
    }
    data.images = normalized.join(',');
  }
  return data.title || data.description ? data : {};
}

function buildFromOg(og: Record<string, string>, finalUrl: string, rawInput: string): ExtractedContent {
  const title = og.title || fallbackTitle(rawInput, finalUrl);
  const body = og.description || '';
  const imageUrls = (og.images || '').split(',').filter(Boolean);
  return {
    platform: 'xiaohongshu',
    url: finalUrl,
    title,
    author: '',
    published_at: null,
    content_markdown: composeMarkdown({ title, body, imageUrls }),
    content_text: body || title,
    image_urls: imageUrls,
    partial: true,
    error_message: '仅解析到页面 og 元数据，正文可能不完整（疑似风控）',
    referer: XHS_REFERER,
  };
}

function degradedXhs(url: string, rawInput: string, message: string): ExtractedContent {
  return degradedContent({
    platform: 'xiaohongshu',
    url,
    rawInput,
    errorMessage: message,
    referer: XHS_REFERER,
    textFallbackToUrl: true,
  });
}

function looksLikeLoginShell(url: string, og: Record<string, string>): boolean {
  if (isLoginLandingPage(url)) return true;
  // The login/404 shell only carries the site name plus a logo image.
  if (!SITE_NAME_TITLES.has(cleanText(og.title))) return false;
  return !cleanText(og.description);
}

/** Pure HTML parser used by the XHS extractor (and unit tests). */
export function parseXhsHtml(html: string, url: string, rawInput = ''): ExtractedContent {
  const note = findNote(extractInitialState(html));
  if (note) return buildFromNote(note, url, rawInput);

  const og = ogFallback(html);
  // Never turn a login/404 shell into a "clip" of the site name + logo.
  if (looksLikeLoginShell(url, og)) {
    return degradedXhs(unwrapXhsRedirect(url), rawInput, XHS_LOGIN_BLOCK_MESSAGE);
  }
  if (og.title || og.description) return buildFromOg(og, url, rawInput);

  return degradedXhs(url, rawInput, '未在页面中找到 window.__INITIAL_STATE__ 笔记数据');
}

/** How much usable data a (possibly partial) extraction carries. */
function richness(content: ExtractedContent | null, rawInput: string): number {
  if (!content) return -1;
  if (!content.partial) return 1000;
  let score = 0;
  if (content.image_urls.length) score += 10 + Math.min(content.image_urls.length, 5);
  const text = String(content.content_text ?? '').trim();
  const raw = String(rawInput ?? '').trim();
  if (text && text !== raw && text !== String(content.url ?? '').trim()) score += 5;
  if (String(content.author ?? '').trim()) score += 1;
  return score;
}

/**
 * Pick the `url` a degraded clip should store.
 *
 * A share short link is the only input that still self-heals on retry, so it is
 * never replaced by an unverified redirect target. Any other input degrades to
 * the unwrapped (TLS, noise-free) note URL — never the `/login` / `/404` shell.
 */
function resolveDegradedUrl(inputUrl: string, requested: string): string {
  const original = (inputUrl || '').trim();
  if (isXhsShortLink(original)) return original;

  const candidate = requested || original;
  if (!candidate) return original;
  // `requested` is already unwrapped, but a dead-end shell can survive: never
  // store `/login` or `/404` as a clip URL.
  if (isLoginLandingPage(candidate)) return XHS_REFERER;
  return candidate;
}

/**
 * Fetch and parse a Xiaohongshu note; never throws.
 *
 * Self-healing ladder (each rung is skipped when the exact same URL + header
 * profile was already requested, since the WAF answer would be identical):
 *
 * 1. the request itself — `requested` is already unwrapped/TLS-upgraded;
 * 2. the note URL revealed by a `/login` / `/404` redirect at network time;
 * 3. `/explore/<noteId>?<原始 query>` with an Android Chrome profile;
 * 4. the original short link recovered from `rawInput` (old clips whose
 *    `clip.url` was rewritten to a wrong note id still heal on “重新抓取”).
 */
export async function extractXhs(url: string, rawInput = ''): Promise<ExtractedContent> {
  const inputUrl = (url || '').trim();
  // A previously polluted clip may still hold `/login?redirectPath=<note>`.
  const requested = unwrapXhsRedirect(inputUrl) || inputUrl;

  const errors: string[] = [];
  const tried = new Set<string>();
  const partials: ExtractedContent[] = [];
  let lastNoteUrl = '';

  const attempt = async (
    target: string,
    headers: Record<string, string>,
  ): Promise<ExtractedContent | null> => {
    if (!target) return null;
    const key = `${target}\n${headers['User-Agent'] || ''}\n${headers['Accept-Encoding'] || ''}`;
    if (tried.has(key)) return null;
    tried.add(key);

    try {
      const page = await fetchHtml(target, headers);
      const finalUrl = (page.finalUrl || target).trim() || target;
      const noteUrl = unwrapXhsRedirect(finalUrl) || finalUrl;
      if (!isLoginLandingPage(noteUrl)) lastNoteUrl = noteUrl;

      const content = parseXhsHtml(page.html, noteUrl, rawInput);
      if (!content.partial) return content;
      // Keep every partial: the richest one is returned if no rung succeeds.
      partials.push(content);
      return null;
    } catch (error) {
      errors.push(errorLabel(error));
      return null;
    }
  };

  // 1) Fresh stateless request (no cookies, identity encoding, navigation headers).
  let content = await attempt(requested, XHS_HEADERS);

  // 2) The redirect chain only revealed the canonical note URL at network time.
  if (!content && lastNoteUrl && lastNoteUrl !== requested) {
    content = await attempt(lastNoteUrl, XHS_HEADERS);
  }

  // 3) The canonical desktop page is walled, but the note id is known.
  if (!content) {
    const exploreSource = lastNoteUrl || requested || inputUrl;
    const noteId =
      extractNoteId(exploreSource) || extractNoteId(requested) || extractNoteId(inputUrl);
    if (noteId) content = await attempt(buildExploreUrl(exploreSource, noteId), XHS_EXPLORE_HEADERS);
  }

  // 4) Old clips rewrote `clip.url` to a wrong note id; the share caption still
  //    holds the original short link, so walk it again (and its redirect).
  if (!content) {
    const shortLink = extractXhsShortLink(rawInput);
    if (shortLink && shortLink !== requested) {
      content = await attempt(shortLink, XHS_HEADERS);
      if (!content && lastNoteUrl && lastNoteUrl !== shortLink) {
        content = await attempt(lastNoteUrl, XHS_HEADERS);
      }
    }
  }

  if (content) return content;

  const fallbackUrl = resolveDegradedUrl(inputUrl, requested);

  let bestPartial: ExtractedContent | null = null;
  for (const partial of partials) {
    if (richness(partial, rawInput) > richness(bestPartial, rawInput)) bestPartial = partial;
  }

  if (bestPartial) {
    return {
      ...bestPartial,
      url: isXhsShortLink(inputUrl)
        ? inputUrl
        : (isLoginLandingPage(bestPartial.url) || !bestPartial.url ? fallbackUrl : bestPartial.url),
      error_message:
        [...(errors.length ? [errors.join('；')] : []), bestPartial.error_message ?? ''].filter(Boolean).join('；')
        || XHS_LOGIN_BLOCK_MESSAGE,
    };
  }

  return degradedXhs(
    fallbackUrl,
    rawInput,
    errors.join('；') || XHS_LOGIN_BLOCK_MESSAGE,
  );
}
