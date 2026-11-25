import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectPlatform,
  extractUrl,
  generateHexId,
  normalizeUrl,
  splitUrlParts,
} from '../src/local/urlUtils.ts';
import { buildSharePayload, detectPlatformFromUrl } from '../src/utils/url.ts';
import {
  BROWSER_HEADERS,
  DEFAULT_USER_AGENT as EXTRACTOR_USER_AGENT,
  EMPTY_BODY_MESSAGE,
  cleanImageUrl,
  extractGeneric,
  fallbackTitle,
  htmlToMarkdown,
  htmlToText,
  parseGenericHtml,
} from '../src/local/extractors/generic.ts';
import { markdownToText } from '../src/local/extractors/base.ts';
import { extractContent } from '../src/local/extractors/index.ts';
import { parseWeChatHtml } from '../src/local/extractors/wechat.ts';
import { extractX, parseFxTwitterPayload, parseStatusUrl } from '../src/local/extractors/x.ts';
import {
  XHS_HEADERS,
  XHS_LOGIN_BLOCK_MESSAGE,
  extractNoteId,
  extractXhs,
  parseXhsHtml,
  unwrapXhsRedirect,
} from '../src/local/extractors/xhs.ts';
import {
  DEFAULT_USER_AGENT,
  dedupeImageUrls,
  extensionForMime,
  resolveMediaFileUri,
  rewriteMarkdownImages,
  sha256Hex,
} from '../src/local/media.ts';
import {
  AIEnrichmentError,
  buildMessages,
  extractJsonObject,
  isLocalAiConfigured,
  parseEnrichment,
  stripCodeFence,
} from '../src/local/ai.ts';

// ---------------------------------------------------------------------------
// fetch mocking (extractor network paths)
// ---------------------------------------------------------------------------

