"""Xiaohongshu (RED) extractor with layered fallbacks.

Strategy:
1. unwrap ``/login``/``/404`` shells (nested ``?source=/404/...?redirectPath=``
   wrappers included), upgrade ``http://`` to ``https://`` and follow short links to the
   canonical note URL;
2. parse ``window.__INITIAL_STATE__``;
3. when the page is a login/risk shell, walk a ladder of attempts: the cleaned HTTPS URL,
   ``/explore/<note_id>`` with an Android Chrome UA, the original ``xhslink`` short link
   recovered from the share caption;
4. ask the MediaCrawler MCP bridge for ``social_detail`` before trusting og metadata;
5. accept ``og:*`` only on real pages (never on login/risk shells), then degrade to a partial
   clip instead of raising.

Requests run on a throwaway cookie jar (a stale WAF cookie bounces every request) and
never overwrite the caller's client state.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import (
    SplitResult,
    parse_qs,
    parse_qsl,
    urlencode,
    urljoin,
    urlsplit,
    urlunsplit,
)

import httpx
from bs4 import BeautifulSoup

from app.config import Settings
from app.models import Platform
from app.services.extractors.base import ExtractedContent
from app.services.extractors.generic import (
    BROWSER_HEADERS,
    compose_markdown,
    fallback_title,
    first_line,
    html_to_markdown,
    meta_content,
    og_images,
    use_client,
)
from app.services.url_utils import normalize_url

logger = logging.getLogger(__name__)

XHS_REFERER = "https://www.xiaohongshu.com/"
XHS_NOTE_BASE = "https://www.xiaohongshu.com"
STATE_MARKER = "window.__INITIAL_STATE__"
NOTE_ID_RE = re.compile(r"/(?:explore|discovery/item|item)/([0-9a-zA-Z]+)")
_URL_IN_TEXT_RE = re.compile(
    r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", re.IGNORECASE
)

#: Android Chrome UA. Xiaohongshu still renders the note page for mobile clients when
#: the desktop request is answered with a login/risk shell.
MOBILE_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
)

# Xiaohongshu's WAF answers with a 302 to ``/login`` when ``Accept-Encoding`` is missing
# or out of browser order, so the header set is explicit instead of relying on httpx defaults.
XHS_HEADERS = {
    **BROWSER_HEADERS,
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

_SHELL_PATHS = ("/login", "/website-login", "/404")
_REDIRECT_PARAM_KEYS = frozenset({"redirectpath", "redirect_path", "redirect"})
# Shell-only query params: never forwarded to the note URL we persist.
_SHELL_ONLY_PARAMS = _REDIRECT_PARAM_KEYS | frozenset({"source", "exsource"})
# Params that can never hold a nested shell URL, so the nested-wrapper scan skips them.
_NESTED_SHELL_SKIP = _REDIRECT_PARAM_KEYS | frozenset({"exsource"})
_NULLISH_VALUES = frozenset({"", "null", "undefined", "none"})
_MAX_UNWRAP_DEPTH = 6
_XHS_HOST_SUFFIX = "xiaohongshu.com"
_SHORT_LINK_HOSTS = ("xhslink.cn", "xhslink.com", "xhs.cn")
_SHELL_TITLES = {"小红书", "小红书 - 标记我的生活", "xiaohongshu"}
_SHELL_TITLE_MARKERS = ("你的生活兴趣社区", "标记我的生活")
# A ``/login`` shell reached through a redirect has a login prompt instead of the
# marketing headline, so that title is a shell marker as well.
_LOGIN_HINT_MARKERS = ("请登录", "登录后继续", "登录页")

_SHELL_ERROR_MESSAGE = "小红书返回了登录/风控壳页，未能获取笔记正文"
_NO_STATE_ERROR_MESSAGE = "未在页面中找到 window.__INITIAL_STATE__ 笔记数据"

# Best single image per ``imageList`` entry, defaults first and previews last.
_PRIMARY_IMAGE_KEYS = ("urlDefault", "masterUrl", "master_url", "url_default")
_FALLBACK_IMAGE_KEYS = ("url", "urlPre")
_DEFAULT_IMAGE_SCENE = "WB_DFT"
_XHSCDN_SUFFIX = "xhscdn.com"

_INLINE_WS_RE = re.compile(r"[ \t\u3000]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")


def _clean(value: object) -> str:
    return " ".join(str(value).split()).strip() if value else ""


def _split_or_none(url: str) -> SplitResult | None:
    """``urlsplit`` that tolerates scheme-less and root-relative inputs."""
    candidate = (url or "").strip()
    if not candidate:
        return None
    if not candidate.startswith(("//", "/")) and "://" not in candidate:
        candidate = "//" + candidate
    try:
        return urlsplit(candidate)
    except ValueError:
        return None


def _path_of(url: str) -> str:
    parts = _split_or_none(url)
    return parts.path if parts is not None else ""


def _path_matches(path: str, prefixes: tuple[str, ...]) -> bool:
    normalized = (path or "").rstrip("/")
    return any(normalized == prefix or normalized.startswith(prefix + "/") for prefix in prefixes)


def _is_shell_url(url: str) -> bool:
    parts = _split_or_none(url)
    return parts is not None and _path_matches(parts.path, _SHELL_PATHS)


def _host_matches(host: str, suffixes: Sequence[str]) -> bool:
    if not host:
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def _is_short_link(url: str) -> bool:
    """True for the share-caption short links (``xhslink.cn``/``xhslink.com``/``xhs.cn``)."""
    parts = _split_or_none(url)
    if parts is None:
        return False
    return _host_matches((parts.hostname or "").lower(), _SHORT_LINK_HOSTS)


def _query_of(url: str) -> str:
    parts = _split_or_none(url)
    return parts.query if parts is not None else ""


def _keep_note_params(query: str) -> list[tuple[str, str]]:
    """Valid note query params in their original order (shell noise dropped)."""
    kept: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key, value in parse_qsl((query or "").lstrip("?"), keep_blank_values=True):
        lowered = key.lower()
        if lowered in _SHELL_ONLY_PARAMS or lowered in seen:
            continue
        if value.strip().lower() in _NULLISH_VALUES:
            continue
        seen.add(lowered)
        kept.append((key, value))
    return kept


def build_explore_url(note_id: str, query: str = "") -> str:
    """Build the canonical ``/explore/<note_id>`` URL, keeping the ``xsec_*`` tokens."""
    note = (note_id or "").strip()
    if not note:
        return ""
    params = _keep_note_params(query)
    base = f"{XHS_NOTE_BASE}/explore/{note}"
    return f"{base}?{urlencode(params)}" if params else base


def recover_short_links(raw_input: str) -> list[str]:
    """Every short link in a share caption, in order and de-duplicated."""
    links: list[str] = []
    for match in _URL_IN_TEXT_RE.finditer(raw_input or ""):
        candidate = match.group(0).rstrip(".,;:!?)]}>\"'")
        if not _is_short_link(candidate) or candidate in links:
            continue
        links.append(candidate)
    return links


def _merge_note_query(target: str, carried: Sequence[tuple[str, str]]) -> str:
    """Append shell-level params (``xsec_token`` ...) missing from the note URL."""
    parts = _split_or_none(target)
    if parts is None:
        return target
    params = _keep_note_params(parts.query)
    present = {key.lower() for key, _ in params}
    for key, value in carried:
        lowered = key.lower()
        if lowered in present or lowered in _SHELL_ONLY_PARAMS:
            continue
        if value.strip().lower() in _NULLISH_VALUES:
            continue
        params.append((key, value))
        present.add(lowered)
    return urlunsplit(
        (parts.scheme or "https", parts.netloc, parts.path, urlencode(params), "")
    )


def _resolve_target(target: str, parts: SplitResult) -> str:
    """Resolve a ``redirectPath`` value, which may be absolute or path-relative."""
    target = (target or "").strip()
    if not target:
        return ""
    if target.startswith("//"):
        return "https:" + target
    if "://" in target:
        return target
    if not parts.netloc:
        return target
    return urljoin(f"{parts.scheme or 'https'}://{parts.netloc}/", target)


def _carried_params(
    params: Sequence[tuple[str, str]], *, skip: int
) -> list[tuple[str, str]]:
    """Shell query params worth forwarding to the unwrapped note URL."""
    carried: list[tuple[str, str]] = []
    for index, (key, value) in enumerate(params):
        if index == skip or key.lower() in _SHELL_ONLY_PARAMS:
            continue
        if value.strip().lower() in _NULLISH_VALUES:
            continue
        carried.append((key, value))
    return carried


def _redirect_target(parts: SplitResult) -> tuple[str, list[tuple[str, str]]]:
    """Return ``(target, carried_params)`` for a login/404 wrapper (else ``("", [])``)."""
    params = parse_qsl(parts.query, keep_blank_values=True)
    for index, (key, value) in enumerate(params):
        if key.lower() in _REDIRECT_PARAM_KEYS and value.strip():
            return value.strip(), _carried_params(params, skip=index)
    # ``?source=/404/sec_...?redirectPath=<note url>`` nests the real redirect one
    # level deeper: unwrap whichever shell hides in a query value.
    for index, (key, value) in enumerate(params):
        if key.lower() in _REDIRECT_PARAM_KEYS or key.lower() in _NESTED_SHELL_SKIP:
            continue
        if not value.strip():
            continue
        nested = _split_or_none(value)
        if nested is not None and _path_matches(nested.path, _SHELL_PATHS):
            return value.strip(), _carried_params(params, skip=index)
    return "", []


def _unwrap_shell(
    url: str, carried: tuple[tuple[str, str], ...] = (), depth: int = 0
) -> str:
    """Walk a login/404 wrapper chain and return the note URL it hides."""
    if depth > _MAX_UNWRAP_DEPTH:
        return ""
    parts = _split_or_none(url)
    if parts is None:
        return ""
    if not _path_matches(parts.path, _SHELL_PATHS):
        return _merge_note_query(url, carried) if carried else url
    target, extra = _redirect_target(parts)
    if not target:
        return ""
    resolved = _resolve_target(target, parts)
    if not resolved:
        return ""
    return _unwrap_shell(resolved, (*carried, *extra), depth + 1)


def _clean_note_url(url: str) -> str:
    """Upgrade ``xiaohongshu.com`` links to HTTPS and drop null shell params."""
    parts = _split_or_none(url)
    if parts is None or not parts.netloc:
        return url
    scheme = parts.scheme or "https"
    if _host_matches((parts.hostname or "").lower(), (_XHS_HOST_SUFFIX,)):
        scheme = "https"
    return urlunsplit(
        (scheme, parts.netloc, parts.path, urlencode(_keep_note_params(parts.query)), "")
    )


def unwrap_xhs_redirect(url: str) -> str:
    """Return the real note URL hidden in a ``/login``/``/404`` shell.

    Used both to repair clips whose stored URL was already polluted with the login page and
    to avoid saving that shell URL back over the original link. Handles nested wrappers
    such as ``/404?source=/404/sec_...?redirectPath=<note url>``, upgrades
    ``http://*.xiaohongshu.com`` to HTTPS and drops ``exSource=null``. URLs that are not
    shells are returned untouched.
    """
    if not url:
        return url
    original = url.strip()
    if not _is_shell_url(original):
        return original
    resolved = _unwrap_shell(original)
    if not resolved:
        return original
    return _clean_note_url(resolved)


def _is_shell_title(title: str) -> bool:
    value = _clean(title)
    if not value:
        return False
    return value in _SHELL_TITLES or any(marker in value for marker in _SHELL_TITLE_MARKERS)


def _has_note_description(description: str) -> bool:
    value = _clean(description)
    return bool(value) and not _is_shell_title(value)


def is_xhs_shell_page(final_url: str, html: str) -> bool:
    """True when the response is Xiaohongshu's login/risk shell instead of a note page."""
    if _path_matches(_path_of(final_url), _SHELL_PATHS):
        return True
    soup = BeautifulSoup(html, "html.parser")
    title = (
        meta_content(soup, "og:title")
        or meta_content(soup, "twitter:title")
        or (soup.title.get_text(strip=True) if soup.title else "")
    )
    if any(marker in _clean(title) for marker in _LOGIN_HINT_MARKERS):
        return True
    if not _is_shell_title(title):
        return False
    description = meta_content(soup, "og:description") or meta_content(soup, "description")
    return not _has_note_description(description)


