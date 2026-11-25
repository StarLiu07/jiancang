import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, DEFAULT_EXTRACT_TIMEOUT_MS, api, buildAuthHeaders, mediaUrl } from '../src/api/client.ts';
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

// ---------------------------------------------------------------------------
// api chat methods
// ---------------------------------------------------------------------------

const CLIP_CHAT_INPUT = { message: '这篇文章的核心观点是什么？' };
const STATELESS_INPUT = {
  article: {
    title: '标题',
    author: '作者',
    platform: 'web',
    url: 'https://example.com/a',
    summary: '摘要',
    key_points: ['要点一', '要点二'],
    content_text: '正文内容',
    user_note: '我的笔记',
  },
  messages: [{ role: 'user', content: '继续追问' }],
};

/** Minimal `Response` stand-in: only the fields `request()` actually touches. */
function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

/** Installs a temporary `globalThis.fetch` mock and always restores it. */
async function withMockFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('api chat methods hit the documented paths with auth headers', async () => {
  const history = { clip_id: 'a/b c', messages: [] };
  const turn = {
    user_message: { id: 'u1', clip_id: 'a/b c', role: 'user', content: '问', created_at: 'TS' },
    assistant_message: { id: 'a1', clip_id: 'a/b c', role: 'assistant', content: '答', created_at: 'TS' },
    model: 'gpt-4o-mini',
  };
  const reply = { reply: '回答', model: 'gpt-4o-mini' };

  await withMockFetch(
    (url, init) => {
      if (url.endsWith('/api/ai/chat')) return jsonResponse(reply);
      if (url.endsWith('/api/clips/a%2Fb%20c/chat')) {
        return (init.method ?? 'GET') === 'POST' ? jsonResponse(turn, 201) : jsonResponse(history);
      }
      throw new Error(`unexpected url ${url}`);
    },
    async (calls) => {
      const listResult = await api.listClipChat(CONFIG, 'a/b c');
      assert.deepEqual(listResult, history);
      assert.equal(calls[0].url, 'http://192.168.31.98:8420/api/clips/a%2Fb%20c/chat');
      assert.equal(calls[0].init.method ?? 'GET', 'GET');
      assert.equal(calls[0].init.body, undefined);
      assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');

      const sendResult = await api.sendClipChat(CONFIG, 'a/b c', CLIP_CHAT_INPUT);
      assert.deepEqual(sendResult, turn);
      assert.equal(calls[1].init.method, 'POST');
      assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
      assert.equal(calls[1].init.headers.Authorization, 'Bearer secret-token');
      assert.deepEqual(JSON.parse(calls[1].init.body), CLIP_CHAT_INPUT);

      const statelessResult = await api.statelessChat(CONFIG, STATELESS_INPUT);
      assert.deepEqual(statelessResult, reply);
      assert.equal(calls[2].url, 'http://192.168.31.98:8420/api/ai/chat');
      assert.equal(calls[2].init.method, 'POST');
      assert.deepEqual(JSON.parse(calls[2].init.body), STATELESS_INPUT);
    },
  );
});

test('api.clearClipChat DELETEs the encoded clip chat path', async () => {
  await withMockFetch(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      const payload = await api.clearClipChat(CONFIG, 'a/b c');
      assert.deepEqual(payload, { ok: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://192.168.31.98:8420/api/clips/a%2Fb%20c/chat');
      assert.equal(calls[0].init.method, 'DELETE');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
    },
  );
});

test('api chat methods surface non-2xx responses as ApiError', async () => {
  await withMockFetch(
    () => jsonResponse({ detail: 'AI 服务不可用' }, 503),
    async () => {
      await assert.rejects(
        () => api.statelessChat(CONFIG, STATELESS_INPUT),
        (error) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 503);
          assert.equal(error.detail, 'AI 服务不可用');
          return true;
        },
      );
      await assert.rejects(() => api.sendClipChat(CONFIG, 'c1', CLIP_CHAT_INPUT), ApiError);
      await assert.rejects(() => api.listClipChat(CONFIG, 'c1'), ApiError);
      await assert.rejects(() => api.clearClipChat(CONFIG, 'c1'), ApiError);
    },
  );
});

