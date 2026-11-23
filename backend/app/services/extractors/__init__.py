"""Content extractors for supported platforms."""

from __future__ import annotations

import logging

import httpx

from app.config import Settings, get_settings
from app.models import Platform
from app.services.extractors.base import BaseExtractor, ExtractedContent
from app.services.extractors.generic import GenericWebExtractor, fallback_title
from app.services.extractors.wechat import WeChatExtractor
from app.services.extractors.x import XExtractor
from app.services.extractors.xhs import XiaohongshuExtractor
from app.services.url_utils import detect_platform

__all__ = [
    "BaseExtractor",
    "ExtractedContent",
    "GenericWebExtractor",
    "WeChatExtractor",
    "XExtractor",
    "XiaohongshuExtractor",
    "build_extractor",
    "extract_content",
]

logger = logging.getLogger(__name__)


def build_extractor(
    platform: Platform,
    settings: Settings | None = None,
) -> BaseExtractor:
    """Instantiate the extractor responsible for ``platform``."""
    if platform is Platform.WECHAT:
        return WeChatExtractor()
    if platform is Platform.X:
        return XExtractor()
    if platform is Platform.XIAOHONGSHU:
        return XiaohongshuExtractor(settings)
    return GenericWebExtractor()


async def extract_content(
    url: str,
    platform: Platform | None = None,
    *,
    raw_input: str = "",
    settings: Settings | None = None,
    client: httpx.AsyncClient | None = None,
) -> ExtractedContent:
    """Fetch and parse ``url`` with the extractor matching ``platform``.

    ``platform`` defaults to auto-detection from the URL, so callers that only have the
    link (or a share caption) do not need to resolve the platform first.

    Never raises: unexpected failures are returned as a ``partial`` clip so the caller can
    persist whatever it has and surface ``error_message`` in the UI.
    """
    resolved_settings = settings or get_settings()
    resolved_platform = platform or detect_platform(url)
    extractor = build_extractor(resolved_platform, resolved_settings)

    try:
        if client is not None:
            return await extractor.extract(url, raw_input, client)
        async with httpx.AsyncClient(
            timeout=resolved_settings.http_timeout_seconds,
            follow_redirects=True,
        ) as owned:
            return await extractor.extract(url, raw_input, owned)
    except Exception as exc:  # noqa: BLE001 - last-resort guard, never crash the API
        logger.exception("Extractor for %s failed on %s", resolved_platform, url)
        raw = (raw_input or "").strip() or url
        return ExtractedContent(
            platform=resolved_platform,
            url=url,
            title=fallback_title(raw_input, url),
            content_markdown=raw,
            content_text=raw,
            partial=True,
            error_message=f"{type(exc).__name__}: {exc}",
        )
