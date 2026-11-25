import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  LOCAL_CLIP_MEDIA_PREFIX,
  LocalRepositoryError,
  buildClipPatch,
  localMediaPathsToDelete,
  localRepo,
  notifyLocalChange,
  shouldPromoteManualContent,
  subscribeLocalChanges,
  toClipSummary,
} from '../src/local/repository.ts';
import {
  INGEST_MAX_KEY_POINTS,
  INGEST_RESUME_CONCURRENCY,
  buildAiUpdates,
  buildIngestFields,
  buildMediaInputs,
  describeIngestError,
  firstContentLine,
  notifyLocalChange as notifyLocalChangeFromIngest,
  pickBetterExtraction,
  processClipLocally,
  resetLocalChangeListeners,
  runWithConcurrency,
  shouldAbortIngest,
  shouldRunLocalAi,
  shouldTryRemoteExtractFallback,
  subscribeLocalChanges as subscribeFromIngest,
} from '../src/local/ingest.ts';

const AI_CONFIG = {
  baseUrl: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-local-test',
  model: 'test-model',
};

const API_CONFIG = { baseUrl: 'http://192.168.31.98:8420', token: 'nuc-token' };

afterEach(() => {
  resetLocalChangeListeners();
});

// ---------------------------------------------------------------------------
// change bus
// ---------------------------------------------------------------------------

test('subscribeLocalChanges notifies and unsubscribes listeners', () => {
  resetLocalChangeListeners();
  const calls = [];

  const off = subscribeLocalChanges(() => calls.push('a'));
  assert.equal(typeof off, 'function');

  notifyLocalChange();
  assert.deepEqual(calls, ['a']);

  off();
  notifyLocalChange();
  assert.deepEqual(calls, ['a'], 'unsubscribed listener must not fire');

  off(); // idempotent unsubscribe
  assert.doesNotThrow(() => notifyLocalChange());
});

test('subscribeLocalChanges registers a listener only once', () => {
  resetLocalChangeListeners();
  let calls = 0;
  const listener = () => {
    calls += 1;
  };

  subscribeLocalChanges(listener);
  subscribeLocalChanges(listener);
  notifyLocalChange();

  assert.equal(calls, 1);
});

test('a throwing listener never blocks the remaining listeners', () => {
  resetLocalChangeListeners();
  const seen = [];

  subscribeLocalChanges(() => {
    seen.push('first');
    throw new Error('unmounted screen');
  });
  subscribeLocalChanges(() => seen.push('second'));

  assert.doesNotThrow(() => notifyLocalChange());
  assert.deepEqual(seen, ['first', 'second']);
});

test('subscribeLocalChanges ignores non-function listeners', () => {
  resetLocalChangeListeners();
  const off = subscribeLocalChanges(null);
  assert.equal(typeof off, 'function');
  assert.doesNotThrow(() => {
    off();
    notifyLocalChange();
  });
});

test('repository re-exports the ingest change bus (single shared bus)', () => {
  assert.equal(subscribeLocalChanges, subscribeFromIngest);
  assert.equal(notifyLocalChange, notifyLocalChangeFromIngest);
});

test('notifyLocalChange with no subscribers is a no-op', () => {
  resetLocalChangeListeners();
  assert.doesNotThrow(() => notifyLocalChange());
});

// ---------------------------------------------------------------------------
// repository surface
// ---------------------------------------------------------------------------

test('localRepo exposes the api-compatible surface', () => {
  const methods = [
    'createClip',
    'listClips',
    'getClip',
    'updateClip',
    'deleteClip',
    'retryClip',
    'reviewToday',
    'reviewAction',
    'listTags',
    'resumePending',
    'countPendingSync',
  ];
  for (const name of methods) {
    assert.equal(typeof localRepo[name], 'function', `missing localRepo.${name}`);
  }
});

test('LocalRepositoryError keeps its name and status', () => {
  const error = new LocalRepositoryError('Clip not found: abc', 404);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'LocalRepositoryError');
  assert.equal(error.status, 404);
  assert.equal(error.message, 'Clip not found: abc');
});

