"""Tests for the daily review deck and spaced-repetition actions."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.config import Settings
from app.db import Database, day_prefix, parse_iso, to_iso
from app.models import ReviewAction, ReviewActionRequest, ReviewState
from app.services.review import (
    ClipNotFoundError,
    apply_review_action,
    get_today_review_deck,
)

NOW = datetime(2025, 5, 20, 12, 0, 0, tzinfo=UTC)


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = Database(tmp_path / "review.db")
    try:
        yield database
    finally:
        database.close()


@pytest.fixture
def settings(test_settings: Settings) -> Settings:
    return test_settings.model_copy(update={"daily_review_limit": 5})


def add_card(
    db: Database,
    title: str,
    *,
    status: str = "ready",
    state: str = "active",
    review_count: int = 0,
    next_review_at: datetime | None = None,
    last_reviewed_at: datetime | None = None,
    created_at: datetime = NOW,
) -> str:
    row = db.create_clip(
        raw_input=f"raw {title}",
        url=f"https://example.com/{title}",
        normalized_url=f"https://example.com/{title}",
        status=status,
        title=title,
        content_text=f"正文 {title}",
        now=created_at,
    )
    clip_id = str(row["id"])
    fields: dict[str, object] = {"review_count": review_count, "review_state": state}
    if next_review_at is not None:
        fields["next_review_at"] = to_iso(next_review_at)
    if last_reviewed_at is not None:
        fields["last_reviewed_at"] = to_iso(last_reviewed_at)
    db.update_clip(clip_id, now=created_at, **fields)
    return clip_id


def titles(response_items: list[object]) -> list[str]:
    return [item.title for item in response_items]  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# deck composition
# ---------------------------------------------------------------------------


def test_deck_mixes_due_and_new_cards(db: Database, settings: Settings) -> None:
    due_titles = []
    for index in range(5):
        # next_review_at grows with index -> index 0 is the most overdue
        title = f"到期{index}"
        due_titles.append(title)
        add_card(
            db,
            title,
            review_count=index + 1,
            next_review_at=NOW - timedelta(days=5 - index),
            last_reviewed_at=NOW - timedelta(days=10),
            created_at=NOW - timedelta(days=20),
        )

    new_titles = []
    for index in range(5):
        title = f"新卡{index}"
        new_titles.append(title)
        add_card(db, title, created_at=NOW - timedelta(days=index))

    deck = get_today_review_deck(db, settings, limit=4, now=NOW)

    assert len(deck.items) == 4
    # 2 most overdue + 2 freshest new cards
    assert titles(deck.items) == ["到期0", "到期1", "新卡0", "新卡1"]
    assert deck.daily_target == 4
    assert deck.total_active == 10
    assert deck.reviewed_today == 0
    assert len({item.id for item in deck.items}) == 4


def test_deck_default_limit_uses_half_quotas(db: Database, settings: Settings) -> None:
    for index in range(4):
        add_card(
            db,
            f"到期{index}",
            review_count=1,
            next_review_at=NOW - timedelta(days=4 - index),
            last_reviewed_at=NOW - timedelta(days=9),
            created_at=NOW - timedelta(days=30),
        )
    for index in range(4):
        add_card(db, f"新卡{index}", created_at=NOW - timedelta(days=index))
    add_card(
        db,
        "遗忘",
        review_count=3,
        next_review_at=NOW + timedelta(days=10),
        last_reviewed_at=NOW - timedelta(days=120),
        created_at=NOW - timedelta(days=200),
    )

    deck = get_today_review_deck(db, settings, now=NOW)

    assert deck.daily_target == 5
    assert len(deck.items) == 5
    # 2 due + 2 new + 1 stale fill (the forgotten card, not yet due)
    assert titles(deck.items)[:4] == ["到期0", "到期1", "新卡0", "新卡1"]
    assert deck.items[4].title == "遗忘"


def test_deck_fills_with_oldest_stale_cards(db: Database, settings: Settings) -> None:
    add_card(
        db,
        "仅到期",
        review_count=2,
        next_review_at=NOW - timedelta(hours=1),
        last_reviewed_at=NOW - timedelta(days=3),
        created_at=NOW - timedelta(days=10),
    )
    add_card(db, "新卡", created_at=NOW - timedelta(minutes=5))
    add_card(
        db,
        "最老",
        review_count=1,
        next_review_at=NOW + timedelta(days=30),
        last_reviewed_at=NOW - timedelta(days=400),
        created_at=NOW - timedelta(days=500),
    )
    add_card(
        db,
        "次老",
        review_count=1,
        next_review_at=NOW + timedelta(days=30),
        last_reviewed_at=NOW - timedelta(days=200),
        created_at=NOW - timedelta(days=300),
    )

    deck = get_today_review_deck(db, settings, limit=4, now=NOW)

    assert len(deck.items) == 4
    assert titles(deck.items) == ["仅到期", "新卡", "最老", "次老"]


def test_deck_excludes_inactive_and_unfinished_clips(
    db: Database, settings: Settings
) -> None:
    add_card(db, "可用", status="ready")
    add_card(db, "部分可用", status="partial")
    add_card(db, "未就绪", status="pending")
    add_card(db, "抓取失败", status="failed")
    add_card(db, "已归档", state=ReviewState.ARCHIVED.value)
    add_card(db, "已删除", state=ReviewState.DELETED.value)

    deck = get_today_review_deck(db, settings, now=NOW)

    assert sorted(titles(deck.items)) == ["可用", "部分可用"]
    assert deck.total_active == 2


# ---------------------------------------------------------------------------
# actions
# ---------------------------------------------------------------------------


def test_snooze_intervals_grow_through_schedule(
    db: Database, settings: Settings
) -> None:
    clip_id = add_card(db, "间隔重复")
    now = NOW

    expected = [3, 7, 14]
    for round_index, days in enumerate(expected, start=1):
        response = apply_review_action(
            db,
            settings,
            clip_id,
            ReviewActionRequest(action=ReviewAction.SNOOZE),
            now=now,
        )
        assert response.clip.review_count == round_index
        # each round happens on a different simulated day -> one log per day
        assert response.reviewed_today == 1
        assert response.clip.review_state is ReviewState.ACTIVE
        next_at = parse_iso(response.clip.next_review_at)
        assert next_at is not None
        assert next_at == now + timedelta(days=days)
        assert parse_iso(response.clip.last_reviewed_at) == now
        assert db.get_clip(clip_id)["review_interval_days"] == days
        now = now + timedelta(days=days)

    assert db.count_reviews_on(day_prefix(NOW)) == 1
    assert db.count_reviews_on(day_prefix(NOW + timedelta(days=3))) == 1
    assert db.count_reviews_on(day_prefix(NOW + timedelta(days=10))) == 1


def test_snooze_uses_explicit_days(db: Database, settings: Settings) -> None:
    clip_id = add_card(db, "自定义间隔")

    response = apply_review_action(
        db,
        settings,
        clip_id,
        ReviewActionRequest(action=ReviewAction.SNOOZE, snooze_days=11),
        now=NOW,
    )

    assert parse_iso(response.clip.next_review_at) == NOW + timedelta(days=11)
    assert db.get_clip(clip_id)["review_interval_days"] == 11


def test_archive_and_delete_transitions(db: Database, settings: Settings) -> None:
    archived_id = add_card(db, "归档我")
    deleted_id = add_card(db, "删掉我")

    archived = apply_review_action(
        db,
        settings,
        archived_id,
        ReviewActionRequest(action=ReviewAction.ARCHIVE),
        now=NOW,
    )
    assert archived.clip.review_state is ReviewState.ARCHIVED
    assert parse_iso(archived.clip.last_reviewed_at) == NOW
    assert archived.clip.next_review_at is None
    assert archived.reviewed_today == 1

    deleted = apply_review_action(
        db,
        settings,
        deleted_id,
        ReviewActionRequest(action=ReviewAction.DELETE),
        now=NOW,
    )
    assert deleted.clip.review_state is ReviewState.DELETED
    assert deleted.reviewed_today == 2

    deck = get_today_review_deck(db, settings, now=NOW)
    assert deck.items == []
    assert deck.total_active == 0
    assert deck.reviewed_today == 2


def test_reviewed_today_counts_only_the_current_day(
    db: Database, settings: Settings
) -> None:
    clip_id = add_card(db, "今日进度")
    yesterday = datetime(2025, 5, 19, 9, 0, 0, tzinfo=UTC)
    db.add_review_log(clip_id, "snooze", to_iso(yesterday))
    db.add_review_log(clip_id, "snooze", to_iso(NOW - timedelta(hours=2)))

    deck = get_today_review_deck(db, settings, now=NOW)
    assert deck.reviewed_today == 1

    response = apply_review_action(
        db,
        settings,
        clip_id,
        ReviewActionRequest(action=ReviewAction.SNOOZE),
        now=NOW,
    )
    assert response.reviewed_today == 2
    assert db.count_reviews_on("2025-05-19") == 1


def test_action_on_missing_clip_raises(db: Database, settings: Settings) -> None:
    with pytest.raises(ClipNotFoundError):
        apply_review_action(
            db,
            settings,
            "does-not-exist",
            ReviewActionRequest(action=ReviewAction.ARCHIVE),
            now=NOW,
        )
    assert db.count_reviews_on(day_prefix(NOW)) == 0
