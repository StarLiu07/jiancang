from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    app_name: str = "剪藏 API"
    host: str = "0.0.0.0"
    port: int = 8420
    api_token: str = ""  # Empty means no auth required (local dev)
    cors_origins: str = "*"

    # Storage
    data_dir: Path = Field(default=Path("data"))

    # HTTP / Proxy (httpx respects HTTP_PROXY / HTTPS_PROXY automatically when trust_env=True)
    http_timeout_seconds: float = 20.0
    max_media_bytes: int = 15 * 1024 * 1024  # 15 MB per image
    user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    )

    # Optional AI enrichment (OpenAI-compatible: NUC new-api or Command Code)
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = "deepseek/deepseek-v4.1-flash"
    llm_timeout_seconds: float = 45.0
    llm_user_agent: str = "jiancang/0.1"

    # Optional MediaCrawler MCP bridge on NUC (fallback for Xiaohongshu)
    mediacrawler_mcp_url: str = ""
    mediacrawler_mcp_token: str = ""

    # Review settings
    daily_review_limit: int = 5
    snooze_schedule_days: str = "3,7,14,30,60"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "jiancang.db"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def ai_enabled(self) -> bool:
        return bool(self.llm_base_url.strip() and self.llm_api_key.strip())

    @property
    def snooze_intervals(self) -> list[int]:
        parts = [p.strip() for p in self.snooze_schedule_days.split(",") if p.strip()]
        values = [int(p) for p in parts if p.isdigit() and int(p) > 0]
        return values or [3, 7, 14, 30, 60]


@lru_cache
def get_settings() -> Settings:
    return Settings()