def extract_note_id(url: str) -> str | None:
    """Extract a note id from a canonical XHS URL (path or query string)."""
    if not url:
        return None
    candidate = url if "://" in url else "//" + url.lstrip("/")
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return None
    match = NOTE_ID_RE.search(parts.path)
    if match:
        return match.group(1)
    for key in ("noteId", "note_id", "noteid"):
        values = parse_qs(parts.query).get(key)
        if values and values[0].strip():
            return values[0].strip()
    return None


def _slice_json_object(text: str, start: int) -> str | None:
    """Return the balanced ``{...}`` object starting at ``start`` (string-aware)."""
    depth = 0
    in_string = False
    quote = ""
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                in_string = False
            continue
        if char in {'"', "'"}:
            in_string = True
            quote = char
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def _loads_lenient(raw: str) -> dict | None:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        patched = re.sub(r"\bundefined\b", "null", raw)
        try:
            parsed = json.loads(patched)
        except json.JSONDecodeError:
            return None
    return parsed if isinstance(parsed, dict) else None


def extract_initial_state(html: str) -> dict | None:
    """Parse the ``window.__INITIAL_STATE__`` blob embedded in a note page."""
    marker_at = html.find(STATE_MARKER)
    if marker_at < 0:
        return None
    assign_at = html.find("=", marker_at + len(STATE_MARKER))
    if assign_at < 0:
        return None
    start = html.find("{", assign_at)
    if start < 0:
        return None
    raw = _slice_json_object(html, start)
    if not raw:
        return None
    return _loads_lenient(raw)


