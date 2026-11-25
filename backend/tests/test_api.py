"""API contract tests: health, auth, CRUD, search, media, review, AI."""

from __future__ import annotations

import importlib
import json
import sys
import types
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database, parse_iso, to_iso
from app.main import create_app
from app.models import AIStatus, ClipStatus, Platform, ReviewState
from app.services.ai import AIEnrichment, AIEnrichmentError, enrich_clip
from app.services.extractors.base import ExtractedContent
from app.services.ingest import markdown_to_text, process_clip

URL_UTILS = "app.services.url_utils"
EXTRACTORS = "app.services.extractors"
MEDIA = "app.services.media"

ClientFor = Callable[..., tuple[TestClient, Settings, Database]]


# ---------------------------------------------------------------------------
# deterministic stand-ins for the concurrently-developed sibling modules
# ---------------------------------------------------------------------------


def fake_extract_url(raw_input: str) -> str | None:
    for token in (raw_input or "").replace("\n", " ").split():
        cleaned = token.strip("，。、,.;)）】]")
        if cleaned.startswith(("http://", "https://")):
            return cleaned
    return None


def fake_detect_platform(url: str) -> str:
    if "mp.weixin.qq.com" in url:
        return "wechat"
    if "xiaohongshu.com" in url or "xhslink.com" in url:
        return "xiaohongshu"
    if "x.com" in url or "twitter.com" in url:
        return "x"
    return "web"


def fake_normalize_url(url: str) -> str:
    return url.split("#", 1)[0].split("?", 1)[0].rstrip("/")


