/**
 * Generic web page extractor plus shared HTML helpers used by other extractors.
 *
 * Ported from `backend/app/services/extractors/generic.py`, replacing
 * BeautifulSoup + html2text with the pure-JS `node-html-parser`.
 */

import { parse, HTMLElement, NodeType } from 'node-html-parser';
import type { Node } from 'node-html-parser';

import type { ExtractedContent } from './base';
import { extractUrl, splitUrlParts } from '../urlUtils';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': DEFAULT_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

export const NOISE_TAGS = ['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'iframe', 'form', 'svg'];

const LAZY_IMAGE_ATTRS = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-echo', 'src'];

const OG_IMAGE_KEYS = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];

const WHITESPACE_RE = /[ \t\u3000\u00a0]+/g;
const BLANK_LINES_RE = /\n{3,}/g;
const URL_IN_TEXT_RE = /https?:\/\/\S+/g;

const SKIP_TAGS = new Set(['head', 'title', 'meta', 'link', 'base', 'template']);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

function tagOf(node: Node): string {
  return (node.rawTagName || '').toLowerCase();
}

/** Collapse all runs of whitespace into single spaces (backend `_clean_text`). */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).split(/\s+/).filter(Boolean).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function parseRoot(markup: string | HTMLElement): HTMLElement {
  return typeof markup === 'string' ? parse(markup) : markup;
}

export function tidyMarkdown(text: string): string {
  let value = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  value = value.replace(WHITESPACE_RE, ' ');
  value = value
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  value = value.replace(BLANK_LINES_RE, '\n\n');
  return value.trim();
}

// ---------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------

function imageMarkdown(node: HTMLElement): string {
  const src = (node.getAttribute('src') || '').trim();
  if (!src) return '';
  const lowered = src.toLowerCase();
  if (['data:', 'javascript:', 'blob:', 'about:'].some((prefix) => lowered.startsWith(prefix))) return '';
  const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '');
  const title = (node.getAttribute('title') || '').trim();
  const suffix = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
  return `![${alt}](${src}${suffix})`;
}

function renderList(node: HTMLElement): string {
  const ordered = tagOf(node) === 'ol';
  const lines: string[] = [];
  let index = 1;

  for (const child of node.childNodes) {
    if (!isElement(child) || tagOf(child) !== 'li') {
      if (isElement(child)) {
        const loose = renderMarkdownNode(child).trim();
        if (loose) lines.push(loose);
      }
      continue;
    }

    const marker = ordered ? `${index}. ` : '- ';
    index += 1;
    const parts: string[] = [];
    const nested: string[] = [];
    for (const itemChild of child.childNodes) {
      if (isElement(itemChild) && ['ul', 'ol'].includes(tagOf(itemChild))) {
        nested.push(renderList(itemChild));
      } else {
        parts.push(renderMarkdownNode(itemChild));
      }
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    lines.push(`${marker}${text}`.trimEnd());
    for (const block of nested) {
      for (const line of block.trim().split('\n')) {
        if (line) lines.push(`  ${line}`);
      }
    }
  }

  return lines.join('\n');
}

function renderTable(node: HTMLElement): string {
  const rows: string[] = [];
  for (const row of node.querySelectorAll('tr')) {
    const cells = row
      .querySelectorAll('td,th')
      .map((cell) => renderMarkdownNode(cell).replace(/\s+/g, ' ').trim());
    if (cells.length) rows.push(`| ${cells.join(' | ')} |`);
  }
  if (!rows.length) {
    const loose = renderChildren(node).trim();
    return loose ? `\n\n${loose}\n\n` : '';
  }
  if (rows.length > 1) rows.splice(1, 0, `|${' --- |'.repeat(rows[0].split('|').length - 2)}`);
  return `\n\n${rows.join('\n')}\n\n`;
}

function renderBlockquote(node: HTMLElement): string {
  const inner = renderChildren(node).trim();
  if (!inner) return '';
  const quoted = inner
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `\n\n${quoted}\n\n`;
}

function renderChildren(node: Node): string {
  let output = '';
  for (const child of node.childNodes) output += renderMarkdownNode(child);
  return output;
}

function renderMarkdownNode(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return (node.text || '').replace(/\s+/g, ' ');
  }
  if (node.nodeType === NodeType.COMMENT_NODE) return '';
  if (!isElement(node)) return '';

  const tag = tagOf(node);
  if (SKIP_TAGS.has(tag)) return '';
  if (NOISE_TAGS.includes(tag)) return '';

  switch (tag) {
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'img':
      return imageMarkdown(node);
    case 'a': {
      const href = (node.getAttribute('href') || '').trim();
      const inner = renderChildren(node).trim();
      if (href) return inner ? `[${inner}](${href})` : href;
      return inner;
    }
    case 'strong':
    case 'b': {
      const inner = renderChildren(node).trim();
      return inner ? `**${inner}**` : '';
    }
    case 'em':
    case 'i': {
      const inner = renderChildren(node).trim();
      return inner ? `*${inner}*` : '';
    }
    case 'del':
    case 's':
    case 'strike': {
      const inner = renderChildren(node).trim();
      return inner ? `~~${inner}~~` : '';
    }
    case 'code': {
      const inner = renderChildren(node).trim();
      return inner ? `\`${inner}\`` : '';
    }
    case 'pre': {
      const raw = (node.text || '').replace(/\r\n/g, '\n').trim();
      return raw ? `\n\n\`\`\`\n${raw}\n\`\`\`\n\n` : '';
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const inner = renderChildren(node).trim();
      return inner ? `\n\n${'#'.repeat(Number(tag[1]))} ${inner}\n\n` : '';
    }
    case 'ul':
    case 'ol':
      return `\n\n${renderList(node)}\n\n`;
    case 'table':
      return renderTable(node);
    case 'blockquote':
      return renderBlockquote(node);
    default:
      if (BLOCK_TAGS.has(tag)) return `\n\n${renderChildren(node)}\n\n`;
      return renderChildren(node);
  }
}