def _looks_like_note(node: object) -> bool:
    if not isinstance(node, dict):
        return False
    return bool(
        node.get("imageList") or node.get("images") or node.get("desc") or node.get("title")
    )


def _deep_find_note(node: object, depth: int = 0) -> dict | None:
    if depth > 14 or not isinstance(node, (dict, list)):
        return None
    if isinstance(node, dict):
        if _looks_like_note(node) and any(
            node.get(key) for key in ("user", "imageList", "noteId", "note_id", "images")
        ):
            return node
        for value in node.values():
            found = _deep_find_note(value, depth + 1)
            if found is not None:
                return found
        return None
    for value in node:
        found = _deep_find_note(value, depth + 1)
        if found is not None:
            return found
    return None


def find_note(state: object) -> dict | None:
    """Locate the note object inside the (deeply nested) initial state."""
    if not isinstance(state, dict):
        return None
    note_block = state.get("note")
    if isinstance(note_block, dict):
        detail_map = note_block.get("noteDetailMap")
        if isinstance(detail_map, dict):
            for value in detail_map.values():
                candidate = value.get("note") if isinstance(value, dict) else None
                if _looks_like_note(candidate):
                    return candidate  # type: ignore[return-value]
        for key in ("note", "data", "detail", "serverRequestInfo"):
            candidate = note_block.get(key)
            if isinstance(candidate, dict) and _looks_like_note(candidate):
                return candidate
    return _deep_find_note(state)


