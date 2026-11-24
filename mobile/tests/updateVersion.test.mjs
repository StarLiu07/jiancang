import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareSemver,
  formatFileSize,
  isNewerVersion,
  parseGitHubRelease,
} from '../src/utils/updateVersion.ts';

test('compareSemver orders numeric segments instead of comparing strings', () => {
  assert.ok(compareSemver('v0.10.0', 'v0.9.0') > 0);
  assert.ok(compareSemver('0.9.0', '0.10.0') < 0);
  assert.equal(compareSemver('v0.4.0', '0.4.0'), 0);
  assert.ok(compareSemver('1.2.3', '1.2.4') < 0);
});

test('compareSemver handles prerelease and build metadata like SemVer 2.0', () => {
  assert.ok(compareSemver('0.4.0', '0.4.0-beta.1') > 0);
  assert.ok(compareSemver('0.4.0-beta.1', '0.4.0') < 0);
  assert.ok(compareSemver('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10') < 0);
  assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
  assert.equal(compareSemver('1.0.0+build.7', '1.0.0'), 0);
  assert.equal(compareSemver('V1.0.0', '1.0.0'), 0);
});

test('isNewerVersion compares the release tag with the installed version', () => {
  assert.equal(isNewerVersion('v0.4.0', '0.3.0'), true);
  assert.equal(isNewerVersion('0.3.0', 'v0.3.0'), false);
  assert.equal(isNewerVersion('0.4.0-beta.1', '0.4.0'), false);
  assert.equal(isNewerVersion('0.4.0', '0.4.0-beta.1'), true);
});

test('parseGitHubRelease prefers the canonical APK asset', () => {
  const release = parseGitHubRelease({
    tag_name: 'v0.4.0',
    name: '剪藏 v0.4.0',
    body: '## 本次更新\n- 支持应用内自动更新',
    html_url: 'https://github.com/StarLiu07/jiancang/releases/tag/v0.4.0',
    published_at: '2025-01-02T03:04:05Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'jiancang-android.apk.sha256',
        size: 88,
        browser_download_url: 'https://example.com/jiancang-android.apk.sha256',
      },
      {
        name: 'jiancang-android.apk',
        size: 65000000,
        browser_download_url: 'https://example.com/jiancang-android.apk',
      },
      {
        name: 'other.apk',
        size: 100,
        browser_download_url: 'https://example.com/other.apk',
      },
    ],
  });

  assert.ok(release);
  assert.equal(release.version, '0.4.0');
  assert.equal(release.tagName, 'v0.4.0');
  assert.equal(release.name, '剪藏 v0.4.0');
  assert.equal(release.apkName, 'jiancang-android.apk');
  assert.equal(release.apkSizeBytes, 65000000);
  assert.equal(release.apkUrl, 'https://example.com/jiancang-android.apk');
  assert.equal(release.htmlUrl, 'https://github.com/StarLiu07/jiancang/releases/tag/v0.4.0');
  assert.match(release.notes, /应用内自动更新/);
});

test('parseGitHubRelease falls back to the first .apk asset', () => {
  const release = parseGitHubRelease({
    tag_name: '0.5.0',
    name: '0.5.0',
    body: '',
    html_url: 'https://example.com/release',
    draft: false,
    prerelease: false,
    assets: [
      { name: 'notes.txt', size: 12, browser_download_url: 'https://example.com/notes.txt' },
      { name: 'build-42.APK', size: 1024, browser_download_url: 'https://example.com/build-42.APK' },
    ],
  });

  assert.ok(release);
  assert.equal(release.version, '0.5.0');
  assert.equal(release.name, '0.5.0');
  assert.equal(release.apkName, 'build-42.APK');
  assert.equal(release.apkSizeBytes, 1024);
  assert.equal(release.notes, '');
});

test('parseGitHubRelease ignores drafts, prereleases and payloads without APK assets', () => {
  assert.equal(
    parseGitHubRelease({
      tag_name: 'v0.5.0',
      draft: true,
      prerelease: false,
      assets: [{ name: 'jiancang-android.apk', size: 1, browser_download_url: 'https://example.com/a.apk' }],
    }),
    null,
  );
  assert.equal(
    parseGitHubRelease({
      tag_name: 'v0.5.0',
      draft: false,
      prerelease: true,
      assets: [{ name: 'jiancang-android.apk', size: 1, browser_download_url: 'https://example.com/a.apk' }],
    }),
    null,
  );
  assert.equal(
    parseGitHubRelease({
      tag_name: 'v0.5.0',
      draft: false,
      prerelease: false,
      assets: [{ name: 'source.zip', size: 1, browser_download_url: 'https://example.com/a.zip' }],
    }),
    null,
  );
  assert.equal(
    parseGitHubRelease({
      tag_name: 'v0.5.0',
      draft: false,
      prerelease: false,
      assets: [{ name: 'jiancang-android.apk', size: 1 }],
    }),
    null,
  );
});

test('parseGitHubRelease rejects invalid payloads', () => {
  assert.equal(parseGitHubRelease(null), null);
  assert.equal(parseGitHubRelease(undefined), null);
  assert.equal(parseGitHubRelease('not-json'), null);
  assert.equal(parseGitHubRelease({}), null);
  assert.equal(parseGitHubRelease({ tag_name: '', assets: [] }), null);
  assert.equal(
    parseGitHubRelease({
      tag_name: 'v',
      draft: false,
      prerelease: false,
      assets: [{ name: 'jiancang-android.apk', size: 1, browser_download_url: 'https://example.com/a.apk' }],
    }),
    null,
  );
  assert.equal(parseGitHubRelease({ tag_name: 'v0.4.0' }), null);
});

test('formatFileSize renders B / KB / MB with one decimal', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(-10), '0 B');
  assert.equal(formatFileSize(1), '1 B');
  assert.equal(formatFileSize(999), '999 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1048576), '1.0 MB');
  assert.equal(formatFileSize(65000000), '62.0 MB');
});
