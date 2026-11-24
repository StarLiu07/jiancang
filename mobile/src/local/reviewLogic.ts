/**
 * Pure spaced-repetition helpers shared by the local SQLite layer and tests.
 *
 * This module mirrors ``backend/app/services/review.py`` and the tag helpers in
 * ``backend/app/db.py`` one-to-one, but deliberately has **no** dependency on
 * `expo-sqlite`, React Native or any other native module so it can be executed
 * directly by Node's built-in test runner.
 *
 * Timestamps follow the backend canonical shape:
 * ``YYYY-MM-DDTHH:MM:SS.ffffff+00:00`` (always UTC, always microseconds).
 */

import type { ReviewActionType, ReviewState } from '../types';

export const DEFAULT_SNOOZE_INTERVALS = [3, 7, 14, 30, 60] as const;

const MICROS_PER_SECOND = 1_000_000;
const MICROS_PER_DAY = 86_400 * MICROS_PER_SECOND;
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

const REVIEW_STATES: readonly ReviewState[] = ['active', 'archived', 'deleted'];
const REVIEW_ACTIONS: readonly ReviewActionType[] = ['snooze', 'archive', 'delete'];

export interface ReviewTransitionSource {
  review_count?: number;
  reviewCount?: number;
  review_state?: ReviewState;
  reviewState?: ReviewState;
  review_interval_days?: number;
  reviewIntervalDays?: number;
  next_review_at?: string | null;
  nextReviewAt?: string | null;
}

export interface ReviewTransition {
  review_state: ReviewState;
  review_count: number;
  review_interval_days: number;
  next_review_at: string | null;
  last_reviewed_at: string;
}

export interface ReviewDeckCard {
  id: string;
}

// ---------------------------------------------------------------------------
// timestamp helpers
// ---------------------------------------------------------------------------