def _upgrade_xhscdn(url: str) -> str:
    """Serve Xiaohongshu CDN images over HTTPS; leave every other URL untouched."""
    if not url.lower().startswith("http://"):
        return url
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return url
    if host == _XHSCDN_SUFFIX or host.endswith("." + _XHSCDN_SUFFIX):
        return "https://" + url[len("http://") :]
    return url


def _pick_image_url(item: dict) -> str:
    """Pick the single best URL for one ``imageList`` entry (defaults over previews)."""
    for key in _PRIMARY_IMAGE_KEYS:
        value = _clean(item.get(key))
        if value:
            return value
    entries = [entry for entry in item.get("infoList") or [] if isinstance(entry, dict)]
    for entry in entries:
        if _clean(entry.get("imageScene")) == _DEFAULT_IMAGE_SCENE:
            value = _clean(entry.get("url"))
            if value:
                return value
    for key in _FALLBACK_IMAGE_KEYS:
        value = _clean(item.get(key))
        if value:
            return value
    for entry in entries:
        value = _clean(entry.get("url"))
        if value:
            return value
    return ""


def _note_images(note: dict) -> list[str]:
    urls: list[str] = []

    def add(value: object) -> None:
        url = _upgrade_xhscdn(_clean(value))
        if url.startswith(("http://", "https://")) and url not in urls:
            urls.append(url)

    for item in note.get("imageList") or []:
        if isinstance(item, str):
            add(item)
        elif isinstance(item, dict):
            # One URL per image: collecting every ``infoList`` entry used to duplicate
            # each picture and drag low-resolution previews into the clip.
            add(_pick_image_url(item))

    for key in ("images", "image_list", "imageUrls"):
        for item in note.get(key) or []:
            if isinstance(item, str):
                add(item)
            elif isinstance(item, dict):
                add(_pick_image_url(item))

    video = note.get("video")
    if isinstance(video, dict):
        media = video.get("media") if isinstance(video.get("media"), dict) else video
        for key in ("thumbnail", "thumbnailUrl", "thumbnail_url", "cover", "coverUrl"):
            add(media.get(key))
    return urls


