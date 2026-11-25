"""SQLite storage layer with FTS5 (trigram) + LIKE hybrid search.

The database keeps four relational tables (``clips``, ``media``, ``tags``,
``clip_tags``) plus the append-only ``review_logs`` table and a virtual
``clips_fts`` table used for full-text search.

Search strategy ("Chinese friendly"):

* ``len(q) >= 3`` -> FTS5 ``MATCH`` (trigram tokenizer, so Chinese substrings
  of three or more characters are matched directly).
* ``len(q) < 3``  -> ``LIKE '%q%'`` over the main text columns and tag names,
  because the trigram tokenizer cannot index one/two character queries
  (``AI``, ``保研``, ``微信`` ...).

Both paths are wrapped in a lock because FastAPI background tasks run in a
worker thread pool while ``sqlite3`` connections are shared.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.models import (
    AIStatus,
    ChatMessageItem,
    ChatRole,
    ClipDetail,
    ClipStatus,
    ClipSummary,
    MediaItem,
    Platform,
    ReviewState,
)

# Columns a sync payload may write through ``upsert_clip_from_sync`` (the id,
# created_at and updated_at are handled separately).
_SYNC_EXTRA_COLUMNS: frozenset[str] = frozenset({"id", "created_at", "updated_at"})

# Defaults used when a sync payload creates a brand new clip row.
_CLIP_INSERT_DEFAULTS: dict[str, Any] = {
    "raw_input": "",
    "url": "",
    "normalized_url": None,
    "platform": Platform.WEB.value,
    "status": ClipStatus.PENDING.value,
    "ai_status": AIStatus.PENDING.value,
    "error_message": None,
    "title": "",
    "author": "",
    "published_at": None,
    "content_markdown": "",
    "content_text": "",
    "cover_media_id": None,
    "summary": "",
    "key_points_json": "[]",
    "user_note": "",
    "review_state": ReviewState.ACTIVE.value,
    "review_count": 0,
    "review_interval_days": 0,
    "next_review_at": None,
    "last_reviewed_at": None,
}

# Columns that callers are allowed to patch through ``update_clip``.
CLIP_COLUMNS: frozenset[str] = frozenset(
    {
        "raw_input",
        "url",
        "normalized_url",
        "platform",
        "status",
        "ai_status",
        "error_message",
        "title",
        "author",
        "published_at",
        "content_markdown",
        "content_text",
        "cover_media_id",
        "summary",
        "key_points_json",
        "user_note",
        "review_state",
        "review_count",
        "review_interval_days",
        "next_review_at",
        "last_reviewed_at",
    }
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS clips (
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
    updated_at TEXT NOT NULL,
    sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_clips_normalized_url ON clips(normalized_url);
CREATE INDEX IF NOT EXISTS idx_clips_review ON clips(review_state, status, next_review_at);
CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at);

-- Monotonic sync cursor. ``seq`` is bumped by every clip mutation so mobile
-- clients can pull "everything newer than the last version they saw".
CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    original_url TEXT NOT NULL DEFAULT '',
    local_path TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_clip ON media(clip_id, sort_order);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS clip_tags (
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (clip_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_clip_tags_tag ON clip_tags(tag_id);

CREATE TABLE IF NOT EXISTS review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    reviewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_logs_time ON review_logs(reviewed_at);

CREATE TABLE IF NOT EXISTS clip_chat_messages (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_chat_clip_time
    ON clip_chat_messages(clip_id, created_at, id);

CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(
    clip_id UNINDEXED,
    title,
    summary,
    content_text,
    user_note,
    author,
    tags_text,
    tokenize='trigram'
);
"""


# ---------------------------------------------------------------------------
# time helpers
# ---------------------------------------------------------------------------


def utcnow() -> datetime:
    """Current time as an aware UTC datetime."""
    return datetime.now(tz=UTC)


def to_utc(value: datetime | None = None) -> datetime:
    """Normalise ``value`` to an aware UTC datetime (naive means UTC)."""
    if value is None:
        return utcnow()
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def to_iso(value: datetime | None = None) -> str:
    """ISO-8601 UTC timestamp with a stable, lexicographically sortable shape."""
    return to_utc(value).isoformat(timespec="microseconds")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return to_utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def day_prefix(value: datetime | None = None) -> str:
    """``YYYY-MM-DD`` prefix (UTC) used for "today" counters."""
    return to_utc(value).date().isoformat()


def days_from_now(days: int, now: datetime | None = None) -> str:
    return to_iso(to_utc(now) + timedelta(days=days))


