from __future__ import annotations

import pytest

from app.models import Platform
from app.services.url_utils import detect_platform, extract_url, normalize_url

XHS_SHARE_TEXT = "87 【标题】 复制本条信息，打开小红书 https://xhslink.com/a/b1c2d3，查看详情！"


def test_extract_url_from_xhs_share_caption() -> None:
    assert extract_url(XHS_SHARE_TEXT) == "https://xhslink.com/a/b1c2d3"


def test_extract_url_skips_text_before_first_url() -> None:
    raw = "看看这个 https://mp.weixin.qq.com/s/abc123 很有意思"
    assert extract_url(raw) == "https://mp.weixin.qq.com/s/abc123"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://example.com/a/b，", "https://example.com/a/b"),
        ("链接：https://example.com/a/b。", "https://example.com/a/b"),
        ("见 https://example.com/a/b！", "https://example.com/a/b"),
        ("https://example.com/a/b,", "https://example.com/a/b"),
        ("https://example.com/a/b.", "https://example.com/a/b"),
        ("https://example.com/a/b!", "https://example.com/a/b"),
        ("https://example.com/a/b;", "https://example.com/a/b"),
        ("他说“https://example.com/a/b\"", "https://example.com/a/b"),
        ("https://example.com/a/b）", "https://example.com/a/b"),
        ("(https://example.com/a/b)", "https://example.com/a/b"),
        ("https://example.com/a/b#frag", "https://example.com/a/b#frag"),
        (
            "https://en.wikipedia.org/wiki/Foo_(bar)",
            "https://en.wikipedia.org/wiki/Foo_(bar)",
        ),
        ("没有链接的一段文字", None),
        ("", None),
    ],
)
def test_extract_url_strips_trailing_punctuation(raw: str, expected: str | None) -> None:
    assert extract_url(raw) == expected


def test_extract_url_keeps_query_string() -> None:
    raw = "分享 https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc 谢谢"
    assert extract_url(raw) == "https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc"


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://mp.weixin.qq.com/s/abc", Platform.WECHAT),
        ("https://mp.weixin.qq.com/s?__biz=MzA", Platform.WECHAT),
        ("https://x.com/elonmusk/status/1", Platform.X),
        ("https://www.x.com/elonmusk/status/1", Platform.X),
        ("https://twitter.com/elonmusk/status/1", Platform.X),
        ("https://mobile.twitter.com/elonmusk/status/1", Platform.X),
        ("https://fxtwitter.com/elonmusk/status/1", Platform.X),
        ("https://vxtwitter.com/elonmusk/status/1", Platform.X),
        ("https://www.xiaohongshu.com/explore/abc123", Platform.XIAOHONGSHU),
        ("https://xiaohongshu.com/explore/abc123", Platform.XIAOHONGSHU),
        ("https://xhslink.com/a/b1c2d3", Platform.XIAOHONGSHU),
        ("https://xhslink.cn/a/b1c2d3", Platform.XIAOHONGSHU),
        ("https://www.xhs.cn/explore/abc123", Platform.XIAOHONGSHU),
        ("https://t.co/abc123", Platform.X),
        ("https://fixupx.com/elonmusk/status/1", Platform.X),
        ("https://fixvx.com/elonmusk/status/1", Platform.X),
        ("https://example.com/post", Platform.WEB),
        ("https://notx.com/foo", Platform.WEB),
        ("https://notxiaohongshu.com/explore/1", Platform.WEB),
    ],
)
def test_detect_platform(url: str, expected: Platform) -> None:
    assert detect_platform(url) is expected


def test_normalize_url_drops_utm_and_fragment() -> None:
    url = "https://example.com/post?utm_source=x&utm_medium=y&id=42#section"
    assert normalize_url(url) == "https://example.com/post?id=42"


def test_normalize_url_keeps_wechat_article_params() -> None:
    url = (
        "https://mp.weixin.qq.com/s?__biz=MzA1&mid=2650001&idx=1&sn=deadbeef"
        "&chksm=cafe&scene=21#wechat_redirect"
    )
    normalized = normalize_url(url)
    assert normalized == "https://mp.weixin.qq.com/s?__biz=MzA1&mid=2650001&idx=1&sn=deadbeef"


def test_normalize_url_keeps_xhs_xsec_token() -> None:
    url = (
        "https://www.xiaohongshu.com/explore/abc123"
        "?xsec_token=ABCtok&xsec_source=pc_feed&xhs_g_s=1"
        "&share_from_user_hidden=true&spm=note&utm_content=1#detail"
    )
    assert normalize_url(url) == (
        "https://www.xiaohongshu.com/explore/abc123?xsec_token=ABCtok&xsec_source=pc_feed"
    )


def test_normalize_url_unifies_twitter_domains() -> None:
    assert (
        normalize_url("https://mobile.twitter.com/foo/status/1?utm_source=tw&s=20")
        == "https://x.com/foo/status/1"
    )
    assert normalize_url("https://twitter.com/foo/status/1") == "https://x.com/foo/status/1"


def test_normalize_url_keeps_tco_short_links() -> None:
    # ``t.co/xxxx`` is a redirect stub: rewriting the host to ``x.com`` would 404.
    assert normalize_url("https://t.co/abc123?s=20&utm_source=tw") == "https://t.co/abc123"
    assert normalize_url("https://t.co/abc123") == "https://t.co/abc123"


def test_normalize_url_rewrites_fixup_fixv_domains() -> None:
    assert normalize_url("https://fixupx.com/foo/status/1") == "https://x.com/foo/status/1"
    assert normalize_url("https://fixvx.com/foo/status/1") == "https://x.com/foo/status/1"


def test_normalize_url_removes_generic_tracking_keys() -> None:
    url = "https://example.com/a?from=timeline&isappinstalled=0&t=123&keep=1"
    assert normalize_url(url) == "https://example.com/a?keep=1"


def test_normalize_url_idempotent() -> None:
    url = "https://x.com/foo/status/1?utm_source=tw#x"
    once = normalize_url(url)
    assert normalize_url(once) == once
