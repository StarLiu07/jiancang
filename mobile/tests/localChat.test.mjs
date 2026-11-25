import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIChatError,
  AIEnrichmentError,
  CHAT_TIMEOUT_MS,
  MAX_CHAT_CONTENT_CHARS,
  MAX_CHAT_HISTORY_MESSAGES,
  buildArticleChatMessages,
  chatWithArticleLocally,
} from '../src/local/ai.ts';
import {
  STARTER_PROMPTS,
  appendReplyToNoteText,
  buildArticleContextFromClip,
  resolveChatChannel,
  sendClipChatMessage,
} from '../src/local/chat.ts';

const VALID_AI_CONFIG = {
  baseUrl: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-local-chat',
  model: 'test-model',
};

const API_CONFIG = {
  baseUrl: 'http://192.168.31.98:8420',
  token: 'nuc-token',
};

const ARTICLE = {
  title: '深度工作',
  author: '卡尔·纽波特',
  platform: 'web',
  url: 'https://example.com/deep-work',
  summary: '专注力正在变成最稀缺的能力。',
  key_points: ['深度工作能创造更高的认知价值', '碎片化会持续削弱专注'],
  content_text: '正文第一段。\n\n正文第二段。',
  user_note: '每周安排两次两小时的深度工作。',
};

function jsonResponse(body, status = 200) {
  return {
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function userTurns(count, prefix = '问题') {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `${prefix}${index}`,
  }));
}

// ---------------------------------------------------------------------------
// buildArticleChatMessages
// ---------------------------------------------------------------------------

test('buildArticleChatMessages embeds every article field in the system prompt', () => {
  const messages = buildArticleChatMessages(ARTICLE, [
    { role: 'user', content: '这篇文章讲了什么？' },
    { role: 'assistant', content: '讲了专注的价值。' },
  ]);

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'system');
  const system = messages[0].content;
  for (const fragment of [
    ARTICLE.title,
    ARTICLE.author,
    ARTICLE.platform,
    ARTICLE.url,
    ARTICLE.summary,
    ARTICLE.key_points[0],
    ARTICLE.key_points[1],
    ARTICLE.user_note,
    ARTICLE.content_text,
  ]) {
    assert.ok(system.includes(fragment), `system prompt must include ${fragment}`);
  }
  assert.ok(system.includes('以下是用户正在精读的文章资料：'));
  assert.ok(system.includes('文章精读与讨论助手'));
  assert.ok(system.includes('回答原则：'));
  assert.ok(system.includes('绝不声称是原文所述'));

  assert.deepEqual(messages[1], { role: 'user', content: '这篇文章讲了什么？' });
  assert.deepEqual(messages[2], { role: 'assistant', content: '讲了专注的价值。' });
});

test('buildArticleChatMessages truncates bodies longer than the character budget', () => {
  const longBody = `${'A'.repeat(MAX_CHAT_CONTENT_CHARS)}${'B'.repeat(500)}TAIL`;
  const messages = buildArticleChatMessages({ ...ARTICLE, content_text: longBody }, []);
  const system = messages[0].content;

  assert.ok(system.includes(`${'A'.repeat(MAX_CHAT_CONTENT_CHARS)}\n...(正文已截断)`));
  assert.ok(!system.includes('A'.repeat(MAX_CHAT_CONTENT_CHARS + 1)));
  assert.ok(!system.includes('TAIL'));
  assert.ok(!system.includes('B'.repeat(500)));
});

test('buildArticleChatMessages truncates by code points without splitting emoji', () => {
  const emoji = '\u{1F600}';
  const body = `${emoji.repeat(MAX_CHAT_CONTENT_CHARS)}TAIL`;
  const system = buildArticleChatMessages({ ...ARTICLE, content_text: body }, [])[0].content;

  assert.ok(system.includes(`${emoji.repeat(MAX_CHAT_CONTENT_CHARS)}\n...(正文已截断)`));
  assert.ok(!system.includes('TAIL'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(system), 'no lone high surrogate');
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(system), 'no lone low surrogate');
});

