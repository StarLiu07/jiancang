"""Xiaohongshu (RED) extractor with layered fallbacks.

Strategy:
1. follow ``xhslink.com`` short links to the canonical note URL;
2. parse ``window.__INITIAL_STATE__`` (falling back to ``og:*`` meta tags);
3. optionally ask the MediaCrawler MCP bridge for ``social_detail``;
4. always degrade to a partial clip instead of raising.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

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
STATE_MARKER = "window.__INITIAL_STATE__"
NOTE_ID_RE = re.compile(r"/(?:explore|discovery/item|item)/([0-9a-zA-Z]+)")

_IMAGE_KEYS = ("urlDefault", "urlPre", "url", "masterUrl", "master_url", "url_default")


def _clean(value: object) -> str:
    return " ".join(str(value).split()).strip() if value else ""


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


def _note_images(note: dict) -> list[str]:
    urls: list[str] = []

    def add(value: object) -> None:
        url = _clean(value)
        if url.startswith(("http://", "https://")) and url not in urls:
            urls.append(url)

    for item in note.get("imageList") or []:
        if isinstance(item, str):
            add(item)
            continue
        if not isinstance(item, dict):
            continue
        for key in _IMAGE_KEYS:
            if item.get(key):
                add(item.get(key))
                break
        for entry in item.get("infoList") or []:
            if isinstance(entry, dict):
                add(entry.get("url"))

    for key in ("images", "image_list", "imageUrls"):
        for item in note.get(key) or []:
            if isinstance(item, str):
                add(item)
            elif isinstance(item, dict):
                for image_key in _IMAGE_KEYS:
                    if item.get(image_key):
                        add(item.get(image_key))
                        break

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


def _note_body_text(note: dict) -> str:
    """Prefer plain description; fall back to converting a rich-text body if present."""
    desc = _clean(note.get("desc") or note.get("description"))
    if desc:
        return desc
    for key in ("content", "noteContent", "body"):
        value = note.get(key)
        if isinstance(value, str) and value.strip():
            return _clean(html_to_markdown(value))
    return ""


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
        final_url = url
        errors: list[str] = []
        og: dict[str, str] = {}

        try:
            async with use_client(client, timeout=self.timeout) as http:
                headers = dict(BROWSER_HEADERS)
                headers["User-Agent"] = self.user_agent
                response = await http.get(url, headers=headers, follow_redirects=True)
                final_url = str(response.url) or url
                response.raise_for_status()
                html = response.text

                note_id = extract_note_id(final_url) or extract_note_id(url)
                note = find_note(extract_initial_state(html))
                if note is not None:
                    return self._build_from_note(note, final_url, raw_input)

                og = self._og_fallback(html)
                if og:
                    return self._build_from_og(og, final_url, raw_input)

                mcp_content = await self._call_mcp(http, final_url, note_id, raw_input)
                if mcp_content is not None:
                    return mcp_content
                errors.append("未在页面中找到 window.__INITIAL_STATE__ 笔记数据")
        except Exception as exc:  # noqa: BLE001 - risk control / network must not crash
            logger.warning("Xiaohongshu extraction failed for %s: %s", url, exc)
            errors.append(f"{type(exc).__name__}: {exc}")

        return self._degraded(
            final_url or url, raw_input, "；".join(errors) or "小红书内容提取失败"
        )

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