// ---------------------------------------------------------------------------
// updateClip patch planning (manual completion promotion)
// ---------------------------------------------------------------------------

test('shouldPromoteManualContent covers every unfinished status', () => {
  for (const status of ['pending', 'processing', 'partial', 'failed']) {
    assert.equal(shouldPromoteManualContent(status, '# 正文'), true, status);
  }
  assert.equal(shouldPromoteManualContent('ready', '# 正文'), false);
  assert.equal(shouldPromoteManualContent('archived', '# 正文'), false);
  assert.equal(shouldPromoteManualContent(undefined, '# 正文'), false);
  assert.equal(shouldPromoteManualContent('failed', ''), false);
  assert.equal(shouldPromoteManualContent('failed', '   \n\t '), false);
  assert.equal(shouldPromoteManualContent('failed', null), false);
});

test('buildClipPatch promotes an unfinished clip when the user writes a body', () => {
  for (const status of ['pending', 'processing', 'partial', 'failed']) {
    const { fields, hasFields } = buildClipPatch(status, {
      content_markdown: '## 正文\n\n**加粗**',
    });
    assert.equal(hasFields, true);
    assert.equal(fields.status, 'ready', status);
    assert.equal(fields.error_message, null);
    assert.equal(fields.content_markdown, '## 正文\n\n**加粗**');
    assert.equal(fields.content_text, '正文\n加粗');
  }
});

test('buildClipPatch leaves a ready clip ready and keeps whitespace bodies verbatim', () => {
  const ready = buildClipPatch('ready', { content_markdown: '# 已完成' });
  assert.equal('status' in ready.fields, false);
  assert.equal('error_message' in ready.fields, false);

  const blank = buildClipPatch('failed', { content_markdown: '   ' });
  assert.equal('status' in blank.fields, false);
  assert.equal(blank.fields.content_markdown, '   ');
  assert.equal(blank.fields.content_text, '');
});

test('buildClipPatch only touches the columns present in the patch', () => {
  const { fields, hasFields } = buildClipPatch('failed', { title: '  新标题  ' });
  assert.equal(hasFields, true);
  assert.equal(fields.title, '新标题');
  assert.equal('status' in fields, false);
  assert.equal('content_markdown' in fields, false);
});

test('buildClipPatch normalizes tags and passes the note through untouched', () => {
  const { fields } = buildClipPatch('active', {
    tags: ['  AI  ', 'ai', '技术', ''],
    user_note: '  保留原样  ',
    summary: '  摘要  ',
  });
  assert.deepEqual(fields.tags, ['AI', '技术']);
  assert.equal(fields.user_note, '  保留原样  ');
  assert.equal(fields.summary, '摘要');
});

test('buildClipPatch reports an empty patch', () => {
  const { fields, hasFields } = buildClipPatch('ready', {});
  assert.deepEqual(fields, {});
  assert.equal(hasFields, false);
});

// ---------------------------------------------------------------------------
// summary projection / media cleanup
// ---------------------------------------------------------------------------

test('toClipSummary drops detail-only fields and copies the tag array', () => {
  const detail = {
    id: 'clip-1',
    url: 'https://example.com/a',
    platform: 'web',
    status: 'ready',
    ai_status: 'done',
    error_message: null,
    title: 'title',
    author: 'author',
    summary: 'summary',
    cover_media_url: '/api/media/media-1',
    tags: ['AI'],
    review_state: 'active',
    review_count: 2,
    next_review_at: null,
    last_reviewed_at: null,
    created_at: '2025-05-20T00:00:00.000000+00:00',
    updated_at: '2025-05-20T00:00:00.000000+00:00',
    raw_input: 'https://example.com/a 分享',
    published_at: null,
    content_markdown: '# body',
    key_points: ['p1'],
    user_note: 'note',
    media: [{ id: 'media-1' }],
  };

  const summary = toClipSummary(detail);
  assert.deepEqual(Object.keys(summary).sort(), [
    'ai_status',
    'author',
    'cover_media_url',
    'created_at',
    'error_message',
    'id',
    'last_reviewed_at',
    'next_review_at',
    'platform',
    'review_count',
    'review_state',
    'status',
    'summary',
    'tags',
    'title',
    'updated_at',
    'url',
  ]);
  assert.equal(summary.id, 'clip-1');
  assert.notEqual(summary.tags, detail.tags, 'tags must be copied, not shared');
  assert.deepEqual(summary.tags, ['AI']);
});