test('buildArticleChatMessages keeps only the most recent history window', () => {
  const history = userTurns(MAX_CHAT_HISTORY_MESSAGES + 5);
  const messages = buildArticleChatMessages(ARTICLE, history);
  const turns = messages.slice(1);

  assert.equal(turns.length, MAX_CHAT_HISTORY_MESSAGES);
  assert.equal(turns[0].content, '问题5');
  assert.equal(turns.at(-1).content, '问题24');
  assert.ok(!messages.some((message) => message.content === '问题4'));
});

test('buildArticleChatMessages drops blank turns and trims content', () => {
  const messages = buildArticleChatMessages(ARTICLE, [
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '  有效问题  ' },
  ]);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { role: 'user', content: '有效问题' });
});

test('buildArticleChatMessages explains a missing body instead of leaving it blank', () => {
  const messages = buildArticleChatMessages({ ...ARTICLE, content_text: '   ' }, []);
  assert.ok(messages[0].content.includes('正文暂缺'));
});

test('buildArticleChatMessages fills placeholders for missing metadata', () => {
  const messages = buildArticleChatMessages(
    { title: '', author: '', platform: 'web', url: '', summary: '', key_points: [], content_text: '', user_note: '' },
    [],
  );
  const system = messages[0].content;
  assert.ok(system.includes('（无标题）'));
  assert.ok(system.includes('（未知）'));
  assert.ok(system.includes('（无）'));
});

// ---------------------------------------------------------------------------
// chatWithArticleLocally
// ---------------------------------------------------------------------------

test('chat exports share the backend chat constants', () => {
  assert.equal(MAX_CHAT_CONTENT_CHARS, 12000);
  assert.equal(MAX_CHAT_HISTORY_MESSAGES, 20);
  assert.equal(CHAT_TIMEOUT_MS, 60_000);
});

test('chatWithArticleLocally returns the trimmed reply and response model', async () => {
  let captured = null;
  const result = await withFetch(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ model: 'nuc-model', choices: [{ message: { content: '  这是回答  ' } }] });
  }, () => chatWithArticleLocally(ARTICLE, [{ role: 'user', content: '讲讲要点' }], VALID_AI_CONFIG));

  assert.deepEqual(result, { reply: '这是回答', model: 'nuc-model' });
  assert.equal(captured.url, 'http://127.0.0.1:3000/v1/chat/completions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-local-chat');
  assert.equal(captured.init.headers['User-Agent'], 'jiancang/0.1');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');

  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.model, 'test-model');
  assert.equal(payload.temperature, 0.5);
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[0].role, 'system');
  assert.deepEqual(payload.messages[1], { role: 'user', content: '讲讲要点' });
});

test('chatWithArticleLocally falls back to the configured model name', async () => {
  const result = await withFetch(
    async () => jsonResponse({ choices: [{ message: { content: '没有 model 字段' } }] }),
    () => chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], VALID_AI_CONFIG),
  );
  assert.deepEqual(result, { reply: '没有 model 字段', model: 'test-model' });
});

test('chatWithArticleLocally strips trailing slashes from the base URL', async () => {
  let url = '';
  await withFetch(
    async (target) => {
      url = target;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    },
    () => chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], {
      ...VALID_AI_CONFIG,
      baseUrl: 'http://127.0.0.1:3000/v1//',
    }),
  );
  assert.equal(url, 'http://127.0.0.1:3000/v1/chat/completions');
});

test('chatWithArticleLocally rejects when the local AI is not configured', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return jsonResponse({});
    },
    async () => {
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], {
          ...VALID_AI_CONFIG,
          baseUrl: '   ',
        }),
        (error) => {
          assert.ok(error instanceof AIChatError);
          assert.ok(error instanceof AIEnrichmentError);
          assert.equal(error.name, 'AIChatError');
          assert.equal(error.message, '本机未配置 AI 接口');
          return true;
        },
      );
    },
  );
  assert.equal(calls, 0);
});