# ---------------------------------------------------------------------------
# row -> model helpers
# ---------------------------------------------------------------------------


def _platform(value: Any) -> Platform:
    try:
        return Platform(str(value))
    except (ValueError, TypeError):
        return Platform.WEB


def _clip_status(value: Any) -> ClipStatus:
    try:
        return ClipStatus(str(value))
    except (ValueError, TypeError):
        return ClipStatus.PENDING


def _ai_status(value: Any) -> AIStatus:
    try:
        return AIStatus(str(value))
    except (ValueError, TypeError):
        return AIStatus.PENDING


def _review_state(value: Any) -> ReviewState:
    try:
        return ReviewState(str(value))
    except (ValueError, TypeError):
        return ReviewState.ACTIVE


def _chat_role(value: Any) -> ChatRole:
    try:
        return ChatRole(str(value))
    except (ValueError, TypeError):
        return ChatRole.USER


def _json_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if str(item).strip()]


def media_url(media_id: str | None) -> str | None:
    return f"/api/media/{media_id}" if media_id else None


def row_to_media_item(row: sqlite3.Row | dict[str, Any]) -> MediaItem:
    return MediaItem(
        id=str(row["id"]),
        clip_id=str(row["clip_id"]),
        original_url=str(row["original_url"] or ""),
        url=media_url(str(row["id"])) or "",
        mime_type=str(row["mime_type"] or ""),
        size_bytes=int(row["size_bytes"] or 0),
        sort_order=int(row["sort_order"] or 0),
    )


def row_to_chat_message(row: sqlite3.Row | dict[str, Any]) -> ChatMessageItem:
    return ChatMessageItem(
        id=str(row["id"]),
        clip_id=str(row["clip_id"]),
        role=_chat_role(row["role"]),
        content=str(row["content"] or ""),
        created_at=str(row["created_at"] or ""),
    )


def row_to_summary(
    row: sqlite3.Row | dict[str, Any],
    tags: Iterable[str] = (),
) -> ClipSummary:
    return ClipSummary(
        id=str(row["id"]),
        url=str(row["url"] or ""),
        platform=_platform(row["platform"]),
        status=_clip_status(row["status"]),
        ai_status=_ai_status(row["ai_status"]),
        error_message=row["error_message"],
        title=str(row["title"] or ""),
        author=str(row["author"] or ""),
        summary=str(row["summary"] or ""),
        cover_media_url=media_url(row["cover_media_id"]),
        tags=list(tags),
        review_state=_review_state(row["review_state"]),
        review_count=int(row["review_count"] or 0),
        next_review_at=row["next_review_at"],
        last_reviewed_at=row["last_reviewed_at"],
        created_at=str(row["created_at"] or ""),
        updated_at=str(row["updated_at"] or ""),
    )


def row_to_detail(
    row: sqlite3.Row | dict[str, Any],
    tags: Iterable[str] = (),
    media: Sequence[sqlite3.Row | dict[str, Any]] = (),
) -> ClipDetail:
    summary = row_to_summary(row, tags)
    return ClipDetail(
        **summary.model_dump(),
        raw_input=str(row["raw_input"] or ""),
        published_at=row["published_at"],
        content_markdown=str(row["content_markdown"] or ""),
        key_points=_json_list(row["key_points_json"]),
        user_note=str(row["user_note"] or ""),
        media=[row_to_media_item(item) for item in media],
    )


# ---------------------------------------------------------------------------
# small text helpers
# ---------------------------------------------------------------------------


def normalize_tag(name: str) -> str:
    return " ".join(str(name).split())[:40].strip()


def normalize_tags(names: Iterable[str]) -> list[str]:
    """Trim, drop empties and de-duplicate tags case-insensitively."""
    result: list[str] = []
    seen: set[str] = set()
    for raw in names:
        name = normalize_tag(raw)
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(name)
    return result


def merge_tags(existing: Iterable[str], extra: Iterable[str]) -> list[str]:
    return normalize_tags([*existing, *extra])


def fts_query(term: str) -> str:
    """Build a safe FTS5 phrase query from user input."""
    cleaned = " ".join(term.split())
    return '"' + cleaned.replace('"', '""') + '"'


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