/** Convert an HTML snippet/node into clean Markdown. */
export function htmlToMarkdown(markup: string | HTMLElement): string {
  if (typeof markup === 'string' && !markup.trim()) return '';
  return tidyMarkdown(renderChildren(parseRoot(markup)));
}

// ---------------------------------------------------------------------------
// HTML -> plain text
// ---------------------------------------------------------------------------

function collectText(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text || '';
  if (node.nodeType === NodeType.COMMENT_NODE) return '';
  if (!isElement(node)) return '';

  const tag = tagOf(node);
  if (SKIP_TAGS.has(tag) || NOISE_TAGS.includes(tag)) return '';
  if (tag === 'br') return '\n';

  const inner = node.childNodes.map((child) => collectText(child)).join('');
  if (tag === 'pre') return `\n${inner}\n`;
  if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
  return inner;
}

/** Extract readable plain text (no Markdown syntax) from HTML. */
export function htmlToText(markup: string | HTMLElement): string {
  if (typeof markup === 'string' && !markup.trim()) return '';
  const raw = collectText(parseRoot(markup));
  const lines = raw
    .split('\n')
    .map((line) => line.replace(WHITESPACE_RE, ' ').trim())
    .filter((line) => line.length > 0);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function findMeta(root: HTMLElement, attr: string, key: string): HTMLElement | null {
  try {
    return root.querySelector(`meta[${attr}="${key}"]`);
  } catch {
    return null;
  }
}

function findAllMeta(root: HTMLElement, attr: string, key: string): HTMLElement[] {
  try {
    return root.querySelectorAll(`meta[${attr}="${key}"]`);
  } catch {
    return [];
  }
}

/** Return `content` of a meta tag matched by property/name/itemprop. */
export function metaContent(root: HTMLElement, key: string): string {
  let tag = findMeta(root, 'property', key);
  if (!tag) tag = findMeta(root, 'name', key);
  if (!tag) tag = findMeta(root, 'itemprop', key);
  if (!tag) return '';
  return (tag.getAttribute('content') || '').trim();
}

export function ogImages(root: HTMLElement): string[] {
  const urls: string[] = [];
  for (const key of OG_IMAGE_KEYS) {
    const tags = [...findAllMeta(root, 'property', key), ...findAllMeta(root, 'name', key)];
    for (const tag of tags) {
      const value = (tag.getAttribute('content') || '').trim();
      if (value && !urls.includes(value)) urls.push(value);
    }
  }
  return urls;
}

/** Normalize an image URL, dropping data URIs and resolving relative ones. */
export function cleanImageUrl(raw: string | null | undefined, baseUrl = ''): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/^["']+|["']+$/g, '');
  if (!value) return null;
  const lowered = value.toLowerCase();
  if (['data:', 'javascript:', 'blob:', 'about:'].some((prefix) => lowered.startsWith(prefix))) {
    return null;
  }
  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (!/^https?:\/\//i.test(value)) {
    if (!baseUrl) return null;
    try {
      value = new URL(value, baseUrl).href;
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(value)) return null;
  return value;
}

/**
 * Collect lazy-loaded/broken image URLs and normalize `src` for Markdown output.
 * Invalid images are removed from the DOM instead of producing empty links.
 */
export function collectImages(
  node: HTMLElement,
  baseUrl: string,
  options: { rewriteSrc?: boolean } = {},
): string[] {
  const rewriteSrc = options.rewriteSrc !== false;
  const urls: string[] = [];
  for (const img of node.querySelectorAll('img')) {
    const raw = LAZY_IMAGE_ATTRS.map((attr) => img.getAttribute(attr)).find((value) => Boolean(value)) || null;
    const resolved = cleanImageUrl(raw, baseUrl);
    if (!resolved) {
      img.remove();
      continue;
    }
    if (rewriteSrc) {
      img.setAttribute('src', resolved);
      for (const attr of LAZY_IMAGE_ATTRS) {
        if (attr !== 'src' && img.hasAttribute(attr)) img.removeAttribute(attr);
      }
    }
    if (!urls.includes(resolved)) urls.push(resolved);
  }
  return urls;
}

export function dropNoise(node: HTMLElement): void {
  for (const tag of NOISE_TAGS) {
    for (const found of node.querySelectorAll(tag)) found.remove();
  }
}

export function pageOrigin(url: string): string | null {
  const value = (url || '').trim();
  if (!value.includes('://')) return null;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)/.exec(value);
  if (!match) return null;
  return `${match[1].toLowerCase()}://${match[2]}`;
}

/** Human readable fallback title derived from the share caption or the URL. */
export function fallbackTitle(rawInput: string, url = ''): string {
  let candidate = '';
  const caption = (rawInput || '').replace(URL_IN_TEXT_RE, ' ').replace(WHITESPACE_RE, ' ');
  const cleanedCaption = trimChars(caption, ' \t\n《》【】[]()（）-—·,，。.：:!！?？"\'“”');
  if (cleanedCaption) candidate = cleanedCaption;

  if (!candidate && url) {
    const parts = splitUrlParts(url);
    candidate = `${parts.hostname}${parts.path && parts.path !== '/' ? parts.path : ''}`;
  }
  if (!candidate) candidate = extractUrl(rawInput) || '未命名剪藏';
  if (candidate.length > 80) candidate = `${candidate.slice(0, 80).replace(/\s+$/, '')}…`;
  return candidate;
}

export interface ComposeMarkdownOptions {
  title?: string;
  metaLine?: string;
  body?: string;
  imageUrls?: string[];
}

export function composeMarkdown(options: ComposeMarkdownOptions = {}): string {
  const parts: string[] = [];
  if (options.title) parts.push(`# ${options.title}`);
  if (options.metaLine) parts.push(options.metaLine);
  if (options.body) parts.push(options.body);
  for (const url of options.imageUrls || []) parts.push(`![](${url})`);
  const nonEmpty = parts.filter((part) => part.trim());
  if (!nonEmpty.length) return '';
  return `${nonEmpty.map((part) => part.trim()).join('\n\n')}\n`;
}

export function firstLine(text: string, limit = 120): string {
  for (const line of (text || '').split('\n')) {
    const stripped = line.trim();
    if (stripped) {
      return stripped.length <= limit ? stripped : `${stripped.slice(0, limit).replace(/\s+$/, '')}…`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchedPage {
  html: string;
  finalUrl: string;
  contentType: string | null;
}

export async function fetchHtml(
  url: string,
  headers: Record<string, string> = BROWSER_HEADERS,
  timeoutMs = 20000,
): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return {
      html,
      finalUrl: response.url || url,
      contentType: response.headers.get('content-type'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(
  url: string,
  headers: Record<string, string> = BROWSER_HEADERS,
  timeoutMs = 20000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function errorLabel(error: unknown): string {
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message}`;
  return `Error: ${String(error)}`;
}

export interface ExtractedContentDefaults {
  platform: ExtractedContent['platform'];
  url: string;
  rawInput?: string;
  errorMessage: string;
  referer?: string | null;
  /** Fall back to the URL when the share caption is empty (X / XHS behaviour). */
  fallbackToUrl?: boolean;
  /** Only `content_text` falls back to the URL (XHS behaviour). */
  textFallbackToUrl?: boolean;
}

export function degradedContent(options: ExtractedContentDefaults): ExtractedContent {
  const raw = (options.rawInput || '').trim();
  const content = options.fallbackToUrl ? raw || options.url : raw;
  const text = options.fallbackToUrl || options.textFallbackToUrl ? raw || options.url : raw;
  return {
    platform: options.platform,
    url: options.url,
    title: fallbackTitle(options.rawInput || '', options.url),
    author: '',
    published_at: null,
    content_markdown: content,
    content_text: text,
    image_urls: [],
    partial: true,
    error_message: options.errorMessage,
    referer: options.referer ?? null,
  };
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/** Pure HTML parser used by the generic extractor (and unit tests). */
export function parseGenericHtml(html: string, url: string, rawInput = ''): ExtractedContent {
  const root = parse(html);
  const titleTag = root.querySelector('title');
  const title =
    metaContent(root, 'og:title') ||
    cleanText(titleTag ? titleTag.text : '') ||
    fallbackTitle(rawInput, url);

  const author = metaContent(root, 'author') || metaContent(root, 'article:author');
  const timeTag = root.querySelector('time');
  const publishedAt =
    metaContent(root, 'article:published_time') ||
    metaContent(root, 'datePublished') ||
    (timeTag ? (timeTag.getAttribute('datetime') || '').trim() : '') ||
    null;

  const body = root.querySelector('article') || root.querySelector('main') || root.querySelector('body') || root;
  dropNoise(body);

  const imageUrls: string[] = [];
  for (const raw of ogImages(root)) {
    const cleaned = cleanImageUrl(raw, url);
    if (cleaned && !imageUrls.includes(cleaned)) imageUrls.push(cleaned);
  }
  for (const imageUrl of collectImages(body, url)) {
    if (!imageUrls.includes(imageUrl)) imageUrls.push(imageUrl);
  }

  const contentText = htmlToText(body) || metaContent(root, 'og:description');
  let contentMarkdown = htmlToMarkdown(body);
  if (!contentMarkdown) {
    const description = metaContent(root, 'og:description') || metaContent(root, 'description');
    contentMarkdown = composeMarkdown({ title, body: description, imageUrls });
  }

  return {
    platform: 'web',
    url,
    title,
    author,
    published_at: publishedAt,
    content_markdown: contentMarkdown,
    content_text: contentText,
    image_urls: imageUrls,
    partial: !contentText,
    error_message: null,
    referer: pageOrigin(url),
  };
}

/** Fetch and parse an arbitrary page; never throws. */
export async function extractGeneric(url: string, rawInput = ''): Promise<ExtractedContent> {
  try {
    const page = await fetchHtml(url);
    return parseGenericHtml(page.html, url, rawInput);
  } catch (error) {
    return degradedContent({
      platform: 'web',
      url,
      rawInput,
      errorMessage: errorLabel(error),
    });
  }
}

export { isRecord, asArray };