@pytest.fixture
def url_utils(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    stub = types.ModuleType(URL_UTILS)
    stub.extract_url = fake_extract_url
    stub.detect_platform = fake_detect_platform
    stub.normalize_url = fake_normalize_url
    monkeypatch.setitem(sys.modules, URL_UTILS, stub)
    return stub


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    async def fake_process_clip(clip_id: str, db: Database, settings: Settings) -> None:
        calls.append(clip_id)

    monkeypatch.setattr("app.routers.clips.process_clip", fake_process_clip)
    return calls


@pytest.fixture
def client_for(
    tmp_path: Path,
    url_utils: types.ModuleType,
    queued: list[str],
) -> Iterator[ClientFor]:
    created: list = []

    def factory(**overrides: object) -> tuple[TestClient, Settings, Database]:
        params: dict[str, object] = {
            "data_dir": tmp_path / "data",
            "api_token": "",
            "llm_base_url": "",
            "llm_api_key": "",
            "mediacrawler_mcp_url": "",
            "mediacrawler_mcp_token": "",
        }
        params.update(overrides)
        settings = Settings(**params)  # type: ignore[arg-type]
        app = create_app(settings)
        created.append(app)
        return TestClient(app), settings, app.state.db

    try:
        yield factory
    finally:
        for app in created:
            app.state.db.close()


# ---------------------------------------------------------------------------
# health & auth
# ---------------------------------------------------------------------------


def test_health_reports_capabilities(client_for: ClientFor) -> None:
    client, _, _ = client_for()

    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["app"] == "剪藏 API"
    assert body["auth_enabled"] is False
    assert body["ai_enabled"] is False


def test_auth_disabled_by_default(client_for: ClientFor) -> None:
    client, _, _ = client_for()

    assert client.get("/api/clips").status_code == 200
    assert client.get("/api/tags").status_code == 200


def test_auth_enabled_requires_headers(client_for: ClientFor) -> None:
    client, _, _ = client_for(api_token="s3cret")

    assert client.get("/api/clips").status_code == 401
    assert client.get("/health").status_code == 200

    bearer = client.get("/api/clips", headers={"Authorization": "Bearer s3cret"})
    api_key = client.get("/api/clips", headers={"X-API-Key": "s3cret"})
    assert bearer.status_code == 200
    assert api_key.status_code == 200

    assert client.get("/api/clips", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/clips", headers={"X-API-Key": "wrong"}).status_code == 401


# ---------------------------------------------------------------------------
# create / dedupe
# ---------------------------------------------------------------------------


def test_create_clip_and_deduplicate(
    client_for: ClientFor, queued: list[str]
) -> None:
    client, _, db = client_for()

    payload = {
        "input": "强烈推荐 https://mp.weixin.qq.com/s/abc?from=timeline",
        "tags": ["AI", "保研"],
        "user_note": "我的笔记",
    }
    first = client.post("/api/clips", json=payload)

    assert first.status_code == 201
    body = first.json()
    clip = body["clip"]
    assert body["deduplicated"] is False
    assert clip["platform"] == "wechat"
    assert clip["status"] == "pending"
    assert clip["tags"] == ["AI", "保研"]
    assert queued == [clip["id"]]

    detail = client.get(f"/api/clips/{clip['id']}")
    assert detail.status_code == 200
    assert detail.json()["user_note"] == "我的笔记"
    assert detail.json()["raw_input"] == payload["input"]

    duplicate = client.post(
        "/api/clips", json={"input": "https://mp.weixin.qq.com/s/abc#comments"}
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["deduplicated"] is True
    assert duplicate.json()["clip"]["id"] == clip["id"]
    assert queued == [clip["id"]], "dedupe must not enqueue another ingest"

    invalid = client.post("/api/clips", json={"input": "这里没有任何链接"})
    assert invalid.status_code == 422
    assert db.list_clips()[1] == 1


def test_create_clip_uses_real_url_utils(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Contract check against the real ``app.services.url_utils`` module."""
    pytest.importorskip("app.services.url_utils")

    async def fake_process_clip(clip_id: str, db: Database, settings: Settings) -> None:
        return None

    monkeypatch.setattr("app.routers.clips.process_clip", fake_process_clip)
    settings = Settings(
        data_dir=tmp_path / "real", api_token="", llm_base_url="", llm_api_key=""
    )
    app = create_app(settings)
    try:
        client = TestClient(app)
        first = client.post(
            "/api/clips",
            json={"input": "强烈推荐 https://mp.weixin.qq.com/s/xyz?chksm=abc#rd 看看"},
        )
        assert first.status_code == 201
        assert first.json()["clip"]["platform"] == "wechat"

        duplicate = client.post(
            "/api/clips", json={"input": "https://mp.weixin.qq.com/s/xyz"}
        )
        assert duplicate.status_code == 200
        assert duplicate.json()["deduplicated"] is True
        assert duplicate.json()["clip"]["id"] == first.json()["clip"]["id"]
    finally:
        app.state.db.close()


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def _seed_search_corpus(db: Database) -> None:
    db.create_clip(
        raw_input="a",
        url="https://example.com/ai",
        normalized_url="https://example.com/ai",
        status=ClipStatus.READY.value,
        title="AI 与保研",
        content_text="保研经验与 AI 工具的结合",
        tags=["保研"],
    )
    db.create_clip(
        raw_input="b",
        url="https://example.com/wechat",
        normalized_url="https://example.com/wechat",
        status=ClipStatus.READY.value,
        title="微信小程序",
        content_text="剪藏工具的使用说明",
        tags=["微信"],
    )
    db.create_clip(
        raw_input="c",
        url="https://example.com/weather",
        normalized_url="https://example.com/weather",
        status=ClipStatus.READY.value,
        title="天气",
        content_text="今天天气不错",
    )


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("AI", 1),  # 2 chars -> LIKE
        ("保研", 1),  # 2 chars -> LIKE
        ("微信", 1),  # 2 chars -> LIKE (tag/title)
        ("天气", 1),  # 2 chars -> LIKE
        ("剪藏工具", 1),  # >= 3 chars -> FTS5 trigram
        ("保研经验与", 1),  # >= 3 chars -> FTS5 trigram
        ("完全不存在", 0),
    ],
)
def test_chinese_search_short_and_long_terms(
    client_for: ClientFor, query: str, expected: int
) -> None:
    client, _, db = client_for()
    _seed_search_corpus(db)

    response = client.get("/api/clips", params={"q": query})

    assert response.status_code == 200
    assert response.json()["total"] == expected


def test_list_filters_and_pagination(client_for: ClientFor) -> None:
    client, _, db = client_for()
    _seed_search_corpus(db)
    archived = db.create_clip(
        raw_input="d",
        url="https://x.com/archived",
        normalized_url="https://x.com/archived",
        platform=Platform.X.value,
        status=ClipStatus.READY.value,
        title="旧推文",
        review_state=ReviewState.ARCHIVED.value,
    )

    # default listing hides only deleted clips (archived stays visible)
    assert client.get("/api/clips").json()["total"] == 4
    assert client.get("/api/clips", params={"review_state": "all"}).json()["total"] == 4
    assert (
        client.get("/api/clips", params={"review_state": "archived"}).json()["total"] == 1
    )
    assert (
        client.get("/api/clips", params={"tag": "微信"}).json()["items"][0]["title"]
        == "微信小程序"
    )
    assert client.get("/api/clips", params={"platform": "x"}).json()["total"] == 1
    assert client.get("/api/clips", params={"status": "ready"}).json()["total"] == 4

    page = client.get("/api/clips", params={"limit": 2, "offset": 0}).json()
    assert len(page["items"]) == 2
    assert page["total"] == 4
    assert page["limit"] == 2
    assert client.get("/api/clips", params={"limit": 0}).status_code == 422
    assert client.get("/api/clips", params={"offset": -1}).status_code == 422

    detail = client.get(f"/api/clips/{archived['id']}").json()
    assert detail["review_state"] == "archived"
    assert client.get("/api/clips/nope").status_code == 404


# ---------------------------------------------------------------------------
# stateless remote extraction (/api/extract)
# ---------------------------------------------------------------------------


def test_extract_endpoint_mirrors_extractor_output(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _ = client_for()
    captured: dict[str, object] = {}

    async def fake_extract_content(
        url: str, raw_input: str = "", settings: Settings | None = None
    ) -> ExtractedContent:
        captured.update({"url": url, "raw_input": raw_input, "settings": settings})
        return ExtractedContent(
            platform=Platform.XIAOHONGSHU,
            url="https://www.xiaohongshu.com/explore/abc?xsec_token=TOK",
            title="笔记标题",
            author="小红薯作者",
            published_at="2025-01-01T00:00:00+00:00",
            content_markdown="# 笔记标题\n\n服务端抠到的正文",
            content_text="服务端抠到的正文",
            image_urls=["https://sns-img.xhscdn.com/a.jpg"],
            partial=False,
            referer="https://www.xiaohongshu.com/",
        )

    monkeypatch.setattr("app.routers.clips.extract_content", fake_extract_content)

    response = client.post(
        "/api/extract",
        json={"url": "https://xhslink.com/a/b1c2d3", "raw_input": "分享文案"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["platform"] == "xiaohongshu"
    assert body["url"] == "https://www.xiaohongshu.com/explore/abc?xsec_token=TOK"
    assert body["title"] == "笔记标题"
    assert body["author"] == "小红薯作者"
    assert body["published_at"] == "2025-01-01T00:00:00+00:00"
    assert body["content_markdown"].startswith("# 笔记标题")
    assert body["content_text"] == "服务端抠到的正文"
    assert body["image_urls"] == ["https://sns-img.xhscdn.com/a.jpg"]
    assert body["partial"] is False
    assert body["error_message"] is None
    assert body["referer"] == "https://www.xiaohongshu.com/"
    # the phone's own URL and caption are handed to the extractor untouched
    assert captured["url"] == "https://xhslink.com/a/b1c2d3"
    assert captured["raw_input"] == "分享文案"
    assert captured["settings"] is not None
    # stateless: nothing is persisted server-side
    assert client.get("/api/clips").json()["total"] == 0


def test_extract_endpoint_maps_degraded_partial(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _ = client_for()

    async def fake_extract_content(
        url: str, raw_input: str = "", settings: Settings | None = None
    ) -> ExtractedContent:
        return ExtractedContent(
            platform=Platform.XIAOHONGSHU,
            url="",  # degrade without a resolvable URL
            title="分享文案",
            content_markdown=raw_input,
            content_text=raw_input,
            partial=True,
            error_message="小红书返回了登录/风控壳页",
        )

    monkeypatch.setattr("app.routers.clips.extract_content", fake_extract_content)

    request_url = "https://www.xiaohongshu.com/explore/abc"
    response = client.post(
        "/api/extract", json={"url": request_url, "raw_input": "分享文案"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["partial"] is True
    assert body["error_message"] == "小红书返回了登录/风控壳页"
    assert body["url"] == request_url  # falls back to the requested URL

    # the schema rejects a request without any URL
    assert client.post("/api/extract", json={"url": ""}).status_code == 422


def test_extract_endpoint_is_protected_by_the_api_token(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _ = client_for(api_token="tok")

    async def never_called(*args: object, **kwargs: object) -> object:
        raise AssertionError("no extraction without a valid token")

    monkeypatch.setattr("app.routers.clips.extract_content", never_called)
    payload = {"url": "https://xhslink.com/a/b1c2d3", "raw_input": "文案"}

    assert client.post("/api/extract", json=payload).status_code == 401
    assert (
        client.post(
            "/api/extract", json=payload, headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )

    async def fake_extract_content(
        url: str, raw_input: str = "", settings: Settings | None = None
    ) -> ExtractedContent:
        return ExtractedContent(platform=Platform.XIAOHONGSHU, url=url, title="登录可抓")

    monkeypatch.setattr("app.routers.clips.extract_content", fake_extract_content)
    allowed = client.post(
        "/api/extract", json=payload, headers={"Authorization": "Bearer tok"}
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["title"] == "登录可抓"


# ---------------------------------------------------------------------------
# patch / delete / retry
# ---------------------------------------------------------------------------


def test_patch_completes_partial_clip_and_syncs_search(
    client_for: ClientFor, queued: list[str]
) -> None:
    client, _, db = client_for()
    row = db.create_clip(
        raw_input="share text",
        url="https://example.com/manual",
        normalized_url="https://example.com/manual",
        status=ClipStatus.PARTIAL.value,
        title="",
        content_markdown="",
        error_message="正文抽取失败",
    )
    clip_id = str(row["id"])

    response = client.patch(
        f"/api/clips/{clip_id}",
        json={
            "title": "手动补全",
            "content_markdown": "# 手动补全\n\n补全的正文内容。\n\n- 要点一",
            "summary": "人工摘要",
            "user_note": "我的备注",
            "tags": ["补全", "手动"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["title"] == "手动补全"
    assert body["summary"] == "人工摘要"
    assert body["user_note"] == "我的备注"
    assert sorted(body["tags"]) == ["手动", "补全"]
    stored = db.get_clip(clip_id)
    assert stored is not None
    assert "补全的正文内容" in stored["content_text"]
    assert body["error_message"] is None

    found = client.get("/api/clips", params={"q": "补全的正文内容"}).json()
    assert found["total"] == 1
    assert found["items"][0]["id"] == clip_id
    assert client.get("/api/clips", params={"q": "手动"}).json()["total"] == 1

    assert client.patch("/api/clips/nope", json={"title": "x"}).status_code == 404


def test_retry_requeues_clip(client_for: ClientFor, queued: list[str]) -> None:
    client, _, db = client_for()
    row = db.create_clip(
        raw_input="https://example.com/retry",
        url="https://example.com/retry",
        normalized_url="https://example.com/retry",
        status=ClipStatus.FAILED.value,
        error_message="boom",
    )
    clip_id = str(row["id"])

    response = client.post(f"/api/clips/{clip_id}/retry")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    assert body["error_message"] is None
    assert queued == [clip_id]
    assert client.post("/api/clips/nope/retry").status_code == 404


def test_soft_delete_then_permanent_delete_removes_media(
    client_for: ClientFor,
) -> None:
    client, settings, db = client_for()
    row = db.create_clip(
        raw_input="https://example.com/del",
        url="https://example.com/del",
        normalized_url="https://example.com/del",
        status=ClipStatus.READY.value,
        title="待删除",
    )
    clip_id = str(row["id"])
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    media_file = settings.media_dir / "pic.png"
    media_file.write_bytes(b"png-bytes")
    db.add_media(
        clip_id=clip_id,
        local_path=str(media_file),
        original_url="https://example.com/pic.png",
        mime_type="image/png",
        size_bytes=9,
    )
    db.update_clip(clip_id, cover_media_id=db.list_media(clip_id)[0]["id"])

    soft = client.delete(f"/api/clips/{clip_id}")
    assert soft.status_code == 200
    assert soft.json()["permanent"] is False
    assert client.get("/api/clips").json()["total"] == 0
    assert client.get("/api/clips", params={"review_state": "all"}).json()["total"] == 1
    assert client.get(f"/api/clips/{clip_id}").json()["review_state"] == "deleted"

    hard = client.delete(f"/api/clips/{clip_id}", params={"permanent": True})
    assert hard.status_code == 200
    assert hard.json()["permanent"] is True
    assert db.get_clip(clip_id) is None
    assert db.list_media(clip_id) == []
    assert not media_file.exists()
    assert client.delete(f"/api/clips/{clip_id}").status_code == 404


# ---------------------------------------------------------------------------
# media serving
# ---------------------------------------------------------------------------


def _store_media(clip_id: str, settings: Settings, db: Database, name: str = "cover.png") -> str:
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    path = settings.media_dir / name
    path.write_bytes(b"png-bytes")
    return db.add_media(
        clip_id=clip_id,
        local_path=str(path),
        original_url=f"https://example.com/{name}",
        mime_type="image/png",
        size_bytes=9,
    )


def test_media_served_without_auth(client_for: ClientFor) -> None:
    client, settings, db = client_for()
    clip = db.create_clip(url="https://example.com/m", normalized_url="https://example.com/m")
    media_id = _store_media(str(clip["id"]), settings, db)

    response = client.get(f"/api/media/{media_id}")

    assert response.status_code == 200
    assert response.content == b"png-bytes"
    assert response.headers["content-type"].startswith("image/png")
    assert "max-age=86400" in response.headers["cache-control"]
    assert response.headers["cache-control"].startswith("public")
    assert client.get("/api/media/missing").status_code == 404


def test_media_requires_token_when_auth_enabled(client_for: ClientFor) -> None:
    client, settings, db = client_for(api_token="tok")
    clip = db.create_clip(url="https://example.com/m2", normalized_url="https://example.com/m2")
    media_id = _store_media(str(clip["id"]), settings, db, name="cover2.png")

    assert client.get(f"/api/media/{media_id}").status_code == 401

    with_query = client.get(f"/api/media/{media_id}", params={"token": "tok"})
    assert with_query.status_code == 200
    assert with_query.content == b"png-bytes"
    assert with_query.headers["cache-control"].startswith("private")

    with_header = client.get(
        f"/api/media/{media_id}", headers={"Authorization": "Bearer tok"}
    )
    assert with_header.status_code == 200
    assert client.get(f"/api/media/{media_id}", params={"token": "bad"}).status_code == 401
    assert client.get("/api/media/missing", params={"token": "tok"}).status_code == 404


def test_media_path_outside_data_dir_is_rejected(
    client_for: ClientFor, tmp_path: Path
) -> None:
    client, _, db = client_for()
    clip = db.create_clip(url="https://example.com/m3", normalized_url="https://example.com/m3")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    media_id = db.add_media(
        clip_id=str(clip["id"]),
        local_path=str(outside),
        mime_type="text/plain",
    )

    assert client.get(f"/api/media/{media_id}").status_code == 404


# ---------------------------------------------------------------------------
# review & tags endpoints
# ---------------------------------------------------------------------------


def test_review_endpoints_drive_the_deck(client_for: ClientFor) -> None:
    client, _, db = client_for()
    row = db.create_clip(
        raw_input="https://example.com/review",
        url="https://example.com/review",
        normalized_url="https://example.com/review",
        status=ClipStatus.READY.value,
        title="复习卡片",
        content_markdown="# 复习\n\n要记住的内容",
        content_text="要记住的内容",
        tags=["复习"],
    )
    clip_id = str(row["id"])

    today = client.get("/api/review/today")
    assert today.status_code == 200
    deck = today.json()
    assert deck["daily_target"] == 5
    assert deck["reviewed_today"] == 0
    assert deck["total_active"] == 1
    assert [item["id"] for item in deck["items"]] == [clip_id]
    assert deck["items"][0]["content_markdown"].startswith("# 复习")
    assert deck["items"][0]["tags"] == ["复习"]

    snoozed = client.post(f"/api/review/{clip_id}/action", json={"action": "snooze"})
    assert snoozed.status_code == 200
    body = snoozed.json()
    assert body["reviewed_today"] == 1
    assert body["clip"]["review_count"] == 1
    assert body["clip"]["review_state"] == "active"
    next_at = parse_iso(body["clip"]["next_review_at"])
    assert next_at is not None
    assert next_at > datetime.now(tz=UTC)

    assert (
        client.get("/api/review/today").json()["reviewed_today"] == 1
    )
    archived = client.post(f"/api/review/{clip_id}/action", json={"action": "archive"})
    assert archived.status_code == 200
    assert archived.json()["clip"]["review_state"] == "archived"
    assert client.get("/api/review/today").json()["total_active"] == 0

    assert (
        client.post("/api/review/missing/action", json={"action": "delete"}).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/review/{clip_id}/action", json={"action": "explode"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/review/{clip_id}/action", json={"action": "snooze", "snooze_days": 0}
        ).status_code
        == 422
    )


def test_tags_endpoint_counts_usage(client_for: ClientFor) -> None:
    client, _, db = client_for()
    db.create_clip(
        url="https://example.com/t1",
        normalized_url="https://example.com/t1",
        status=ClipStatus.READY.value,
        tags=["AI", "保研"],
    )
    deleted = db.create_clip(
        url="https://example.com/t2",
        normalized_url="https://example.com/t2",
        status=ClipStatus.READY.value,
        tags=["AI"],
    )
    db.update_clip(str(deleted["id"]), review_state=ReviewState.DELETED.value)

    response = client.get("/api/tags")

    assert response.status_code == 200
    tags = response.json()["tags"]
    assert tags == [{"name": "AI", "count": 1}, {"name": "保研", "count": 1}]
    with_deleted = client.get("/api/tags", params={"include_deleted": True}).json()
    assert with_deleted["tags"][0] == {"name": "AI", "count": 2}


# ---------------------------------------------------------------------------
# AI enrichment
# ---------------------------------------------------------------------------


async def test_enrich_clip_sets_user_agent_and_parses_fence() -> None:
    settings = Settings(
        llm_base_url="https://llm.example.com/v1/",
        llm_api_key="k-123",
        llm_user_agent="jiancang-test/9",
    )
    captured: dict[str, object] = {}
    fenced = (
        "```json\n"
        + json.dumps(
            {
                "summary": "一句话摘要",
                "key_points": ["要点一", "要点二", "要点三"],
                "tags": ["AI", "工具"],
            },
            ensure_ascii=False,
        )
        + "\n```"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["ua"] = request.headers.get("user-agent")
        captured["auth"] = request.headers.get("authorization")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(
            200, json={"choices": [{"message": {"content": fenced}}]}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await enrich_clip("标题", "正文内容", ["已有"], settings, client=client)

    assert result is not None
    assert result.summary == "一句话摘要"
    assert result.key_points == ["要点一", "要点二", "要点三"]
    assert result.tags == ["AI", "工具"]
    assert captured["url"] == "https://llm.example.com/v1/chat/completions"
    assert captured["ua"] == "jiancang-test/9"
    assert captured["auth"] == "Bearer k-123"
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert payload["model"] == settings.llm_model
    assert "已有" in payload["messages"][1]["content"]


async def test_enrich_clip_disabled_and_failures(test_settings: Settings) -> None:
    assert await enrich_clip("标题", "正文", [], test_settings) is None

    settings = Settings(llm_base_url="https://llm.example.com/v1", llm_api_key="k")

    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream boom")

    async with httpx.AsyncClient(transport=httpx.MockTransport(failing)) as client:
        with pytest.raises(AIEnrichmentError):
            await enrich_clip("标题", "正文", [], settings, client=client)

    def garbage(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "不是 JSON"}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(garbage)) as client:
        with pytest.raises(AIEnrichmentError):
            await enrich_clip("标题", "正文", [], settings, client=client)


@pytest.fixture
def extraction_stubs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> dict[str, object]:
    """Install stub extractor/media modules and capture their inputs."""
    state: dict[str, object] = {"fail": False, "media": None}

    async def fake_extract_content(url: str, raw_input: str = "", client=None):
        state["extract_url"] = url
        if state["fail"]:
            raise RuntimeError("boom")
        images = ["https://example.com/a.png"]
        state["media"] = images
        return ExtractedContent(
            platform=Platform.WEB,
            url=url,
            title="抓取到的标题",
            author="原作者",
            published_at="2025-01-01",
            content_markdown="![a](https://example.com/a.png)\n\n正文段落",
            content_text="正文段落",
            image_urls=images,
        )

    extractors = types.ModuleType(EXTRACTORS)
    extractors.extract_content = fake_extract_content
    monkeypatch.setitem(sys.modules, EXTRACTORS, extractors)

    class Stored:
        def __init__(self, index: int, path: Path) -> None:
            self.id = f"stub-media-{index}"
            self.original_url = "https://example.com/a.png"
            self.local_path = str(path)
            self.mime_type = "image/png"
            self.size_bytes = 9
            self.sha256 = "deadbeef"
            self.sort_order = index

    async def fake_download_and_store_images(
        image_urls, clip_id=None, settings=None, db=None, referer=None
    ):
        state["download_args"] = {
            "image_urls": list(image_urls),
            "clip_id": clip_id,
            "media_dir": settings.media_dir if settings else None,
        }
        return [Stored(0, tmp_path / "fake.png")]

    def fake_rewrite_markdown_images(markdown, media=None, clip_id=None, settings=None):
        assert media, "rewriter must receive stored media"
        return str(markdown).replace("https://example.com/a.png", "/api/media/stub-media-0")

    media_module = types.ModuleType(MEDIA)
    media_module.download_and_store_images = fake_download_and_store_images
    media_module.rewrite_markdown_images = fake_rewrite_markdown_images
    media_module.StoredMedia = Stored
    monkeypatch.setitem(sys.modules, MEDIA, media_module)

    return state


async def test_process_clip_pipeline_with_ai_mock(
    client_for: ClientFor,
    extraction_stubs: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, settings, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )
    calls: list[tuple[str, str, list[str]]] = []

    async def fake_enrich(title, content_text, existing_tags, settings, client=None):
        calls.append((title, content_text, list(existing_tags)))
        return AIEnrichment(
            summary="AI 摘要",
            key_points=["要点一", "要点二"],
            tags=["AI", "整理"],
        )

    monkeypatch.setattr("app.services.ingest.enrich_clip", fake_enrich)

    row = db.create_clip(
        raw_input="https://example.com/pipeline",
        url="https://example.com/pipeline",
        normalized_url="https://example.com/pipeline",
        tags=["用户标签"],
        user_note="原始笔记",
    )
    clip_id = str(row["id"])

    await process_clip(clip_id, db, settings)

    stored = db.get_clip(clip_id)
    assert stored is not None
    assert stored["status"] == ClipStatus.READY.value
    assert stored["ai_status"] == AIStatus.DONE.value
    assert stored["title"] == "抓取到的标题"
    assert stored["author"] == "原作者"
    assert stored["summary"] == "AI 摘要"
    assert json.loads(stored["key_points_json"]) == ["要点一", "要点二"]
    assert sorted(db.get_clip_tags(clip_id)) == sorted(["用户标签", "AI", "整理"])
    assert "正文段落" in stored["content_text"]
    assert stored["cover_media_id"] == "stub-media-0"
    assert "/api/media/stub-media-0" in stored["content_markdown"]
    media_rows = db.list_media(clip_id)
    assert len(media_rows) == 1
    assert media_rows[0]["mime_type"] == "image/png"

    # AI receives the extracted title/text plus the user's own tags
    assert calls == [("抓取到的标题", "正文段落", ["用户标签"])]

    # the enriched text is searchable through FTS/LIKE
    assert db.list_clips(q="正文段落")[1] == 1


async def test_process_clip_marks_failure_without_losing_clip(
    client_for: ClientFor,
    extraction_stubs: dict[str, object],
) -> None:
    _, settings, db = client_for()
    extraction_stubs["fail"] = True
    row = db.create_clip(
        raw_input="https://example.com/broken",
        url="https://example.com/broken",
        normalized_url="https://example.com/broken",
        tags=["保留我"],
    )
    clip_id = str(row["id"])

    await process_clip(clip_id, db, settings)

    stored = db.get_clip(clip_id)
    assert stored is not None
    assert stored["status"] == ClipStatus.FAILED.value
    assert stored["ai_status"] == AIStatus.SKIPPED.value
    assert "boom" in (stored["error_message"] or "")
    assert db.get_clip_tags(clip_id) == ["保留我"]
    assert (
        db.find_by_normalized_url("https://example.com/broken")["id"] == clip_id
    )


async def test_process_clip_survives_ai_failure(
    client_for: ClientFor,
    extraction_stubs: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, settings, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )

    async def failing_enrich(*args: object, **kwargs: object):
        raise AIEnrichmentError("upstream is down")

    monkeypatch.setattr("app.services.ingest.enrich_clip", failing_enrich)

    row = db.create_clip(
        raw_input="https://example.com/ai-fail",
        url="https://example.com/ai-fail",
        normalized_url="https://example.com/ai-fail",
    )
    clip_id = str(row["id"])

    await process_clip(clip_id, db, settings)

    stored = db.get_clip(clip_id)
    assert stored is not None
    assert stored["status"] == ClipStatus.READY.value
    assert stored["ai_status"] == AIStatus.FAILED.value
    assert "正文段落" in stored["content_text"]


def test_markdown_to_text_strips_formatting() -> None:
    markdown = (
        "# 标题\n\n"
        "![图](https://example.com/a.png)\n\n"
        "[链接文字](https://example.com)\n\n"
        "- **加粗**要点\n"
    )

    text = markdown_to_text(markdown)

    assert "标题" in text
    assert "链接文字" in text
    assert "加粗要点" in text
    assert "https://example.com" not in text
    assert "**" not in text


def test_importlib_and_time_helpers_are_sane() -> None:
    # guards against accidental import-time side effects in app.main
    assert importlib.import_module("app.main").app is not None
    now = datetime(2025, 1, 1, 0, 0, tzinfo=UTC)
    assert parse_iso(to_iso(now + timedelta(days=3))) == now + timedelta(days=3)
    assert parse_iso("not-a-date") is None


def test_hard_delete_preserves_shared_media_file(client_for: ClientFor) -> None:
    client, settings, db = client_for()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    shared = settings.media_dir / "shared.png"
    shared.write_bytes(b"\x89PNG\r\n\x1a\n")

    clip_a = db.create_clip(
        raw_input="https://example.com/a",
        url="https://example.com/a",
        normalized_url="https://example.com/a",
    )
    clip_b = db.create_clip(
        raw_input="https://example.com/b",
        url="https://example.com/b",
        normalized_url="https://example.com/b",
    )
    db.add_media(clip_id=str(clip_a["id"]), local_path="shared.png", mime_type="image/png")
    db.add_media(clip_id=str(clip_b["id"]), local_path="shared.png", mime_type="image/png")

    resp_a = client.delete(f"/api/clips/{clip_a['id']}", params={"permanent": True})
    assert resp_a.status_code == 200
    assert shared.exists(), "shared media file must stay while another clip references it"

    resp_b = client.delete(f"/api/clips/{clip_b['id']}", params={"permanent": True})
    assert resp_b.status_code == 200
    assert not shared.exists(), "media file should be removed once the last reference is gone"


def test_retry_returns_clip_detail_fields(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, db = client_for()

    async def noop_process(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr("app.routers.clips.process_clip", noop_process)
    row = db.create_clip(
        raw_input="https://example.com/retry-detail",
        url="https://example.com/retry-detail",
        normalized_url="https://example.com/retry-detail",
        user_note="待重试笔记",
    )

    resp = client.post(f"/api/clips/{row['id']}/retry")
    assert resp.status_code == 200
    body = resp.json()
    assert body["raw_input"] == "https://example.com/retry-detail"
    assert body["user_note"] == "待重试笔记"
    assert body["media"] == []
    assert body["key_points"] == []


async def test_process_clip_forwards_referer_and_library_tags(
    client_for: ClientFor,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _, settings, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )
    db.create_clip(
        raw_input="https://example.com/existing",
        url="https://example.com/existing",
        normalized_url="https://example.com/existing",
        tags=["系统架构"],
    )
    seen: dict[str, object] = {}

    async def fake_extract(url: str, raw_input: str = "", client=None, settings=None):
        return ExtractedContent(
            platform=Platform.WECHAT,
            url=url,
            title="微信文章",
            content_markdown="![img](https://mmbiz.qpic.cn/1.jpg)\n\n内容",
            content_text="内容",
            image_urls=["https://mmbiz.qpic.cn/1.jpg"],
            referer="https://mp.weixin.qq.com/",
        )

    async def fake_download(image_urls, *, referer=None, **kwargs):
        seen["referer"] = referer
        return []

    async def fake_enrich(title, content_text, existing_tags, settings, client=None):
        seen["existing_tags"] = list(existing_tags)
        return AIEnrichment(summary="摘要", key_points=["点1"], tags=["系统架构"])

    extractors_mod = types.ModuleType(EXTRACTORS)
    extractors_mod.extract_content = fake_extract
    monkeypatch.setitem(sys.modules, EXTRACTORS, extractors_mod)

    media_mod = types.ModuleType(MEDIA)
    media_mod.download_and_store_images = fake_download
    media_mod.rewrite_markdown_images = lambda md, **kw: md
    monkeypatch.setitem(sys.modules, MEDIA, media_mod)
    monkeypatch.setattr("app.services.ingest.enrich_clip", fake_enrich)

    clip = db.create_clip(
        raw_input="https://mp.weixin.qq.com/s/test",
        url="https://mp.weixin.qq.com/s/test",
        normalized_url="https://mp.weixin.qq.com/s/test",
        tags=["自定"],
    )
    await process_clip(str(clip["id"]), db, settings)

    assert seen["referer"] == "https://mp.weixin.qq.com/"
    assert "系统架构" in seen["existing_tags"]
    assert "自定" in seen["existing_tags"]
