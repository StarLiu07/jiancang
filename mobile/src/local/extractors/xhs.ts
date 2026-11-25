/**
 * Xiaohongshu (RED) extractor with layered fallbacks.
 *
 * Strategy (mirrors `backend/app/services/extractors/xhs.py`):
 * 1. follow `xhslink.com` short links to the canonical note URL;
 * 2. parse `window.__INITIAL_STATE__` (falling back to `og:*` meta tags);
 * 3. always degrade to a partial clip instead of raising.
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
import { normalizeUrl, splitUrlParts } from '../urlUtils';

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
};

/** Shown when the WAF/login wall is all we got back. */
export const XHS_LOGIN_BLOCK_MESSAGE = '触发小红书登录拦截，无法直接读取笔记';

const LOGIN_PATH_RE = /^\/(?:website-)?login(?:\/|$)/;
const NOT_FOUND_PATH_RE = /^\/404(?:\/|$)/;
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

/**
 * Unwrap `/login?redirectPath=<real note>` into the note URL.
 *
 * Needed twice: the WAF redirect itself, and old clips that already stored the
 * `/login?...` URL (re-fetching them must recover the real note).
 */
export function unwrapXhsRedirect(url: string): string {
  let current = (url || '').trim();
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const parts = splitUrlParts(current);
    if (!LOGIN_PATH_RE.test(parts.path || '')) return current;

    let target = '';
    for (const chunk of parts.query.split('&')) {
      if (!chunk) continue;
      const equalsAt = chunk.indexOf('=');
      const key = decodeQueryValue(equalsAt >= 0 ? chunk.slice(0, equalsAt) : chunk).toLowerCase();
      if (key !== 'redirectpath' && key !== 'redirect_path') continue;
      target = decodeQueryValue(equalsAt >= 0 ? chunk.slice(equalsAt + 1) : '').trim();
      if (target) break;
    }
    if (!target) return current;

    if (target.startsWith('//')) target = `https:${target}`;
    if (target.startsWith('/')) {
      target = `${(parts.scheme || 'https').toLowerCase()}://${parts.netloc}${target}`;
    }
    if (!/^https?:\/\//i.test(target)) return current;
    current = target;
  }
  return current;
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

/** Fetch and parse a Xiaohongshu note; never throws. */
export async function extractXhs(url: string, rawInput = ''): Promise<ExtractedContent> {
  const errors: string[] = [];
  // A previously polluted clip may still hold `/login?redirectPath=<note>`.
  const requested = unwrapXhsRedirect(url);

  try {
    let page = await fetchHtml(requested, XHS_HEADERS);
    let finalUrl = (page.finalUrl || requested).trim() || requested;
    let noteUrl = unwrapXhsRedirect(finalUrl);

    if (noteUrl !== finalUrl) {
      // The WAF bounced us into the login shell; the real note survived in
      // `redirectPath`, so retry once with the unwrapped URL.
      try {
        page = await fetchHtml(noteUrl, XHS_HEADERS);
        finalUrl = (page.finalUrl || noteUrl).trim() || noteUrl;
        noteUrl = unwrapXhsRedirect(finalUrl);
      } catch (error) {
        errors.push(errorLabel(error));
      }
    }

    if (isLoginLandingPage(finalUrl)) {
      return degradedXhs(noteUrl, rawInput, XHS_LOGIN_BLOCK_MESSAGE);
    }

    const content = parseXhsHtml(page.html, noteUrl, rawInput);
    if (errors.length && content.partial) {
      return {
        ...content,
        error_message: [errors.join('；'), content.error_message ?? ''].filter(Boolean).join('；'),
      };
    }
    return content;
  } catch (error) {
    errors.push(errorLabel(error));
  }

  return degradedXhs(requested || url, rawInput, errors.join('；') || '小红书内容提取失败');
}
