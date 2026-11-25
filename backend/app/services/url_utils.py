"""URL extraction, platform detection and normalization helpers."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.models import Platform

# Only RFC-3986-ish characters are considered part of a URL. This makes a match stop
# naturally in front of Chinese text such as `https://xhslink.com/a/b1c2d3，查看详情`.
_URL_RE = re.compile(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", re.IGNORECASE)

# Punctuation that frequently sticks to the end of a URL inside share captions.
_TRAILING_JUNK = "，。！？；：、…·,.!?;:'\"“”‘’<>》」』】}）"

_BRACKETS = {")": "(", "]": "[", "}": "{"}

_WECHAT_HOSTS = {"mp.weixin.qq.com", "weixin.qq.com"}
_X_HOSTS = {
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
    "fxtwitter.com",
    "vxtwitter.com",
    "fixupx.com",
    "fixvx.com",
    "t.co",
}
# Hosts whose ``/<screen_name>/status/<id>`` path is valid on ``x.com`` after rewriting.
# ``t.co/xxxx`` is a redirect stub only: rewriting it to ``x.com`` would 404.
_X_REWRITE_HOSTS = {
    "twitter.com",
    "mobile.twitter.com",
    "fxtwitter.com",
    "vxtwitter.com",
    "fixupx.com",
    "fixvx.com",
}
_XHS_HOSTS = {"xiaohongshu.com", "xhslink.com", "xhslink.cn", "xhs.cn"}

# Query parameters dropped during normalization. `utm_*` is handled by prefix.
_TRACKING_PARAMS = {
    "spm",
    "spm_id_from",
    "chksm",
    "scene",
    "poc_token",
    "from",
    "from_source",
    "isappinstalled",
    "s",
    "t",
    "xhs_g_s",
    "share_from_user_hidden",
    "share_id",
    "share_channel",
    "share_reduce_image_id",
    "share_source",
    "appuid",
    "apptime",
    "app_id",
    "wxshare_count",
    "sessionid",
    "clicktime",
    "enterid",
    "ref",
    "ref_src",
    "ref_url",
    "src",
    "source",
    "fbclid",
    "gclid",
}

# Parameters that must never be stripped even if they look like tracking parameters.
_KEEP_PARAMS = {
    "__biz",
    "mid",
    "idx",
    "sn",
    "xsec_token",
    "xsec_source",
}


def _strip_trailing(url: str) -> str:
    """Drop punctuation glued to the end of a URL while keeping balanced brackets."""
    while url:
        last = url[-1]
        if last in _BRACKETS:
            opener = _BRACKETS[last]
            if url.count(opener) >= url.count(last):
                break
            url = url[:-1]
            continue
        if last in _TRAILING_JUNK:
            url = url[:-1]
            continue
        break
    return url


def _split(url: str):
    """``urlsplit`` that also tolerates scheme-less inputs such as ``x.com/a/b``."""
    candidate = url.strip()
    if "://" not in candidate:
        candidate = "//" + candidate.lstrip("/")
    return urlsplit(candidate)


def extract_url(raw_input: str) -> str | None:
    """Return the first usable http(s) URL found in a (possibly messy) share caption."""
    if not raw_input:
        return None
    for match in _URL_RE.finditer(raw_input):
        candidate = _strip_trailing(match.group(0))
        try:
            parts = _split(candidate)
        except ValueError:
            continue
        if parts.scheme in {"http", "https"} and parts.netloc:
            return candidate
    return None


def _host(url: str) -> str:
    try:
        return (_split(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _host_matches(host: str, candidates: set[str]) -> bool:
    if not host:
        return False
    return any(host == candidate or host.endswith("." + candidate) for candidate in candidates)


def detect_platform(url: str) -> Platform:
    """Map a URL to the platform whose extractor should handle it."""
    host = _host(url)
    if _host_matches(host, _WECHAT_HOSTS):
        return Platform.WECHAT
    if _host_matches(host, _X_HOSTS):
        return Platform.X
    if _host_matches(host, _XHS_HOSTS):
        return Platform.XIAOHONGSHU
    return Platform.WEB


def _is_tracking(key: str) -> bool:
    lowered = key.lower()
    return lowered.startswith("utm_") or lowered in _TRACKING_PARAMS


def normalize_url(url: str, platform: Platform | None = None) -> str:
    """Strip tracking noise, unify Twitter hosts to ``x.com`` and drop the fragment."""
    url = (url or "").strip()
    if not url:
        return ""
    if "://" not in url:
        url = "https://" + url.lstrip("/")

    parts = urlsplit(url)
    scheme = (parts.scheme or "https").lower()
    host = (parts.hostname or "").lower()
    if not host:
        return url

    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"

    resolved = platform or detect_platform(url)
    if resolved is Platform.X and _host_matches(host, _X_REWRITE_HOSTS):
        netloc = "x.com"

    kept: list[tuple[str, str]] = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in _KEEP_PARAMS:
            kept.append((key, value))
            continue
        if _is_tracking(key):
            continue
        kept.append((key, value))

    query = urlencode(kept, doseq=True, safe="/:@!$'()*,;+~?=")
    path = parts.path or ""
    if path == "/" and not query:
        path = ""
    return urlunsplit((scheme, netloc, path, query, ""))
