"""Generic web page extractor plus shared HTML helpers used by other extractors."""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urljoin, urlsplit

import html2text
import httpx
from bs4 import BeautifulSoup, Tag

from app.models import Platform
from app.services.extractors.base import ExtractedContent
from app.services.url_utils import extract_url

logger = logging.getLogger(__name__)

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

BROWSER_HEADERS = {
    "User-Agent": DEFAULT_USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

NOISE_TAGS = ("script", "style", "nav", "footer", "aside", "noscript", "iframe", "form", "svg")

_LAZY_IMAGE_ATTRS = (
    "data-src",
    "data-original",
    "data-actualsrc",
    "data-lazy-src",
    "data-echo",
    "src",
)

_OG_IMAGE_KEYS = (
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
)

_WHITESPACE_RE = re.compile(r"[ \t\u3000]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")
_URL_IN_TEXT_RE = re.compile(r"https?://\S+")


def html_to_markdown(markup: str | Tag) -> str:
    """Convert an HTML snippet/node into clean Markdown with unwrapped lines."""
    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_images = False
    converter.ignore_links = False
    converter.ignore_emphasis = False
    converter.single_line_break = True
    text = converter.handle(str(markup))
    return tidy_markdown(text)


def tidy_markdown(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = _WHITESPACE_RE.sub(" ", text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = _BLANKLINES_RE.sub("\n\n", text)
    return text.strip()


def html_to_text(markup: str | Tag) -> str:
    """Extract readable plain text (no Markdown syntax) from HTML."""
    soup = BeautifulSoup(str(markup), "html.parser")
    for tag in soup.find_all(NOISE_TAGS):
        tag.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")
    raw = soup.get_text("\n")
    lines = [line.strip() for line in raw.splitlines()]
    text = "\n".join(line for line in lines if line)
    return _BLANKLINES_RE.sub("\n\n", text).strip()


def meta_content(soup: BeautifulSoup, key: str) -> str:
    """Return ``content`` of a meta tag matched by property/name/itemprop."""
    tag = soup.find("meta", attrs={"property": key}) or soup.find("meta", attrs={"name": key})
    if tag is None:
        tag = soup.find("meta", attrs={"itemprop": key})
    if tag is None:
        return ""
    return (tag.get("content") or "").strip()


def og_images(soup: BeautifulSoup) -> list[str]:
    urls: list[str] = []
    for key in _OG_IMAGE_KEYS:
        for tag in soup.find_all("meta", attrs={"property": key}) + soup.find_all(
            "meta", attrs={"name": key}
        ):
            value = (tag.get("content") or "").strip()
            if value and value not in urls:
                urls.append(value)
    return urls


def clean_image_url(raw: str | None, base_url: str = "") -> str | None:
    """Normalize an image URL, dropping data URIs and resolving scheme-relative ones."""
    if not raw:
        return None
    value = raw.strip().strip("\"'")
    if not value:
        return None
    lowered = value.lower()
    if lowered.startswith(("data:", "javascript:", "blob:", "about:")):
        return None
    if value.startswith("//"):
        value = "https:" + value
    elif not lowered.startswith(("http://", "https://")):
        if not base_url:
            return None
        value = urljoin(base_url, value)
    if not value.lower().startswith(("http://", "https://")):
        return None
    return value


def collect_images(
    node: Tag | BeautifulSoup, base_url: str, *, rewrite_src: bool = True
) -> list[str]:
    """Collect lazy-loaded/broken image URLs and normalize ``src`` for Markdown output."""
    urls: list[str] = []
    for img in node.find_all("img"):
        raw = next((img.get(attr) for attr in _LAZY_IMAGE_ATTRS if img.get(attr)), None)
        resolved = clean_image_url(raw, base_url)
        if not resolved:
            img.decompose()
            continue
        if rewrite_src:
            img["src"] = resolved
            for attr in _LAZY_IMAGE_ATTRS[:-1]:
                if img.has_attr(attr):
                    del img[attr]
        if resolved not in urls:
            urls.append(resolved)
    return urls


def drop_noise(node: Tag | BeautifulSoup) -> None:
    for tag in node.find_all(NOISE_TAGS):
        tag.decompose()


def page_origin(url: str) -> str | None:
    try:
        parts = urlsplit(url if "://" in url else "//" + url)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def fallback_title(raw_input: str, url: str = "") -> str:
    """Human readable fallback title derived from the share caption or the URL."""
    candidate = ""
    caption = _URL_IN_TEXT_RE.sub(" ", raw_input or "")
    caption = _WHITESPACE_RE.sub(" ", caption)
    caption = caption.strip(" \t\n《》【】[]()（）-—·,，。.：:!！?？\"'“”")
    if caption:
        candidate = caption
    if not candidate:
        parts = urlsplit(url if "://" in url else "//" + url) if url else None
        if parts is not None:
            candidate = (parts.hostname or "") + (parts.path if parts.path not in ("", "/") else "")
    if not candidate:
        candidate = (extract_url(raw_input) or "未命名剪藏")
    if len(candidate) > 80:
        candidate = candidate[:80].rstrip() + "…"
    return candidate


def compose_markdown(
    *,
    title: str = "",
    meta_line: str = "",
    body: str = "",
    image_urls: list[str] | None = None,
) -> str:
    parts: list[str] = []
    if title:
        parts.append(f"# {title}")
    if meta_line:
        parts.append(meta_line)
    if body:
        parts.append(body)
    for url in image_urls or []:
        parts.append(f"![]({url})")
    return "\n\n".join(part.strip() for part in parts if part.strip()) + ("\n" if parts else "")


@asynccontextmanager
async def use_client(
    client: httpx.AsyncClient | None, *, timeout: float = 20.0
) -> AsyncIterator[httpx.AsyncClient]:
    """Reuse an injected client or create a short-lived one."""
    if client is not None:
        yield client
        return
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as owned:
        yield owned


def first_line(text: str, limit: int = 120) -> str:
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped:
            return stripped if len(stripped) <= limit else stripped[:limit].rstrip() + "…"
    return ""


class GenericWebExtractor:
    """Fallback extractor for arbitrary blog/news pages."""

    platform = Platform.WEB

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
            logger.warning("Generic fetch failed for %s: %s", url, exc)
            return ExtractedContent(
                platform=self.platform,
                url=url,
                title=fallback_title(raw_input, url),
                content_markdown=raw_input,
                content_text=raw_input,
                partial=True,
                error_message=f"{type(exc).__name__}: {exc}",
            )
        return self.parse(html, url, raw_input)

    def parse(self, html: str, url: str, raw_input: str = "") -> ExtractedContent:
        soup = BeautifulSoup(html, "html.parser")
        title = meta_content(soup, "og:title") or (
            soup.title.get_text(strip=True) if soup.title else ""
        )
        title = title or fallback_title(raw_input, url)

        author = meta_content(soup, "author") or meta_content(soup, "article:author")
        published_at = (
            meta_content(soup, "article:published_time")
            or meta_content(soup, "datePublished")
            or (soup.find("time").get("datetime") if soup.find("time") else None)
        )

        body = soup.find("article") or soup.find("main") or soup.body or soup
        drop_noise(body)
        image_urls = [u for u in (clean_image_url(raw, url) for raw in og_images(soup)) if u]
        for image_url in collect_images(body, url):
            if image_url not in image_urls:
                image_urls.append(image_url)

        content_text = html_to_text(body) or meta_content(soup, "og:description")
        content_markdown = html_to_markdown(body)
        if not content_markdown:
            description = meta_content(soup, "og:description") or meta_content(
                soup, "description"
            )
            content_markdown = compose_markdown(
                title=title, body=description, image_urls=image_urls
            )

        return ExtractedContent(
            platform=self.platform,
            url=url,
            title=title,
            author=author,
            published_at=published_at,
            content_markdown=content_markdown,
            content_text=content_text,
            image_urls=image_urls,
            partial=not bool(content_text),
            referer=page_origin(url),
        )