test('localMediaPathsToDelete keeps only clip-scoped files', () => {
  assert.equal(LOCAL_CLIP_MEDIA_PREFIX, 'clips/');
  assert.deepEqual(
    localMediaPathsToDelete([
      { local_path: 'clips/c1/a.png' },
      { local_path: 'clips/c1/a.png' },
      { local_path: ' remote/r1.png' },
      { local_path: '' },
      {},
      { local_path: 'clips/c1/../../etc/passwd' },
      { local_path: '/abs/clips/c1/b.png' },
      { local_path: 'clips/c1/b.jpg' },
    ]),
    ['clips/c1/a.png', 'clips/c1/b.jpg'],
  );
  assert.deepEqual(localMediaPathsToDelete(null), []);
});

// ---------------------------------------------------------------------------
// ingest: guards and field mapping
// ---------------------------------------------------------------------------

test('shouldAbortIngest protects deleted and manually completed clips', () => {
  assert.equal(shouldAbortIngest(null), true);
  assert.equal(shouldAbortIngest(undefined), true);

  assert.equal(shouldAbortIngest({ review_state: 'deleted', status: 'pending' }), true);
  assert.equal(
    shouldAbortIngest({ review_state: 'active', status: 'ready', content_markdown: '# body' }),
    true,
  );
  assert.equal(
    shouldAbortIngest({ review_state: 'active', status: 'ready', content_markdown: '   ' }),
    false,
    'a ready clip without a body is still worth ingesting',
  );
  assert.equal(
    shouldAbortIngest({ review_state: 'active', status: 'partial', content_markdown: '# body' }),
    false,
    'partial clips must stay retryable',
  );
  assert.equal(shouldAbortIngest({ review_state: 'active', status: 'processing' }), false);
  assert.equal(shouldAbortIngest({ review_state: 'archived', status: 'pending' }), false);
});

function extracted(overrides = {}) {
  return {
    platform: 'web',
    url: 'https://example.com/a',
    title: '标题',
    author: '作者',
    published_at: '2025-05-20T00:00:00.000000+00:00',
    content_markdown: '# 标题\n\n正文',
    content_text: '标题\n正文',
    image_urls: [],
    partial: false,
    error_message: null,
    referer: 'https://example.com/',
    ...overrides,
  };
}

test('buildIngestFields maps a full extraction to clip columns', () => {
  const fields = buildIngestFields(extracted(), {
    url: 'https://example.com/fallback',
    platform: 'x',
    title: 'fallback',
    author: 'fallback',
    published_at: null,
  });

  assert.equal(fields.status, 'ready');
  assert.equal(fields.error_message, null);
  assert.equal(fields.platform, 'web');
  assert.equal(fields.url, 'https://example.com/a');
  assert.equal(fields.title, '标题');
  assert.equal(fields.author, '作者');
  assert.equal(fields.published_at, '2025-05-20T00:00:00.000000+00:00');
  assert.equal(fields.content_markdown, '# 标题\n\n正文');
  assert.equal(fields.content_text, '标题\n正文');
});

test('buildIngestFields degrades to partial and keeps the extractor error', () => {
  const fields = buildIngestFields(
    extracted({
      title: '',
      partial: true,
      error_message: '403 Forbidden',
      content_markdown: '',
      content_text: '',
    }),
    { title: '原始标题', url: 'https://example.com/a', platform: 'web' },
  );

  assert.equal(fields.status, 'partial');
  assert.equal(fields.error_message, '403 Forbidden');
  assert.equal(fields.title, '原始标题');
});

