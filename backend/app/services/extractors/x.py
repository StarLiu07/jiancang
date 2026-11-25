"""X / Twitter status extractor backed by the public fxtwitter API."""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import httpx

from app.models import Platform
from app.services.extractors.base import ExtractedContent
from app.services.extractors.generic import (
    BROWSER_HEADERS,
    compose_markdown,
    fallback_title,
    first_line,
    tidy_markdown,
    use_client,
)
from app.services.url_utils import detect_platform

logger = logging.getLogger(__name__)

FX_API_URL = "https://api.fxtwitter.com/{screen_name}/status/{status_id}"
X_REFERER = "https://x.com/"

_STATUS_SEGMENTS = {"status", "statuses"}

# Hosts that only exist to redirect (``t.co/abc`` -> the real status URL).
_SHORTENER_HOSTS = {
    "t.co",
    "bit.ly",
    "bitly.com",
    "tinyurl.com",
    "tiny.cc",
    "goo.gl",
    "ow.ly",
    "buff.ly",
    "is.gd",
    "v.gd",
    "cutt.ly",
    "shorturl.at",
    "rebrand.ly",
    "t.cn",
    "dlvr.it",
    "ift.tt",
    "lnkd.in",
}


def _host(url: str) -> str:
    candidate = url if "://" in url else "//" + (url or "").lstrip("/")
    try:
        return (urlsplit(candidate).hostname or "").lower()
    except ValueError:
        return ""


def _needs_redirect_lookup(url: str) -> bool:
    """True when ``url`` is a redirect stub rather than a canonical X status/profile URL."""
    host = _host(url)
    if not host:
        return False
    if host in _SHORTENER_HOSTS or any(host.endswith("." + s) for s in _SHORTENER_HOSTS):
        return True
    # Any non-Twitter host that does not expose a status id is a redirect wrapper.
    return detect_platform(url) is not Platform.X


def parse_status_url(url: str) -> tuple[str | None, str | None]:
    """Return ``(screen_name, status_id)`` extracted from any Twitter/X URL flavour."""
    candidate = url if "://" in url else "//" + url.lstrip("/")
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return None, None

    segments = [segment for segment in parts.path.split("/") if segment]
    for index, segment in enumerate(segments):
        if segment.lower() not in _STATUS_SEGMENTS:
            continue
        if index + 1 >= len(segments) or not segments[index + 1].isdigit():
            continue
        screen_name = segments[index - 1] if index >= 1 else "i"
        if screen_name.lower() == "web" and index >= 2:
            screen_name = segments[index - 2]
        if screen_name.lower() in {"i", "web", "intent"}:
            screen_name = "i"
        return screen_name, segments[index + 1]
    return None, None


def _clean(value: object) -> str:
    return " ".join(str(value).split()).strip() if value else ""


def _media_images(media: object, *, include_all: bool = True) -> list[str]:
    """Collect photo URLs and video thumbnails from a fxtwitter ``media`` object."""
    if not isinstance(media, dict):
        return []

    urls: list[str] = []

    def add(value: object) -> None:
        url = _clean(value)
        if url.startswith(("http://", "https://")) and url not in urls:
            urls.append(url)

    for photo in media.get("photos") or []:
        if isinstance(photo, dict):
            add(photo.get("url") or photo.get("thumbnail_url"))
    for video in media.get("videos") or []:
        if isinstance(video, dict):
            add(video.get("thumbnail_url") or video.get("url"))
    if include_all:
        for item in media.get("all") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "photo":
                add(item.get("url") or item.get("thumbnail_url"))
            else:
                add(item.get("thumbnail_url"))
    return urls


def _article_section(article: object) -> tuple[str, str, list[str]]:
    """Return ``(heading, body, image_urls)`` for an X Article payload."""
    if not isinstance(article, dict):
        return "", "", []

    title = _clean(article.get("title"))
    blocks: list[str] = []
    content = article.get("content")
    if isinstance(content, dict):
        for block in content.get("blocks") or []:
            if isinstance(block, dict):
                text = _clean(block.get("text"))
                if text:
                    blocks.append(text)
    elif isinstance(content, str):
        blocks.append(_clean(content))

    body = "\n\n".join(blocks) or _clean(article.get("preview_text"))
    images: list[str] = []
    cover = article.get("cover_media")
    if isinstance(cover, dict):
        images.extend(_media_images({"photos": [cover]}))
    images.extend(_media_images(article.get("media")))

    heading = f"## {title}" if title else "## X Article"
    return heading, body, images


