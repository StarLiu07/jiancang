/**
 * Pure update helpers shared by the update store and its unit tests.
 *
 * This module intentionally has zero React Native / Expo imports so it can be
 * executed directly by `node --test` (Node 22 strips the TypeScript types).
 */

export const GITHUB_REPO = 'StarLiu07/jiancang';
export const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;

export const APK_ASSET_NAME = 'jiancang-android.apk';

export interface AppRelease {
  /** Raw GitHub tag, e.g. `v0.4.0`. */
  tagName: string;
  /** Display / comparison version without the leading `v`, e.g. `0.4.0`. */
  version: string;
  name: string;
  notes: string;
  htmlUrl: string;
  publishedAt: string | null;
  apkUrl: string;
  apkName: string;
  apkSizeBytes: number;
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemver(input: string): ParsedSemver | null {
  if (typeof input !== 'string') return null;

  // Build metadata is ignored for precedence, and tags may be prefixed with `v`.
  const cleaned = input.trim().replace(/^v/i, '').split('+')[0];
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned);
  if (!match) return null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  // A release without a prerelease suffix has higher precedence.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftIsNumber = /^\d+$/.test(leftPart);
    const rightIsNumber = /^\d+$/.test(rightPart);

    if (leftIsNumber && rightIsNumber) {
      const diff = Number(leftPart) - Number(rightPart);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }

    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;

    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

/** Returns 1 when `a > b`, -1 when `a < b`, and 0 when equal. Invalid input sorts lower. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a);
  const right = parseSemver(b);

  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index] - right.core[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return comparePrerelease(left.prerelease, right.prerelease) as -1 | 0 | 1;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

export function normalizeVersion(input: string): string {
  return input.trim().replace(/^v/i, '');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface ApkAsset {
  name: string;
  url: string;
  size: number;
}

function isApkAsset(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  const name = asString(asset.name);
  return /\.apk$/i.test(name) && asString(asset.browser_download_url).trim().length > 0;
}

/**
 * Converts a GitHub `/releases/latest` payload into the small shape the app
 * needs. Drafts, prereleases and releases without an APK asset are rejected.
 */
export function parseGitHubRelease(payload: unknown): AppRelease | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const raw = payload as Record<string, unknown>;
  if (raw.draft === true || raw.prerelease === true) return null;

  const tagName = asString(raw.tag_name).trim();
  const version = normalizeVersion(tagName);
  if (!tagName || !version) return null;

  const assets = Array.isArray(raw.assets) ? raw.assets.filter(isApkAsset) : [];
  if (assets.length === 0) return null;

  const normalized: ApkAsset[] = assets.map((asset) => ({
    name: asString(asset.name).trim(),
    url: asString(asset.browser_download_url).trim(),
    size: asFiniteNumber(asset.size),
  }));

  const apk =
    normalized.find(
      (asset) => asset.name.toLowerCase() === APK_ASSET_NAME.toLowerCase(),
    ) ?? normalized[0];

  if (!apk) return null;

  return {
    tagName,
    version,
    name: asString(raw.name).trim() || tagName,
    notes: asString(raw.body),
    htmlUrl: asString(raw.html_url).trim() || GITHUB_RELEASES_PAGE_URL,
    publishedAt: asString(raw.published_at).trim() || null,
    apkUrl: apk.url,
    apkName: apk.name,
    apkSizeBytes: apk.size,
  };
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
