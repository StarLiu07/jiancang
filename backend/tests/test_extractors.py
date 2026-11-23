from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.models import Platform
from app.services.extractors import extract_content
from app.services.extractors.generic import GenericWebExtractor
from app.services.extractors.wechat import WeChatExtractor
from app.services.extractors.x import FX_API_URL, XExtractor, parse_status_url
from app.services.extractors.xhs import (
    XiaohongshuExtractor,
    extract_initial_state,
    extract_note_id,
    find_note,
)

Handler = Callable[[httpx.Request], httpx.Response]


def make_client(handler: Handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --------------------------------------------------------------------------- WeChat

WECHAT_HTML = """
<html><head>
  <meta property="og:title" content="OG 标题不应覆盖正文标题">
  <meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg">
  <meta name="author" content="元数据作者">
  <meta property="article:published_time" content="2024-05-01T10:00:00+08:00">
</head><body>
  <h1 class="rich_media_title" id="activity-name"> 测试文章标题 </h1>
  <a id="js_name">测试公众号</a>
  <em id="publish_time">2024-05-01</em>
  <div class="rich_media_content" id="js_content">
    <p>第一段正文。</p>
    <p><img data-src="https://mmbiz.qpic.cn/img1.png" src="data:image/gif;base64,R0lGOD" /></p>
    <p><img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/img2.jpg" /></p>
    <script>var secret = 1;</script>
    <style>.a{color:red}</style>
  </div>
</body></html>
"""


async def test_wechat_extract_rewrites_data_src_and_markdown() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text=WECHAT_HTML, headers={"content-type": "text/html"})

    async with make_client(handler) as client:
        result = await WeChatExtractor().extract(
            "https://mp.weixin.qq.com/s/abc123", raw_input="分享一篇好文", client=client
        )

    assert result.platform is Platform.WECHAT
    assert result.partial is False
    assert result.error_message is None
    assert result.title == "测试文章标题"
    assert result.author == "测试公众号"
    assert result.referer == "https://mp.weixin.qq.com/"
    assert result.published_at == "2024-05-01T10:00:00+08:00"

    assert "https://mmbiz.qpic.cn/img1.png" in result.image_urls
    assert "https://mmbiz.qpic.cn/img2.jpg" in result.image_urls
    assert "https://mmbiz.qpic.cn/cover.jpg" in result.image_urls
    # data: URIs must never be treated as images
    assert all(not url.startswith("data:") for url in result.image_urls)

    assert "第一段正文。" in result.content_markdown
    assert "![](https://mmbiz.qpic.cn/img1.png)" in result.content_markdown
    assert "![](https://mmbiz.qpic.cn/cover.jpg)" in result.content_markdown

    assert "第一段正文。" in result.content_text
    assert "<p>" not in result.content_text
    assert "var secret" not in result.content_text
    assert len(seen) == 1


async def test_wechat_extract_degrades_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="blocked")

    async with make_client(handler) as client:
        result = await WeChatExtractor().extract(
            "https://mp.weixin.qq.com/s/abc", raw_input="微信分享文案", client=client
        )

    assert result.partial is True
    assert result.error_message is not None
    assert result.content_text == "微信分享文案"
    assert result.referer == "https://mp.weixin.qq.com/"


# -------------------------------------------------------------------------------- X

FX_PAYLOAD = {
    "code": 200,
    "message": "OK",
    "tweet": {
        "url": "https://twitter.com/elonmusk/status/1726110000000000000",
        "id": "1726110000000000000",
        "text": "第一行推文\n第二行内容",
        "author": {"name": "Elon Musk", "screen_name": "elonmusk"},
        "created_at": "Sat Nov 18 23:00:00 +0000 2023",
        "media": {
            "photos": [{"type": "photo", "url": "https://pbs.twimg.com/media/a.jpg"}],
            "videos": [
                {
                    "type": "video",
                    "url": "https://video.twimg.com/x.mp4",
                    "thumbnail_url": "https://pbs.twimg.com/media/thumb.jpg",
                }
            ],
        },
        "quote": {
            "text": "引用推文内容",
            "author": {"screen_name": "someone"},
            "media": {"photos": [{"url": "https://pbs.twimg.com/media/q.jpg"}]},
        },
        "article": {"title": "长文标题", "preview_text": "长文摘要正文"},
    },
}


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://x.com/elonmusk/status/123", ("elonmusk", "123")),
        ("https://twitter.com/elonmusk/status/123", ("elonmusk", "123")),
        ("https://mobile.twitter.com/elonmusk/status/123", ("elonmusk", "123")),
        ("https://fxtwitter.com/elonmusk/status/123", ("elonmusk", "123")),
        ("https://x.com/elonmusk/statuses/123", ("elonmusk", "123")),
        ("https://x.com/i/web/status/123", ("i", "123")),
        ("https://x.com/elonmusk", (None, None)),
    ],
)
def test_parse_status_url(url: str, expected: tuple[str | None, str | None]) -> None:
    assert parse_status_url(url) == expected