function pad(value: number, length: number): string {
  return String(Math.abs(Math.trunc(value))).padStart(length, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseOffsetMicros(offset: string | undefined): number {
  if (!offset || offset === 'Z' || offset === 'z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!match) throw new Error(`Invalid ISO timestamp offset: ${offset}`);
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) {
    throw new Error(`Invalid ISO timestamp offset: ${offset}`);
  }
  return sign * (hours * 60 + minutes) * 60 * MICROS_PER_SECOND;
}

/**
 * Parse an ISO-8601 timestamp into epoch microseconds (UTC).
 *
 * Naive timestamps are treated as UTC, matching ``app.db.to_utc``. Fractional
 * seconds keep microsecond precision so round-tripping a backend timestamp is
 * lossless.
 */
function parseIsoMicros(value: string): number {
  const text = String(value ?? '').trim();
  const match = ISO_PATTERN.exec(text);
  if (!match) throw new Error(`Invalid ISO timestamp: ${value}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] === undefined ? '' : match[7];

  if (month < 1 || month > 12) throw new Error(`Invalid ISO timestamp: ${value}`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }

  const fractionMicros = Number((fraction + '000000').slice(0, 6));
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utcMillis)) throw new Error(`Invalid ISO timestamp: ${value}`);

  return utcMillis * 1000 + fractionMicros - parseOffsetMicros(match[8]);
}

function formatMicros(micros: number): string {
  const wholeMicros = Math.trunc(micros);
  const totalSeconds = Math.floor(wholeMicros / MICROS_PER_SECOND);
  const fractionMicros = wholeMicros - totalSeconds * MICROS_PER_SECOND;
  const date = new Date(totalSeconds * 1000);

  const year = pad(date.getUTCFullYear(), 4);
  const month = pad(date.getUTCMonth() + 1, 2);
  const day = pad(date.getUTCDate(), 2);
  const hour = pad(date.getUTCHours(), 2);
  const minute = pad(date.getUTCMinutes(), 2);
  const second = pad(date.getUTCSeconds(), 2);
  const fraction = pad(fractionMicros, 6);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction}+00:00`;
}

/** Normalise any ISO timestamp / epoch-millisecond value to the canonical UTC shape. */
export function toIsoUtc(value: string | number | Date): string {
  if (typeof value === 'string') return formatMicros(parseIsoMicros(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid timestamp: ${value}`);
    return formatMicros(Math.round(value * 1000));
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) throw new Error('Invalid Date');
    return formatMicros(millis * 1000);
  }
  throw new Error(`Invalid timestamp: ${String(value)}`);
}

/** Current time in the backend canonical UTC shape. */
export function nowIso(): string {
  return formatMicros(Date.now() * 1000);
}

/** Add whole days to an ISO timestamp, returning the canonical UTC shape. */
export function addDaysIso(nowIsoValue: string, days: number): string {
  if (!Number.isFinite(days)) throw new Error(`Invalid day offset: ${days}`);
  return formatMicros(parseIsoMicros(nowIsoValue) + Math.round(days * MICROS_PER_DAY));
}

/** ``YYYY-MM-DD`` UTC day prefix used for "reviewed today" counters. */
export function utcDayPrefix(isoValue: string): string {
  const micros = parseIsoMicros(isoValue);
  const totalSeconds = Math.floor(micros / MICROS_PER_SECOND);
  const date = new Date(totalSeconds * 1000);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

// ---------------------------------------------------------------------------
// spaced repetition
// ---------------------------------------------------------------------------

function normalizeIntervals(intervals?: readonly number[]): readonly number[] {
  const cleaned = (intervals ?? DEFAULT_SNOOZE_INTERVALS)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  return cleaned.length ? cleaned : DEFAULT_SNOOZE_INTERVALS;
}

function asCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function asReviewState(value: unknown): ReviewState {
  return REVIEW_STATES.includes(value as ReviewState) ? (value as ReviewState) : 'active';
}

/**
 * Pick the snooze interval for the next review.
 *
 * Mirrors ``review._snooze_days``: an explicit positive request wins,
 * otherwise the interval is indexed by the *new* review count (capped at the
 * last schedule entry).
 */
export function computeSnoozeDays(
  reviewCount: number,
  requestedDays?: number,
  intervals?: readonly number[],
): number {
  const requested = Number(requestedDays);
  if (Number.isFinite(requested) && requested > 0) return Math.trunc(requested);

  const schedule = normalizeIntervals(intervals);
  const count = asCount(reviewCount);
  const index = Math.min(Math.max(count, 1) - 1, schedule.length - 1);
  return schedule[index];
}

/**
 * Compute the mutated review fields for a single action.
 *
 * - ``snooze`` increments ``review_count``, reschedules and resurrects a
 *   soft-deleted card;
 * - ``archive`` / ``delete`` only change the state (the existing schedule is
 *   preserved, exactly like the backend).
 */
export function computeReviewTransition(
  clip: ReviewTransitionSource,
  action: ReviewActionType,
  nowIsoValue: string,
  requestedSnoozeDays?: number,
  intervals?: readonly number[],
): ReviewTransition {
  if (!REVIEW_ACTIONS.includes(action)) {
    throw new Error(`Unknown review action: ${String(action)}`);
  }

  const stamp = toIsoUtc(nowIsoValue);
  const currentCount = asCount(clip.review_count ?? clip.reviewCount);
  const currentState = asReviewState(clip.review_state ?? clip.reviewState);
  const currentInterval = asCount(clip.review_interval_days ?? clip.reviewIntervalDays);
  const currentNext = clip.next_review_at ?? clip.nextReviewAt ?? null;

  if (action === 'snooze') {
    const reviewCount = currentCount + 1;
    const interval = computeSnoozeDays(reviewCount, requestedSnoozeDays, intervals);
    return {
      review_state: currentState === 'deleted' ? 'active' : currentState,
      review_count: reviewCount,
      review_interval_days: interval,
      next_review_at: addDaysIso(stamp, interval),
      last_reviewed_at: stamp,
    };
  }

  return {
    review_state: action === 'archive' ? 'archived' : 'deleted',
    review_count: currentCount,
    review_interval_days: currentInterval,
    next_review_at: currentNext,
    last_reviewed_at: stamp,
  };
}

/**
 * Mix the due / fresh / stale pools into one de-duplicated daily deck.
 *
 * Quotas mirror the backend: at most half of the deck comes from due cards,
 * at most half from fresh cards, and stale cards fill the remaining quota.
 * If one pool is short the deck stays smaller rather than exceeding the
 * requested limit.
 */
export function composeReviewDeck<T extends ReviewDeckCard>(
  dueCards: readonly T[] = [],
  newCards: readonly T[] = [],
  staleCards: readonly T[] = [],
  limit = 5,
): T[] {
  const numericLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
  const daily = Math.max(1, numericLimit);
  const half = Math.max(1, Math.floor(daily / 2));

  const picked: T[] = [];
  const seen = new Set<string>();

  const take = (pool: readonly T[], quota: number): void => {
    let taken = 0;
    for (const card of pool) {
      if (picked.length >= daily || taken >= quota) break;
      if (!card || typeof card.id !== 'string' || !card.id || seen.has(card.id)) continue;
      seen.add(card.id);
      picked.push(card);
      taken += 1;
    }
  };

  take(dueCards, half);
  take(newCards, half);
  take(staleCards, daily);

  return picked;
}

// ---------------------------------------------------------------------------
// tags (mirrors app.db.normalize_tag / normalize_tags / merge_tags)
// ---------------------------------------------------------------------------

/** Collapse internal whitespace, trim and truncate to 40 code points. */
export function normalizeTag(name: string): string {
  const collapsed = String(name ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ');
  return Array.from(collapsed).slice(0, 40).join('').trim();
}

/** Normalise, drop empties and de-duplicate tags case-insensitively. */
export function normalizeTags(names: Iterable<string> | null | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of names ?? []) {
    const name = normalizeTag(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

/** ``existing`` first, then ``extra``; duplicates keep the first spelling. */
export function mergeTags(
  existing: Iterable<string> | null | undefined,
  extra: Iterable<string> | null | undefined,
): string[] {
  return normalizeTags([...(existing ?? []), ...(extra ?? [])]);
}

export type { ReviewActionType, ReviewState };
