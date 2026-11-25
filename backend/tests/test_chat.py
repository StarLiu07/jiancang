"""Article AI chat: prompt building, model call, persistence and HTTP contract.

No test ever touches the real network: every LLM call goes through
``httpx.MockTransport`` (directly for the service tests, via a thin wrapper that
injects the mock client for the API tests).
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database, parse_iso, row_to_chat_message, to_iso
from app.main import create_app
from app.models import ArticleChatContext, ChatRole, ChatTurnInput, Platform
from app.services.ai import (
    MAX_CHAT_CONTENT_CHARS,
    MAX_CHAT_HISTORY_MESSAGES,
    AIChatError,
    build_chat_messages,
    chat_with_article,
)

AI_SETTINGS: dict[str, object] = {
    "llm_base_url": "https://llm.example.com/v1",
    "llm_api_key": "k-test",
    "llm_user_agent": "jiancang-test/9",
}

ClientFor = Callable[..., tuple[TestClient, Settings, Database]]


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def client_for(tmp_path: Path) -> Iterator[ClientFor]:
    created: list[Any] = []
    counter = {"n": 0}

    def factory(**overrides: object) -> tuple[TestClient, Settings, Database]:
        counter["n"] += 1
        params: dict[str, object] = {
            "data_dir": tmp_path / f"chat-data-{counter['n']}",
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


def make_article(**overrides: Any) -> ArticleChatContext:
    base: dict[str, Any] = {
        "title": "深入理解 SQLite",
        "author": "张三",
        "platform": Platform.WECHAT,
        "url": "https://example.com/a",
        "summary": "SQLite 的并发模型摘要",
        "key_points": ["WAL 提升并发", "trigram 支持中文"],
        "content_text": "SQLite 正文内容",
        "user_note": "我的个人笔记",
    }
    base.update(overrides)
    return ArticleChatContext(**base)


def make_clip(db: Database, **overrides: Any) -> str:
    fields: dict[str, Any] = {
        "title": "深入理解 SQLite",
        "author": "张三",
        "summary": "SQLite 的并发模型摘要",
        "content_markdown": "# Markdown 正文",
        "content_text": "纯文本正文",
        "key_points": ["WAL 提升并发", "trigram 支持中文"],
        "user_note": "我的个人笔记",
    }
    fields.update(overrides)
    return str(db.create_clip(**fields)["id"])


def chat_http_client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def model_reply(content: str, model: str = "test-model") -> httpx.Response:
    return httpx.Response(
        200,
        json={"model": model, "choices": [{"message": {"content": content}}]},
    )


class Recorder:
    """Mock LLM transport recording every request; replies ``第N次回答``."""

    def __init__(self, model: str = "test-model") -> None:
        self.model = model
        self.status = 200
        self.error_text = "upstream boom"
        self.requests: list[dict[str, Any]] = []
        self.articles: list[ArticleChatContext] = []
        self.histories: list[list[ChatTurnInput]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        self.requests.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "payload": payload,
            }
        )
        if self.status >= 400:
            return httpx.Response(self.status, text=self.error_text)
        return model_reply(f"第{len(self.requests)}次回答", self.model)


@pytest.fixture
def live_chat(monkeypatch: pytest.MonkeyPatch) -> Iterator[Recorder]:
    """Route the real service call through a mock transport from the router."""
    recorder = Recorder()

    async def fake_chat(
        article: ArticleChatContext,
        history: Any,
        settings: Settings,
        client: httpx.AsyncClient | None = None,
    ) -> tuple[str, str]:
        recorder.articles.append(article)
        recorder.histories.append(list(history))
        async with chat_http_client(recorder.handle) as http_client:
            return await chat_with_article(
                article, history, settings, client=http_client
            )

    monkeypatch.setattr("app.routers.clips.chat_with_article", fake_chat)
    yield recorder


# ---------------------------------------------------------------------------
# build_chat_messages
# ---------------------------------------------------------------------------


def test_build_chat_messages_embeds_article_context() -> None:
    messages = build_chat_messages(
        make_article(),
        [ChatTurnInput(role=ChatRole.USER, content="  这篇文章讲了什么？  ")],
    )

    assert [item["role"] for item in messages] == ["system", "user"]
    system = messages[0]["content"]
    for needle in (
        "深入理解 SQLite",
        "张三",
        "wechat",
        "https://example.com/a",
        "SQLite 的并发模型摘要",
        "WAL 提升并发",
        "trigram 支持中文",
        "我的个人笔记",
        "SQLite 正文内容",
    ):
        assert needle in system
    assert "文章精读与讨论助手" in system
    assert messages[1] == {"role": "user", "content": "这篇文章讲了什么？"}


def test_build_chat_messages_truncates_long_body() -> None:
    body = "甲" * (MAX_CHAT_CONTENT_CHARS + 500)
    messages = build_chat_messages(
        make_article(content_text=body),
        [ChatTurnInput(role=ChatRole.USER, content="总结")],
    )

    system = messages[0]["content"]
    assert "甲" * MAX_CHAT_CONTENT_CHARS in system
    assert "甲" * (MAX_CHAT_CONTENT_CHARS + 1) not in system
    assert "...(正文已截断)" in system


def test_build_chat_messages_keeps_only_recent_history_and_drops_blanks() -> None:
    history = [
        ChatTurnInput(
            role=ChatRole.USER if index % 2 == 0 else ChatRole.ASSISTANT,
            content=f"轮次{index}",
        )
        for index in range(30)
    ]
    history.insert(0, ChatTurnInput(role=ChatRole.USER, content="   "))

    messages = build_chat_messages(make_article(), history)

    assert len(messages) == 1 + MAX_CHAT_HISTORY_MESSAGES
    assert [item["content"] for item in messages[1:]] == [
        f"轮次{index}"
        for index in range(30 - MAX_CHAT_HISTORY_MESSAGES, 30)
    ]
    assert messages[1]["role"] == "user"
    assert messages[2]["role"] == "assistant"


def test_build_chat_messages_flags_missing_body() -> None:
    messages = build_chat_messages(
        make_article(content_text="   "),
        [ChatTurnInput(role=ChatRole.USER, content="总结")],
    )

    assert (
        "（正文暂缺，请结合标题/摘要/笔记回答并向用户说明正文不足）"
        in messages[0]["content"]
    )


# ---------------------------------------------------------------------------
# chat_with_article
# ---------------------------------------------------------------------------


async def test_chat_with_article_returns_reply_and_model() -> None:
    settings = Settings(
        llm_base_url="https://llm.example.com/v1/",
        llm_api_key="k-123",
        llm_user_agent="jiancang-test/9",
    )
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["payload"] = json.loads(request.content)
        return model_reply("  模型回答  ", "deepseek-test")

    async with chat_http_client(handler) as client:
        reply, model = await chat_with_article(
            make_article(),
            [ChatTurnInput(role=ChatRole.USER, content="问题")],
            settings,
            client=client,
        )

    assert reply == "模型回答"
    assert model == "deepseek-test"
    assert captured["url"] == "https://llm.example.com/v1/chat/completions"
    assert captured["headers"]["user-agent"] == "jiancang-test/9"
    assert captured["headers"]["authorization"] == "Bearer k-123"
    payload = captured["payload"]
    assert payload["model"] == settings.llm_model
    assert payload["temperature"] == 0.5
    assert payload["stream"] is False
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][-1] == {"role": "user", "content": "问题"}


async def test_chat_with_article_uses_min_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        llm_base_url="https://llm.example.com/v1",
        llm_api_key="k",
        llm_timeout_seconds=5.0,
    )
    captured: dict[str, Any] = {}

    class FakeAsyncClient:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

        async def post(self, url: str, **kwargs: Any) -> httpx.Response:
            captured["url"] = url
            return model_reply("好的")

        async def aclose(self) -> None:
            captured["closed"] = True

    monkeypatch.setattr("app.services.ai.httpx.AsyncClient", FakeAsyncClient)

    reply, _ = await chat_with_article(
        make_article(),
        [ChatTurnInput(role=ChatRole.USER, content="问题")],
        settings,
    )

    assert reply == "好的"
    timeout = captured["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == 60.0
    assert timeout.connect == 60.0
    assert captured["closed"] is True


async def test_chat_with_article_disabled(test_settings: Settings) -> None:
    with pytest.raises(AIChatError, match="AI is not enabled"):
        await chat_with_article(
            make_article(),
            [ChatTurnInput(role=ChatRole.USER, content="问题")],
            test_settings,
        )


async def test_chat_with_article_requires_user_turn() -> None:
    settings = Settings(llm_base_url="https://llm.example.com/v1", llm_api_key="k")

    def never(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the model must not be called without a user turn")

    async with chat_http_client(never) as client:
        with pytest.raises(AIChatError, match="empty chat history"):
            await chat_with_article(
                make_article(),
                [ChatTurnInput(role=ChatRole.ASSISTANT, content="只有助手消息")],
                settings,
                client=client,
            )


async def test_chat_with_article_wraps_failures() -> None:
    settings = Settings(llm_base_url="https://llm.example.com/v1", llm_api_key="k")
    history = [ChatTurnInput(role=ChatRole.USER, content="问题")]

    def upstream_error(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream boom")

    async with chat_http_client(upstream_error) as client:
        with pytest.raises(AIChatError, match="llm http 500"):
            await chat_with_article(make_article(), history, settings, client=client)

    def empty_reply(request: httpx.Request) -> httpx.Response:
        return model_reply("   ")

    async with chat_http_client(empty_reply) as client:
        with pytest.raises(AIChatError, match="empty model reply"):
            await chat_with_article(make_article(), history, settings, client=client)

    def non_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json at all")

    async with chat_http_client(non_json) as client:
        with pytest.raises(AIChatError, match="non-JSON"):
            await chat_with_article(make_article(), history, settings, client=client)

    def no_choices(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": "m"})

    async with chat_http_client(no_choices) as client:
        with pytest.raises(AIChatError):
            await chat_with_article(make_article(), history, settings, client=client)


async def test_chat_with_article_wraps_transport_errors() -> None:
    settings = Settings(llm_base_url="https://llm.example.com/v1", llm_api_key="k")

    def transport_error(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    async with chat_http_client(transport_error) as client:
        with pytest.raises(AIChatError, match="llm request failed"):
            await chat_with_article(
                make_article(),
                [ChatTurnInput(role=ChatRole.USER, content="问题")],
                settings,
                client=client,
            )


# ---------------------------------------------------------------------------
# persistence layer
# ---------------------------------------------------------------------------


def test_chat_message_persistence(tmp_path: Path) -> None:
    db = Database(tmp_path / "chat.db")
    try:
        clip_id = make_clip(db)
        assert db.list_chat_messages(clip_id) == []
        assert db.count_chat_messages(clip_id) == 0

        base = datetime(2025, 5, 1, 8, 0, tzinfo=UTC)
        first = db.add_chat_message(
            clip_id, ChatRole.USER, "第一个问题", message_id="m1", now=base
        )
        second = db.add_chat_message(
            clip_id,
            ChatRole.ASSISTANT,
            "第一个回答",
            message_id="m2",
            now=base + timedelta(seconds=1),
        )

        assert first["id"] == "m1"
        assert second["clip_id"] == clip_id
        assert second["role"] == "assistant"
        item = row_to_chat_message(first)
        assert item.id == "m1"
        assert item.role is ChatRole.USER
        assert item.content == "第一个问题"
        assert item.created_at == to_iso(base)

        assert db.count_chat_messages(clip_id) == 2
        assert [row["id"] for row in db.list_chat_messages(clip_id)] == ["m1", "m2"]

        for offset, message_id in enumerate(("m3", "m4", "m5"), start=2):
            db.add_chat_message(
                clip_id,
                ChatRole.USER,
                message_id,
                message_id=message_id,
                now=base + timedelta(seconds=offset),
            )

        # limit keeps the *newest* messages, still returned oldest-first
        assert [row["id"] for row in db.list_chat_messages(clip_id, limit=2)] == [
            "m4",
            "m5",
        ]

        assert db.clear_chat_messages(clip_id) == 5
        assert db.count_chat_messages(clip_id) == 0
        assert db.clear_chat_messages(clip_id) == 0
    finally:
        db.close()


def test_hard_delete_clip_cascades_chat_messages(tmp_path: Path) -> None:
    path = tmp_path / "chat.db"
    db = Database(path)
    try:
        clip_id = make_clip(db)
        db.add_chat_message(clip_id, ChatRole.USER, "问题")
        db.add_chat_message(clip_id, ChatRole.ASSISTANT, "回答")
        assert db.count_chat_messages(clip_id) == 2

        db.hard_delete_clip(clip_id)

        assert db.count_chat_messages(clip_id) == 0
        with sqlite3.connect(path) as conn:
            remaining = conn.execute(
                "SELECT COUNT(*) FROM clip_chat_messages"
            ).fetchone()[0]
        assert remaining == 0
    finally:
        db.close()


def test_chat_schema_is_added_to_a_pre_chat_database(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    db = Database(path)
    db.close()

    # Simulate a database created before the chat feature landed.
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE clip_chat_messages")

    reopened = Database(path)
    try:
        tables = {
            str(row["name"])
            for row in reopened._fetchall(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        indexes = {
            str(row["name"])
            for row in reopened._fetchall(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            )
        }
        assert "clip_chat_messages" in tables
        assert "idx_clip_chat_clip_time" in indexes
        clip_id = make_clip(reopened)
        reopened.add_chat_message(clip_id, ChatRole.USER, "升级后可用")
        assert reopened.count_chat_messages(clip_id) == 1
    finally:
        reopened.close()


# ---------------------------------------------------------------------------
# API: /api/clips/{clip_id}/chat
# ---------------------------------------------------------------------------


def test_chat_history_empty_and_unknown_clip(client_for: ClientFor) -> None:
    client, _, db = client_for(**AI_SETTINGS)
    clip_id = make_clip(db)

    response = client.get(f"/api/clips/{clip_id}/chat")
    assert response.status_code == 200
    assert response.json() == {"clip_id": clip_id, "messages": []}

    assert client.get("/api/clips/missing/chat").status_code == 404
    assert client.post("/api/clips/missing/chat", json={"message": "hi"}).status_code == 404
    assert client.delete("/api/clips/missing/chat").status_code == 404


def test_chat_round_trip_persists_and_replays_history(
    client_for: ClientFor, live_chat: Recorder
) -> None:
    client, _, db = client_for(**AI_SETTINGS)
    clip_id = make_clip(db)

    first = client.post(f"/api/clips/{clip_id}/chat", json={"message": " 第一问 "})
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["model"] == "test-model"
    assert first_body["user_message"]["clip_id"] == clip_id
    assert first_body["user_message"]["role"] == "user"
    assert first_body["user_message"]["content"] == "第一问"
    assert first_body["assistant_message"]["role"] == "assistant"
    assert first_body["assistant_message"]["content"] == "第1次回答"
    user_time = parse_iso(first_body["user_message"]["created_at"])
    assistant_time = parse_iso(first_body["assistant_message"]["created_at"])
    assert user_time is not None
    assert assistant_time is not None
    assert assistant_time > user_time

    # the clip row is turned into an article context, markdown wins over text
    article = live_chat.articles[0]
    assert article.title == "深入理解 SQLite"
    assert article.content_text == "# Markdown 正文"
    assert article.key_points == ["WAL 提升并发", "trigram 支持中文"]

    second = client.post(f"/api/clips/{clip_id}/chat", json={"message": "第二问"})
    assert second.status_code == 200

    sent_messages = live_chat.requests[1]["payload"]["messages"]
    assert sent_messages[0]["role"] == "system"
    assert "深入理解 SQLite" in sent_messages[0]["content"]
    assert sent_messages[1:] == [
        {"role": "user", "content": "第一问"},
        {"role": "assistant", "content": "第1次回答"},
        {"role": "user", "content": "第二问"},
    ]

    history = client.get(f"/api/clips/{clip_id}/chat")
    assert history.status_code == 200
    assert [item["content"] for item in history.json()["messages"]] == [
        "第一问",
        "第1次回答",
        "第二问",
        "第2次回答",
    ]
    assert db.count_chat_messages(clip_id) == 4


def test_chat_rejects_blank_message(client_for: ClientFor, live_chat: Recorder) -> None:
    client, _, db = client_for(**AI_SETTINGS)
    clip_id = make_clip(db)

    response = client.post(f"/api/clips/{clip_id}/chat", json={"message": "   "})
    assert response.status_code == 422
    assert live_chat.requests == []
    assert client.get(f"/api/clips/{clip_id}/chat").json()["messages"] == []


def test_chat_requires_ai_configuration(client_for: ClientFor) -> None:
    client, _, db = client_for()
    clip_id = make_clip(db)

    response = client.post(f"/api/clips/{clip_id}/chat", json={"message": "问题"})
    assert response.status_code == 503
    assert "LLM_BASE_URL" in response.json()["detail"]


def test_chat_upstream_failure_returns_502_without_dirty_messages(
    client_for: ClientFor, live_chat: Recorder
) -> None:
    client, _, db = client_for(**AI_SETTINGS)
    clip_id = make_clip(db)
    live_chat.status = 500

    response = client.post(f"/api/clips/{clip_id}/chat", json={"message": "问题"})
    assert response.status_code == 502
    assert db.count_chat_messages(clip_id) == 0
    assert client.get(f"/api/clips/{clip_id}/chat").json()["messages"] == []


def test_delete_chat_clears_history(client_for: ClientFor, live_chat: Recorder) -> None:
    client, _, db = client_for(**AI_SETTINGS)
    clip_id = make_clip(db)
    assert client.post(f"/api/clips/{clip_id}/chat", json={"message": "一"}).status_code == 200
    assert client.post(f"/api/clips/{clip_id}/chat", json={"message": "二"}).status_code == 200

    response = client.delete(f"/api/clips/{clip_id}/chat")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "deleted": 4}
    assert client.get(f"/api/clips/{clip_id}/chat").json()["messages"] == []
    assert db.count_chat_messages(clip_id) == 0

    assert client.delete(f"/api/clips/{clip_id}/chat").json() == {
        "ok": True,
        "deleted": 0,
    }


# ---------------------------------------------------------------------------
# API: /api/ai/chat (stateless proxy)
# ---------------------------------------------------------------------------


def stateless_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "article": {
            "title": "未同步的文章",
            "author": "李四",
            "platform": "web",
            "url": "https://example.com/unsynced",
            "summary": "摘要",
            "key_points": ["要点一"],
            "content_text": "手机端正文",
            "user_note": "临时笔记",
        },
        "messages": [{"role": "user", "content": "这篇文章讲了什么？"}],
    }
    payload.update(overrides)
    return payload


def test_stateless_chat_returns_reply(client_for: ClientFor, live_chat: Recorder) -> None:
    client, _, _ = client_for(**AI_SETTINGS)

    response = client.post("/api/ai/chat", json=stateless_payload())
    assert response.status_code == 200
    assert response.json() == {"reply": "第1次回答", "model": "test-model"}

    sent = live_chat.requests[0]["payload"]["messages"]
    assert sent[0]["role"] == "system"
    assert "未同步的文章" in sent[0]["content"]
    assert "手机端正文" in sent[0]["content"]
    assert sent[-1] == {"role": "user", "content": "这篇文章讲了什么？"}


def test_stateless_chat_requires_ai_configuration(client_for: ClientFor) -> None:
    client, _, _ = client_for()
    response = client.post("/api/ai/chat", json=stateless_payload())
    assert response.status_code == 503


def test_stateless_chat_rejects_blank_user_messages(
    client_for: ClientFor, live_chat: Recorder
) -> None:
    client, _, _ = client_for(**AI_SETTINGS)

    blank = client.post(
        "/api/ai/chat",
        json=stateless_payload(messages=[{"role": "user", "content": "   "}]),
    )
    assert blank.status_code == 422

    assistant_only = client.post(
        "/api/ai/chat",
        json=stateless_payload(messages=[{"role": "assistant", "content": "我先说"}]),
    )
    assert assistant_only.status_code == 422

    empty = client.post("/api/ai/chat", json=stateless_payload(messages=[]))
    assert empty.status_code == 422
    assert live_chat.requests == []


def test_stateless_chat_upstream_failure_returns_502(
    client_for: ClientFor, live_chat: Recorder
) -> None:
    client, _, _ = client_for(**AI_SETTINGS)
    live_chat.status = 500

    response = client.post("/api/ai/chat", json=stateless_payload())
    assert response.status_code == 502