test('buildIngestFields falls back to markdown text and the first content line', () => {
  const fields = buildIngestFields(
    extracted({
      title: '',
      content_markdown: '## 正文\n\n**加粗**',
      content_text: '',
    }),
    {},
  );

  assert.equal(fields.content_text, '正文\n加粗');
  assert.equal(fields.title, '正文');

  const fromText = buildIngestFields(
    extracted({ title: '', content_markdown: '', content_text: '  第一行  有空格\n第二行' }),
    {},
  );
  assert.equal(fromText.title, '第一行 有空格');
});

test('buildIngestFields keeps clip defaults when the extraction is empty', () => {
  const fields = buildIngestFields(
    extracted({
      url: '',
      platform: undefined,
      author: '',
      published_at: null,
      title: '',
      content_markdown: '',
      content_text: '',
    }),
    {
      url: 'https://example.com/a',
      platform: 'xiaohongshu',
      title: '',
      author: '原作者',
      published_at: '2024-01-01T00:00:00.000000+00:00',
    },
  );

  assert.equal(fields.url, 'https://example.com/a');
  assert.equal(fields.platform, 'xiaohongshu');
  assert.equal(fields.author, '原作者');
  assert.equal(fields.published_at, '2024-01-01T00:00:00.000000+00:00');
  assert.equal(fields.title, '');
  assert.equal(fields.content_text, '');
});

test('firstContentLine collapses whitespace and truncates', () => {
  assert.equal(firstContentLine('  \n  第一行   有空格  \n第二行'), '第一行 有空格');
  assert.equal(firstContentLine('', 10), '');
  assert.equal(firstContentLine(null), '');
  assert.equal(firstContentLine('x'.repeat(200)).length, 80);
  assert.equal(firstContentLine('abcdefghij', 4), 'abcd');
});

// ---------------------------------------------------------------------------
// ingest: media + AI planning
// ---------------------------------------------------------------------------

test('buildMediaInputs assigns sequential sort order', () => {
  const stored = [
    {
      id: 'hash-a',
      original_url: 'https://img/a.png',
      local_path: 'clips/c1/a.png',
      mime_type: 'image/png',
      size_bytes: 10,
      sha256: 'a',
      sort_order: 7,
    },
    {
      id: 'hash-b',
      original_url: 'https://img/b.png',
      local_path: 'clips/c1/b.png',
      mime_type: 'image/jpeg',
      size_bytes: 20,
      sha256: 'b',
      sort_order: 3,
    },
  ];

  assert.deepEqual(buildMediaInputs(stored), [
    {
      id: 'hash-a',
      original_url: 'https://img/a.png',
      local_path: 'clips/c1/a.png',
      mime_type: 'image/png',
      size_bytes: 10,
      sha256: 'a',
      sort_order: 0,
    },
    {
      id: 'hash-b',
      original_url: 'https://img/b.png',
      local_path: 'clips/c1/b.png',
      mime_type: 'image/jpeg',
      size_bytes: 20,
      sha256: 'b',
      sort_order: 1,
    },
  ]);
  assert.deepEqual(buildMediaInputs([]), []);
});

test('shouldRunLocalAi requires a configured endpoint and some text', () => {
  assert.equal(shouldRunLocalAi({ baseUrl: '', apiKey: 'k', model: 'm' }, 't', 'c'), false);
  assert.equal(shouldRunLocalAi({ baseUrl: 'http://x', apiKey: '  ', model: 'm' }, 't', 'c'), false);
  assert.equal(shouldRunLocalAi(AI_CONFIG, '标题', ''), true);
  assert.equal(shouldRunLocalAi(AI_CONFIG, '', '  正文  '), true);
  assert.equal(shouldRunLocalAi(AI_CONFIG, '   ', '\n\t'), false);
  assert.equal(shouldRunLocalAi(AI_CONFIG, undefined, undefined), false);
});

