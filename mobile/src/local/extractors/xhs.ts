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

const NOTE_ID_RE = /\/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]+)/;
const IMAGE_KEYS = ['urlDefault', 'urlPre', 'url', 'masterUrl', 'master_url', 'url_default'];

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return Boolean(value);
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

function noteImages(note: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const add = (value: unknown): void => {
    const url = cleanText(value);
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
    for (const key of IMAGE_KEYS) {
      if (item[key]) {
        add(item[key]);
        break;
      }
    }
    for (const entry of asArray(item.infoList)) {
      if (isRecord(entry)) add(entry.url);
    }
  }

  for (const key of ['images', 'image_list', 'imageUrls']) {
    for (const item of asArray(note[key])) {
      if (typeof item === 'string') {
        add(item);
      } else if (isRecord(item)) {
        for (const imageKey of IMAGE_KEYS) {
          if (item[imageKey]) {
            add(item[imageKey]);
            break;
          }
        }
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

/** Prefer plain description; fall back to converting a rich-text body if present. */
function noteBodyText(note: Record<string, unknown>): string {
  const desc = cleanText(note.desc || note.description);
  if (desc) return desc;
  for (const key of ['content', 'noteContent', 'body']) {
    const value = note[key];
    if (typeof value === 'string' && value.trim()) {
      return cleanText(htmlToMarkdown(value));
    }
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

/** Pure HTML parser used by the XHS extractor (and unit tests). */
export function parseXhsHtml(html: string, url: string, rawInput = ''): ExtractedContent {
  const note = findNote(extractInitialState(html));
  if (note) return buildFromNote(note, url, rawInput);

  const og = ogFallback(html);
  if (og.title || og.description) return buildFromOg(og, url, rawInput);

  return degradedXhs(url, rawInput, '未在页面中找到 window.__INITIAL_STATE__ 笔记数据');
}

/** Fetch and parse a Xiaohongshu note; never throws. */
export async function extractXhs(url: string, rawInput = ''): Promise<ExtractedContent> {
  let finalUrl = url;
  const errors: string[] = [];

  try {
    const page = await fetchHtml(url, BROWSER_HEADERS);
    finalUrl = page.finalUrl || url;

    const note = findNote(extractInitialState(page.html));
    if (note) return buildFromNote(note, finalUrl, rawInput);

    const og = ogFallback(page.html);
    if (og.title || og.description) return buildFromOg(og, finalUrl, rawInput);

    errors.push('未在页面中找到 window.__INITIAL_STATE__ 笔记数据');
  } catch (error) {
    errors.push(errorLabel(error));
  }

  return degradedXhs(finalUrl || url, rawInput, errors.join('；') || '小红书内容提取失败');
}
