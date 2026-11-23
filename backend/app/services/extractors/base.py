from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import httpx

from app.models import Platform


@dataclass(slots=True)
class ExtractedContent:
    platform: Platform
    url: str
    title: str = ""
    author: str = ""
    published_at: str | None = None
    content_markdown: str = ""
    content_text: str = ""
    image_urls: list[str] = field(default_factory=list)
    partial: bool = False
    error_message: str | None = None
    referer: str | None = None


class BaseExtractor(Protocol):
    platform: Platform

    async def extract(
        self,
        url: str,
        raw_input: str = "",
        client: httpx.AsyncClient | None = None,
    ) -> ExtractedContent: ...
