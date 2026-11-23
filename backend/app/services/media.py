"""Image download + local storage for clipped content."""

from __future__ import annotations

import hashlib
import html
import logging
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

import httpx

logger = logging.getLogger(__name__)

DEFAULT_USER_AGENT = "Mozilla/5.0"
DEFAULT_MAX_BYTES = 15 * 1024 * 1024

_EXT_BY_MIME: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
    "image/tiff": ".tiff",
    "image/heic": ".heic",
}

_MIME_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/x-png": "image/png",
}

# Markdown image/link targets: ![alt](url "title") / [text](url)
_MD_TARGET_RE = re.compile(r"(?P<prefix>!?\[[^\]]*\]\(\s*)(?P<url>[^)\s]+)")
# Raw HTML <img src="url">
_HTML_IMG_RE = re.compile(
    r"(?P<prefix><img\b[^>]*?\bsrc\s*=\s*[\"'])(?P<url>[^\"']+)",
    re.IGNORECASE,
)


@dataclass(slots=True)
class StoredMedia:
    id: str
    original_url: str
    local_path: str
    mime_type: str
    size_bytes: int
    sha256: str
    sort_order: int = 0


def _normalize_mime(value: str | None) -> str:
    if not value:
        return ""
    base = value.split(";", 1)[0].strip().lower()
    return _MIME_ALIASES.get(base, base)


def _sniff_mime(data: bytes) -> str:
    """Detect the image type from magic bytes; empty string when unknown."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"BM"):
        return "image/bmp"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "image/avif"
    head = data[:512].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        return "image/svg+xml"
    return ""


def _resolve_mime(content_type: str | None, data: bytes) -> str:
    sniffed = _sniff_mime(data)
    header = _normalize_mime(content_type)
    if sniffed:
        return sniffed
    if header.startswith("image/"):
        return header
    return ""


def _extension_for(mime: str) -> str:
    ext = _EXT_BY_MIME.get(mime)
    if ext:
        return ext
    guessed = mimetypes.guess_extension(mime) if mime else None
    return guessed or ".img"


def _dedupe(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for url in urls:
        cleaned = (url or "").strip()
        if not cleaned or not cleaned.lower().startswith(("http://", "https://")):
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        ordered.append(cleaned)
    return ordered


async def _fetch_one(
    client: httpx.AsyncClient,
    url: str,
    *,
    referer: str | None,
    user_agent: str,
    max_bytes: int,
) -> tuple[bytes, str] | None:
    headers = {"User-Agent": user_agent}
    if referer:
        headers["Referer"] = referer

    response = await client.get(url, headers=headers)
    response.raise_for_status()

    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        logger.warning("Skipping oversized image (content-length) %s: %s bytes", url, declared)
        return None

    data = response.content
    if not data:
        logger.warning("Skipping empty image response: %s", url)
        return None
    if len(data) > max_bytes:
        logger.warning("Skipping oversized image %s: %s bytes", url, len(data))
        return None

    mime = _resolve_mime(response.headers.get("content-type"), data)
    if not mime:
        logger.warning(
            "Skipping non-image response %s (content-type=%s)",
            url,
            response.headers.get("content-type"),
        )
        return None
    return data, mime


async def download_and_store_images(
    image_urls: list[str],
    media_dir: Path,
    *,
    referer: str | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
    max_bytes: int = DEFAULT_MAX_BYTES,
    timeout: float = 20.0,
    client: httpx.AsyncClient | None = None,
) -> list[StoredMedia]:
    """Download images in order, store them content-addressed and return metadata.

    Failures (network errors, non-image payloads, oversized files) are logged and skipped so
    a single broken image never aborts the whole clip.
    """
    urls = _dedupe(image_urls)
    if not urls:
        return []

    media_dir = Path(media_dir)
    if client is not None:
        return await _download_all(
            client, urls, media_dir, referer=referer, user_agent=user_agent, max_bytes=max_bytes
        )

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as owned:
        return await _download_all(
            owned, urls, media_dir, referer=referer, user_agent=user_agent, max_bytes=max_bytes
        )


async def _download_all(
    client: httpx.AsyncClient,
    urls: list[str],
    media_dir: Path,
    *,
    referer: str | None,
    user_agent: str,
    max_bytes: int,
) -> list[StoredMedia]:
    stored: list[StoredMedia] = []
    by_hash: dict[str, StoredMedia] = {}

    for url in urls:
        try:
            fetched = await _fetch_one(
                client, url, referer=referer, user_agent=user_agent, max_bytes=max_bytes
            )
        except Exception as exc:  # noqa: BLE001 - one bad image must not kill the clip
            logger.warning("Failed to download image %s: %s", url, exc)
            continue

        if fetched is None:
            continue
        data, mime = fetched

        sha256 = hashlib.sha256(data).hexdigest()
        existing = by_hash.get(sha256)
        if existing is not None:
            continue

        ext = _extension_for(mime)
        relative = f"{sha256[:2]}/{sha256}{ext}"
        target = media_dir / sha256[:2] / f"{sha256}{ext}"
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        item = StoredMedia(
            id=sha256,
            original_url=url,
            local_path=relative,
            mime_type=mime,
            size_bytes=len(data),
            sha256=sha256,
            sort_order=len(stored),
        )
        by_hash[sha256] = item
        stored.append(item)

    return stored


def _lookup(mapping: dict[str, str], url: str) -> str | None:
    if not url:
        return None
    candidates = (url, html.unescape(url), unquote(url), unquote(html.unescape(url)))
    for candidate in candidates:
        if candidate in mapping:
            return mapping[candidate]
    stripped = url.split("#", 1)[0]
    return mapping.get(stripped)


def _mapping_from_media(items: list[object] | None, api_prefix: str) -> dict[str, str]:
    """Build ``original_url -> /api/media/{id}`` for already stored media objects."""
    mapping: dict[str, str] = {}
    for item in items or []:
        if isinstance(item, dict):
            original = item.get("original_url") or item.get("url")
            identifier = item.get("id") or item.get("media_id")
        else:
            original = getattr(item, "original_url", None) or getattr(item, "url", None)
            identifier = getattr(item, "id", None) or getattr(item, "media_id", None)
        if original and identifier:
            mapping[str(original)] = f"{api_prefix}{identifier}"
    return mapping


def rewrite_markdown_images(
    markdown: str,
    url_to_api_path: dict[str, str] | None = None,
    *,
    media: list[object] | None = None,
    api_prefix: str = "/api/media/",
) -> str:
    """Replace original remote image URLs with local API paths inside Markdown/HTML.

    ``url_to_api_path`` is the canonical mapping; as a convenience for callers holding the
    stored media objects, ``media`` can be supplied instead and the mapping is derived from
    each item's ``original_url``/``id``.
    """
    mapping = url_to_api_path if url_to_api_path is not None else _mapping_from_media(
        media, api_prefix
    )
    if not markdown or not mapping:
        return markdown

    def replace(match: re.Match[str]) -> str:
        replacement = _lookup(mapping, match.group("url"))
        if replacement is None:
            return match.group(0)
        return f"{match.group('prefix')}{replacement}"

    markdown = _MD_TARGET_RE.sub(replace, markdown)
    return _HTML_IMG_RE.sub(replace, markdown)
