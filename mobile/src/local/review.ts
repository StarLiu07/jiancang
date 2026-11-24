/**
 * Local review engine: combines the pure scheduling helpers in
 * `reviewLogic.ts` with the offline SQLite store in `db.ts`.
 *
 * These functions are the offline equivalents of:
 *   GET  /api/review/today
 *   POST /api/review/{clip_id}/action
 */

import type {
  ClipSummary,
  ReviewActionInput,
  ReviewActionResponse,
  ReviewTodayResponse,
} from '../types';
import {
  addReviewLog,
  countActiveDeck,
  countReviewsOn,
  getClip,
  pickDueCards,
  pickNewCards,
  pickStaleCards,
  updateClip,
} from './db';
import {
  composeReviewDeck,
  computeReviewTransition,
  nowIso,
  utcDayPrefix,
} from './reviewLogic';

export const DEFAULT_DAILY_REVIEW_LIMIT = 5;

export class ClipNotFoundError extends Error {
  readonly clipId: string;

  constructor(clipId: string) {
    super(`Clip not found: ${clipId}`);
    this.name = 'ClipNotFoundError';
    this.clipId = clipId;
    Object.setPrototypeOf(this, ClipNotFoundError.prototype);
  }
}

function normalizeDailyLimit(limit: number): number {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric)) return DEFAULT_DAILY_REVIEW_LIMIT;
  return Math.max(1, Math.floor(numeric));
}

/** Build today's mixed due/new/stale deck entirely from local data. */
export async function getTodayReviewDeckLocal(
  limit = DEFAULT_DAILY_REVIEW_LIMIT,
): Promise<ReviewTodayResponse> {
  const daily = normalizeDailyLimit(limit);
  const half = Math.max(1, Math.floor(daily / 2));
  const stamp = nowIso();

  // Individual pools are capped exactly like the backend queries: due and new
  // cards can each contribute at most half of the deck, then stale cards fill
  // any remaining quota.
  const due = await pickDueCards(stamp, half);
  const seenAfterDue = due.map((clip) => clip.id);
  const fresh = await pickNewCards(half, seenAfterDue);
  const seenAfterFresh = [...seenAfterDue, ...fresh.map((clip) => clip.id)];
  const stale = await pickStaleCards(daily, seenAfterFresh);

  const items = composeReviewDeck(due, fresh, stale, daily);

  const [reviewedToday, totalActive] = await Promise.all([
    countReviewsOn(utcDayPrefix(stamp)),
    countActiveDeck(),
  ]);

  return {
    items,
    reviewed_today: reviewedToday,
    daily_target: daily,
    total_active: totalActive,
  };
}

/** Apply a snooze/archive/delete action and persist the review log offline. */
export async function applyReviewActionLocal(
  clipId: string,
  input: ReviewActionInput,
): Promise<ReviewActionResponse> {
  const clip = await getClip(clipId);
  if (!clip) throw new ClipNotFoundError(clipId);

  const stamp = nowIso();
  const transition = computeReviewTransition(
    clip,
    input.action,
    stamp,
    input.snooze_days,
  );

  const updated = await updateClip(clipId, transition, {
    markDirty: true,
    updatedAt: stamp,
  });
  if (!updated) throw new ClipNotFoundError(clipId);

  await addReviewLog(clipId, input.action, stamp);
  const reviewedToday = await countReviewsOn(utcDayPrefix(stamp));

  const summary: ClipSummary = updated;
  return {
    clip: summary,
    reviewed_today: reviewedToday,
    daily_target: DEFAULT_DAILY_REVIEW_LIMIT,
  };
}