def _note_time(note: dict) -> str | None:
    raw = note.get("time") or note.get("createTime") or note.get("create_time")
    if isinstance(raw, str) and raw.strip().isdigit():
        raw = int(raw.strip())
    if isinstance(raw, (int, float)) and raw > 0:
        seconds = raw / 1000 if raw > 1e11 else raw
        try:
            return datetime.fromtimestamp(seconds, tz=UTC).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def _clean_desc(text: str) -> str:
    """Collapse inline whitespace while keeping the author's line/paragraph breaks."""
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [_INLINE_WS_RE.sub(" ", line).strip() for line in normalized.split("\n")]
    return _BLANKLINES_RE.sub("\n\n", "\n".join(lines)).strip()


def _note_body_text(note: dict) -> str:
    """Prefer plain description; fall back to converting a rich-text body if present."""
    desc = note.get("desc") or note.get("description")
    body = _clean_desc(str(desc)) if desc else ""
    if body:
        return body
    for key in ("content", "noteContent", "body"):
        value = note.get(key)
        if isinstance(value, str) and value.strip():
            return _clean_desc(html_to_markdown(value))
    return ""


@dataclass(slots=True)
class _Page:
    """One fetch attempt of the risk-control ladder."""

    html: str = ""
    final_url: str = ""
    raw_final_url: str = ""
    error: str = ""


