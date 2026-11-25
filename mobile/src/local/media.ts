/**
 * Image download + local caching for clipped content.
 *
 * Ported from `backend/app/services/media.py`. The pure helpers at the top are
 * dependency-free (unit-testable in plain Node); the download helpers lazily
 * import `expo-file-system` so importing this module in tests never touches a
 * native module.
 *
 * Every failure is best-effort: a single broken image is skipped and never
 * aborts the whole clip.
 */

import { generateHexId } from './urlUtils';

export const MEDIA_API_PREFIX = '/api/media/';
/**
 * Desktop Chrome UA shared with `extractors/generic.ts`. Android's OkHttp
 * default (`okhttp/4.x`) and the old bare `Mozilla/5.0` are rejected by most
 * image CDNs (XHS, WeChat mmbiz, pbs.twimg) with a 403/empty body.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';
export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/apng': '.apng',
  'image/jp2': '.jp2',
};

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

/** Markdown image/link targets: `![alt](url "title")` / `[text](url)`. */
const MD_TARGET_RE = /(!?\[[^\]]*\]\(\s*)([^)\s]+)/g;
/** Raw HTML `<img src="url">`. */
const HTML_IMG_RE = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)/gi;

export interface StoredMedia {
  /** Content hash or caller supplied media id. */
  id: string;
  original_url: string;
  /** Path relative to the local media directory. */
  local_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  sort_order: number;
}