class XExtractor:
    platform = Platform.X

    async def extract(
        self,
        url: str,
        raw_input: str = "",
        client: httpx.AsyncClient | None = None,
    ) -> ExtractedContent:
        screen_name, status_id = parse_status_url(url)
        if not status_id and not _needs_redirect_lookup(url):
            return self._degraded(url, raw_input, "无法从链接中解析推文 ID")

        try:
            async with use_client(client) as http:
                target_url = url
                if not status_id:
                    # ``t.co`` and other redirect stubs hide the real status URL behind a 3xx.
                    target_url = await self._resolve_url(http, url)
                    screen_name, status_id = parse_status_url(target_url)
                if not status_id:
                    return self._degraded(target_url, raw_input, "无法从链接中解析推文 ID")

                api_url = FX_API_URL.format(
                    screen_name=screen_name or "i", status_id=status_id
                )
                response = await http.get(api_url, headers=BROWSER_HEADERS)
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:  # noqa: BLE001 - always degrade, never crash
            logger.warning("fxtwitter request failed for %s: %s", url, exc)
            return self._degraded(url, raw_input, f"{type(exc).__name__}: {exc}")

        if not isinstance(payload, dict):
            return self._degraded(target_url, raw_input, "fxtwitter 返回了非预期格式")
        code = payload.get("code")
        if code not in (None, 200):
            message = payload.get("message") or f"fxtwitter code={code}"
            return self._degraded(target_url, raw_input, str(message))

        tweet = payload.get("tweet")
        if not isinstance(tweet, dict):
            return self._degraded(target_url, raw_input, "fxtwitter 未返回推文内容")

        return self._build(target_url, tweet, raw_input)

    async def _resolve_url(self, http: httpx.AsyncClient, url: str) -> str:
        """Follow redirects on a short link and return the final URL (best effort)."""
        try:
            response = await http.get(url, headers=BROWSER_HEADERS, follow_redirects=True)
        except Exception as exc:  # noqa: BLE001 - keep the original URL and degrade later
            logger.warning("X short link resolution failed for %s: %s", url, exc)
            return url
        return str(response.url) or url

    def _build(self, url: str, tweet: dict, raw_input: str) -> ExtractedContent:
        text = (tweet.get("text") or "").replace("\r\n", "\n").strip()
        author_obj = tweet.get("author") if isinstance(tweet.get("author"), dict) else {}
        author_name = _clean(author_obj.get("name"))
        screen_name = _clean(author_obj.get("screen_name"))
        if author_name and screen_name and author_name.lower() != screen_name.lower():
            author = f"{author_name} (@{screen_name})"
        else:
            author = author_name or (f"@{screen_name}" if screen_name else "")

        title = first_line(text) or (
            f"@{screen_name} 的推文" if screen_name else fallback_title(raw_input, url)
        )
        published_at = _clean(tweet.get("created_at")) or None

        image_urls = _media_images(tweet.get("media"))

        sections: list[str] = []
        if text:
            sections.append(text)

        quote = tweet.get("quote")
        plain_quote = ""
        if isinstance(quote, dict):
            quote_author = _clean((quote.get("author") or {}).get("screen_name"))
            quote_text = (quote.get("text") or "").strip()
            quote_lines = [f"> 引用 @{quote_author}:" if quote_author else "> 引用:"]
            for line in quote_text.splitlines():
                quote_lines.append(f"> {line}".rstrip())
            sections.append("\n".join(quote_lines))
            if quote_text:
                plain_quote = "\n".join(
                    part
                    for part in (
                        f"引用 @{quote_author}:" if quote_author else "引用:",
                        quote_text,
                    )
                    if part
                )
            for quote_image in _media_images(quote.get("media")):
                if quote_image not in image_urls:
                    image_urls.append(quote_image)

        heading, article_body, article_images = _article_section(tweet.get("article"))
        article = tweet.get("article")
        article_title = _clean(article.get("title")) if isinstance(article, dict) else ""
        if article_body or article_images:
            sections.append(heading)
            if article_body:
                sections.append(article_body)
            for article_image in article_images:
                if article_image not in image_urls:
                    image_urls.append(article_image)

        content_markdown = tidy_markdown(
            compose_markdown(body="\n\n".join(sections), image_urls=image_urls)
        )
        # Long-form (X Article) and quote-only tweets carry no ``text``: keep ``content_text``
        # populated so FTS search and AI summaries still see the words.
        content_text = tidy_markdown(text)
        if not content_text:
            plain_parts = [part for part in (plain_quote, article_title, article_body) if part]
            content_text = tidy_markdown("\n\n".join(plain_parts))

        return ExtractedContent(
            platform=self.platform,
            url=_clean(tweet.get("url")) or url,
            title=title,
            author=author,
            published_at=published_at,
            content_markdown=content_markdown,
            content_text=content_text,
            image_urls=image_urls,
            partial=not bool(content_text or image_urls),
            error_message=None,
            referer=X_REFERER,
        )

    def _degraded(self, url: str, raw_input: str, message: str) -> ExtractedContent:
        raw = (raw_input or "").strip() or url
        return ExtractedContent(
            platform=self.platform,
            url=url,
            title=fallback_title(raw_input, url),
            content_markdown=raw,
            content_text=raw,
            partial=True,
            error_message=message,
            referer=X_REFERER,
        )