test('buildAiUpdates merges summary, key points and tags', () => {
  const updates = buildAiUpdates(
    {
      summary: '  一句话摘要 ',
      key_points: [' 要点一 ', '', '要点二', '要点三', '要点四', '要点五', '要点六'],
      tags: ['ai', '新标签'],
    },
    ['AI', '技术'],
  );

  assert.equal(updates.ai_status, 'done');
  assert.equal(updates.summary, '一句话摘要');
  assert.deepEqual(updates.key_points, ['要点一', '要点二', '要点三', '要点四', '要点五']);
  assert.equal(updates.key_points.length, INGEST_MAX_KEY_POINTS);
  assert.deepEqual(updates.tags, ['AI', '技术', '新标签']);
});

test('buildAiUpdates degrades empty payloads to skipped', () => {
  assert.deepEqual(buildAiUpdates(null, ['AI']), { ai_status: 'skipped' });
  assert.deepEqual(buildAiUpdates(undefined), { ai_status: 'skipped' });
  assert.deepEqual(
    buildAiUpdates({ summary: '   ', key_points: [], tags: [] }, ['AI']),
    { ai_status: 'skipped' },
  );
});

test('buildAiUpdates never invents an empty summary field', () => {
  const updates = buildAiUpdates({ summary: '', key_points: ['要点'], tags: [] }, []);
  assert.equal(updates.ai_status, 'done');
  assert.equal('summary' in updates, false);
  assert.equal('tags' in updates, false);
  assert.deepEqual(updates.key_points, ['要点']);
});

test('describeIngestError always returns a non-empty, capped label', () => {
  assert.equal(describeIngestError(new Error('boom')), '抓取失败: boom');
  assert.equal(describeIngestError('timeout'), '抓取失败: timeout');
  assert.equal(describeIngestError(''), '抓取失败: 未知错误');
  assert.equal(describeIngestError(null), '抓取失败: 未知错误');

  const long = describeIngestError('x'.repeat(800));
  assert.equal(long.length, 500);
  assert.ok(long.startsWith('抓取失败: '));
  assert.equal(describeIngestError(new Error('abcdef'), 10).length, 10);
});

// ---------------------------------------------------------------------------
// ingest: concurrency helper + blank ids
// ---------------------------------------------------------------------------

test('runWithConcurrency respects the concurrency cap and processes every item', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  const started = [];
  const finished = [];
  let active = 0;
  let maxActive = 0;

  await runWithConcurrency(items, INGEST_RESUME_CONCURRENCY, async (item) => {
    started.push(item);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    finished.push(item);
  });

  assert.equal(INGEST_RESUME_CONCURRENCY, 2);
  assert.equal(maxActive, 2);
  assert.deepEqual(started.slice(0, 2), [0, 1], 'items are claimed in order');
  assert.deepEqual([...finished].sort((a, b) => a - b), items);
});

test('runWithConcurrency clamps invalid limits and handles empty input', async () => {
  await assert.doesNotReject(runWithConcurrency([], 2, async () => {}));

  let active = 0;
  let maxActive = 0;
  await runWithConcurrency([1, 2, 3], 0, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
  });
  assert.equal(maxActive, 1);
});

test('runWithConcurrency swallows a failing item and keeps draining the queue', async () => {
  const done = [];
  await assert.doesNotReject(
    runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      if (item === 2) throw new Error('broken clip');
      done.push(item);
    }),
  );
  assert.deepEqual([...done].sort((a, b) => a - b), [1, 3, 4]);
});

test('processClipLocally ignores blank ids without touching SQLite', async () => {
  await assert.doesNotReject(processClipLocally('   ', AI_CONFIG));
  await assert.doesNotReject(processClipLocally('', AI_CONFIG));
});

// ---------------------------------------------------------------------------
// ingest: NUC remote-extract fallback (pure planning helpers)
// ---------------------------------------------------------------------------

