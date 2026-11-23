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

logger = logging.getLogger(__name__)

FX_API_URL = "https://api.fxtwitter.com/{screen_name}/status/{status_id}"
X_REFERER = "https://x.com/"

_STATUS_SEGMENTS = {"status", "statuses"}


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
        if not status_id:
            return self._degraded(url, raw_input, "无法从链接中解析推文 ID")

        api_url = FX_API_URL.format(screen_name=screen_name or "i", status_id=status_id)
        try:
            async with use_client(client) as http:
                response = await http.get(api_url, headers=BROWSER_HEADERS)
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:  # noqa: BLE001 - always degrade, never crash
            logger.warning("fxtwitter request failed for %s: %s", url, exc)
            return self._degraded(url, raw_input, f"{type(exc).__name__}: {exc}")

        if not isinstance(payload, dict):
            return self._degraded(url, raw_input, "fxtwitter 返回了非预期格式")
        code = payload.get("code")
        if code not in (None, 200):
            message = payload.get("message") or f"fxtwitter code={code}"
            return self._degraded(url, raw_input, str(message))

        tweet = payload.get("tweet")
        if not isinstance(tweet, dict):
            return self._degraded(url, raw_input, "fxtwitter 未返回推文内容")

        return self._build(url, tweet, raw_input)

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
        if isinstance(quote, dict):
            quote_author = _clean((quote.get("author") or {}).get("screen_name"))
            quote_text = (quote.get("text") or "").strip()
            quote_lines = [f"> 引用 @{quote_author}:" if quote_author else "> 引用:"]
            for line in quote_text.splitlines():
                quote_lines.append(f"> {line}".rstrip())
            sections.append("\n".join(quote_lines))
            for quote_image in _media_images(quote.get("media")):
                if quote_image not in image_urls:
                    image_urls.append(quote_image)

        heading, article_body, article_images = _article_section(tweet.get("article"))
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
        content_text = tidy_markdown(text)

        return ExtractedContent(
            platform=self.platform,
            url=_clean(tweet.get("url")) or url,
            title=title,
            author=author,
            published_at=published_at,
            content_markdown=content_markdown,
            content_text=content_text,
            image_urls=image_urls,
            partial=not bool(text or image_urls or article_body),
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