class Database:
    """Thread-safe (coarse locked) SQLite wrapper with FTS5 hybrid search."""

    def __init__(self, db_path: str | Path) -> None:
        path = Path(db_path)
        if path.parent and str(path.parent) not in ("", "."):
            path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._closed = False
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.execute("PRAGMA synchronous = NORMAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
            self._migrate()

    def _migrate(self) -> None:
        """Idempotently upgrade databases created before incremental sync."""
        with self._lock:
            columns = {
                str(row["name"])
                for row in self._conn.execute("PRAGMA table_info(clips)").fetchall()
            }
            if "sync_version" not in columns:
                # Historic rows silently get sync_version = 1 so a phone that
                # has never synced can pull the whole library from version 0.
                self._conn.execute(
                    "ALTER TABLE clips ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1"
                )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_clips_sync_version "
                "ON clips(sync_version)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS sync_meta "
                "(key TEXT PRIMARY KEY, value INTEGER NOT NULL)"
            )
            self._conn.execute(
                "INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('seq', 1)"
            )
            # Chat history arrived after the first release: recreate it for
            # databases that were initialised before this table existed.
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS clip_chat_messages ("
                "id TEXT PRIMARY KEY, "
                "clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE, "
                "role TEXT NOT NULL, "
                "content TEXT NOT NULL, "
                "created_at TEXT NOT NULL)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_clip_chat_clip_time "
                "ON clip_chat_messages(clip_id, created_at, id)"
            )
            self._conn.commit()

    # -- plumbing ---------------------------------------------------------
    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._conn.commit()
            except sqlite3.Error:  # pragma: no cover - already broken
                pass
            finally:
                self._conn.close()

    def _fetchall(
        self, sql: str, params: Sequence[Any] = ()
    ) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._conn.execute(sql, tuple(params)).fetchall())

    def _fetchone(
        self, sql: str, params: Sequence[Any] = ()
    ) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchone()

    def _scalar(self, sql: str, params: Sequence[Any] = ()) -> Any:
        row = self._fetchone(sql, params)
        return None if row is None else row[0]

    def _write(self, sql: str, params: Sequence[Any] = ()) -> None:
        with self._lock:
            self._conn.execute(sql, tuple(params))
            self._conn.commit()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        """Run several statements atomically on the shared connection."""
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    # -- sync cursor ------------------------------------------------------
    def _next_seq_locked(self) -> int:
        """Bump ``sync_meta.seq`` and return the new value (inside a txn)."""
        self._conn.execute("UPDATE sync_meta SET value = value + 1 WHERE key = 'seq'")
        row = self._conn.execute(
            "SELECT value FROM sync_meta WHERE key = 'seq'"
        ).fetchone()
        if row is None:  # pragma: no cover - only if sync_meta was tampered with
            self._conn.execute(
                "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('seq', 1)"
            )
            return 1
        return int(row[0])

    def _touch_sync_locked(self, clip_id: str) -> int:
        """Stamp ``clips.sync_version`` with a freshly bumped seq (inside a txn)."""
        seq = self._next_seq_locked()
        self._conn.execute(
            "UPDATE clips SET sync_version = ? WHERE id = ?", (seq, clip_id)
        )
        return seq

    def current_sync_version(self) -> int:
        """Latest global sync cursor (monotonically increasing)."""
        value = self._scalar("SELECT value FROM sync_meta WHERE key = 'seq'")
        return int(value or 1)

    # -- clips ------------------------------------------------------------
    def create_clip(
        self,
        *,
        raw_input: str = "",
        url: str = "",
        normalized_url: str | None = None,
        platform: str | Platform = Platform.WEB.value,
        status: str | ClipStatus = ClipStatus.PENDING.value,
        ai_status: str | AIStatus = AIStatus.PENDING.value,
        title: str = "",
        author: str = "",
        published_at: str | None = None,
        content_markdown: str = "",
        content_text: str = "",
        summary: str = "",
        key_points: Iterable[str] = (),
        user_note: str = "",
        error_message: str | None = None,
        review_state: str | ReviewState = ReviewState.ACTIVE.value,
        tags: Iterable[str] = (),
        clip_id: str | None = None,
        now: datetime | None = None,
    ) -> sqlite3.Row:
        new_id = clip_id or uuid.uuid4().hex
        stamp = to_iso(now)
        row = {
            "id": new_id,
            "raw_input": raw_input or "",
            "url": url or "",
            "normalized_url": normalized_url,
            "platform": str(platform),
            "status": str(status),
            "ai_status": str(ai_status),
            "error_message": error_message,
            "title": title or "",
            "author": author or "",
            "published_at": published_at,
            "content_markdown": content_markdown or "",
            "content_text": content_text or "",
            "cover_media_id": None,
            "summary": summary or "",
            "key_points_json": json.dumps(list(key_points), ensure_ascii=False),
            "user_note": user_note or "",
            "review_state": str(review_state),
            "review_count": 0,
            "review_interval_days": 0,
            "next_review_at": None,
            "last_reviewed_at": None,
            "created_at": stamp,
            "updated_at": stamp,
        }
        with self._transaction() as conn:
            row["sync_version"] = self._next_seq_locked()
            columns = ", ".join(row)
            placeholders = ", ".join("?" for _ in row)
            conn.execute(
                f"INSERT INTO clips ({columns}) VALUES ({placeholders})",
                list(row.values()),
            )
        if tags:
            self.add_clip_tags(new_id, tags)
        self.sync_fts(new_id)
        created = self.get_clip(new_id)
        assert created is not None  # noqa: S101 - just inserted
        return created

    def get_clip(self, clip_id: str) -> sqlite3.Row | None:
        return self._fetchone("SELECT * FROM clips WHERE id = ?", (clip_id,))

    def require_clip(self, clip_id: str) -> sqlite3.Row:
        row = self.get_clip(clip_id)
        if row is None:
            raise KeyError(clip_id)
        return row

    def find_by_normalized_url(self, normalized_url: str | None) -> sqlite3.Row | None:
        if not normalized_url:
            return None
        return self._fetchone(
            "SELECT * FROM clips "
            "WHERE normalized_url = ? AND review_state != 'deleted' "
            "ORDER BY created_at DESC LIMIT 1",
            (normalized_url,),
        )

    def update_clip(
        self,
        clip_id: str,
        *,
        now: datetime | None = None,
        sync_fts: bool = True,
        **fields: Any,
    ) -> sqlite3.Row | None:
        unknown = set(fields) - CLIP_COLUMNS
        if unknown:
            raise ValueError(f"unknown clip columns: {sorted(unknown)}")
        if not fields:
            return self.get_clip(clip_id)
        params: list[Any] = [
            _coerce_column(column, value) for column, value in fields.items()
        ]
        params.append(to_iso(now))
        params.append(clip_id)
        sql = (
            "UPDATE clips SET "
            + ", ".join(f"{column} = ?" for column in fields)
            + ", updated_at = ? WHERE id = ?"
        )
        with self._transaction() as conn:
            conn.execute(sql, params)
            self._touch_sync_locked(clip_id)
        if sync_fts:
            self.sync_fts(clip_id)
        return self.get_clip(clip_id)

    # -- incremental sync -------------------------------------------------
    def list_clips_since_version(
        self, since_version: int = 0, limit: int = 100
    ) -> tuple[list[sqlite3.Row], bool]:
        """Clips changed after ``since_version``, ordered for stable paging.

        Soft-deleted rows (``review_state = 'deleted'``) are included on purpose:
        they are the tombstones the client needs to delete locally.
        """
        since = max(0, int(since_version or 0))
        size = max(1, min(int(limit or 100), 500))
        rows = self._fetchall(
            "SELECT * FROM clips WHERE sync_version > ? "
            "ORDER BY sync_version ASC, id ASC LIMIT ?",
            (since, size + 1),
        )
        has_more = len(rows) > size
        return rows[:size], has_more

    def upsert_clip_from_sync(
        self,
        fields: Mapping[str, Any],
        *,
        tags: Iterable[str] | None = None,
        media: Sequence[Mapping[str, Any]] | None = None,
        now: datetime | None = None,
    ) -> sqlite3.Row:
        """Insert or update a clip coming from the mobile client.

        ``fields`` holds already merged clip columns (the caller owns LWW and AI
        protection). Tags are replaced when ``tags`` is given; media rows are
        upserted (never deleted) when ``media`` is given.
        """
        clip_id = str(fields.get("id") or "").strip()
        if not clip_id:
            raise ValueError("upsert_clip_from_sync requires a non-empty id")
        unknown = set(fields) - CLIP_COLUMNS - _SYNC_EXTRA_COLUMNS
        if unknown:
            raise ValueError(f"unknown clip columns: {sorted(unknown)}")

        stamp = to_iso(now)
        columns = {
            column: _coerce_column(column, value)
            for column, value in fields.items()
            if column in CLIP_COLUMNS
        }
        created_at = str(fields.get("created_at") or "") or stamp
        updated_at = str(fields.get("updated_at") or "") or stamp

        with self._transaction() as conn:
            exists = (
                conn.execute("SELECT 1 FROM clips WHERE id = ?", (clip_id,)).fetchone()
                is not None
            )
            seq = self._next_seq_locked()
            if exists:
                values = {**columns, "sync_version": seq, "updated_at": updated_at}
                assignments = ", ".join(f"{column} = ?" for column in values)
                conn.execute(
                    f"UPDATE clips SET {assignments} WHERE id = ?",
                    (*values.values(), clip_id),
                )
            else:
                row = {
                    **_CLIP_INSERT_DEFAULTS,
                    **columns,
                    "id": clip_id,
                    "created_at": created_at,
                    "updated_at": updated_at,
                    "sync_version": seq,
                }
                conn.execute(
                    "INSERT INTO clips ("
                    + ", ".join(row)
                    + ") VALUES ("
                    + ", ".join("?" for _ in row)
                    + ")",
                    list(row.values()),
                )
            if tags is not None:
                conn.execute("DELETE FROM clip_tags WHERE clip_id = ?", (clip_id,))
                self._add_tag_rows_locked(clip_id, normalize_tags(tags))
            if media is not None:
                self._upsert_media_locked(clip_id, media, stamp)

        self.sync_fts(clip_id)
        row = self.get_clip(clip_id)
        assert row is not None  # noqa: S101 - just inserted/updated
        return row

    def add_review_log_if_missing(
        self, clip_id: str, action: str, reviewed_at: str | None = None
    ) -> bool:
        """Insert a review log once; returns ``False`` for duplicates/unknown clips."""
        stamp = reviewed_at or to_iso()
        with self._transaction() as conn:
            if conn.execute("SELECT 1 FROM clips WHERE id = ?", (clip_id,)).fetchone() is None:
                return False
            duplicate = conn.execute(
                "SELECT 1 FROM review_logs "
                "WHERE clip_id = ? AND action = ? AND reviewed_at = ?",
                (clip_id, str(action), stamp),
            ).fetchone()
            if duplicate is not None:
                return False
            conn.execute(
                "INSERT INTO review_logs (clip_id, action, reviewed_at) VALUES (?, ?, ?)",
                (clip_id, str(action), stamp),
            )
            # let other devices pull the new log with the clip record
            self._touch_sync_locked(clip_id)
        return True

    def list_review_logs_for_clips(
        self, clip_ids: Sequence[str]
    ) -> list[sqlite3.Row]:
        ids = [str(clip_id) for clip_id in clip_ids if clip_id]
        if not ids:
            return []
        placeholders = ", ".join("?" for _ in ids)
        return self._fetchall(
            "SELECT id, clip_id, action, reviewed_at FROM review_logs "
            f"WHERE clip_id IN ({placeholders}) "
            "ORDER BY reviewed_at ASC, id ASC",
            ids,
        )

    def hard_delete_clip(self, clip_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM clips_fts WHERE clip_id = ?", (clip_id,))
            self._conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
            self._conn.commit()

    def iter_clip_ids(self, *, include_deleted: bool = False) -> list[str]:
        sql = "SELECT id FROM clips"
        if not include_deleted:
            sql += " WHERE review_state != 'deleted'"
        return [str(row["id"]) for row in self._fetchall(sql)]

    # -- listing / search -------------------------------------------------
    def list_clips(
        self,
        *,
        q: str | None = None,
        platform: str | None = None,
        tag: str | None = None,
        review_state: str | None = None,
        status: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[sqlite3.Row], int]:
        where, params = self._filters(
            platform=platform,
            tag=tag,
            review_state=review_state,
            status=status,
        )
        limit = max(1, min(int(limit), 100))
        offset = max(0, int(offset))
        term = (q or "").strip()
        if term:
            if len(term) >= 3:
                fts_where = [
                    *where,
                    "c.id IN (SELECT clip_id FROM clips_fts WHERE clips_fts MATCH ?)",
                ]
                try:
                    return self._run_list(
                        fts_where, [*params, fts_query(term)], limit, offset
                    )
                except sqlite3.OperationalError:
                    pass
            like_where, like_params = self._like_filters(where, params, term)
            return self._run_list(like_where, like_params, limit, offset)
        return self._run_list(where, params, limit, offset)

    def _run_list(
        self,
        where: list[str],
        params: list[Any],
        limit: int,
        offset: int,
    ) -> tuple[list[sqlite3.Row], int]:
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(
            self._scalar(f"SELECT COUNT(*) FROM clips c{where_sql}", params) or 0
        )
        rows = self._fetchall(
            "SELECT c.* FROM clips c"
            f"{where_sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        )
        return rows, total

    def _filters(
        self,
        *,
        platform: str | None,
        tag: str | None,
        review_state: str | None,
        status: str | None,
    ) -> tuple[list[str], list[Any]]:
        where: list[str] = []
        params: list[Any] = []
        if review_state is None:
            where.append("c.review_state != 'deleted'")
        elif str(review_state).lower() != "all":
            where.append("c.review_state = ?")
            params.append(str(review_state))
        if platform:
            where.append("c.platform = ?")
            params.append(str(platform))
        if status:
            where.append("c.status = ?")
            params.append(str(status))
        if tag:
            where.append(
                "EXISTS (SELECT 1 FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id "
                "WHERE ct.clip_id = c.id AND t.name = ? COLLATE NOCASE)"
            )
            params.append(normalize_tag(tag))
        return where, params

    def _like_filters(
        self,
        where: list[str],
        params: list[Any],
        term: str,
    ) -> tuple[list[str], list[Any]]:
        pattern = f"%{term}%"
        clause = (
            "(c.title LIKE ? OR c.summary LIKE ? OR c.content_text LIKE ? "
            "OR c.user_note LIKE ? OR c.author LIKE ? "
            "OR EXISTS (SELECT 1 FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id "
            "WHERE ct.clip_id = c.id AND t.name LIKE ?))"
        )
        return [*where, clause], [*params, *([pattern] * 6)]

    # -- review queue -----------------------------------------------------
    _ACTIVE_DECK = "c.review_state = 'active' AND c.status IN ('ready', 'partial')"

    def _exclude_clause(self, exclude_ids: Sequence[str]) -> tuple[str, list[Any]]:
        ids = [str(item) for item in exclude_ids if item]
        if not ids:
            return "", []
        placeholders = ", ".join("?" for _ in ids)
        return f" AND c.id NOT IN ({placeholders})", ids

    def pick_due_cards(
        self,
        now_iso: str,
        limit: int,
        exclude_ids: Sequence[str] = (),
    ) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        extra, extra_params = self._exclude_clause(exclude_ids)
        return self._fetchall(
            "SELECT c.* FROM clips c "
            f"WHERE {self._ACTIVE_DECK} AND c.review_count > 0 "
            "AND c.next_review_at IS NOT NULL AND c.next_review_at <= ?"
            f"{extra} ORDER BY c.next_review_at ASC, c.created_at ASC LIMIT ?",
            [now_iso, *extra_params, limit],
        )

    def pick_new_cards(
        self,
        limit: int,
        exclude_ids: Sequence[str] = (),
    ) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        extra, extra_params = self._exclude_clause(exclude_ids)
        return self._fetchall(
            "SELECT c.* FROM clips c "
            f"WHERE {self._ACTIVE_DECK} AND c.review_count = 0"
            f"{extra} ORDER BY c.created_at DESC, c.id DESC LIMIT ?",
            [*extra_params, limit],
        )

    def pick_stale_cards(
        self,
        limit: int,
        exclude_ids: Sequence[str] = (),
    ) -> list[sqlite3.Row]:
        if limit <= 0:
            return []
        extra, extra_params = self._exclude_clause(exclude_ids)
        return self._fetchall(
            "SELECT c.* FROM clips c "
            f"WHERE {self._ACTIVE_DECK}{extra} "
            "ORDER BY COALESCE(c.last_reviewed_at, c.created_at) ASC, c.id ASC "
            "LIMIT ?",
            [*extra_params, limit],
        )

    def count_active_deck(self) -> int:
        return int(
            self._scalar(f"SELECT COUNT(*) FROM clips c WHERE {self._ACTIVE_DECK}")
            or 0
        )

    def count_reviews_on(self, day: str) -> int:
        return int(
            self._scalar(
                "SELECT COUNT(*) FROM review_logs WHERE reviewed_at LIKE ?",
                (f"{day}%",),
            )
            or 0
        )

    def add_review_log(
        self,
        clip_id: str,
        action: str,
        reviewed_at: str | None = None,
    ) -> None:
        self._write(
            "INSERT INTO review_logs (clip_id, action, reviewed_at) VALUES (?, ?, ?)",
            (clip_id, str(action), reviewed_at or to_iso()),
        )

    # -- article chat -----------------------------------------------------
    def list_chat_messages(
        self, clip_id: str, limit: int = 100
    ) -> list[sqlite3.Row]:
        """Newest ``limit`` messages for a clip, returned oldest-first."""
        size = max(1, int(limit or 100))
        rows = self._fetchall(
            "SELECT * FROM clip_chat_messages WHERE clip_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (clip_id, size),
        )
        rows.reverse()
        return rows

    def add_chat_message(
        self,
        clip_id: str,
        role: str | ChatRole,
        content: str,
        *,
        message_id: str | None = None,
        now: datetime | None = None,
    ) -> sqlite3.Row:
        new_id = message_id or uuid.uuid4().hex
        with self._lock:
            self._conn.execute(
                "INSERT INTO clip_chat_messages "
                "(id, clip_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (new_id, clip_id, str(role), content or "", to_iso(now)),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM clip_chat_messages WHERE id = ?", (new_id,)
            ).fetchone()
        if row is None:  # pragma: no cover - only if the insert vanished
            raise KeyError(new_id)
        return row

    def clear_chat_messages(self, clip_id: str) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM clip_chat_messages WHERE clip_id = ?", (clip_id,)
            )
            self._conn.commit()
            return int(cursor.rowcount or 0)

    def count_chat_messages(self, clip_id: str) -> int:
        return int(
            self._scalar(
                "SELECT COUNT(*) FROM clip_chat_messages WHERE clip_id = ?",
                (clip_id,),
            )
            or 0
        )

    # -- media ------------------------------------------------------------
    def add_media(
        self,
        *,
        clip_id: str,
        local_path: str,
        original_url: str = "",
        media_id: str | None = None,
        mime_type: str = "",
        size_bytes: int = 0,
        sha256: str = "",
        sort_order: int = 0,
        now: datetime | None = None,
    ) -> str:
        new_id = media_id or uuid.uuid4().hex
        with self._transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO media "
                "(id, clip_id, original_url, local_path, mime_type, size_bytes, sha256, "
                "sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    new_id,
                    clip_id,
                    original_url or "",
                    str(local_path),
                    mime_type or "",
                    int(size_bytes or 0),
                    sha256 or "",
                    int(sort_order or 0),
                    to_iso(now),
                ),
            )
            self._touch_sync_locked(clip_id)
        return new_id

    def _upsert_media_locked(
        self,
        clip_id: str,
        items: Sequence[Mapping[str, Any]],
        stamp: str,
    ) -> None:
        for index, item in enumerate(items):
            media_id = str(item.get("id") or uuid.uuid4().hex)
            self._conn.execute(
                "INSERT OR REPLACE INTO media "
                "(id, clip_id, original_url, local_path, mime_type, size_bytes, sha256, "
                "sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    media_id,
                    clip_id,
                    str(item.get("original_url") or ""),
                    str(item.get("local_path") or ""),
                    str(item.get("mime_type") or ""),
                    int(item.get("size_bytes") or 0),
                    str(item.get("sha256") or ""),
                    int(item.get("sort_order", index) or 0),
                    str(item.get("created_at") or stamp),
                ),
            )

    def get_media(self, media_id: str) -> sqlite3.Row | None:
        return self._fetchone("SELECT * FROM media WHERE id = ?", (media_id,))

    def list_media(self, clip_id: str) -> list[sqlite3.Row]:
        return self._fetchall(
            "SELECT * FROM media WHERE clip_id = ? ORDER BY sort_order ASC, id ASC",
            (clip_id,),
        )

    def replace_media(self, clip_id: str, items: Sequence[dict[str, Any]]) -> list[str]:
        """Replace all media rows for ``clip_id`` (used after re-extraction)."""
        ids: list[str] = []
        normalized: list[dict[str, Any]] = []
        for item in items:
            media_id = str(item.get("id") or uuid.uuid4().hex)
            ids.append(media_id)
            normalized.append({**item, "id": media_id})
        stamp = to_iso()
        with self._transaction() as conn:
            conn.execute("DELETE FROM media WHERE clip_id = ?", (clip_id,))
            self._upsert_media_locked(clip_id, normalized, stamp)
            self._touch_sync_locked(clip_id)
        return ids

    def delete_media_rows(self, clip_id: str) -> None:
        with self._transaction() as conn:
            conn.execute("DELETE FROM media WHERE clip_id = ?", (clip_id,))
            self._touch_sync_locked(clip_id)

    def count_media_references(
        self, local_path: str, *, exclude_clip_id: str | None = None
    ) -> int:
        if exclude_clip_id is None:
            return int(
                self._scalar(
                    "SELECT COUNT(*) FROM media WHERE local_path = ?",
                    (local_path,),
                )
                or 0
            )
        return int(
            self._scalar(
                "SELECT COUNT(*) FROM media WHERE local_path = ? AND clip_id != ?",
                (local_path, exclude_clip_id),
            )
            or 0
        )

    # -- tags -------------------------------------------------------------
    def _add_tag_rows_locked(self, clip_id: str, names: Sequence[str]) -> None:
        """Attach tag names to a clip (inside a txn); the bump is the caller's job."""
        for name in names:
            row = self._conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()
            if row is None:
                cursor = self._conn.execute("INSERT INTO tags (name) VALUES (?)", (name,))
                tag_id = int(cursor.lastrowid or 0)
            else:
                tag_id = int(row["id"])
            self._conn.execute(
                "INSERT OR IGNORE INTO clip_tags (clip_id, tag_id) VALUES (?, ?)",
                (clip_id, tag_id),
            )

    def add_clip_tags(self, clip_id: str, tags: Iterable[str]) -> list[str]:
        names = normalize_tags(tags)
        if not names:
            return self.get_clip_tags(clip_id)
        with self._transaction():
            self._add_tag_rows_locked(clip_id, names)
            self._touch_sync_locked(clip_id)
        self.sync_fts(clip_id)
        return self.get_clip_tags(clip_id)

    def set_clip_tags(self, clip_id: str, tags: Iterable[str]) -> list[str]:
        names = normalize_tags(tags)
        with self._transaction() as conn:
            conn.execute("DELETE FROM clip_tags WHERE clip_id = ?", (clip_id,))
            self._add_tag_rows_locked(clip_id, names)
            self._touch_sync_locked(clip_id)
        self.sync_fts(clip_id)
        return self.get_clip_tags(clip_id)

    def get_clip_tags(self, clip_id: str) -> list[str]:
        rows = self._fetchall(
            "SELECT t.name AS name FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id "
            "WHERE ct.clip_id = ? ORDER BY t.name COLLATE NOCASE ASC",
            (clip_id,),
        )
        return [str(row["name"]) for row in rows]

    def get_tags_map(self, clip_ids: Sequence[str]) -> dict[str, list[str]]:
        ids = [str(item) for item in clip_ids]
        mapping: dict[str, list[str]] = {clip_id: [] for clip_id in ids}
        if not ids:
            return mapping
        placeholders = ", ".join("?" for _ in ids)
        rows = self._fetchall(
            "SELECT ct.clip_id AS clip_id, t.name AS name "
            f"FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id "
            f"WHERE ct.clip_id IN ({placeholders}) "
            "ORDER BY t.name COLLATE NOCASE ASC",
            ids,
        )
        for row in rows:
            mapping.setdefault(str(row["clip_id"]), []).append(str(row["name"]))
        return mapping

    def list_tags(self, *, include_deleted: bool = False) -> list[tuple[str, int]]:
        state_clause = "" if include_deleted else " WHERE c.review_state != 'deleted'"
        rows = self._fetchall(
            "SELECT t.name AS name, COUNT(ct.clip_id) AS count "
            "FROM tags t JOIN clip_tags ct ON ct.tag_id = t.id "
            f"JOIN clips c ON c.id = ct.clip_id{state_clause} "
            "GROUP BY t.id, t.name ORDER BY count DESC, t.name COLLATE NOCASE ASC"
        )
        return [(str(row["name"]), int(row["count"])) for row in rows]

    # -- FTS --------------------------------------------------------------
    def sync_fts(self, clip_id: str) -> None:
        row = self.get_clip(clip_id)
        with self._lock:
            self._conn.execute("DELETE FROM clips_fts WHERE clip_id = ?", (clip_id,))
            if row is not None:
                tags_text = " ".join(self.get_clip_tags(clip_id))
                self._conn.execute(
                    "INSERT INTO clips_fts "
                    "(clip_id, title, summary, content_text, user_note, author, tags_text) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        clip_id,
                        str(row["title"] or ""),
                        str(row["summary"] or ""),
                        str(row["content_text"] or ""),
                        str(row["user_note"] or ""),
                        str(row["author"] or ""),
                        tags_text,
                    ),
                )
            self._conn.commit()

    def reindex_fts(self) -> int:
        with self._lock:
            self._conn.execute("DELETE FROM clips_fts")
            self._conn.commit()
        clip_ids = self.iter_clip_ids(include_deleted=True)
        for clip_id in clip_ids:
            self.sync_fts(clip_id)
        return len(clip_ids)


def _coerce_column(column: str, value: Any) -> Any:
    if column == "key_points_json":
        if isinstance(value, str):
            return value
        return json.dumps(list(value or []), ensure_ascii=False)
    if column in {"review_count", "review_interval_days"}:
        return int(value or 0)
    if column in {"status", "ai_status", "review_state", "platform"}:
        return str(value)
    return value