class XiaohongshuExtractor:
    platform = Platform.XIAOHONGSHU

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        timeout: float | None = None,
        user_agent: str | None = None,
    ) -> None:
        self.settings = settings
        self.timeout = timeout if timeout is not None else (
            settings.http_timeout_seconds if settings is not None else 20.0
        )
        self.user_agent = user_agent or (
            settings.user_agent if settings is not None else BROWSER_HEADERS["User-Agent"]
        )

    async def extract(
        self,
        url: str,
        raw_input: str = "",
        client: httpx.AsyncClient | None = None,
    ) -> ExtractedContent:
        requested_url = (url or "").strip()
        # Older clips stored the ``/login?redirectPath=...`` shell instead of the note URL.
        target_url = unwrap_xhs_redirect(requested_url) or requested_url
        note_id = extract_note_id(target_url) or extract_note_id(requested_url)
        errors: list[str] = []
        og_candidate: tuple[dict[str, str], str] | None = None

        try:
            async with use_client(client, timeout=self.timeout) as http:
                # A stale WAF cookie left in the shared jar bounces every request, so the
                # extractor runs on a throwaway jar and gives the client its own back.
                saved_cookies = http.cookies
                http.cookies = httpx.Cookies()
                try:
                    for strategy_url, user_agent in self._strategies(
                        target_url, note_id, raw_input
                    ):
                        page = await self._fetch(http, strategy_url, user_agent)
                        if page.error:
                            errors.append(page.error)
                            continue
                        note = find_note(extract_initial_state(page.html))
                        if note is not None:
                            return self._build_from_note(note, page.final_url, raw_input)
                        # Risk control first: the login shell ships generic og tags that
                        # would otherwise pass for a partially successful note.
                        if is_xhs_shell_page(page.raw_final_url, page.html):
                            errors.append(_SHELL_ERROR_MESSAGE)
                            continue
                        og = self._og_fallback(page.html)
                        if not og:
                            errors.append(_NO_STATE_ERROR_MESSAGE)
                        elif og_candidate is None:
                            og_candidate = (og, page.final_url)

                    mcp_content = await self._call_mcp(
                        http, target_url, note_id, raw_input
                    )
                    if mcp_content is not None:
                        return mcp_content
                finally:
                    http.cookies = saved_cookies
        except Exception as exc:  # noqa: BLE001 - risk control / network must not crash
            logger.warning(
                "Xiaohongshu extraction failed for %s: %s", requested_url, exc
            )
            errors.append(f"{type(exc).__name__}: {exc}")

        if og_candidate is not None:
            og, og_url = og_candidate
            return self._build_from_og(og, og_url, raw_input)

        message = "；".join(dict.fromkeys(errors)) or "小红书内容提取失败"
        return self._degraded(
            self._degrade_url(requested_url, target_url), raw_input, message
        )

    # ------------------------------------------------------------------ fetching

    @staticmethod
    def _headers(user_agent: str) -> dict[str, str]:
        headers = dict(XHS_HEADERS)
        headers["User-Agent"] = user_agent
        return headers

    def _strategies(
        self, target_url: str, note_id: str | None, raw_input: str
    ) -> list[tuple[str, str]]:
        """The risk-control ladder: ``(url, user_agent)`` pairs, best chance first."""
        strategies: list[tuple[str, str]] = []
        attempted: set[str] = set()
        if target_url:
            strategies.append((target_url, self.user_agent))
            attempted.add(target_url)
        if note_id:
            explore_url = build_explore_url(note_id, _query_of(target_url))
            if explore_url:
                strategies.append((explore_url, MOBILE_USER_AGENT))
                attempted.add(explore_url)
        # The clip URL may have been rewritten while the share caption kept the original
        # ``xhslink`` short link: it is a second chance at the note id.
        for short_link in recover_short_links(raw_input):
            if short_link in attempted:
                continue
            strategies.append((short_link, MOBILE_USER_AGENT))
            attempted.add(short_link)

        ladder: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for item in strategies:
            if item in seen:
                continue
            seen.add(item)
            ladder.append(item)
        return ladder

    async def _fetch(
        self, http: httpx.AsyncClient, url: str, user_agent: str
    ) -> _Page:
        try:
            response = await http.get(
                url, headers=self._headers(user_agent), follow_redirects=True
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            return _Page(error=f"{type(exc).__name__}: {exc}")
        raw_final_url = str(response.url) or url
        return _Page(
            html=response.text,
            final_url=unwrap_xhs_redirect(raw_final_url) or raw_final_url,
            raw_final_url=raw_final_url,
        )

    def _degrade_url(self, requested_url: str, target_url: str) -> str:
        """Link worth keeping when extraction keeps being blocked.

        A short link the user actually shared survives a retry (the phone can re-resolve
        it), while a login/404 shell is useless: fall back to the cleaned HTTPS note URL.
        """
        if _is_short_link(requested_url):
            return requested_url
        if target_url and not _is_shell_url(target_url):
            return target_url
        if requested_url and not _is_shell_url(requested_url):
            return requested_url
        return target_url or requested_url

    # ------------------------------------------------------------------ builders

    def _build_from_note(self, note: dict, final_url: str, raw_input: str) -> ExtractedContent:
        user = note.get("user") if isinstance(note.get("user"), dict) else {}
        title = _clean(note.get("title")) or _clean(note.get("displayTitle"))
        body = _note_body_text(note)
        if not title:
            title = first_line(body, limit=60)
        title = title or fallback_title(raw_input, final_url)

        author = _clean(user.get("nickname") or user.get("nickName") or user.get("name"))
        image_urls = _note_images(note)
        published_at = _note_time(note)

        meta_line = " · ".join(part for part in (author, published_at) if part)
        content_markdown = compose_markdown(
            title=title, meta_line=meta_line, body=body, image_urls=image_urls
        )

        return ExtractedContent(
            platform=self.platform,
            url=final_url,
            title=title,
            author=author,
            published_at=published_at,
            content_markdown=content_markdown,
            content_text=body or title,
            image_urls=image_urls,
            partial=False,
            referer=XHS_REFERER,
        )

    def _og_fallback(self, html: str) -> dict[str, str]:
        soup = BeautifulSoup(html, "html.parser")
        data: dict[str, str] = {}
        title = meta_content(soup, "og:title") or meta_content(soup, "twitter:title")
        description = meta_content(soup, "og:description") or meta_content(
            soup, "description"
        )
        if title:
            data["title"] = title
        if description:
            data["description"] = description
        images = [url for url in og_images(soup) if url]
        if images:
            data["images"] = ",".join(
                dict.fromkeys(normalize_url(url) for url in images if url)
            )
        return data if (data.get("title") or data.get("description")) else {}

    def _build_from_og(
        self, og: dict[str, str], final_url: str, raw_input: str
    ) -> ExtractedContent:
        title = og.get("title") or fallback_title(raw_input, final_url)
        body = og.get("description", "")
        image_urls = [url for url in og.get("images", "").split(",") if url]
        return ExtractedContent(
            platform=self.platform,
            url=final_url,
            title=title,
            content_markdown=compose_markdown(
                title=title, body=body, image_urls=image_urls
            ),
            content_text=body or title,
            image_urls=image_urls,
            partial=True,
            error_message="仅解析到页面 og 元数据，正文可能不完整（疑似风控）",
            referer=XHS_REFERER,
        )

    # --------------------------------------------------------------- MCP bridge

    async def _call_mcp(
        self,
        http: httpx.AsyncClient,
        url: str,
        note_id: str | None,
        raw_input: str,
    ) -> ExtractedContent | None:
        endpoint = (self.settings.mediacrawler_mcp_url or "").strip() if self.settings else ""
        if not endpoint:
            return None

        payload = {
            "jsonrpc": "2.0",
            "id": "1",
            "method": "tools/call",
            "params": {
                "name": "social_detail",
                "arguments": {
                    "platform": "xhs",
                    "url": url,
                    "note_id": note_id or "",
                    "raw_input": raw_input,
                },
            },
        }
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        token = (self.settings.mediacrawler_mcp_token or "").strip() if self.settings else ""
        if token:
            headers["Authorization"] = f"Bearer {token}"

        try:
            response = await http.post(endpoint, json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
        except Exception as exc:  # noqa: BLE001 - optional fallback only
            logger.warning("MediaCrawler MCP social_detail failed: %s", exc)
            return None

        detail = _mcp_detail_payload(body)
        if not isinstance(detail, dict):
            return None

        note = detail.get("note") if isinstance(detail.get("note"), dict) else detail
        if not _looks_like_note(note):
            data = detail.get("data") if isinstance(detail.get("data"), dict) else None
            note = data or note
        if not _looks_like_note(note):
            return None

        content = self._build_from_note(note, url, raw_input)
        content.error_message = None
        return content

    # ---------------------------------------------------------------- degraded

    def _degraded(self, url: str, raw_input: str, message: str) -> ExtractedContent:
        raw = (raw_input or "").strip()
        return ExtractedContent(
            platform=self.platform,
            url=url,
            title=fallback_title(raw_input, url),
            content_markdown=raw,
            content_text=raw or url,
            partial=True,
            error_message=message,
            referer=XHS_REFERER,
        )


def _mcp_detail_payload(body: object) -> dict | None:
    """Unwrap a JSON-RPC ``tools/call`` response into the raw detail dict."""
    if not isinstance(body, dict):
        return None
    if "result" not in body and ("title" in body or "desc" in body or "note" in body):
        return body
    result = body.get("result")
    if isinstance(result, dict):
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            return _unwrap_detail(structured)
        for item in result.get("content") or []:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                try:
                    parsed = json.loads(item["text"])
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    return _unwrap_detail(parsed)
        return _unwrap_detail(result)
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except json.JSONDecodeError:
            return None
        return _unwrap_detail(parsed) if isinstance(parsed, dict) else None
    return None


def _unwrap_detail(data: dict) -> dict:
    for key in ("detail", "data", "note", "result"):
        value = data.get(key)
        if isinstance(value, dict):
            return value
    return data
