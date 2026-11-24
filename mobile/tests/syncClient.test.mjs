import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuthHeaders, mediaUrl } from '../src/api/client.ts';
import { formatSyncSummary } from '../src/sync/engine.ts';

const CONFIG = { baseUrl: 'http://192.168.31.98:8420', token: 'secret-token' };

function result(patch) {
  return {
    status: 'success',
    message: '',
    pushed: 0,
    pulled: 0,
    uploadedMedia: 0,
    downloadedMedia: 0,
    queuedAi: 0,
    pendingCount: 0,
    changed: false,
    lastSyncAt: null,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// mediaUrl
// ---------------------------------------------------------------------------

test('mediaUrl passes device-local URIs through untouched', () => {
  for (const uri of [
    'file:///data/user/0/app.jiancang/files/media/clips/abc/def.jpg',
    'content://media/external/images/media/42',
    'data:image/png;base64,iVBORw0KGgo=',
  ]) {
    assert.equal(mediaUrl(CONFIG, uri), uri);
  }
  // Query strings inside the local path must never gain a backend token.
  const local = 'file:///tmp/cached.jpg?size=1';
  assert.equal(mediaUrl(CONFIG, local), local);
});

test('mediaUrl resolves remote media paths against the backend and appends the token', () => {
  assert.equal(
    mediaUrl(CONFIG, '/api/media/abc123'),
    'http://192.168.31.98:8420/api/media/abc123?token=secret-token',
  );
  assert.equal(
    mediaUrl({ baseUrl: CONFIG.baseUrl, token: '  ' }, '/api/media/abc123'),
    'http://192.168.31.98:8420/api/media/abc123',
  );
  assert.equal(mediaUrl(CONFIG, null), null);
  assert.equal(mediaUrl(CONFIG, ''), null);
});

test('mediaUrl keeps third-party absolute URLs untouched', () => {
  assert.equal(
    mediaUrl(CONFIG, 'https://cdn.example.com/pic.jpg'),
    'https://cdn.example.com/pic.jpg',
  );
});

// ---------------------------------------------------------------------------
// buildAuthHeaders
// ---------------------------------------------------------------------------

test('buildAuthHeaders trims the token and omits the header when empty', () => {
  assert.deepEqual(buildAuthHeaders({ baseUrl: CONFIG.baseUrl, token: ' abc ' }), {
    Authorization: 'Bearer abc',
  });
  assert.deepEqual(buildAuthHeaders({ baseUrl: CONFIG.baseUrl, token: '   ' }), {});
});

// ---------------------------------------------------------------------------
// formatSyncSummary
// ---------------------------------------------------------------------------

test('formatSyncSummary lists every transferred count', () => {
  assert.equal(
    formatSyncSummary(
      result({ pushed: 2, pulled: 3, uploadedMedia: 1, downloadedMedia: 2, queuedAi: 1, changed: true }),
    ),
    '同步完成：上传 2 条，下载 3 条，上传图片 1 张，下载图片 2 张，AI 补全排队 1 条',
  );
  assert.equal(
    formatSyncSummary(result({ pulled: 4, changed: true })),
    '同步完成：下载 4 条',
  );
});

test('formatSyncSummary reports clean and pending states', () => {
  assert.equal(formatSyncSummary(result({})), '已是最新状态');
  assert.equal(formatSyncSummary(result({ pendingCount: 4 })), '已同步，还有 4 项待重试');
});

test('formatSyncSummary surfaces offline / error / idle messages', () => {
  assert.equal(
    formatSyncSummary(result({ status: 'offline', message: '连不上 NUC，稍后会自动重试' })),
    '连不上 NUC，稍后会自动重试',
  );
  assert.equal(
    formatSyncSummary(result({ status: 'offline', message: '' })),
    '离线：暂时连不上 NUC，稍后自动重试',
  );
  assert.equal(formatSyncSummary(result({ status: 'error', message: '' })), '同步失败，请稍后重试');
  assert.equal(formatSyncSummary(result({ status: 'syncing' })), '正在同步…');
  assert.equal(formatSyncSummary(result({ status: 'idle' })), '还没有同步过');
});