/** Minimal `Response` stand-in with an overridable `url` (Node's is read-only). */
function fakeResponse(
  body,
  { url = '', status = 200, contentType = 'text/html; charset=utf-8' } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/**
 * Run `fn` with `globalThis.fetch` stubbed, restoring the real fetch afterwards.
 * `calls` records every request so tests can assert on the sent headers.
 */
async function withFetchMock(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push({ url, init, headers: (init && init.headers) || {} });
    const response = await handler(url, init);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// urlUtils
// ---------------------------------------------------------------------------

test('extractUrl stops at Chinese punctuation glued to the link', () => {
  assert.equal(extractUrl('看这个：https://xhslink.com/a/b1c2d3，查看详情'), 'https://xhslink.com/a/b1c2d3');
  assert.equal(
    extractUrl('英语 caption https://example.com/posts/1?utm_source=x. next sentence'),
    'https://example.com/posts/1?utm_source=x',
  );
  assert.equal(extractUrl('not a link'), null);
  assert.equal(extractUrl(''), null);
});

test('extractUrl keeps balanced brackets and strips unbalanced trailing ones', () => {
  assert.equal(extractUrl('https://example.com/a_(b)。'), 'https://example.com/a_(b)');
  assert.equal(extractUrl('https://example.com/a_(b))'), 'https://example.com/a_(b)');
  assert.equal(extractUrl('https://example.com/x]'), 'https://example.com/x');
});

test('detectPlatform maps all supported hosts', () => {
  assert.equal(detectPlatform('https://mp.weixin.qq.com/s/abc'), 'wechat');
  assert.equal(detectPlatform('https://weixin.qq.com/s/abc'), 'wechat');
  assert.equal(detectPlatform('https://mobile.twitter.com/a/status/1'), 'x');
  assert.equal(detectPlatform('https://fxtwitter.com/a/status/1'), 'x');
  assert.equal(detectPlatform('https://www.xiaohongshu.com/explore/abc'), 'xiaohongshu');
  assert.equal(detectPlatform('https://xhslink.com/a/b1c2d3'), 'xiaohongshu');
  assert.equal(detectPlatform('https://example.com/blog/1'), 'web');
});

test('detectPlatform recognises the new short-link hosts', () => {
  assert.equal(detectPlatform('https://xhslink.cn/o/b1c2d3'), 'xiaohongshu');
  assert.equal(detectPlatform('https://www.xhs.cn/o/b1c2d3'), 'xiaohongshu');
  assert.equal(detectPlatform('https://t.co/b1c2d3'), 'x');
  assert.equal(detectPlatform('https://fixupx.com/a/status/1'), 'x');
  assert.equal(detectPlatform('https://fixvx.com/a/status/1'), 'x');
  assert.equal(detectPlatform('https://vxtwitter.com/a/status/1'), 'x');

  assert.equal(detectPlatformFromUrl('https://xhslink.cn/o/b1c2d3'), 'xiaohongshu');
  assert.equal(detectPlatformFromUrl('https://xhs.cn/o/b1c2d3'), 'xiaohongshu');
  assert.equal(detectPlatformFromUrl('https://t.co/b1c2d3'), 'x');
  assert.equal(detectPlatformFromUrl('https://fixupx.com/a/status/1'), 'x');
  assert.equal(detectPlatformFromUrl('https://fixvx.com/a/status/1'), 'x');
  assert.equal(detectPlatformFromUrl('https://fxtwitter.com/a/status/1'), 'x');
});

test('normalizeUrl keeps t.co but rewrites every other X alias', () => {
  // t.co is a redirector: rewriting it to x.com would destroy the share token.
  assert.equal(normalizeUrl('https://t.co/b1c2d3'), 'https://t.co/b1c2d3');
  assert.equal(normalizeUrl('https://fixupx.com/a/status/1?s=20'), 'https://x.com/a/status/1');
  assert.equal(normalizeUrl('https://fixvx.com/a/status/1'), 'https://x.com/a/status/1');
  assert.equal(normalizeUrl('https://vxtwitter.com/a/status/1'), 'https://x.com/a/status/1');
});

test('buildSharePayload keeps the original share caption', () => {
  const xhsCaption = '我的笔记标题 http://xhslink.cn/o/b1c2d3 复制后打开【小红书】';
  // The caption already holds a link: keep the title text, not just the URL.
  assert.equal(buildSharePayload('', xhsCaption), xhsCaption);
  assert.equal(
    buildSharePayload('https://www.xiaohongshu.com/explore/64f0abc', xhsCaption),
    xhsCaption,
  );

  const wechatUrl = 'https://mp.weixin.qq.com/s/abc';
  assert.equal(buildSharePayload(wechatUrl, '公众号标题'), `公众号标题\n${wechatUrl}`);
  assert.equal(buildSharePayload(wechatUrl, ''), wechatUrl);
  assert.equal(buildSharePayload('', '只有文案没有链接'), '只有文案没有链接');
  assert.equal(buildSharePayload(null, '   '), '');
});

test('normalizeUrl strips tracking params and drops the fragment', () => {
  assert.equal(
    normalizeUrl('https://example.com/article/?utm_source=weibo&utm_medium=social&id=42#section'),
    'https://example.com/article/?id=42',
  );
  assert.equal(normalizeUrl('https://example.com/?utm_source=x'), 'https://example.com');
  assert.equal(normalizeUrl('example.com/a?utm_source=x&b=2'), 'https://example.com/a?b=2');
  assert.equal(normalizeUrl(''), '');
});

test('normalizeUrl keeps WeChat __biz/mid/idx/sn and XHS xsec tokens', () => {
  assert.equal(
    normalizeUrl(
      'https://mp.weixin.qq.com/s?__biz=MzA5&mid=265&idx=1&sn=abc&chksm=xyz&scene=21&src=timeline&from=singlemessage#rd',
    ),
    'https://mp.weixin.qq.com/s?__biz=MzA5&mid=265&idx=1&sn=abc',
  );
  assert.equal(
    normalizeUrl(
      'https://www.xiaohongshu.com/explore/64f0abc?xsec_token=TOKEN&xsec_source=pc_feed&appuid=123&share_from_user_hidden=true',
    ),
    'https://www.xiaohongshu.com/explore/64f0abc?xsec_token=TOKEN&xsec_source=pc_feed',
  );
});

test('normalizeUrl rewrites Twitter hosts to x.com', () => {
  assert.equal(
    normalizeUrl('https://mobile.twitter.com/foo/status/123?s=20&t=abc'),
    'https://x.com/foo/status/123',
  );
  assert.equal(
    normalizeUrl('https://twitter.com/foo/status/123?ref_src=twsrc%5Etfw&ref_url=https%3A%2F%2Fx.com'),
    'https://x.com/foo/status/123',
  );
});

test('normalizeUrl percent-encodes query values like Python urlencode', () => {
  assert.equal(normalizeUrl('https://example.com/?q=hello world&x=1'), 'https://example.com/?q=hello+world&x=1');
});

test('normalizeUrl leaves port and non-tracking params untouched', () => {
  assert.equal(normalizeUrl('https://example.com:8443/a?keep=1&spm=abc'), 'https://example.com:8443/a?keep=1');
});

test('generateHexId returns a lowercase 32-char hex string', () => {
  const first = generateHexId();
  const second = generateHexId();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test('splitUrlParts tolerates scheme-less inputs', () => {
  const parts = splitUrlParts('x.com/foo/status/1?s=20#top');
  assert.equal(parts.hostname, 'x.com');
  assert.equal(parts.path, '/foo/status/1');
  assert.equal(parts.query, 's=20');
  assert.equal(parts.fragment, 'top');
});

// ---------------------------------------------------------------------------
// generic extractor
// ---------------------------------------------------------------------------

test('markdownToText strips markdown syntax for FTS/AI input', () => {
  const text = markdownToText(
    '# 标题\n\n- 要点 **粗**\n\n[链接](https://a.b) ![img](https://a.b/i.png)\n\n> 引用',
  );
  assert.equal(text, '标题\n要点 粗\n链接\n引用');
});

test('parseGenericHtml extracts metadata, markdown, text and images', () => {
  const html = `<!doctype html><html><head>
    <title>Doc Title</title>
    <meta property="og:title" content="OG 标题">
    <meta property="article:author" content="Alice">
    <meta property="article:published_time" content="2024-01-02T03:04:05Z">
    <meta property="og:image" content="//cdn.example.com/cover.png">
    <meta name="description" content="页面描述">
  </head><body>
    <nav>menu should disappear</nav>
    <article>
      <h1>Hello</h1>
      <p>第一段 <strong>重点</strong></p>
      <img data-src="/img/one.jpg" src="data:image/gif;base64,AAA">
      <script>evil()</script>
      <p>第二段</p>
    </article>
  </body></html>`;

  const content = parseGenericHtml(html, 'https://example.com/posts/1', '');
  assert.equal(content.platform, 'web');
  assert.equal(content.title, 'OG 标题');
  assert.equal(content.author, 'Alice');
  assert.equal(content.published_at, '2024-01-02T03:04:05Z');
  assert.equal(content.partial, false);
  assert.equal(content.referer, 'https://example.com');
  assert.deepEqual(content.image_urls, [
    'https://cdn.example.com/cover.png',
    'https://example.com/img/one.jpg',
  ]);
  assert.match(content.content_markdown, /# Hello/);
  assert.match(content.content_markdown, /\*\*重点\*\*/);
  assert.match(content.content_markdown, /!\[\]\(https:\/\/example\.com\/img\/one\.jpg\)/);
  assert.match(content.content_markdown, /第二段/);
  assert.doesNotMatch(content.content_markdown, /evil|menu should disappear/);
  assert.equal(content.content_text, 'Hello\n第一段 重点\n第二段');
});

test('parseGenericHtml falls back to the share caption and marks empty pages partial', () => {
  const content = parseGenericHtml(
    '<html><head><title>Empty</title></head><body><article></article></body></html>',
    'https://example.com/a',
    '',
  );
  assert.equal(content.title, 'Empty');
  assert.equal(content.content_text, '');
  assert.equal(content.partial, true);
  assert.equal(content.content_markdown, '# Empty\n');

  const captioned = parseGenericHtml(
    '<html><body><div></div></body></html>',
    'https://example.com/a',
    '  看这篇 https://foo.bar/x 真的很棒  ',
  );
  assert.equal(captioned.title, '看这篇 真的很棒');
  assert.equal(captioned.content_markdown, '# 看这篇 真的很棒\n');
});

test('parseGenericHtml explains why an empty body is partial', () => {
  const content = parseGenericHtml(
    '<html><head><title>Empty</title></head><body><article></article></body></html>',
    'https://example.com/a',
    '',
  );
  assert.equal(content.partial, true);
  assert.equal(content.error_message, EMPTY_BODY_MESSAGE);
  assert.equal(EMPTY_BODY_MESSAGE, '未能提取到正文内容（可能是动态渲染页或需要登录）');
});

test('cleanImageUrl resolves relative URLs and rejects data URIs', () => {
  assert.equal(cleanImageUrl('//cdn.example.com/x.png'), 'https://cdn.example.com/x.png');
  assert.equal(cleanImageUrl('/img/a.png', 'https://example.com/p/1'), 'https://example.com/img/a.png');
  assert.equal(cleanImageUrl('img/a.png', 'https://example.com/p/1'), 'https://example.com/p/img/a.png');
  assert.equal(cleanImageUrl('data:image/png;base64,AAA', 'https://example.com'), null);
  assert.equal(cleanImageUrl('', 'https://example.com'), null);
});

test('fallbackTitle trims caption punctuation and truncates long titles', () => {
  assert.equal(fallbackTitle('《标题》 https://x.com/a ！', ''), '标题');
  assert.equal(fallbackTitle('', 'https://example.com/blog/post'), 'example.com/blog/post');
  assert.equal(fallbackTitle('', ''), '未命名剪藏');
  const long = fallbackTitle('a'.repeat(100), '');
  assert.equal(long.length, 81);
  assert.ok(long.endsWith('…'));
});

test('htmlToMarkdown and htmlToText share block-level semantics', () => {
  const html =
    '<div><h2>小标题</h2><p>段落 <em>斜体</em> <a href="https://a.b/c">链接</a></p>' +
    '<ul><li>一</li><li>二<ul><li>嵌套</li></ul></li></ul><blockquote>引用</blockquote></div>';
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /## 小标题/);
  assert.match(markdown, /段落 \*斜体\* \[链接\]\(https:\/\/a\.b\/c\)/);
  assert.match(markdown, /- 一\n- 二/);
  assert.match(markdown, /  - 嵌套/);
  assert.match(markdown, /> 引用/);
  assert.equal(htmlToText(html), '小标题\n段落 斜体 链接\n一\n二\n嵌套\n引用');
});

// ---------------------------------------------------------------------------
// WeChat extractor
// ---------------------------------------------------------------------------

const WECHAT_URL = 'https://mp.weixin.qq.com/s/wechat-article';

test('parseWeChatHtml extracts title/author/date, body and lazy images', () => {
  const html = `<html><head>
      <meta property="og:title" content="OG 微信标题">
      <meta property="og:description" content="摘要文案">
      <meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg">
    </head><body>
      <h1 id="activity-name"> 微信  标题 </h1>
      <a id="js_name"> 公众号名 </a>
      <span id="publish_time">2024-02-03</span>
      <div id="js_content">
        <p>正文 <strong>加粗</strong></p>
        <img data-src="https://mmbiz.qpic.cn/body.jpg" src="data:image/gif;base64,AAA">
        <script>tracker()</script>
      </div>
    </body></html>`;

  const content = parseWeChatHtml(html, WECHAT_URL, '');
  assert.equal(content.platform, 'wechat');
  assert.equal(content.title, '微信 标题');
  assert.equal(content.author, '公众号名');
  assert.equal(content.published_at, '2024-02-03');
  assert.deepEqual(content.image_urls, [
    'https://mmbiz.qpic.cn/body.jpg',
    'https://mmbiz.qpic.cn/cover.jpg',
  ]);
  assert.match(content.content_markdown, /正文 \*\*加粗\*\*/);
  assert.match(content.content_markdown, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/body\.jpg\)/);
  assert.match(content.content_markdown, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/cover\.jpg\)/);
  assert.doesNotMatch(content.content_markdown, /tracker/);
  assert.equal(content.content_text, '正文 加粗');
  assert.equal(content.partial, false);
  assert.equal(content.error_message, null);
  assert.equal(content.referer, 'https://mp.weixin.qq.com/');
});

test('parseWeChatHtml degrades to a partial clip when #js_content is empty', () => {
  const content = parseWeChatHtml(
    '<html><body><div id="js_content"></div></body></html>',
    WECHAT_URL,
    '原始分享文案',
  );
  assert.equal(content.title, '原始分享文案');
  assert.equal(content.content_markdown, '# 原始分享文案\n');
  assert.equal(content.content_text, '原始分享文案');
  assert.equal(content.partial, true);
  assert.equal(content.error_message, '找不到正文内容（#js_content）');
  assert.equal(content.referer, 'https://mp.weixin.qq.com/');
});

test('parseWeChatHtml degrades the verification wall instead of marking it ready', () => {
  const html = `<html><head><title>微信公众平台</title></head><body>
      <div class="weui-msg">
        <h2>环境异常</h2>
        <p>当前环境异常，完成验证后即可继续访问。</p>
        <a class="weui-btn" href="/mp/verify">去验证</a>
      </div>
    </body></html>`;
  const raw = '分享文案 https://mp.weixin.qq.com/s/wechat-article';
  const content = parseWeChatHtml(html, WECHAT_URL, raw);

  assert.equal(content.platform, 'wechat');
  assert.equal(content.partial, true);
  assert.equal(content.error_message, '触发微信访问验证，无法直接抓取正文');
  assert.equal(content.content_text, raw);
  assert.doesNotMatch(content.content_markdown, /环境异常|去验证/);
});

// ---------------------------------------------------------------------------
// X extractor
// ---------------------------------------------------------------------------

test('parseStatusUrl supports every Twitter/X URL flavour', () => {
  assert.deepEqual(parseStatusUrl('https://twitter.com/jack/status/20?s=20'), ['jack', '20']);
  assert.deepEqual(parseStatusUrl('https://x.com/i/web/status/1234567890'), ['i', '1234567890']);
  assert.deepEqual(parseStatusUrl('mobile.twitter.com/foo/status/42'), ['foo', '42']);
  assert.deepEqual(parseStatusUrl('https://x.com/foo/statuses/43'), ['foo', '43']);
  assert.deepEqual(parseStatusUrl('https://x.com/foo'), [null, null]);
  assert.deepEqual(parseStatusUrl('https://x.com/foo/status/not-a-number'), [null, null]);
});

test('parseFxTwitterPayload builds a complete X clip', () => {
  const payload = {
    code: 200,
    tweet: {
      text: 'Hello world\nsecond line',
      url: 'https://x.com/jack/status/20',
      created_at: 'Wed Nov 20 00:00:00 +0000 2024',
      author: { name: 'Jack Dorsey', screen_name: 'jack' },
      media: {
        photos: [{ url: 'https://pbs.twimg.com/media/a.jpg' }],
        videos: [{ thumbnail_url: 'https://pbs.twimg.com/media/v.jpg' }],
        all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }],
      },
      quote: {
        author: { screen_name: 'quoteuser' },
        text: '引用内容\n第二行',
        media: { photos: [{ url: 'https://pbs.twimg.com/media/q.jpg' }] },
      },
      article: {
        title: '文章标题',
        content: { blocks: [{ text: '段落一' }, { text: '段落二' }] },
        media: { photos: [{ url: 'https://pbs.twimg.com/media/art.jpg' }] },
      },
    },
  };

  const content = parseFxTwitterPayload(payload, 'https://x.com/jack/status/20', '');
  assert.equal(content.platform, 'x');
  assert.equal(content.url, 'https://x.com/jack/status/20');
  assert.equal(content.title, 'Hello world');
  assert.equal(content.author, 'Jack Dorsey (@jack)');
  assert.equal(content.published_at, 'Wed Nov 20 00:00:00 +0000 2024');
  assert.deepEqual(content.image_urls, [
    'https://pbs.twimg.com/media/a.jpg',
    'https://pbs.twimg.com/media/v.jpg',
    'https://pbs.twimg.com/media/q.jpg',
    'https://pbs.twimg.com/media/art.jpg',
  ]);
  assert.match(content.content_markdown, /Hello world\nsecond line/);
  assert.match(content.content_markdown, /> 引用 @quoteuser:/);
  assert.match(content.content_markdown, /## 文章标题/);
  assert.match(content.content_markdown, /段落一\n\n段落二/);
  assert.equal(content.content_text, 'Hello world\nsecond line');
  assert.equal(content.partial, false);
  assert.equal(content.referer, 'https://x.com/');
});

test('parseFxTwitterPayload degrades on API errors and unexpected payloads', () => {
  const error = parseFxTwitterPayload(
    { code: 404, message: 'Not Found' },
    'https://x.com/foo/status/1',
    '这条推文',
  );
  assert.equal(error.partial, true);
  assert.equal(error.error_message, 'Not Found');
  assert.equal(error.title, '这条推文');
  assert.equal(error.content_text, '这条推文');
  assert.equal(error.referer, 'https://x.com/');

  const missing = parseFxTwitterPayload({ code: 200 }, 'https://x.com/foo/status/1', '');
  assert.equal(missing.partial, true);
  assert.equal(missing.error_message, 'fxtwitter 未返回推文内容');
  assert.equal(missing.content_text, 'https://x.com/foo/status/1');

  const weird = parseFxTwitterPayload('nope', 'https://x.com/foo/status/1', '');
  assert.equal(weird.partial, true);
  assert.equal(weird.error_message, 'fxtwitter 返回了非预期格式');
});

test('parseFxTwitterPayload falls back to article/quote text when the tweet body is empty', () => {
  const articleOnly = parseFxTwitterPayload(
    {
      code: 200,
      tweet: {
        text: '',
        url: 'https://x.com/foo/status/9',
        author: { screen_name: 'foo' },
        article: {
          title: '长文标题',
          content: { blocks: [{ text: '第一段' }, { text: '第二段' }] },
        },
      },
    },
    'https://x.com/foo/status/9',
    '',
  );
  assert.equal(articleOnly.content_text, '长文标题\n\n第一段\n\n第二段');
  assert.match(articleOnly.content_markdown, /## 长文标题/);

  const quoteOnly = parseFxTwitterPayload(
    {
      code: 200,
      tweet: {
        text: '',
        url: 'https://x.com/foo/status/10',
        author: { screen_name: 'foo' },
        quote: { author: { screen_name: 'quoted' }, text: '引用正文' },
      },
    },
    'https://x.com/foo/status/10',
    '',
  );
  assert.equal(quoteOnly.content_text, '引用正文');
});

test('extractX resolves t.co redirects before calling fxtwitter', async () => {
  const content = await withFetchMock(
    (url) => {
      if (url === 'https://t.co/b1c2d3') {
        return fakeResponse('<html><body>redirect</body></html>', {
          url: 'https://x.com/foo/status/123',
        });
      }
      if (url === 'https://api.fxtwitter.com/foo/status/123') {
        return fakeResponse(
          JSON.stringify({
            code: 200,
            tweet: {
              text: '短链解析后的推文',
              url: 'https://x.com/foo/status/123',
              author: { name: 'Foo', screen_name: 'foo' },
            },
          }),
          { contentType: 'application/json; charset=utf-8' },
        );
      }
      return null;
    },
    async () => extractX('https://t.co/b1c2d3', '推文分享文案'),
  );

  assert.equal(content.platform, 'x');
  assert.equal(content.partial, false);
  assert.equal(content.title, '短链解析后的推文');
  assert.equal(content.content_text, '短链解析后的推文');
  assert.equal(content.url, 'https://x.com/foo/status/123');
});

test('extractX degrades when a t.co link cannot resolve to a status id', async () => {
  const content = await withFetchMock(
    () => fakeResponse('<html></html>', { url: 'https://x.com/foo' }),
    async () => extractX('https://t.co/nope', '分享文案'),
  );
  assert.equal(content.partial, true);
  assert.equal(content.error_message, '无法从链接中解析推文 ID');
  assert.equal(content.content_text, '分享文案');
});

// ---------------------------------------------------------------------------
// Xiaohongshu extractor
// ---------------------------------------------------------------------------

test('extractNoteId reads canonical paths and query strings', () => {
  assert.equal(extractNoteId('https://www.xiaohongshu.com/explore/64f0abc123?xsec_token=x'), '64f0abc123');
  assert.equal(extractNoteId('https://www.xiaohongshu.com/discovery/item/64f0def'), '64f0def');
  assert.equal(extractNoteId('https://www.xiaohongshu.com/unknown?noteId=64f0xyz'), '64f0xyz');
  assert.equal(extractNoteId('https://www.xiaohongshu.com/unknown'), null);
  assert.equal(extractNoteId(''), null);
});

function buildXhsStateHtml() {
  const note = {
    title: '笔记标题',
    desc: '正文里含 } 与 "引号"',
    user: { nickname: '作者' },
    imageList: [{ urlDefault: 'https://sns.xhscdn.com/a.jpg' }],
    time: 1700000000,
    extra: 'IGNORED',
  };
  const state = JSON.stringify({ note: { noteDetailMap: { n1: { note } } } }).replace(
    '"time":1700000000',
    '"time":1700000000,"extra":undefined',
  );
  return `<html><body><script>window.__INITIAL_STATE__=${state};</script><div>dom</div></body></html>`;
}

test('parseXhsHtml parses window.__INITIAL_STATE__ with string-aware slicing', () => {
  const content = parseXhsHtml(
    buildXhsStateHtml(),
    'https://www.xiaohongshu.com/explore/64f0abc',
    '',
  );
  assert.equal(content.platform, 'xiaohongshu');
  assert.equal(content.title, '笔记标题');
  assert.equal(content.author, '作者');
  assert.equal(content.published_at, '2023-11-14T22:13:20+00:00');
  assert.deepEqual(content.image_urls, ['https://sns.xhscdn.com/a.jpg']);
  assert.equal(content.content_text, '正文里含 } 与 "引号"');
  assert.match(content.content_markdown, /^# 笔记标题/);
  assert.match(content.content_markdown, /作者 · 2023-11-14T22:13:20\+00:00/);
  assert.match(content.content_markdown, /正文里含 } 与 "引号"/);
  assert.match(content.content_markdown, /!\[\]\(https:\/\/sns\.xhscdn\.com\/a\.jpg\)/);
  assert.equal(content.partial, false);
  assert.equal(content.error_message, null);
  assert.equal(content.referer, 'https://www.xiaohongshu.com/');
});

test('parseXhsHtml falls back to og metadata and marks the clip partial', () => {
  const html = `<html><head>
      <meta property="og:title" content="小红书标题">
      <meta property="og:description" content="笔记描述">
      <meta property="og:image" content="https://sns.xhscdn.com/og.jpg?imageView2/2/w/1080">
    </head><body><div>风控页</div></body></html>`;
  const content = parseXhsHtml(html, 'https://www.xiaohongshu.com/explore/64f0abc', '');
  assert.equal(content.title, '小红书标题');
  assert.equal(content.content_text, '笔记描述');
  assert.deepEqual(content.image_urls, ['https://sns.xhscdn.com/og.jpg?imageView2/2/w/1080']);
  assert.equal(content.partial, true);
  assert.match(content.error_message || '', /og 元数据/);
  assert.match(content.content_markdown, /^# 小红书标题/);
});

test('parseXhsHtml degrades to raw input when no note data exists', () => {
  const raw = '复制文案 https://xhslink.com/a/b1c2d3';
  const content = parseXhsHtml(
    '<html><body><div>nothing</div></body></html>',
    'https://xhslink.com/a/b1c2d3',
    raw,
  );
  assert.equal(content.partial, true);
  assert.equal(content.error_message, '未在页面中找到 window.__INITIAL_STATE__ 笔记数据');
  assert.equal(content.title, '复制文案');
  assert.equal(content.content_markdown, raw);
  assert.equal(content.content_text, raw);
  assert.equal(content.referer, 'https://www.xiaohongshu.com/');
});

function xhsStateHtml(note) {
  const state = JSON.stringify({ note: { noteDetailMap: { n1: { note } } } });
  return `<html><body><script>window.__INITIAL_STATE__=${state};</script></body></html>`;
}

test('XHS_HEADERS disables compression to slip past the WAF', () => {
  assert.equal(XHS_HEADERS['Accept-Encoding'], 'gzip;q=0, deflate;q=0, identity');
  assert.equal(XHS_HEADERS['User-Agent'], EXTRACTOR_USER_AGENT);
  // WeChat (and most sites) ignore `q=0` and still gzip, so this must stay XHS-only.
  assert.equal(Object.prototype.hasOwnProperty.call(BROWSER_HEADERS, 'Accept-Encoding'), false);
});

test('unwrapXhsRedirect recovers the note URL from the login shell', () => {
  const noteUrl = 'https://www.xiaohongshu.com/explore/64f0abc?xsec_token=TOKEN&xsec_source=pc_feed';
  const login = `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(noteUrl)}`;
  assert.equal(unwrapXhsRedirect(login), noteUrl);
  assert.equal(
    unwrapXhsRedirect(
      `https://www.xiaohongshu.com/website-login/cookie?redirectPath=${encodeURIComponent(
        '/explore/64f0def?xsec_token=T',
      )}`,
    ),
    'https://www.xiaohongshu.com/explore/64f0def?xsec_token=T',
  );
  assert.equal(unwrapXhsRedirect('https://www.xiaohongshu.com/login'), 'https://www.xiaohongshu.com/login');
  assert.equal(unwrapXhsRedirect(noteUrl), noteUrl);
  assert.equal(unwrapXhsRedirect(''), '');
});

test('parseXhsHtml refuses to clip the login shell as og metadata', () => {
  const noteUrl = 'https://www.xiaohongshu.com/explore/64f0abc?xsec_token=TOKEN';
  const html = `<html><head>
      <meta property="og:title" content="小红书 - 你的生活兴趣社区">
      <meta property="og:image" content="https://sns.xhscdn.com/logo.png">
    </head><body><div class="login-box">登录</div></body></html>`;

  const bounced = parseXhsHtml(
    html,
    `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(noteUrl)}`,
    '我的笔记标题 http://xhslink.cn/o/b1c2d3 复制后打开【小红书】',
  );
  assert.equal(bounced.partial, true);
  assert.equal(bounced.error_message, XHS_LOGIN_BLOCK_MESSAGE);
  assert.deepEqual(bounced.image_urls, []);
  assert.equal(bounced.url, noteUrl);
  assert.doesNotMatch(bounced.title, /你的生活兴趣社区/);
  assert.match(bounced.content_text, /我的笔记标题/);

  // Same shell served with HTTP 200 on a note URL: the site-name og:title is
  // the only signal left, and it must still degrade instead of building a clip.
  const shell = parseXhsHtml(
    '<html><head><meta property="og:title" content="小红书"></head><body></body></html>',
    noteUrl,
    '',
  );
  assert.equal(shell.partial, true);
  assert.equal(shell.error_message, XHS_LOGIN_BLOCK_MESSAGE);
});

test('parseXhsHtml keeps one https image per imageList entry', () => {
  const content = parseXhsHtml(
    xhsStateHtml({
      title: '多图笔记',
      desc: '第一段\n\n  第二段   有   空格\n\n\n第三段',
      user: { nickname: '作者' },
      imageList: [
        {
          urlDefault: 'http://sns-webpic-qc.xhscdn.com/a.jpg',
          masterUrl: 'https://sns-webpic-qc.xhscdn.com/a-master.jpg',
          urlPre: 'http://sns-webpic-qc.xhscdn.com/a-pre.jpg',
          url: 'http://sns-webpic-qc.xhscdn.com/a-url.jpg',
          url_default: 'http://sns-webpic-qc.xhscdn.com/a-default.jpg',
          infoList: [
            { imageScene: 'WB_PRV', url: 'http://sns-webpic-qc.xhscdn.com/a-prev.jpg' },
            { imageScene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/a-dft.jpg' },
          ],
        },
        {
          // No urlDefault/masterUrl: the WB_DFT rendition wins.
          infoList: [
            { imageScene: 'WB_PRV', url: 'http://sns-webpic-qc.xhscdn.com/b-prev.jpg' },
            { imageScene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/b-dft.jpg' },
          ],
        },
        {
          urlPre: 'http://sns-webpic-qc.xhscdn.com/c-pre.jpg',
          url: 'http://sns-webpic-qc.xhscdn.com/c-url.jpg',
        },
      ],
      time: 1700000000,
    }),
    'https://www.xiaohongshu.com/explore/64f0abc',
    '',
  );

  assert.deepEqual(content.image_urls, [
    'https://sns-webpic-qc.xhscdn.com/a.jpg',
    'https://sns-webpic-qc.xhscdn.com/b-dft.jpg',
    'https://sns-webpic-qc.xhscdn.com/c-url.jpg',
  ]);
  // Paragraphs survive; inline whitespace is collapsed.
  assert.equal(content.content_text, '第一段\n\n第二段 有 空格\n\n第三段');
  assert.match(content.content_markdown, /第一段\n\n第二段 有 空格\n\n第三段/);
});

test('extractXhs retries the unwrapped note URL after a WAF login redirect', async () => {
  const noteUrl = 'https://www.xiaohongshu.com/explore/64f0abc?xsec_token=TOKEN';
  const loginHtml = `<html><head>
      <meta property="og:title" content="小红书 - 你的生活兴趣社区">
      <meta property="og:image" content="https://sns.xhscdn.com/logo.png">
    </head><body>登录</body></html>`;
  const noteHtml = xhsStateHtml({
    title: '绕过风控的笔记',
    desc: '正文内容',
    user: { nickname: '作者' },
    imageList: [{ urlDefault: 'http://sns-webpic-qc.xhscdn.com/a.jpg' }],
  });

  const content = await withFetchMock(
    (url) => {
      if (url === 'http://xhslink.cn/o/b1c2d3') {
        return fakeResponse(loginHtml, {
          url: `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(noteUrl)}`,
        });
      }
      if (url === noteUrl) return fakeResponse(noteHtml, { url: noteUrl });
      return null;
    },
    async (calls) => {
      const result = await extractXhs('http://xhslink.cn/o/b1c2d3', '分享文案');
      // Every XHS request must advertise `identity`.
      for (const call of calls) {
        assert.equal(call.headers['Accept-Encoding'], 'gzip;q=0, deflate;q=0, identity');
      }
      return result;
    },
  );

  assert.equal(content.partial, false);
  assert.equal(content.url, noteUrl);
  assert.equal(content.title, '绕过风控的笔记');
  assert.deepEqual(content.image_urls, ['https://sns-webpic-qc.xhscdn.com/a.jpg']);
});

test('extractXhs degrades (never stores /login) when the login wall persists', async () => {
  const noteUrl = 'https://www.xiaohongshu.com/explore/64f0abc';
  const loginUrl = `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(noteUrl)}`;
  const loginHtml = `<html><head><meta property="og:title" content="小红书"></head><body>登录</body></html>`;

  const content = await withFetchMock(
    () => fakeResponse(loginHtml, { url: loginUrl }),
    async () => extractXhs(loginUrl, '分享文案'),
  );

  assert.equal(content.partial, true);
  assert.equal(content.error_message, XHS_LOGIN_BLOCK_MESSAGE);
  assert.equal(content.url, noteUrl);
  assert.doesNotMatch(content.url, /\/login/);
});

// ---------------------------------------------------------------------------
// media helpers
// ---------------------------------------------------------------------------

test('dedupeImageUrls keeps order and rejects invalid schemes', () => {
  assert.deepEqual(
    dedupeImageUrls([
      ' https://a.example/1.jpg ',
      'https://a.example/1.jpg',
      'ftp://a.example/x.png',
      '',
      '//cdn.example/x.png',
      'http://b.example/2.png',
    ]),
    ['https://a.example/1.jpg', 'http://b.example/2.png'],
  );
  assert.deepEqual(dedupeImageUrls(null), []);
});

test('resolveMediaFileUri renders locally downloaded images', () => {
  const docDirectory = 'file:///data/user/0/app.jiancang/files/';
  assert.equal(
    resolveMediaFileUri('clips/abc123/deadbeef.jpg', docDirectory),
    'file:///data/user/0/app.jiancang/files/media/clips/abc123/deadbeef.jpg',
  );
  assert.equal(
    resolveMediaFileUri('clips/abc123/deadbeef.jpg', 'file:///data/user/0/app.jiancang/files'),
    'file:///data/user/0/app.jiancang/files/media/clips/abc123/deadbeef.jpg',
  );
  // Already absolute URIs are passed through untouched.
  assert.equal(
    resolveMediaFileUri('file:///data/user/0/app.jiancang/files/media/a.jpg', docDirectory),
    'file:///data/user/0/app.jiancang/files/media/a.jpg',
  );
  assert.equal(
    resolveMediaFileUri('content://media/external/images/1', docDirectory),
    'content://media/external/images/1',
  );
  // Escapes and missing document directory never produce a broken URI.
  assert.equal(resolveMediaFileUri('../escape.jpg', docDirectory), null);
  assert.equal(resolveMediaFileUri('clips/../../escape.jpg', docDirectory), null);
  assert.equal(resolveMediaFileUri('clips/abc/hash.jpg', null), null);
  assert.equal(resolveMediaFileUri('', docDirectory), null);
  assert.equal(resolveMediaFileUri(null, docDirectory), null);
});

test('media downloads use the same desktop UA as the extractors', () => {
  assert.equal(DEFAULT_USER_AGENT, EXTRACTOR_USER_AGENT);
  assert.match(DEFAULT_USER_AGENT, /Mozilla\/5\.0 \(Windows/);
  assert.match(DEFAULT_USER_AGENT, /Chrome\/\d+/);
});

test('extensionForMime normalizes aliases and falls back to .img', () => {
  assert.equal(extensionForMime('image/jpeg; charset=binary'), '.jpg');
  assert.equal(extensionForMime('image/jpg'), '.jpg');
  assert.equal(extensionForMime('image/png'), '.png');
  assert.equal(extensionForMime('image/svg+xml'), '.svg');
  assert.equal(extensionForMime('application/octet-stream'), '.img');
  assert.equal(extensionForMime(''), '.img');
  assert.equal(extensionForMime(undefined), '.img');
});

test('rewriteMarkdownImages rewrites markdown, links, html imgs and entities', () => {
  const stored = [
    { id: 'abc123', original_url: 'https://cdn.example.com/a.jpg' },
    { id: 'def456', original_url: 'https://cdn.example.com/b.png' },
    { id: 'ghi789', original_url: 'https://cdn.example.com/c.jpg?x=1&y=2' },
  ];
  const markdown = [
    '![alt](https://cdn.example.com/a.jpg)',
    '[link](https://cdn.example.com/a.jpg)',
    '<img src="https://cdn.example.com/b.png">',
    '![](https://cdn.example.com/c.jpg?x=1&amp;y=2)',
    '![](https://cdn.example.com/a.jpg#frag)',
    '![](https://other.example.com/z.jpg)',
  ].join('\n');

  const rewritten = rewriteMarkdownImages(markdown, stored);
  assert.match(rewritten, /!\[alt\]\(\/api\/media\/abc123\)/);
  assert.match(rewritten, /\[link\]\(\/api\/media\/abc123\)/);
  assert.match(rewritten, /<img src="\/api\/media\/def456">/);
  assert.match(rewritten, /!\[\]\(\/api\/media\/ghi789\)/);
  assert.match(rewritten, /!\[\]\(\/api\/media\/abc123\)\n/);
  assert.match(rewritten, /!\[\]\(https:\/\/other\.example\.com\/z\.jpg\)/);
});

test('rewriteMarkdownImages accepts snake_case media rows and no-ops when empty', () => {
  const markdown = '![x](https://cdn.example.com/a.jpg)';
  assert.equal(
    rewriteMarkdownImages(markdown, [{ media_id: 'snake-id', original_url: 'https://cdn.example.com/a.jpg' }]),
    '![x](/api/media/snake-id)',
  );
  assert.equal(rewriteMarkdownImages(markdown, []), markdown);
  assert.equal(rewriteMarkdownImages(markdown, null), markdown);
});

test('sha256Hex matches the standard FIPS-180 vectors', () => {
  const encoder = new TextEncoder();
  assert.equal(
    sha256Hex(encoder.encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex(encoder.encode('The quick brown fox jumps over the lazy dog')),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  );
});

// ---------------------------------------------------------------------------
// AI enrichment
// ---------------------------------------------------------------------------

test('extractJsonObject strips code fences and ignores chatty prefixes', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('no fence'), 'no fence');

  const parsed = extractJsonObject(
    '好的，结果如下：\n```json\n{"summary":"摘要","key_points":["一","二"],"tags":"标签A, 标签B"}\n```\n以上',
  );
  assert.equal(parsed.summary, '摘要');
  assert.deepEqual(parsed.key_points, ['一', '二']);
  assert.equal(parsed.tags, '标签A, 标签B');
});

test('extractJsonObject tolerates trailing text and invalid replies', () => {
  assert.deepEqual(extractJsonObject('{"a":{"b":2}} 结束'), { a: { b: 2 } });
  assert.throws(() => extractJsonObject('no json here'), (error) => {
    assert.ok(error instanceof AIEnrichmentError);
    assert.match(error.message, /no JSON object/);
    return true;
  });
  assert.throws(() => extractJsonObject(''), /empty model response/);
  assert.throws(() => extractJsonObject('{bad json}'), /invalid JSON/);
});

test('parseEnrichment coerces lists, dedupes and enforces limits', () => {
  const parsed = parseEnrichment({
    summary: ' 一句话  摘要 ',
    key_points: '一，二；三',
    tags: ['a', 'a', 'b'],
  });
  assert.equal(parsed.summary, '一句话 摘要');
  assert.deepEqual(parsed.key_points, ['一', '二', '三']);
  assert.deepEqual(parsed.tags, ['a', 'b']);

  const limited = parseEnrichment({
    key_points: ['1', '2', '3', '4', '5', '6'],
    tags: ['t1', 't2', 't3', 't4', 't5'],
  });
  assert.deepEqual(limited.key_points, ['1', '2', '3', '4', '5']);
  assert.deepEqual(limited.tags, ['t1', 't2', 't3', 't4']);

  assert.throws(() => parseEnrichment({}), /no usable fields/);
});

test('parseEnrichment truncates oversized summaries and ignores non-strings', () => {
  const parsed = parseEnrichment({
    summary: '字'.repeat(130),
    key_points: [1, { a: 1 }, ''],
    tags: null,
  });
  assert.equal(parsed.summary.length, 120);
  assert.ok(parsed.summary.endsWith('…'));
  assert.deepEqual(parsed.key_points, ['1', '[object Object]']);
  assert.deepEqual(parsed.tags, []);
});

test('buildMessages truncates long bodies and includes existing tags', () => {
  const messages = buildMessages('标题', 'x'.repeat(7000), ['已有标签']);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /标题：标题/);
  assert.match(messages[1].content, /用户已有标签：已有标签/);
  assert.match(messages[1].content, /\.\.\.\(正文已截断\)/);
  assert.match(messages[1].content, /x{6000}/);
});

test('isLocalAiConfigured mirrors the backend ai_enabled rule', () => {
  assert.equal(isLocalAiConfigured({ baseUrl: 'https://llm.local/v1', apiKey: 'k', model: 'm' }), true);
  assert.equal(isLocalAiConfigured({ baseUrl: '  ', apiKey: 'k', model: 'm' }), false);
  assert.equal(isLocalAiConfigured({ baseUrl: 'https://llm.local/v1', apiKey: '', model: 'm' }), false);
});

// ---------------------------------------------------------------------------
// extractContent: second routing pass after a redirect
// ---------------------------------------------------------------------------

test('extractContent re-routes a generic short link that lands on Xiaohongshu', async () => {
  const noteUrl = 'https://www.xiaohongshu.com/explore/64f0abc?xsec_token=TOKEN';
  const noteHtml = xhsStateHtml({
    title: '重定向后的笔记',
    desc: '第一段\n\n第二段',
    user: { nickname: '作者' },
    imageList: [{ urlDefault: 'http://sns-webpic-qc.xhscdn.com/a.jpg' }],
    time: 1700000000,
  });

  const content = await withFetchMock(
    (url) => {
      if (url === 'https://sourl.cn/xhs') {
        // The short link itself only redirects; the HTML has no article.
        return fakeResponse('<html><body>跳转中</body></html>', { url: noteUrl });
      }
      if (url === noteUrl) return fakeResponse(noteHtml, { url: noteUrl });
      return null;
    },
    async (calls) => {
      const result = await extractContent('https://sourl.cn/xhs', '分享笔记');
      assert.equal(calls.length, 2);
      // The second pass must go through the XHS-specific transport headers.
      assert.equal(calls[1].headers['Accept-Encoding'], 'gzip;q=0, deflate;q=0, identity');
      return result;
    },
  );

  assert.equal(content.platform, 'xiaohongshu');
  assert.equal(content.url, noteUrl);
  assert.equal(content.title, '重定向后的笔记');
  assert.equal(content.content_text, '第一段\n\n第二段');
  assert.deepEqual(content.image_urls, ['https://sns-webpic-qc.xhscdn.com/a.jpg']);
  assert.equal(content.partial, false);
});

test('extractContent re-routes a generic short link that lands on WeChat', async () => {
  const articleUrl = 'https://mp.weixin.qq.com/s/redirected-article';
  const articleHtml = `<html><head><meta property="og:title" content="OG 标题"></head><body>
      <h1 id="activity-name">公众号标题</h1>
      <div id="js_content"><p>正文内容</p></div>
    </body></html>`;

  const content = await withFetchMock(
    (url) => {
      if (url === 'https://sourl.cn/wx') {
        return fakeResponse(articleHtml, { url: articleUrl });
      }
      return null;
    },
    async () => extractContent('https://sourl.cn/wx', '公众号分享文案'),
  );

  // The already-fetched HTML is parsed, no second request.
  assert.equal(content.platform, 'wechat');
  assert.equal(content.url, articleUrl);
  assert.equal(content.title, '公众号标题');
  assert.equal(content.content_text, '正文内容');
  assert.equal(content.partial, false);
});

test('extractContent re-routes a generic short link that lands on X', async () => {
  const statusUrl = 'https://x.com/foo/status/123';

  const content = await withFetchMock(
    (url) => {
      if (url === 'https://sourl.cn/tw') return fakeResponse('<html></html>', { url: statusUrl });
      if (url === 'https://api.fxtwitter.com/foo/status/123') {
        return fakeResponse(
          JSON.stringify({ code: 200, tweet: { text: '推文正文', url: statusUrl } }),
          { contentType: 'application/json' },
        );
      }
      return null;
    },
    async () => extractContent('https://sourl.cn/tw', '推文分享'),
  );

  assert.equal(content.platform, 'x');
  assert.equal(content.url, statusUrl);
  assert.equal(content.content_text, '推文正文');
  assert.equal(content.partial, false);
});

test('extractGeneric parses against the post-redirect URL', async () => {
  const finalUrl = 'https://cdn.example.net/posts/1';
  const html =
    '<html><head><title>重定向页面</title></head><body><article>'
    + '<p>正文段落</p><img data-src="/img/rel.jpg">'
    + '</article></body></html>';

  const content = await withFetchMock(
    () => fakeResponse(html, { url: finalUrl }),
    async () => extractGeneric('https://short.example/abc'),
  );

  assert.equal(content.url, finalUrl);
  assert.equal(content.referer, 'https://cdn.example.net');
  assert.deepEqual(content.image_urls, ['https://cdn.example.net/img/rel.jpg']);
  assert.equal(content.partial, false);
});