test('shouldTryRemoteExtractFallback only fires for a partial clip on a configured NUC', () => {
  const fallback = { apiConfig: API_CONFIG, syncEnabled: true };

  // A complete local extraction is never re-uploaded.
  assert.equal(shouldTryRemoteExtractFallback(extracted(), fallback), false);

  // The only happy path: partial local + sync on + a real baseUrl.
  assert.equal(shouldTryRemoteExtractFallback(extracted({ partial: true }), fallback), true);

  // Missing / disabled fallback stays fully offline.
  assert.equal(shouldTryRemoteExtractFallback(extracted({ partial: true }), undefined), false);
  assert.equal(shouldTryRemoteExtractFallback(extracted({ partial: true }), null), false);
  assert.equal(
    shouldTryRemoteExtractFallback(extracted({ partial: true }), { ...fallback, syncEnabled: false }),
    false,
  );
  assert.equal(
    shouldTryRemoteExtractFallback(extracted({ partial: true }), { ...fallback, syncEnabled: 'yes' }),
    false,
    'syncEnabled must be strictly true',
  );

  // Blank / whitespace-only baseUrl counts as not configured.
  for (const baseUrl of ['', '   ', '\n\t']) {
    assert.equal(
      shouldTryRemoteExtractFallback(extracted({ partial: true }), {
        apiConfig: { baseUrl, token: '' },
        syncEnabled: true,
      }),
      false,
      `baseUrl ${JSON.stringify(baseUrl)} must not trigger a request`,
    );
  }
});

test('pickBetterExtraction always prefers a complete remote extraction', () => {
  const local = extracted({
    partial: true,
    content_text: '原始分享文案',
    content_markdown: '原始分享文案',
  });
  const remote = extracted({
    url: 'https://example.com/remote',
    title: '远程正文',
    content_text: '完整的笔记正文',
    content_markdown: '# 远程正文\n\n完整的笔记正文',
    partial: false,
    error_message: null,
  });

  assert.equal(pickBetterExtraction(local, remote), remote);

  // A complete local clip is never replaced by a partial remote one.
  const readyLocal = extracted();
  assert.equal(pickBetterExtraction(readyLocal, remote), remote);
  assert.equal(pickBetterExtraction(readyLocal, extracted({ partial: true })), readyLocal);
});

test('pickBetterExtraction keeps local when the remote result is missing or emptier', () => {
  const local = extracted({
    partial: true,
    content_text: '原始分享文案',
    content_markdown: '原始分享文案',
    image_urls: [],
  });

  assert.equal(pickBetterExtraction(local, null), local);
  assert.equal(pickBetterExtraction(local, undefined), local);

  // Remote partial echoing the same caption adds nothing.
  const echoed = extracted({
    partial: true,
    content_text: '原始分享文案',
    content_markdown: '原始分享文案',
    image_urls: [],
  });
  assert.equal(pickBetterExtraction(local, echoed), local);

  // Remote partial whose body is just the URL is not "有效正文".
  const urlOnly = extracted({
    partial: true,
    content_text: 'https://example.com/a',
    content_markdown: 'https://example.com/a',
    image_urls: [],
  });
  assert.equal(pickBetterExtraction(local, urlOnly), local);

  // A ready local clip is never downgraded.
  const readyLocal = extracted();
  assert.equal(pickBetterExtraction(readyLocal, extracted({ partial: true })), readyLocal);
  assert.equal(pickBetterExtraction(readyLocal, null), readyLocal);
});

test('pickBetterExtraction upgrades a partial local result with richer remote content', () => {
  const local = extracted({
    partial: true,
    content_text: '原始分享文案',
    content_markdown: '原始分享文案',
    image_urls: [],
    error_message: '触发小红书登录拦截',
  });

  const withImages = extracted({
    partial: true,
    content_text: '原始分享文案',
    content_markdown: '原始分享文案',
    image_urls: ['https://sns.xhscdn.com/a.jpg'],
  });
  assert.equal(pickBetterExtraction(local, withImages), withImages);

  const withBody = extracted({
    partial: true,
    content_text: '半页能读到的笔记正文',
    content_markdown: '# 标题\n\n半页能读到的笔记正文',
    image_urls: [],
  });
  assert.equal(pickBetterExtraction(local, withBody), withBody);
});