async def test_x_extract_from_fxtwitter_payload() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, json=FX_PAYLOAD)

    async with make_client(handler) as client:
        result = await XExtractor().extract(
            "https://twitter.com/elonmusk/status/1726110000000000000",
            raw_input="推文分享文案",
            client=client,
        )

    assert requested == [FX_API_URL.format(screen_name="elonmusk", status_id="1726110000000000000")]
    assert result.platform is Platform.X
    assert result.partial is False
    assert result.error_message is None
    assert result.title == "第一行推文"
    assert "Elon Musk" in result.author
    assert "@elonmusk" in result.author
    assert result.published_at == "Sat Nov 18 23:00:00 +0000 2023"
    assert result.url == "https://twitter.com/elonmusk/status/1726110000000000000"
    assert result.image_urls == [
        "https://pbs.twimg.com/media/a.jpg",
        "https://pbs.twimg.com/media/thumb.jpg",
        "https://pbs.twimg.com/media/q.jpg",
    ]
    assert "第二行内容" in result.content_markdown
    assert "引用推文内容" in result.content_markdown
    assert "## 长文标题" in result.content_markdown
    assert "长文摘要正文" in result.content_markdown
    assert "![](https://pbs.twimg.com/media/a.jpg)" in result.content_markdown


async def test_x_extract_uses_i_endpoint_for_bare_status_url() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, json=FX_PAYLOAD)

    async with make_client(handler) as client:
        await XExtractor().extract("https://x.com/i/web/status/1726110000000000000", client=client)

    assert requested == [FX_API_URL.format(screen_name="i", status_id="1726110000000000000")]


async def test_x_extract_degrades_on_network_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down", request=request)

    raw_input = "来看这条推文 https://x.com/elonmusk/status/1726110000000000000"
    async with make_client(handler) as client:
        result = await XExtractor().extract(
            "https://x.com/elonmusk/status/1726110000000000000",
            raw_input=raw_input,
            client=client,
        )

    assert result.partial is True
    assert result.error_message
    assert "network down" in result.error_message
    assert result.title
    assert result.content_text == raw_input


async def test_x_extract_degrades_on_api_error_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 404, "message": "Tweet not found"})

    async with make_client(handler) as client:
        result = await XExtractor().extract(
            "https://x.com/elonmusk/status/1", raw_input="文案", client=client
        )

    assert result.partial is True
    assert result.error_message == "Tweet not found"


async def test_x_extract_degrades_on_unparsable_url() -> None:
    result = await XExtractor().extract("https://x.com/elonmusk", raw_input="文案")
    assert result.partial is True
    assert result.error_message is not None


# ---------------------------------------------------------------------------- XHS

NOTE_ID = "64f0c0ffee1234567890abcd"

XHS_HTML = (
    """
<html><head><title>小红书</title></head><body>
<span>小红书页面壳</span>
<script>
window.__INITIAL_STATE__ = """
    + json.dumps(
        {
            "global": {"appSettings": {"x": 1}},
            "note": {
                "noteDetailMap": {
                    NOTE_ID: {
                        "note": {
                            "noteId": NOTE_ID,
                            "title": "笔记标题",
                            "desc": "这是笔记的正文内容。\n换行第二段。",
                            "time": 1700000000000,
                            "user": {"nickname": "小红薯作者"},
                            "imageList": [
                                {"urlDefault": "https://sns-img.xhscdn.com/a.jpg"},
                                {"infoList": [{"url": "https://sns-img.xhscdn.com/b.jpg"}]},
                            ],
                        }
                    }
                }
            },
        },
        ensure_ascii=False,
    )
    + """;
</script></body></html>"""
)

XHS_RISK_HTML = "<html><body><p>当前笔记暂时无法浏览，请稍后再试</p></body></html>"


def test_extract_note_id_variants() -> None:
    assert extract_note_id(f"https://www.xiaohongshu.com/explore/{NOTE_ID}?xsec_token=x") == NOTE_ID
    assert extract_note_id(f"https://www.xiaohongshu.com/discovery/item/{NOTE_ID}") == NOTE_ID
    assert (
        extract_note_id(f"https://www.xiaohongshu.com/explore?noteId={NOTE_ID}&x=1") == NOTE_ID
    )
    assert extract_note_id("https://xhslink.com/a/b1c2d3") is None


def test_extract_initial_state_and_find_note() -> None:
    state = extract_initial_state(XHS_HTML)
    assert state is not None
    note = find_note(state)
    assert note is not None
    assert note["title"] == "笔记标题"


