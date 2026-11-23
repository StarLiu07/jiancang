from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        api_token="",
        llm_base_url="",
        llm_api_key="",
        mediacrawler_mcp_url="",
        mediacrawler_mcp_token="",
    )