test('chatWithArticleLocally rejects a history without user turns', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return jsonResponse({});
    },
    async () => {
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'assistant', content: '只有回复' }], VALID_AI_CONFIG),
        (error) => error instanceof AIChatError && error.message === '请输入要提问的内容',
      );
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'user', content: '   ' }], VALID_AI_CONFIG),
        (error) => error instanceof AIChatError,
      );
    },
  );
  assert.equal(calls, 0);
});

test('chatWithArticleLocally wraps HTTP failures in AIChatError', async () => {
  await withFetch(
    async () => jsonResponse('upstream exploded', 500),
    async () => {
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], VALID_AI_CONFIG),
        (error) => {
          assert.ok(error instanceof AIChatError);
          assert.equal(error.name, 'AIChatError');
          assert.match(error.message, /llm http 500/);
          assert.match(error.message, /upstream exploded/);
          return true;
        },
      );
    },
  );
});

test('chatWithArticleLocally rejects empty model replies', async () => {
  for (const content of ['   ', '']) {
    await withFetch(
      async () => jsonResponse({ choices: [{ message: { content } }] }),
      async () => {
        await assert.rejects(
          chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], VALID_AI_CONFIG),
          (error) => error instanceof AIChatError && error.message === 'empty model reply',
        );
      },
    );
  }
});

test('chatWithArticleLocally rejects malformed payloads and network errors', async () => {
  await withFetch(
    async () => ({ status: 200, json: async () => ({}), text: async () => '' }),
    async () => {
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], VALID_AI_CONFIG),
        (error) => error instanceof AIChatError,
      );
    },
  );

  await withFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], VALID_AI_CONFIG),
        (error) => error instanceof AIChatError && error.name === 'AIChatError',
      );
    },
  );
});

test('chatWithArticleLocally rejects a non-JSON body', async () => {
  await withFetch(
    async () => ({
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token <');
      },
      async text() {
        return '<html>';
      },
    }),
    async () => {
      await assert.rejects(
        chatWithArticleLocally(ARTICLE, [{ role: 'user', content: 'hi' }], VALID_AI_CONFIG),
        (error) => error instanceof AIChatError && error.message === 'llm returned non-JSON body',
      );
    },
  );
});