def test_extract_initial_state_handles_undefined_and_missing() -> None:
    html = '<script>window.__INITIAL_STATE__={"a":undefined,"b":{"c":1}}</script>'
    state = extract_initial_state(html)
    assert state == {"a": None, "b": {"c": 1}}
    assert extract_initial_state("<html></html>") is None


async def test_xhs_extract_follows_short_link_and_parses_state() -> None:
    canonical = f"https://www.xiaohongshu.com/explore/{NOTE_ID}?xsec_token=TOK"
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if request.url.host == "xhslink.com":
            return httpx.Response(302, headers={"location": canonical})
        return httpx.Response(200, text=XHS_HTML, headers={"content-type": "text/html"})

    # Deliberately no follow_redirects on the client: the extractor must ask for it.
    async with make_client(handler) as client:
        result = await XiaohongshuExtractor().extract(
            "https://xhslink.com/a/b1c2d3",
            raw_input="87 【笔记标题】 复制本条信息，打开小红书 https://xhslink.com/a/b1c2d3",
            client=client,
        )

    assert requested[0] == "https://xhslink.com/a/b1c2d3"
    assert result.platform is Platform.XIAOHONGSHU
    assert result.partial is False
    assert result.title == "笔记标题"
    assert result.author == "小红薯作者"
    assert result.url == canonical
    assert result.published_at is not None and result.published_at.startswith("2023-11-14")
    assert result.image_urls == [
        "https://sns-img.xhscdn.com/a.jpg",
        "https://sns-img.xhscdn.com/b.jpg",
    ]
    assert "这是笔记的正文内容。" in result.content_text
    assert "这是笔记的正文内容。" in result.content_markdown
    assert "![](https://sns-img.xhscdn.com/a.jpg)" in result.content_markdown
    assert result.referer == "https://www.xiaohongshu.com/"


async def test_xhs_extract_degrades_on_risk_control(test_settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=XHS_RISK_HTML)

    url = f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
    raw_input = f"87 【某笔记】 复制本条信息，打开小红书 {url}"
    async with make_client(handler) as client:
        result = await XiaohongshuExtractor(test_settings).extract(
            url, raw_input=raw_input, client=client
        )

    assert result.platform is Platform.XIAOHONGSHU
    assert result.partial is True
    assert result.error_message
    assert result.url == url
    assert result.content_text == raw_input
    assert result.title


async def test_xhs_extract_degrades_on_http_403(test_settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="forbidden")

    url = f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
    async with make_client(handler) as client:
        result = await XiaohongshuExtractor(test_settings).extract(
            url, raw_input="小红书分享", client=client
        )

    assert result.partial is True
    assert "403" in (result.error_message or "")
    assert result.content_text == "小红书分享"


async def test_xhs_extract_uses_og_fallback() -> None:
    html = """<html><head>
      <meta property="og:title" content="OG 笔记标题">
      <meta property="og:description" content="OG 笔记描述">
      <meta property="og:image" content="https://sns-img.xhscdn.com/og.jpg">
    </head><body>加载中</body></html>"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    url = f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
    async with make_client(handler) as client:
        result = await XiaohongshuExtractor().extract(url, raw_input="文案", client=client)

    assert result.partial is True
    assert result.title == "OG 笔记标题"
    assert "OG 笔记描述" in result.content_text
    assert result.image_urls == ["https://sns-img.xhscdn.com/og.jpg"]
    assert "仅解析到页面 og 元数据" in (result.error_message or "")


async def test_xhs_extract_falls_back_to_mediacrawler_mcp(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        mediacrawler_mcp_url="https://nuc.local/mcp",
        mediacrawler_mcp_token="secret-token",
    )
    captured: dict[str, object] = {}

    detail_payload = {
        "title": "MCP 笔记标题",
        "desc": "MCP 返回的正文",
        "user": {"nickname": "MCP 作者"},
        "imageList": [{"urlDefault": "https://sns-img.xhscdn.com/mcp.jpg"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            captured["auth"] = request.headers.get("authorization")
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": "1",
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps(detail_payload, ensure_ascii=False)}
                        ]
                    },
                },
            )
        return httpx.Response(200, text=XHS_RISK_HTML)

    url = f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
    async with make_client(handler) as client:
        result = await XiaohongshuExtractor(settings).extract(url, raw_input="文案", client=client)

    assert captured["auth"] == "Bearer secret-token"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["method"] == "tools/call"
    assert body["params"]["name"] == "social_detail"
    assert body["params"]["arguments"]["note_id"] == NOTE_ID

    assert result.partial is False
    assert result.error_message is None
    assert result.title == "MCP 笔记标题"
    assert result.author == "MCP 作者"
    assert "MCP 返回的正文" in result.content_text
    assert result.image_urls == ["https://sns-img.xhscdn.com/mcp.jpg"]


async def test_xhs_extract_survives_mcp_failure(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        mediacrawler_mcp_url="https://nuc.local/mcp",
        mediacrawler_mcp_token="secret-token",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            raise httpx.ConnectError("mcp offline", request=request)
        return httpx.Response(200, text=XHS_RISK_HTML)

    url = f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
    async with make_client(handler) as client:
        result = await XiaohongshuExtractor(settings).extract(
            url, raw_input="原始文案", client=client
        )

    assert result.partial is True
    assert result.content_text == "原始文案"


# ------------------------------------------------------------------------ Generic

GENERIC_HTML = """
<html><head>
  <title>页面标题</title>
  <meta property="og:title" content="OG 页面标题">
  <meta property="og:image" content="https://cdn.example.com/cover.png">
  <meta name="author" content="站点作者">