/** Shape tolerated by `rewriteMarkdownImages` (DB rows / backend media dicts). */
export interface StoredMediaLike {
  id?: string;
  media_id?: string;
  original_url?: string;
  originalUrl?: string;
  url?: string;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Turn a stored `media.local_path` into a URI React Native can render.
 *
 * Rows written by `downloadAndStoreImages` hold a path *relative* to
 * `<documentDirectory>media/` (e.g. `clips/<id>/<sha256>.jpg`), while synced
 * rows may already hold an absolute `file://`/`content://` URI. Resolving only
 * the `file://` case used to fall back to `/api/media/{id}` for every locally
 * downloaded image, i.e. a blank box whenever the NUC was unreachable.
 *
 * Pure + synchronous so both `db.ts` and tests can use it.
 */
export function resolveMediaFileUri(
  localPath: string | null | undefined,
  documentDirectory: string | null | undefined,
): string | null {
  const value = clean(localPath);
  if (!value) return null;
  if (/^(file|content):\/\//i.test(value)) return value;

  const base = clean(documentDirectory);
  if (!base) return null;

  const relative = value.replace(/^\/+/, '');
  if (!relative) return null;
  // A stored path must stay inside the media directory.
  if (relative.split('/').some((segment) => segment === '..')) return null;

  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}media/${relative}`;
}

function normalizeMime(value: string | null | undefined): string {
  if (!value) return '';
  const base = value.split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES[base] || base;
}

/** Normalize a MIME type to a file extension (backend `_extension_for`). */
export function extensionForMime(mimeType: string | null | undefined): string {
  const mime = normalizeMime(mimeType);
  if (!mime) return '.img';
  return EXT_BY_MIME[mime] || '.img';
}

/** Deduplicate/validate remote image URLs in order. */
export function dedupeImageUrls(imageUrls: ReadonlyArray<string> | null | undefined): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of imageUrls || []) {
    const cleaned = (raw || '').trim();
    if (!cleaned) continue;
    const lowered = cleaned.toLowerCase();
    if (!lowered.startsWith('http://') && !lowered.startsWith('https://')) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    ordered.push(cleaned);
  }
  return ordered;
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, name: string) => {
      switch (name) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return '\u00a0';
      }
    });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lookupMediaPath(mapping: Map<string, string>, url: string): string | null {
  if (!url) return null;
  const candidates = [url, htmlUnescape(url), safeDecode(url), safeDecode(htmlUnescape(url))];
  for (const candidate of candidates) {
    const found = mapping.get(candidate);
    if (found) return found;
  }
  return mapping.get(url.split('#')[0]) || null;
}

function readMediaField(item: StoredMedia | StoredMediaLike, ...keys: string[]): string {
  const record = item as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Replace original remote image URLs with local API paths inside Markdown/HTML.
 * Always rewrites to the canonical `/api/media/{id}` path.
 */
export function rewriteMarkdownImages(
  markdown: string,
  stored: ReadonlyArray<StoredMedia | StoredMediaLike> | null | undefined,
): string {
  if (!markdown || !stored || !stored.length) return markdown;

  const mapping = new Map<string, string>();
  for (const item of stored) {
    if (!item) continue;
    const id = readMediaField(item, 'id', 'media_id');
    const original = readMediaField(item, 'original_url', 'originalUrl', 'url');
    if (!id || !original) continue;
    mapping.set(original, `${MEDIA_API_PREFIX}${id}`);
  }
  if (!mapping.size) return markdown;

  const replace = (_match: string, prefix: string, url: string): string => {
    const replacement = lookupMediaPath(mapping, url);
    return replacement === null ? `${prefix}${url}` : `${prefix}${replacement}`;
  };

  const withMarkdown = markdown.replace(MD_TARGET_RE, replace);
  return withMarkdown.replace(HTML_IMG_RE, replace);
}

// ---------------------------------------------------------------------------
// SHA-256 (content-addressed ids, no native crypto dependency)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Pure TypeScript SHA-256. Exported for unit tests and sync metadata. */
export function sha256Hex(input: Uint8Array): string {
  const length = input.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(input);
  data[length] = 0x80;

  const bitLenHi = Math.floor(length / 0x20000000) >>> 0;
  const bitLenLo = (length << 3) >>> 0;
  data[paddedLength - 8] = (bitLenHi >>> 24) & 0xff;
  data[paddedLength - 7] = (bitLenHi >>> 16) & 0xff;
  data[paddedLength - 6] = (bitLenHi >>> 8) & 0xff;
  data[paddedLength - 5] = bitLenHi & 0xff;
  data[paddedLength - 4] = (bitLenLo >>> 24) & 0xff;
  data[paddedLength - 3] = (bitLenLo >>> 16) & 0xff;
  data[paddedLength - 2] = (bitLenLo >>> 8) & 0xff;
  data[paddedLength - 1] = bitLenLo & 0xff;

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] = ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  let digest = '';
  for (const word of hash) digest += word.toString(16).padStart(8, '0');
  return digest;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(input: string): Uint8Array {
  const cleanInput = input.replace(/[^A-Za-z0-9+/=]/g, '');
  let padding = 0;
  if (cleanInput.endsWith('==')) padding = 2;
  else if (cleanInput.endsWith('=')) padding = 1;

  const output = new Uint8Array(Math.max(0, Math.floor((cleanInput.length * 3) / 4) - padding));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < cleanInput.length; index += 1) {
    const char = cleanInput[index];
    if (char === '=') break;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[written] = (buffer >>> bits) & 0xff;
      written += 1;
    }
  }
  return output.subarray(0, written);
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, start: number, length: number): string {
  let text = '';
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (bytesStartWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (bytes.length >= 12 && asciiAt(bytes, 4, 8) === 'ftypavif') return 'image/avif';
  if (bytes.length >= 12 && asciiAt(bytes, 4, 8) === 'ftypavis') return 'image/avif';

  const head = asciiAt(bytes, 0, 512).trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Local storage (lazy expo-file-system)
// ---------------------------------------------------------------------------

type FileSystemModule = typeof import('expo-file-system');

let cachedFileSystem: FileSystemModule | null = null;

async function loadFileSystem(): Promise<FileSystemModule> {
  if (!cachedFileSystem) {
    // Metro bundles this lazily; Node unit tests never call download helpers.
    cachedFileSystem = require('expo-file-system') as FileSystemModule;
  }
  return cachedFileSystem;
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = (value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return cleaned || fallback;
}

function relativeDirForClip(clipId: string): string {
  return `clips/${safeSegment(clipId, 'local')}`;
}

/** `file://` URI of the media directory (created on demand). */
export async function getLocalMediaDir(): Promise<string> {
  const fileSystem = await loadFileSystem();
  const base = fileSystem.documentDirectory;
  if (!base) throw new Error('expo-file-system documentDirectory is unavailable');
  const dir = `${base}media/`;
  await fileSystem.makeDirectoryAsync(dir, { intermediates: true });
  return dir;
}

async function resolveLocalUri(localPath: string): Promise<string | null> {
  const value = (localPath || '').trim();
  if (!value) return null;
  if (/^(file|content):\/\//i.test(value)) return value;

  const mediaDir = await getLocalMediaDir();
  const relative = value.replace(/^\/+/, '');
  if (!relative || relative.split('/').some((segment) => segment === '..')) return null;
  return `${mediaDir}${relative}`;
}

export async function localMediaFileExists(localPath: string): Promise<boolean> {
  try {
    const uri = await resolveLocalUri(localPath);
    if (!uri) return false;
    const fileSystem = await loadFileSystem();
    const info = await fileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

export async function deleteLocalMediaFile(localPath: string): Promise<boolean> {
  try {
    const value = (localPath || '').trim();
    if (!value || value.startsWith('content://')) return false;
    const mediaDir = await getLocalMediaDir();
    const uri = await resolveLocalUri(value);
    if (!uri) return false;
    if (uri.startsWith('file://') && !uri.startsWith(mediaDir)) return false;

    const fileSystem = await loadFileSystem();
    const info = await fileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory) return false;
    await fileSystem.deleteAsync(uri, { idempotent: true });
    return true;
  } catch {
    return false;
  }
}

interface StoreOptions {
  relativeDir: string;
  originalUrl: string;
  forcedId?: string;
  mimeTypeHint?: string | null;
  maxBytes: number;
}

async function cleanupFile(fileSystem: FileSystemModule, uri: string): Promise<void> {
  try {
    const info = await fileSystem.getInfoAsync(uri);
    if (info.exists) await fileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort cleanup only.
  }
}

async function storeDownloadedFile(
  fileSystem: FileSystemModule,
  tempUri: string,
  download: { mimeType?: string | null },
  mediaDir: string,
  options: StoreOptions,
): Promise<StoredMedia | null> {
  const info = await fileSystem.getInfoAsync(tempUri);
  if (!info.exists || info.isDirectory) return null;
  if (info.size <= 0 || info.size > options.maxBytes) return null;

  const base64 = await fileSystem.readAsStringAsync(tempUri, {
    encoding: fileSystem.EncodingType.Base64,
  });
  const bytes = base64ToBytes(base64);
  if (!bytes.length || bytes.length > options.maxBytes) return null;

  const declared = normalizeMime(download.mimeType || '');
  const hint = normalizeMime(options.mimeTypeHint || '');
  const mime =
    sniffImageMime(bytes) ||
    (declared.startsWith('image/') ? declared : '') ||
    (hint.startsWith('image/') ? hint : '');
  if (!mime) return null;

  const sha256 = sha256Hex(bytes);
  const id = options.forcedId || sha256;
  const extension = extensionForMime(mime);
  const relativePath = `${options.relativeDir}/${id}${extension}`;
  const finalUri = `${mediaDir}${relativePath}`;

  await fileSystem.makeDirectoryAsync(`${mediaDir}${options.relativeDir}/`, { intermediates: true });
  const existing = await fileSystem.getInfoAsync(finalUri);
  if (existing.exists) {
    await cleanupFile(fileSystem, tempUri);
  } else {
    await fileSystem.moveAsync({ from: tempUri, to: finalUri });
  }

  return {
    id: safeSegment(id, sha256),
    original_url: options.originalUrl,
    local_path: relativePath,
    mime_type: mime,
    size_bytes: bytes.length,
    sha256,
    sort_order: 0,
  };
}

export interface DownloadImagesOptions {
  clipId: string;
  referer?: string | null;
  maxBytes?: number;
}

/**
 * Download images in order and store them content-addressed.
 * Failures (network errors, non-image payloads, oversized files) are skipped.
 */
export async function downloadAndStoreImages(
  imageUrls: ReadonlyArray<string> | null | undefined,
  options: DownloadImagesOptions,
): Promise<StoredMedia[]> {
  const urls = dedupeImageUrls(imageUrls);
  if (!urls.length) return [];

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fileSystem = await loadFileSystem();
  const mediaDir = await getLocalMediaDir();
  const tempDir = `${mediaDir}.tmp/`;
  await fileSystem.makeDirectoryAsync(tempDir, { intermediates: true });

  const relativeDir = relativeDirForClip(options.clipId);
  const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
  if (options.referer) headers.Referer = options.referer;

  const stored: StoredMedia[] = [];
  const seenHashes = new Set<string>();

  for (const url of urls) {
    const tempUri = `${tempDir}${generateHexId()}.download`;
    try {
      const download = await fileSystem.downloadAsync(url, tempUri, { headers, md5: true });
      if (download.status < 200 || download.status >= 300) {
        await cleanupFile(fileSystem, tempUri);
        continue;
      }
      const item = await storeDownloadedFile(fileSystem, tempUri, download, mediaDir, {
        relativeDir,
        originalUrl: url,
        maxBytes,
      });
      if (!item) continue;
      if (seenHashes.has(item.sha256)) continue;
      seenHashes.add(item.sha256);
      item.sort_order = stored.length;
      stored.push(item);
    } catch {
      // One bad image must never abort the clip.
    } finally {
      await cleanupFile(fileSystem, tempUri);
    }
  }

  return stored;
}

/**
 * Download a media file that lives on the sync server under `mediaId`.
 * Returns `null` when the response is not a usable image.
 */
export async function downloadRemoteMediaById(
  mediaId: string,
  remoteUrl: string,
  headers: Record<string, string> = {},
  mimeTypeHint?: string,
): Promise<StoredMedia | null> {
  const id = safeSegment(mediaId, '');
  if (!id || !remoteUrl) return null;

  const fileSystem = await loadFileSystem();
  const mediaDir = await getLocalMediaDir();
  const tempDir = `${mediaDir}.tmp/`;
  await fileSystem.makeDirectoryAsync(tempDir, { intermediates: true });

  const tempUri = `${tempDir}${generateHexId()}.download`;
  try {
    const download = await fileSystem.downloadAsync(remoteUrl, tempUri, { headers, md5: true });
    if (download.status < 200 || download.status >= 300) return null;
    return await storeDownloadedFile(fileSystem, tempUri, download, mediaDir, {
      relativeDir: 'remote',
      originalUrl: remoteUrl,
      forcedId: id,
      mimeTypeHint,
      maxBytes: DEFAULT_MAX_BYTES,
    });
  } catch {
    return null;
  } finally {
    await cleanupFile(fileSystem, tempUri);
  }
}