test('chatWithArticleLocally honours an already-aborted external signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(
    async (url, init) => {
      assert.equal(init.signal.aborted, true);
      throw new DOMException('aborted', 'AbortError');
    },
    async () => {
      await assert.rejects(
        chatWithArticleLocally(
          ARTICLE,
          [{ role: 'user', content: 'hi' }],
          VALID_AI_CONFIG,
          controller.signal,
        ),
        (error) => error instanceof AIChatError,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// resolveChatChannel
// ---------------------------------------------------------------------------

test('resolveChatChannel prefers local AI, then NUC sync, then none', () => {
  assert.equal(resolveChatChannel(VALID_AI_CONFIG, API_CONFIG, true), 'local');
  assert.equal(
    resolveChatChannel({ baseUrl: '', apiKey: '', model: '' }, API_CONFIG, true),
    'server',
  );
  assert.equal(
    resolveChatChannel({ baseUrl: '', apiKey: '', model: '' }, API_CONFIG, false),
    'none',
  );
});

test('resolveChatChannel requires both syncEnabled and a usable base URL', () => {
  const noLocal = { baseUrl: '  ', apiKey: '', model: '' };
  assert.equal(resolveChatChannel(noLocal, { ...API_CONFIG, baseUrl: '  ' }, true), 'none');
  assert.equal(resolveChatChannel(noLocal, { ...API_CONFIG, baseUrl: '' }, true), 'none');
  assert.equal(resolveChatChannel(noLocal, { ...API_CONFIG, baseUrl: undefined }, true), 'none');
  assert.equal(resolveChatChannel(noLocal, API_CONFIG, false), 'none');
  assert.equal(resolveChatChannel(noLocal, API_CONFIG, true), 'server');
});

test('resolveChatChannel needs both base URL and API key for the local channel', () => {
  assert.equal(resolveChatChannel({ ...VALID_AI_CONFIG, apiKey: ' ' }, API_CONFIG, true), 'server');
  assert.equal(
    resolveChatChannel({ ...VALID_AI_CONFIG, apiKey: ' ' }, API_CONFIG, false),
    'none',
  );
});

// ---------------------------------------------------------------------------
// buildArticleContextFromClip
// ---------------------------------------------------------------------------

test('buildArticleContextFromClip maps the locally stored clip onto the chat contract', () => {
  const article = buildArticleContextFromClip({
    id: 'clip-1',
    title: ' 标题 ',
    author: ' 作者 ',
    platform: 'wechat',
    url: ' https://mp.weixin.qq.com/s/abc ',
    summary: ' 摘要 ',
    key_points: [' 要点一 ', '', '要点二'],
    content_markdown: '# 正文\n\n内容',
    user_note: '我的笔记',
  });

  assert.deepEqual(article, {
    title: '标题',
    author: '作者',
    platform: 'wechat',
    url: 'https://mp.weixin.qq.com/s/abc',
    summary: '摘要',
    key_points: ['要点一', '要点二'],
    content_text: '# 正文\n\n内容',
    user_note: '我的笔记',
  });
});

test('buildArticleContextFromClip tolerates missing fields', () => {
  const article = buildArticleContextFromClip({ id: 'clip-2' });
  assert.deepEqual(article, {
    title: '',
    author: '',
    platform: 'web',
    url: '',
    summary: '',
    key_points: [],
    content_text: '',
    user_note: '',
  });
});

// ---------------------------------------------------------------------------
// appendReplyToNoteText
// ---------------------------------------------------------------------------

test('appendReplyToNoteText writes a fresh block when the note is empty', () => {
  assert.equal(appendReplyToNoteText('', '  第一行\n第二行  '), '[AI 对话摘录]\n第一行\n第二行');
  assert.equal(appendReplyToNoteText('   \n\n ', '回答'), '[AI 对话摘录]\n回答');
  assert.equal(appendReplyToNoteText(undefined, '回答'), '[AI 对话摘录]\n回答');
});

test('appendReplyToNoteText appends after an existing note and trims its tail', () => {
  assert.equal(
    appendReplyToNoteText('原有笔记\n\n  ', '新回复'),
    '原有笔记\n\n[AI 对话摘录]\n新回复',
  );
});

test('appendReplyToNoteText returns the note untouched for blank replies', () => {
  const note = '原有笔记\n\n';
  assert.equal(appendReplyToNoteText(note, ''), note);
  assert.equal(appendReplyToNoteText(note, '   \n\n '), note);
  assert.equal(appendReplyToNoteText(note, undefined), note);
});

// ---------------------------------------------------------------------------
// starter prompts
// ---------------------------------------------------------------------------

test('STARTER_PROMPTS exposes four distinct, non-empty Chinese prompts', () => {
  assert.equal(STARTER_PROMPTS.length, 4);
  const labels = STARTER_PROMPTS.map((item) => item.label);
  assert.equal(new Set(labels).size, 4);
  assert.deepEqual(labels, ['大白话讲透', '提炼行动清单', '批判性思考', '延伸追问']);
  for (const item of STARTER_PROMPTS) {
    assert.ok(item.label.trim().length > 0);
    assert.ok(item.prompt.trim().length > 10);
  }
});

// ---------------------------------------------------------------------------
// sendClipChatMessage (input/channel guards run before any DB access)
// ---------------------------------------------------------------------------

test('sendClipChatMessage rejects blank messages', async () => {
  await assert.rejects(
    sendClipChatMessage(
      { id: 'clip-1' },
      '   ',
      { localAiConfig: VALID_AI_CONFIG, apiConfig: API_CONFIG, syncEnabled: true },
    ),
    /请输入要提问的内容/,
  );
});

test('sendClipChatMessage explains how to configure a channel when none is available', async () => {
  await assert.rejects(
    sendClipChatMessage(
      { id: 'clip-1' },
      '这篇文章讲什么？',
      {
        localAiConfig: { baseUrl: '', apiKey: '', model: '' },
        apiConfig: { baseUrl: '', token: '' },
        syncEnabled: false,
      },
    ),
    /未配置可用的 AI/,
  );
});