</head><body>
  <nav>导航栏内容</nav>
  <article>
    <h1>正文标题</h1>
    <p>正文第一段。</p>
    <p><img src="/img/inline.jpg" alt="inline" /></p>
    <script>console.log('noise')</script>
  </article>
  <footer>页脚内容</footer>
</body></html>
"""


async def test_generic_extract_builds_markdown_and_images() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=GENERIC_HTML)

    async with make_client(handler) as client:
        result = await GenericWebExtractor().extract(
            "https://blog.example.com/post/1", raw_input="分享", client=client
        )

    assert result.platform is Platform.WEB
    assert result.title == "OG 页面标题"
    assert result.author == "站点作者"
    assert result.referer == "https://blog.example.com"
    assert result.image_urls == [
        "https://cdn.example.com/cover.png",
        "https://blog.example.com/img/inline.jpg",
    ]
    assert "正文第一段。" in result.content_text
    assert "导航栏内容" not in result.content_text
    assert "页脚内容" not in result.content_text
    assert "console.log" not in result.content_text
    assert "https://blog.example.com/img/inline.jpg" in result.content_markdown


async def test_generic_extract_degrades_on_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout", request=request)

    async with make_client(handler) as client:
        result = await GenericWebExtractor().extract(
            "https://blog.example.com/post/1", raw_input="分享文案", client=client
        )

    assert result.partial is True
    assert result.error_message is not None
    assert result.content_text == "分享文案"


# ----------------------------------------------------------------- dispatch API


async def test_extract_content_dispatches_by_platform(test_settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.fxtwitter.com":
            return httpx.Response(200, json=FX_PAYLOAD)
        if request.url.host == "mp.weixin.qq.com":
            return httpx.Response(200, text=WECHAT_HTML)
        return httpx.Response(200, text=GENERIC_HTML)

    async with make_client(handler) as client:
        wechat = await extract_content(
            "https://mp.weixin.qq.com/s/abc",
            Platform.WECHAT,
            raw_input="微信",
            settings=test_settings,
            client=client,
        )
        x_result = await extract_content(
            "https://x.com/elonmusk/status/1",
            Platform.X,
            raw_input="推文",
            settings=test_settings,
            client=client,
        )
        web = await extract_content(
            "https://blog.example.com/post/1",
            Platform.WEB,
            raw_input="网页",
            settings=test_settings,
            client=client,
        )

    assert wechat.platform is Platform.WECHAT and wechat.title == "测试文章标题"
    assert x_result.platform is Platform.X and x_result.title == "第一行推文"
    assert web.platform is Platform.WEB and web.title == "OG 页面标题"


async def test_extract_content_auto_detects_platform(test_settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.fxtwitter.com":
            return httpx.Response(200, json=FX_PAYLOAD)
        if request.url.host == "mp.weixin.qq.com":
            return httpx.Response(200, text=WECHAT_HTML)
        return httpx.Response(200, text=GENERIC_HTML)

    async with make_client(handler) as client:
        # No explicit platform: the URL decides, like the ingestion pipeline expects.
        wechat = await extract_content(
            "https://mp.weixin.qq.com/s/abc",
            raw_input="微信",
            settings=test_settings,
            client=client,
        )
        x_result = await extract_content(
            "https://x.com/elonmusk/status/1",
            raw_input="推文",
            settings=test_settings,
            client=client,
        )
        web = await extract_content(
            "https://blog.example.com/post/1",
            raw_input="网页",
            settings=test_settings,
            client=client,
        )

    assert wechat.platform is Platform.WECHAT
    assert x_result.platform is Platform.X
    assert web.platform is Platform.WEB


async def test_extract_content_never_raises_on_unexpected_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("unexpected boom")

    async with make_client(handler) as client:
        result = await extract_content(
            "https://blog.example.com/post/1",
            Platform.WEB,
            raw_input="原始文案",
            client=client,
        )

    assert result.partial is True
    assert result.error_message is not None
    assert result.content_text == "原始文案"
