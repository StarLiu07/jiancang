"""Daily review deck + spaced-repetition actions.

Deck composition (no duplicates, quota aware):

1. **Due** cards - ``review_count > 0`` and ``next_review_at <= now``,
   oldest ``next_review_at`` first, capped at ``max(1, limit // 2)``.
2. **Fresh** cards - ``review_count == 0``, newest ``created_at`` first,
   capped at ``max(1, limit // 2)``.
3. **Stale / random walk** - oldest ``COALESCE(last_reviewed_at, created_at)``
   first, fills the remaining quota so "forgotten" saves resurface.

Only ``review_state = 'active'`` cards whose ``status`` is ``ready``/``partial``
are eligible.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

from app.config import Settings
from app.db import (
    Database,
    day_prefix,
    days_from_now,
    row_to_detail,
    row_to_summary,
    to_iso,
    to_utc,
)
from app.models import (
    ClipDetail,
    ReviewAction,
    ReviewActionRequest,
    ReviewActionResponse,
    ReviewState,
    ReviewTodayResponse,
)

DEFAULT_SNOOZE_INTERVALS: tuple[int, ...] = (3, 7, 14, 30, 60)


class ClipNotFoundError(LookupError):
    """Raised when a review action targets a missing clip."""


def _detail(db: Database, row: sqlite3.Row) -> ClipDetail:
    clip_id = str(row["id"])
    return row_to_detail(row, db.get_clip_tags(clip_id), db.list_media(clip_id))


def _snooze_days(
    settings: Settings,
    review_count: int,
    requested: int | None,
) -> int:
    if requested and requested > 0:
        return int(requested)
    intervals = settings.snooze_intervals or list(DEFAULT_SNOOZE_INTERVALS)
    index = min(max(review_count, 1) - 1, len(intervals) - 1)
    return int(intervals[index])


def get_today_review_deck(
    db: Database,
    settings: Settings,
    limit: int | None = None,
    now: datetime | None = None,
) -> ReviewTodayResponse:
    """Build today's mixed review deck."""
    daily = int(limit if limit is not None else settings.daily_review_limit)
    daily = max(1, daily)
    now_dt = to_utc(now)
    now_iso = to_iso(now_dt)

    half = max(1, daily // 2)
    picked: list[sqlite3.Row] = []
    seen: set[str] = set()

    def take(rows: list[sqlite3.Row], quota: int) -> None:
        for row in rows:
            if len(picked) >= daily or quota <= 0:
                break
            clip_id = str(row["id"])
            if clip_id in seen:
                continue
            seen.add(clip_id)
            picked.append(row)
            quota -= 1

    take(db.pick_due_cards(now_iso, min(half, daily)), daily)
    take(db.pick_new_cards(half, sorted(seen)), daily - len(picked))
    take(db.pick_stale_cards(daily - len(picked), sorted(seen)), daily - len(picked))

    return ReviewTodayResponse(
        items=[_detail(db, row) for row in picked],
        reviewed_today=db.count_reviews_on(day_prefix(now_dt)),
        daily_target=daily,
        total_active=db.count_active_deck(),
    )


def apply_review_action(
    db: Database,
    settings: Settings,
    clip_id: str,
    req: ReviewActionRequest,
    now: datetime | None = None,
) -> ReviewActionResponse:
    """Record a review action and reschedule the card."""
    row = db.get_clip(clip_id)
    if row is None:
        raise ClipNotFoundError(clip_id)

    now_dt = to_utc(now)
    stamp = to_iso(now_dt)
    action = ReviewAction(str(req.action))
    fields: dict[str, object] = {"last_reviewed_at": stamp}

    if action is ReviewAction.SNOOZE:
        review_count = int(row["review_count"] or 0) + 1
        interval = _snooze_days(settings, review_count, req.snooze_days)
        fields["review_count"] = review_count
        fields["review_interval_days"] = interval
        fields["next_review_at"] = days_from_now(interval, now_dt)
        if str(row["review_state"]) == ReviewState.DELETED.value:
            fields["review_state"] = ReviewState.ACTIVE.value
    elif action is ReviewAction.ARCHIVE:
        fields["review_state"] = ReviewState.ARCHIVED.value
    else:  # DELETE
        fields["review_state"] = ReviewState.DELETED.value

    updated = db.update_clip(clip_id, now=now_dt, **fields)
    if updated is None:  # pragma: no cover - deleted between read and write
        raise ClipNotFoundError(clip_id)
    db.add_review_log(clip_id, action.value, stamp)

    return ReviewActionResponse(
        clip=row_to_summary(updated, db.get_clip_tags(clip_id)),
        reviewed_today=db.count_reviews_on(day_prefix(now_dt)),
        daily_target=max(1, int(settings.daily_review_limit)),
    )


__all__ = [
    "ClipNotFoundError",
    "apply_review_action",
    "get_today_review_deck",
]