test('api.sendClipChat forwards the caller abort signal', async () => {
  const controller = new AbortController();
  const seen = {};
  await withMockFetch(
    (_url, init) => {
      seen.signal = init.signal;
      // Mirrors real fetch: reject only once the composed signal aborts.
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('caller signal was not forwarded')), 1000);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          seen.aborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
    async () => {
      const pending = api.sendClipChat(CONFIG, 'c1', CLIP_CHAT_INPUT, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await assert.rejects(pending, (error) => {
        assert.equal(seen.aborted, true, 'fetch signal must abort with the caller signal');
        assert.equal(seen.signal.aborted, true);
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 0);
        return true;
      });
    },
  );
});

// ---------------------------------------------------------------------------
// api.extractRemote (remote extraction fallback contract)
// ---------------------------------------------------------------------------

const EXTRACT_INPUT = {
  url: 'https://www.xiaohongshu.com/explore/65f0abc?xsec_token=ABC',
  raw_input: '打开小红书看看【标题】 😆 http://xhslink.com/a/xyz',
};

const EXTRACT_RESULT = {
  platform: 'xiaohongshu',
  url: EXTRACT_INPUT.url,
  title: '标题',
  author: '作者',
  published_at: '2026-01-02',
  content_markdown: '## 正文',
  content_text: '正文',
  image_urls: ['https://cdn.example.com/1.jpg'],
  partial: false,
  error_message: null,
  referer: 'https://www.xiaohongshu.com/',
};

test('api.extractRemote POSTs /api/extract with auth headers, body and parsed response', async () => {
  await withMockFetch(
    () => jsonResponse(EXTRACT_RESULT),
    async (calls) => {
      const payload = await api.extractRemote(CONFIG, EXTRACT_INPUT);

      assert.deepEqual(payload, EXTRACT_RESULT);
      assert.equal(payload.published_at, '2026-01-02');
      assert.equal(payload.error_message, null);
      assert.equal(payload.referer, 'https://www.xiaohongshu.com/');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://192.168.31.98:8420/api/extract');
      assert.equal(calls[0].init.method, 'POST');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
      assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(calls[0].init.body), EXTRACT_INPUT);

      // `raw_input` is optional: omit it and the payload must stay minimal.
      await api.extractRemote({ baseUrl: CONFIG.baseUrl, token: '  ' }, { url: EXTRACT_INPUT.url });
      assert.equal(calls[1].url, 'http://192.168.31.98:8420/api/extract');
      assert.equal(calls[1].init.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(calls[1].init.body), { url: EXTRACT_INPUT.url });
    },
  );
});

test('api.extractRemote uses the documented timeout and surfaces ApiError', async () => {
  assert.equal(DEFAULT_EXTRACT_TIMEOUT_MS, 25_000);

  // The constant must actually be wired into the request budget.
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return originalSetTimeout(fn, ms, ...rest);
  };
  try {
    await withMockFetch(
      () => jsonResponse(EXTRACT_RESULT),
      () => api.extractRemote(CONFIG, EXTRACT_INPUT),
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(
    delays.includes(DEFAULT_EXTRACT_TIMEOUT_MS),
    `expected a ${DEFAULT_EXTRACT_TIMEOUT_MS}ms timeout, saw ${JSON.stringify(delays)}`,
  );

  await withMockFetch(
    () => jsonResponse({ detail: '抓取被风控拦截' }, 502),
    async () => {
      await assert.rejects(
        () => api.extractRemote(CONFIG, EXTRACT_INPUT),
        (error) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 502);
          assert.equal(error.detail, '抓取被风控拦截');
          return true;
        },
      );
    },
  );
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
