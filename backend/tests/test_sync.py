"""Regression tests for the bidirectional incremental sync protocol.

Covers: legacy DB migration, push/pull round-trip, LWW conflicts, AI/body
protection, tombstones, media metadata + binary upload, the NUC AI backfill
triggered by a push, review-log de-duplication and pull pagination.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database, parse_iso, to_iso
from app.main import create_app
from app.services.ai import AIEnrichment
from app.services.ingest import enrich_existing_clip

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 48
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 48
NOW = datetime(2025, 5, 1, 8, 0, 0, tzinfo=UTC)

ClientFor = Callable[..., tuple[TestClient, Settings, Database]]


# ---------------------------------------------------------------------------
# fixtures & helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def client_for(tmp_path: Path) -> Iterator[ClientFor]:
    created: list = []
    counter = {"n": 0}

    def factory(**overrides: object) -> tuple[TestClient, Settings, Database]:
        counter["n"] += 1
        params: dict[str, object] = {
            "data_dir": tmp_path / f"data-{counter['n']}",
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


def clip_payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "clip-1",
        "raw_input": "https://example.com/a",
        "url": "https://example.com/a",
        "normalized_url": "https://example.com/a",
        "platform": "web",
        "status": "ready",
        "ai_status": "pending",
        "title": "标题",
        "content_markdown": "正文段落",
        "content_text": "正文段落",
        "summary": "",
        "key_points": [],
        "user_note": "",
        "review_state": "active",
        "created_at": "2025-05-01T08:00:00+00:00",
        "updated_at": "2025-05-01T08:00:00+00:00",
        "tags": [],
    }
    base.update(overrides)
    return base


def push(client: TestClient, *clips: dict[str, object], logs: list[dict] | None = None):
    response = client.post(
        "/api/sync/push",
        json={"clips": list(clips), "review_logs": logs or []},
    )
    assert response.status_code == 200, response.text
    return response.json()


def pull(client: TestClient, since_version: int = 0, limit: int = 100) -> dict:
    response = client.get(
        "/api/sync/pull", params={"since_version": since_version, "limit": limit}
    )
    assert response.status_code == 200, response.text
    return response.json()


def review_logs_count(db: Database) -> int:
    with sqlite3.connect(db.path) as raw:
        return int(raw.execute("SELECT COUNT(*) FROM review_logs").fetchone()[0])


# The pre-sync schema: exactly what shipped before Wave 2 (no ``sync_version``
# column and no ``sync_meta`` table).
LEGACY_SCHEMA = """
CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    raw_input TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    normalized_url TEXT,
    platform TEXT NOT NULL DEFAULT 'web',
    status TEXT NOT NULL DEFAULT 'pending',
    ai_status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    content_markdown TEXT NOT NULL DEFAULT '',
    content_text TEXT NOT NULL DEFAULT '',
    cover_media_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    key_points_json TEXT NOT NULL DEFAULT '[]',
    user_note TEXT NOT NULL DEFAULT '',
    review_state TEXT NOT NULL DEFAULT 'active',
    review_count INTEGER NOT NULL DEFAULT 0,
    review_interval_days INTEGER NOT NULL DEFAULT 0,
    next_review_at TEXT,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reviewed_at TEXT NOT NULL
);
"""


def _insert_legacy_clip(
    raw: sqlite3.Connection,
    *,
    clip_id: str,
    title: str,
    review_state: str = "active",
) -> None:
    raw.execute(
        "INSERT INTO clips (id, raw_input, url, normalized_url, status, ai_status, "
        "title, content_markdown, content_text, summary, key_points_json, "
        "review_state, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 'ready', 'done', ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            clip_id,
            f"https://example.com/{clip_id}",
            f"https://example.com/{clip_id}",
            f"https://example.com/{clip_id}",
            title,
            f"{title} 正文",
            f"{title} 正文",
            f"{title} 摘要",
            json.dumps(["要点"], ensure_ascii=False),
            review_state,
            "2025-01-01T00:00:00.000000+00:00",
            "2025-01-02T00:00:00.000000+00:00",
        ),
    )


# ---------------------------------------------------------------------------
# legacy DB migration
# ---------------------------------------------------------------------------


def test_legacy_database_migrates_and_pulls_from_version_one(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    legacy = data_dir / "jiancang.db"
    raw = sqlite3.connect(legacy)
    try:
        raw.executescript(LEGACY_SCHEMA)
        _insert_legacy_clip(raw, clip_id="old-active", title="旧笔记")
        _insert_legacy_clip(raw, clip_id="old-deleted", title="旧墓碑", review_state="deleted")
        raw.execute(
            "INSERT INTO review_logs (clip_id, action, reviewed_at) "
            "VALUES ('old-active', 'snooze', '2025-01-03T00:00:00.000000+00:00')"
        )
        raw.commit()
    finally:
        raw.close()

    settings = Settings(
        data_dir=data_dir,
        api_token="",
        llm_base_url="",
        llm_api_key="",
    )
    app = create_app(settings)
    try:
        client = TestClient(app)
        body = pull(client, since_version=0)

        assert {clip["id"] for clip in body["clips"]} == {"old-active", "old-deleted"}
        assert {clip["sync_version"] for clip in body["clips"]} == {1}
        deleted = next(clip for clip in body["clips"] if clip["id"] == "old-deleted")
        assert deleted["review_state"] == "deleted"
        assert [log["clip_id"] for log in body["review_logs"]] == ["old-active"]
        assert body["latest_version"] >= 1
        assert body["has_more"] is False

        # a phone that already knows version 1 must not see history again
        assert pull(client, since_version=1)["clips"] == []
    finally:
        app.state.db.close()

    with sqlite3.connect(legacy) as check:
        columns = {row[1] for row in check.execute("PRAGMA table_info(clips)")}
        indexes = {row[1] for row in check.execute("PRAGMA index_list(clips)")}
        seq = check.execute("SELECT value FROM sync_meta WHERE key = 'seq'").fetchone()
    assert "sync_version" in columns
    assert "idx_clips_sync_version" in indexes
    assert seq is not None and int(seq[0]) >= 1


# ---------------------------------------------------------------------------
# push / pull round-trip
# ---------------------------------------------------------------------------


def test_push_then_pull_roundtrip(client_for: ClientFor) -> None:
    client, _, db = client_for()
    payload = clip_payload(
        tags=["阅读", "后端"],
        user_note="我的笔记",
        summary="一句话摘要",
        key_points=["要点一", "要点二"],
        review_count=2,
        review_interval_days=3,
        next_review_at="2025-05-04T08:00:00+00:00",
        last_reviewed_at="2025-05-01T08:00:00+00:00",
    )

    pushed = push(client, payload)

    assert pushed["accepted_ids"] == ["clip-1"]
    assert pushed["skipped_ids"] == []
    assert pushed["missing_media_ids"] == []
    assert pushed["queued_ai_ids"] == []  # AI disabled in the fixture
    assert pushed["server_version"] >= 1

    body = pull(client, since_version=0)
    assert len(body["clips"]) == 1
    record = body["clips"][0]
    assert record["id"] == "clip-1"
    assert record["title"] == "标题"
    assert record["content_markdown"] == "正文段落"
    assert record["key_points"] == ["要点一", "要点二"]
    assert record["tags"] == ["后端", "阅读"]
    assert record["user_note"] == "我的笔记"
    assert record["review_count"] == 2
    assert parse_iso(record["next_review_at"]) == parse_iso("2025-05-04T08:00:00+00:00")
    assert record["sync_version"] >= 1
    assert record["sync_version"] <= pushed["server_version"]
    assert body["latest_version"] == pushed["server_version"]
    assert body["has_more"] is False

    # the existing clip API sees the same record
    detail = client.get("/api/clips/clip-1").json()
    assert detail["user_note"] == "我的笔记"
    assert detail["tags"] == ["后端", "阅读"]
    # sync-created clips are indexed for search too
    assert db.list_clips(q="正文段落")[1] == 1

    # a later push updates in place instead of duplicating
    push(client, clip_payload(user_note="更新后的笔记", updated_at="2025-05-02T08:00:00+00:00"))
    listing = client.get("/api/clips").json()
    assert listing["total"] == 1
    assert client.get("/api/clips/clip-1").json()["user_note"] == "更新后的笔记"

    follow_up = pull(client, since_version=body["latest_version"])
    assert [clip["id"] for clip in follow_up["clips"]] == ["clip-1"]
    assert follow_up["clips"][0]["user_note"] == "更新后的笔记"


def test_lww_newer_wins_and_strictly_older_is_skipped(client_for: ClientFor) -> None:
    client, _, db = client_for()
    push(client, clip_payload(title="第一版", updated_at="2025-05-01T10:00:00+00:00"))

    stale = push(
        client,
        clip_payload(title="更旧的标题", updated_at="2025-05-01T09:00:00+00:00"),
    )
    assert stale["accepted_ids"] == []
    assert stale["skipped_ids"] == ["clip-1"]
    assert db.get_clip("clip-1")["title"] == "第一版"

    newer = push(
        client,
        clip_payload(title="更新版", updated_at="2025-05-01T11:00:00+00:00"),
    )
    assert newer["accepted_ids"] == ["clip-1"]
    assert db.get_clip("clip-1")["title"] == "更新版"

    # identical timestamps merge (client edit + server edit at the same second)
    tie = push(
        client,
        clip_payload(
            title="同刻标题",
            user_note="同刻合并",
            updated_at=to_iso(parse_iso("2025-05-01T11:00:00+00:00")),
        ),
    )
    assert tie["accepted_ids"] == ["clip-1"]
    stored = db.get_clip("clip-1")
    assert stored["title"] == "同刻标题"
    assert stored["user_note"] == "同刻合并"


# ---------------------------------------------------------------------------
# AI / body protection
# ---------------------------------------------------------------------------


def test_push_cannot_erase_server_ai_summary_or_body(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )

    async def never_called(*args: object, **kwargs: object) -> None:
        raise AssertionError("a done summary must not be re-enriched")

    monkeypatch.setattr("app.services.ingest.enrich_clip", never_called)

    row = db.create_clip(
        raw_input="https://example.com/server",
        url="https://example.com/server",
        normalized_url="https://example.com/server",
        status="ready",
        ai_status="done",
        title="服务端标题",
        content_markdown="# 抓取正文\n\n完整段落",
        content_text="抓取正文 完整段落",
        summary="服务端摘要",
        key_points=["服务端要点"],
        tags=["AI标签"],
        now=NOW,
    )
    clip_id = str(row["id"])

    pushed = push(
        client,
        clip_payload(
            id=clip_id,
            title="服务端标题",
            status="pending",
            ai_status="pending",
            content_markdown="",
            content_text="",
            summary="",
            key_points=[],
            tags=["用户标签"],
            updated_at="2025-05-02T08:00:00+00:00",
        ),
    )

    assert pushed["accepted_ids"] == [clip_id]
    assert pushed["queued_ai_ids"] == []

    stored = db.get_clip(clip_id)
    assert stored["ai_status"] == "done"
    assert stored["summary"] == "服务端摘要"
    assert json.loads(stored["key_points_json"]) == ["服务端要点"]
    # body + status survive a mobile payload that never scraped the page
    assert "完整段落" in stored["content_markdown"]
    assert stored["status"] == "ready"
    # AI tags are unioned with the mobile tags instead of being dropped
    assert db.get_clip_tags(clip_id) == ["AI标签", "用户标签"]


def test_ai_status_downgrade_is_allowed_when_server_never_finished(
    client_for: ClientFor,
) -> None:
    # AI disabled: the pushed status is stored verbatim and nothing is queued
    client, _, db = client_for()
    other = db.create_clip(
        raw_input="https://example.com/pending",
        url="https://example.com/pending",
        normalized_url="https://example.com/pending",
        status="ready",
        ai_status="pending",
        title="未整理",
        content_text="正文",
        now=NOW,
    )
    pushed = push(
        client,
        clip_payload(
            id=str(other["id"]),
            title="未整理",
            status="ready",
            ai_status="skipped",
            content_markdown="正文",
            content_text="正文",
            updated_at="2025-05-03T08:00:00+00:00",
        ),
    )
    assert pushed["accepted_ids"] == [str(other["id"])]
    assert pushed["queued_ai_ids"] == []
    assert db.get_clip(str(other["id"]))["ai_status"] == "skipped"


# ---------------------------------------------------------------------------
# tombstones
# ---------------------------------------------------------------------------


def test_soft_delete_tombstone_is_pulled(client_for: ClientFor) -> None:
    client, _, db = client_for()
    first = push(client, clip_payload())
    before_version = first["server_version"]

    tombstone = push(
        client,
        clip_payload(
            review_state="deleted",
            updated_at="2025-05-05T08:00:00+00:00",
        ),
        logs=[
            {
                "clip_id": "clip-1",
                "action": "delete",
                "reviewed_at": "2025-05-05T08:00:00+00:00",
            }
        ],
    )
    assert tombstone["accepted_ids"] == ["clip-1"]

    body = pull(client, since_version=before_version)
    assert [clip["id"] for clip in body["clips"]] == ["clip-1"]
    assert body["clips"][0]["review_state"] == "deleted"
    assert body["clips"][0]["sync_version"] > before_version
    assert body["review_logs"][0]["action"] == "delete"

    # the tombstone still exists server-side but is hidden from the normal list
    assert db.get_clip("clip-1")["review_state"] == "deleted"
    assert client.get("/api/clips").json()["total"] == 0
    assert client.get("/api/clips", params={"review_state": "deleted"}).json()["total"] == 1


# ---------------------------------------------------------------------------
# media: missing report + binary upload
# ---------------------------------------------------------------------------


def test_missing_media_reported_then_uploaded_and_served(client_for: ClientFor) -> None:
    client, settings, db = client_for()
    media = {
        "id": "media-1",
        "clip_id": "clip-1",
        "original_url": "https://cdn.example.com/a.png",
        "mime_type": "image/png",
        "size_bytes": len(PNG),
        "sha256": hashlib.sha256(PNG).hexdigest(),
        "sort_order": 0,
    }

    pushed = push(client, clip_payload(media=[media]))
    assert pushed["missing_media_ids"] == ["media-1"]
    pulled = pull(client, since_version=0)["clips"][0]
    assert pulled["media"] == [
        {
            "id": "media-1",
            "clip_id": "clip-1",
            "original_url": "https://cdn.example.com/a.png",
            "mime_type": "image/png",
            "size_bytes": len(PNG),
            "sha256": hashlib.sha256(PNG).hexdigest(),
            "sort_order": 0,
            "created_at": pulled["media"][0]["created_at"],
        }
    ]

    # uploads for an unknown clip are rejected
    bad = client.put(
        "/api/sync/media/media-1",
        content=PNG,
        headers={"X-Clip-Id": "does-not-exist", "Content-Type": "image/png"},
    )
    assert bad.status_code == 404

    # no X-Clip-Id: fall back to the clip_id stored on the existing media row
    uploaded = client.put(
        "/api/sync/media/media-1",
        content=PNG,
        headers={
            "Content-Type": "image/png",
            "X-Original-Url": "https://cdn.example.com/a.png",
            "X-Sort-Order": "1",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    body = uploaded.json()
    assert body["id"] == "media-1"
    assert body["clip_id"] == "clip-1"
    assert body["mime_type"] == "image/png"
    assert body["size_bytes"] == len(PNG)
    assert body["sha256"] == hashlib.sha256(PNG).hexdigest()

    stored_rows = db.list_media("clip-1")
    assert len(stored_rows) == 1
    assert stored_rows[0]["sort_order"] == 1
    assert (settings.media_dir / str(stored_rows[0]["local_path"])).read_bytes() == PNG

    served = client.get("/api/media/media-1")
    assert served.status_code == 200
    assert served.content == PNG
    assert served.headers["content-type"].startswith("image/png")

    # pushing the metadata again keeps the server-owned local_path and clears
    # the missing report
    again = push(client, clip_payload(media=[media]))
    assert again["missing_media_ids"] == []
    assert db.list_media("clip-1")[0]["local_path"] == stored_rows[0]["local_path"]
    assert client.get("/api/media/media-1").status_code == 200


def test_media_upload_rejects_oversized_and_non_images(client_for: ClientFor) -> None:
    small, _, _ = client_for(max_media_bytes=32)
    push(small, clip_payload(id="clip-small"))
    too_big = small.put(
        "/api/sync/media/big",
        content=PNG,
        headers={"X-Clip-Id": "clip-small", "Content-Type": "image/png"},
    )
    assert too_big.status_code == 413

    client, _, _ = client_for()
    push(client, clip_payload(id="clip-non-image"))
    not_an_image = client.put(
        "/api/sync/media/page",
        content=b"<html>nope</html>",
        headers={"X-Clip-Id": "clip-non-image", "Content-Type": "text/html"},
    )
    assert not_an_image.status_code == 415

    # sniffing wins over a lying content-type: JPEG magic bytes are stored as jpeg
    uploaded = client.put(
        "/api/sync/media/looks-like-text",
        content=JPEG,
        headers={"X-Clip-Id": "clip-non-image", "Content-Type": "text/plain"},
    )
    assert uploaded.status_code == 200
    assert uploaded.json()["mime_type"] == "image/jpeg"


# ---------------------------------------------------------------------------
# NUC AI backfill
# ---------------------------------------------------------------------------


def test_push_backfills_ai_on_nuc_and_bumps_cursor(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )
    calls: list[tuple[str, str]] = []

    async def fake_enrich(
        title: str,
        content_text: str,
        existing_tags: list[str],
        settings: Settings,
        client: object = None,
    ) -> AIEnrichment:
        calls.append((title, content_text))
        return AIEnrichment(
            summary="NUC 摘要",
            key_points=["NUC 要点"],
            tags=["AI补充"],
        )

    monkeypatch.setattr("app.services.ingest.enrich_clip", fake_enrich)

    row = db.create_clip(
        raw_input="https://example.com/backfill",
        url="https://example.com/backfill",
        normalized_url="https://example.com/backfill",
        status="ready",
        title="待整理的文章",
        content_markdown="正文段落",
        content_text="正文段落",
        tags=["用户标签"],
        now=NOW,
    )
    clip_id = str(row["id"])
    version_before = int(db.get_clip(clip_id)["sync_version"])

    pushed = push(
        client,
        clip_payload(
            id=clip_id,
            title="待整理的文章",
            status="ready",
            ai_status="pending",
            content_markdown="正文段落",
            content_text="正文段落",
            tags=["用户标签"],
            updated_at=str(db.get_clip(clip_id)["updated_at"]),
        ),
    )

    assert pushed["accepted_ids"] == [clip_id]
    assert pushed["queued_ai_ids"] == [clip_id]
    # TestClient runs BackgroundTasks synchronously, so enrichment already ran
    assert calls == [("待整理的文章", "正文段落")]

    enriched = db.get_clip(clip_id)
    assert enriched["ai_status"] == "done"
    assert enriched["summary"] == "NUC 摘要"
    assert json.loads(enriched["key_points_json"]) == ["NUC 要点"]
    assert "AI补充" in db.get_clip_tags(clip_id)
    assert int(enriched["sync_version"]) > version_before

    # the phone sees the enrichment on its next incremental pull
    body = pull(client, since_version=version_before)
    assert [clip["id"] for clip in body["clips"]] == [clip_id]
    record = body["clips"][0]
    assert record["ai_status"] == "done"
    assert record["summary"] == "NUC 摘要"
    assert record["key_points"] == ["NUC 要点"]
    assert record["sync_version"] > version_before
    assert body["latest_version"] >= record["sync_version"]


def test_push_does_not_queue_ai_without_body_or_when_disabled(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def never_called(*args: object, **kwargs: object) -> None:
        raise AssertionError("nothing should be enriched")

    monkeypatch.setattr("app.services.ingest.enrich_clip", never_called)

    disabled, _, _ = client_for()
    assert push(disabled, clip_payload())["queued_ai_ids"] == []

    enabled, _, _ = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )
    empty = push(
        enabled,
        clip_payload(
            id="empty",
            title="",
            status="ready",
            content_markdown="",
            content_text="",
            ai_status="skipped",
        ),
    )
    assert empty["queued_ai_ids"] == []

    pending_status = push(
        enabled,
        clip_payload(
            id="still-pending",
            status="pending",
            ai_status="pending",
            content_markdown="",
            content_text="",
        ),
    )
    assert pending_status["queued_ai_ids"] == []


async def test_enrich_existing_clip_guards_and_never_raises(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, settings, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )

    async def boom(*args: object, **kwargs: object) -> dict[str, object]:
        raise RuntimeError("enrich exploded")

    monkeypatch.setattr("app.services.ingest._enrich", boom)

    ready = db.create_clip(
        raw_input="https://example.com/ready",
        status="ready",
        title="可整理",
        content_text="正文",
    )
    await enrich_existing_clip(str(ready["id"]), db, settings)  # must not raise
    assert db.get_clip(str(ready["id"]))["ai_status"] == "pending"

    # pending clips and tombstones are never touched
    pending = db.create_clip(raw_input="https://example.com/pending", status="pending")
    deleted = db.create_clip(
        raw_input="https://example.com/deleted", status="ready", content_text="正文"
    )
    db.update_clip(str(deleted["id"]), review_state="deleted")

    await enrich_existing_clip(str(pending["id"]), db, settings)
    await enrich_existing_clip(str(deleted["id"]), db, settings)
    await enrich_existing_clip("missing-clip", db, settings)

    assert db.get_clip(str(pending["id"]))["ai_status"] == "pending"
    assert db.get_clip(str(deleted["id"]))["ai_status"] == "pending"


async def test_enrich_existing_clip_marks_ai_failure_without_losing_body(
    client_for: ClientFor, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, settings, db = client_for(
        llm_base_url="https://llm.example.com/v1", llm_api_key="k"
    )

    async def failing_enrich(*args: object, **kwargs: object) -> object:
        raise RuntimeError("llm down")

    monkeypatch.setattr("app.services.ingest.enrich_clip", failing_enrich)

    ready = db.create_clip(
        raw_input="https://example.com/ready",
        status="ready",
        title="可整理",
        content_text="正文",
    )
    await enrich_existing_clip(str(ready["id"]), db, settings)

    stored = db.get_clip(str(ready["id"]))
    assert stored["ai_status"] == "failed"
    assert stored["content_text"] == "正文"


# ---------------------------------------------------------------------------
# review logs
# ---------------------------------------------------------------------------


def test_review_logs_are_deduped_and_require_existing_clips(client_for: ClientFor) -> None:
    client, _, db = client_for()
    push(client, clip_payload())
    log = {
        "clip_id": "clip-1",
        "action": "snooze",
        "reviewed_at": "2025-05-02T09:00:00+00:00",
    }

    push(client, logs=[log, dict(log)])
    assert review_logs_count(db) == 1

    push(client, logs=[{"clip_id": "ghost", "action": "snooze", "reviewed_at": log["reviewed_at"]}])
    assert review_logs_count(db) == 1

    body = pull(client, since_version=0)
    assert [(item["clip_id"], item["action"]) for item in body["review_logs"]] == [
        ("clip-1", "snooze")
    ]
    assert parse_iso(body["review_logs"][0]["reviewed_at"]) == parse_iso(log["reviewed_at"])


# ---------------------------------------------------------------------------
# pagination + cursor bookkeeping
# ---------------------------------------------------------------------------


def test_pull_paginates_by_increasing_version(client_for: ClientFor) -> None:
    client, _, db = client_for()
    for index in range(5):
        db.create_clip(
            raw_input=f"https://example.com/{index}",
            url=f"https://example.com/{index}",
            normalized_url=f"https://example.com/{index}",
            title=f"条目{index}",
            status="ready",
            content_text="正文",
        )

    first = pull(client, since_version=0, limit=2)
    assert len(first["clips"]) == 2
    assert first["has_more"] is True
    versions = [clip["sync_version"] for clip in first["clips"]]
    assert versions == sorted(versions)

    second = pull(client, since_version=versions[-1], limit=2)
    assert len(second["clips"]) == 2
    assert second["has_more"] is True
    assert second["clips"][0]["sync_version"] > versions[-1]

    third = pull(client, since_version=second["clips"][-1]["sync_version"], limit=2)
    assert len(third["clips"]) == 1
    assert third["has_more"] is False

    seen = [clip["id"] for clip in [*first["clips"], *second["clips"], *third["clips"]]]
    assert len(set(seen)) == 5
    assert {clip["id"] for clip in pull(client, limit=100)["clips"]} == set(db.iter_clip_ids())


def test_every_db_mutation_bumps_the_sync_cursor(tmp_path: Path) -> None:
    db = Database(tmp_path / "sync.db")
    try:
        start = db.current_sync_version()
        row = db.create_clip(title="初始", content_text="正文")
        clip_id = str(row["id"])
        after_create = db.current_sync_version()
        assert after_create > start
        assert int(db.get_clip(clip_id)["sync_version"]) == after_create

        db.update_clip(clip_id, title="改过")
        after_update = db.current_sync_version()
        assert after_update > after_create
        assert int(db.get_clip(clip_id)["sync_version"]) == after_update

        db.set_clip_tags(clip_id, ["标签"])
        after_tags = db.current_sync_version()
        assert after_tags > after_update
        assert int(db.get_clip(clip_id)["sync_version"]) == after_tags

        db.add_media(clip_id=clip_id, local_path="aa/aa.png", mime_type="image/png")
        after_media = db.current_sync_version()
        assert after_media > after_tags

        assert db.add_review_log_if_missing(
            clip_id, "snooze", "2025-05-01T00:00:00+00:00"
        )
        assert not db.add_review_log_if_missing(
            clip_id, "snooze", "2025-05-01T00:00:00+00:00"
        )
        assert not db.add_review_log_if_missing(
            "missing", "snooze", "2025-05-01T00:00:00+00:00"
        )

        db.update_clip(clip_id, review_state="deleted")
        rows, has_more = db.list_clips_since_version(0, limit=10)
        assert [str(item["id"]) for item in rows] == [clip_id]
        assert str(rows[0]["review_state"]) == "deleted"
        assert has_more is False

        rows, has_more = db.list_clips_since_version(
            int(db.get_clip(clip_id)["sync_version"]), limit=10
        )
        assert rows == []
        assert has_more is False
        assert db.current_sync_version() >= after_media
    finally:
        db.close()
