"""WeChat Official Account (mp.weixin.qq.com) article extractor."""

from __future__ import annotations

import logging

import httpx
from bs4 import BeautifulSoup

from app.models import Platform
from app.services.extractors.base import ExtractedContent
from app.services.extractors.generic import (
    BROWSER_HEADERS,
    clean_image_url,
    collect_images,
    compose_markdown,
    drop_noise,
    fallback_title,
    first_line,
    html_to_markdown,
    html_to_text,
    meta_content,
    og_images,
    tidy_markdown,
    use_client,
)

logger = logging.getLogger(__name__)

WECHAT_REFERER = "https://mp.weixin.qq.com/"

# Served by the anti-bot interstitial instead of the article body.
_VERIFICATION_MARKERS = ("环境异常", "完成验证后即可继续访问", "去验证")
_VERIFICATION_MESSAGE = "触发微信访问验证，无法直接抓取正文"
_NO_BODY_MESSAGE = "找不到正文内容（#js_content）"


def _clean_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(value.split()).strip()


def _visible_text(soup: BeautifulSoup) -> str:
    """Page text without script/style noise, used for anti-bot page detection."""
    clone = BeautifulSoup(str(soup), "html.parser")
    for tag in clone.find_all(("script", "style", "noscript")):
        tag.decompose()
    return clone.get_text(" ", strip=True)


def _is_verification_page(soup: BeautifulSoup) -> bool:
    text = _visible_text(soup)
    return any(marker in text for marker in _VERIFICATION_MARKERS)


class WeChatExtractor:
    platform = Platform.WECHAT

    async def extract(
        self,
        url: str,
        raw_input: str = "",
        client: httpx.AsyncClient | None = None,
    ) -> ExtractedContent:
        try:
            async with use_client(client) as http:
                response = await http.get(url, headers=BROWSER_HEADERS)
                response.raise_for_status()
                html = response.text
        except Exception as exc:  # noqa: BLE001 - degrade instead of crashing
            logger.warning("WeChat fetch failed for %s: %s", url, exc)
            return ExtractedContent(
                platform=self.platform,
                url=url,
                title=fallback_title(raw_input, url),
                content_markdown=raw_input,
                content_text=raw_input,
                partial=True,
                error_message=f"{type(exc).__name__}: {exc}",
                referer=WECHAT_REFERER,
            )
        return self.parse(html, url, raw_input)

    def parse(self, html: str, url: str, raw_input: str = "") -> ExtractedContent:
        soup = BeautifulSoup(html, "html.parser")

        title_node = soup.select_one("#activity-name") or soup.select_one(".rich_media_title")
        title = _clean_text(title_node.get_text() if title_node else "")
        title = title or _clean_text(meta_content(soup, "og:title"))
        title = title or _clean_text(meta_content(soup, "twitter:title"))
        if not title and soup.title:
            title = _clean_text(soup.title.get_text())
        title = title or fallback_title(raw_input, url)

        author_node = soup.select_one("#js_name") or soup.select_one(".rich_media_meta_nickname")
        author = _clean_text(author_node.get_text() if author_node else "")
        author = author or _clean_text(meta_content(soup, "author"))
        author = author or _clean_text(meta_content(soup, "og:article:author"))

        published_node = soup.select_one("#publish_time") or soup.select_one(
            ".rich_media_meta_text"
        )
        published_at = (
            _clean_text(meta_content(soup, "article:published_time"))
            or _clean_text(meta_content(soup, "og:release_date"))
            or _clean_text(published_node.get_text() if published_node else "")
            or None
        )

        # Only a real article body (``#js_content``/``.rich_media_content``, or an
        # ``<article>`` fallback) may be treated as content; the page body can be the
        # anti-bot interstitial.
        body_node = soup.select_one("#js_content") or soup.select_one(".rich_media_content")
        if body_node is None and _is_verification_page(soup):
            raw = (raw_input or "").strip()
            return ExtractedContent(
                platform=self.platform,
                url=url,
                title=first_line(title, limit=200) or title,
                author=author,
                published_at=published_at,
                content_markdown=raw or title,
                content_text=raw or title,
                partial=True,
                error_message=_VERIFICATION_MESSAGE,
                referer=WECHAT_REFERER,
            )
        content_node = body_node or soup.find("article")
        if content_node is None:
            description = _clean_text(meta_content(soup, "og:description"))
            raw = (raw_input or "").strip()
            return ExtractedContent(
                platform=self.platform,
                url=url,
                title=first_line(title, limit=200) or title,
                author=author,
                published_at=published_at,
                content_markdown=compose_markdown(
                    title=title, meta_line=author, body=description
                ),
                content_text=description or raw or title,
                partial=True,
                error_message=_NO_BODY_MESSAGE,
                referer=WECHAT_REFERER,
            )
        drop_noise(content_node)

        # WeChat lazy-loads every body image through `data-src`; rewrite before Markdown conversion.
        content_images = collect_images(content_node, url)

        image_urls: list[str] = []
        for image_url in content_images:
            if image_url not in image_urls:
                image_urls.append(image_url)
        covers: list[str] = []
        for raw in og_images(soup):
            cover = clean_image_url(raw, url)
            if cover and cover not in image_urls:
                image_urls.append(cover)
                covers.append(cover)

        body_markdown = html_to_markdown(content_node)
        content_markdown = tidy_markdown(body_markdown)
        if not content_markdown:
            content_markdown = compose_markdown(
                title=title,
                meta_line=author,
                body=_clean_text(meta_content(soup, "og:description")),
                image_urls=image_urls,
            )
        else:
            # Keep the cover image even when it is not part of the article body.
            for cover in covers:
                if cover not in content_markdown:
                    content_markdown = f"{content_markdown}\n\n![]({cover})"

        content_text = html_to_text(content_node)
        if not content_text:
            content_text = _clean_text(meta_content(soup, "og:description")) or title

        return ExtractedContent(
            platform=self.platform,
            url=url,
            title=first_line(title, limit=200) or title,
            author=author,
            published_at=published_at,
            content_markdown=content_markdown,
            content_text=content_text,
            image_urls=image_urls,
            partial=not bool(body_markdown),
            error_message=None if body_markdown else _NO_BODY_MESSAGE,
            referer=WECHAT_REFERER,
        )
