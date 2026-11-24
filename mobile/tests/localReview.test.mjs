import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SNOOZE_INTERVALS,
  addDaysIso,
  composeReviewDeck,
  computeReviewTransition,
  computeSnoozeDays,
  mergeTags,
  normalizeTag,
  normalizeTags,
  utcDayPrefix,
} from '../src/local/reviewLogic.ts';

const NOW = '2025-05-20T12:00:00.000000+00:00';

function cards(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
}

// ---------------------------------------------------------------------------
// snooze schedule
// ---------------------------------------------------------------------------

test('default snooze schedule matches the backend constant', () => {
  assert.deepEqual([...DEFAULT_SNOOZE_INTERVALS], [3, 7, 14, 30, 60]);
});

test('computeSnoozeDays walks the default intervals and caps at the last one', () => {
  assert.equal(computeSnoozeDays(0), 3);
  assert.equal(computeSnoozeDays(1), 3);
  assert.equal(computeSnoozeDays(2), 7);
  assert.equal(computeSnoozeDays(3), 14);
  assert.equal(computeSnoozeDays(4), 30);
  assert.equal(computeSnoozeDays(5), 60);
  assert.equal(computeSnoozeDays(9), 60);
  assert.equal(computeSnoozeDays(-4), 3);
});

test('computeSnoozeDays lets an explicit positive request win', () => {
  assert.equal(computeSnoozeDays(1, 11), 11);
  assert.equal(computeSnoozeDays(6, 2), 2);
  assert.equal(computeSnoozeDays(1, 0), 3);
  assert.equal(computeSnoozeDays(1, -5), 3);
});

test('computeSnoozeDays honours custom schedules and empty-schedule fallback', () => {
  assert.equal(computeSnoozeDays(1, undefined, [1, 2]), 1);
  assert.equal(computeSnoozeDays(2, undefined, [1, 2]), 2);
  assert.equal(computeSnoozeDays(9, undefined, [1, 2]), 2);
  assert.equal(computeSnoozeDays(2, undefined, []), 7);
  assert.equal(computeSnoozeDays(2, undefined, [0, -1]), 7);
});

// ---------------------------------------------------------------------------
// time helpers
// ---------------------------------------------------------------------------

test('addDaysIso adds UTC days and keeps the canonical microsecond shape', () => {
  assert.equal(addDaysIso(NOW, 3), '2025-05-23T12:00:00.000000+00:00');
  assert.equal(addDaysIso('2025-05-20T12:00:00Z', 0), NOW);
  assert.equal(addDaysIso('2025-01-31T08:30:00+00:00', 1), '2025-02-01T08:30:00.000000+00:00');
  assert.equal(addDaysIso('2024-02-28T23:30:00+00:00', 2), '2024-03-01T23:30:00.000000+00:00');
  assert.equal(addDaysIso('2025-05-20T12:00:00.123456+00:00', 1), '2025-05-21T12:00:00.123456+00:00');
});

test('utcDayPrefix normalises offsets and treats naive timestamps as UTC', () => {
  assert.equal(utcDayPrefix(NOW), '2025-05-20');
  assert.equal(utcDayPrefix('2025-05-20T23:30:00+08:00'), '2025-05-20');
  assert.equal(utcDayPrefix('2025-05-20T23:30:00-05:00'), '2025-05-21');
  assert.equal(utcDayPrefix('2025-05-20T00:15:00'), '2025-05-20');
  assert.equal(utcDayPrefix('2025-05-20'), '2025-05-20');
  assert.throws(() => utcDayPrefix('not-a-date'));
  assert.throws(() => utcDayPrefix('2025-02-30T00:00:00+00:00'));
});

// ---------------------------------------------------------------------------
// review transitions
// ---------------------------------------------------------------------------

test('snooze increments review_count and follows 3/7/14/30/60 day gaps', () => {
  let clip = { review_count: 0, review_state: 'active' };

  const first = computeReviewTransition(clip, 'snooze', NOW);
  assert.deepEqual(first, {
    review_state: 'active',
    review_count: 1,
    review_interval_days: 3,
    next_review_at: '2025-05-23T12:00:00.000000+00:00',
    last_reviewed_at: NOW,
  });

  clip = { ...clip, ...first };
  const second = computeReviewTransition(clip, 'snooze', '2025-05-23T12:00:00.000000+00:00');
  assert.equal(second.review_count, 2);
  assert.equal(second.review_interval_days, 7);
  assert.equal(second.next_review_at, '2025-05-30T12:00:00.000000+00:00');

  clip = { ...clip, ...second };
  const third = computeReviewTransition(clip, 'snooze', '2025-05-30T12:00:00.000000+00:00');
  assert.equal(third.review_interval_days, 14);

  clip = { ...clip, ...third };
  const fourth = computeReviewTransition(clip, 'snooze', '2025-06-13T12:00:00.000000+00:00');
  assert.equal(fourth.review_interval_days, 30);

  clip = { ...clip, ...fourth };
  const fifth = computeReviewTransition(clip, 'snooze', '2025-07-13T12:00:00.000000+00:00');
  assert.equal(fifth.review_interval_days, 60);

  clip = { ...clip, ...fifth };
  const sixth = computeReviewTransition(clip, 'snooze', '2025-09-11T12:00:00.000000+00:00');
  assert.equal(sixth.review_interval_days, 60);
});

test('snooze supports explicit days and custom intervals', () => {
  const custom = computeReviewTransition({ review_count: 2, review_state: 'active' }, 'snooze', NOW, 11);
  assert.equal(custom.review_count, 3);
  assert.equal(custom.review_interval_days, 11);
  assert.equal(custom.next_review_at, '2025-05-31T12:00:00.000000+00:00');

  const schedule = computeReviewTransition(
    { review_count: 1, review_state: 'active' },
    'snooze',
    NOW,
    undefined,
    [1, 5],
  );
  assert.equal(schedule.review_interval_days, 5);
  assert.equal(schedule.next_review_at, '2025-05-25T12:00:00.000000+00:00');
});

test('archive and delete preserve the existing review schedule', () => {
  const source = {
    review_count: 4,
    review_state: 'active',
    review_interval_days: 30,
    next_review_at: '2025-06-19T12:00:00.000000+00:00',
  };

  const archived = computeReviewTransition(source, 'archive', NOW);
  assert.deepEqual(archived, {
    review_state: 'archived',
    review_count: 4,
    review_interval_days: 30,
    next_review_at: '2025-06-19T12:00:00.000000+00:00',
    last_reviewed_at: NOW,
  });

  const deleted = computeReviewTransition(source, 'delete', NOW);
  assert.deepEqual(deleted, {
    review_state: 'deleted',
    review_count: 4,
    review_interval_days: 30,
    next_review_at: '2025-06-19T12:00:00.000000+00:00',
    last_reviewed_at: NOW,
  });
});

test('snoozing a deleted card resurrects it as active', () => {
  const revived = computeReviewTransition(
    { review_count: 3, review_state: 'deleted', review_interval_days: 14, next_review_at: null },
    'snooze',
    NOW,
  );

  assert.equal(revived.review_state, 'active');
  assert.equal(revived.review_count, 4);
  assert.equal(revived.review_interval_days, 30);
  assert.equal(revived.next_review_at, '2025-06-19T12:00:00.000000+00:00');
});

test('snoozing an archived card keeps it archived but reschedules it', () => {
  const transition = computeReviewTransition(
    { review_count: 1, review_state: 'archived' },
    'snooze',
    NOW,
  );
  assert.equal(transition.review_state, 'archived');
  assert.equal(transition.review_count, 2);
  assert.equal(transition.review_interval_days, 7);
});

test('camelCase-shaped cards are accepted for compatibility', () => {
  const transition = computeReviewTransition(
    { reviewCount: 2, reviewState: 'deleted', reviewIntervalDays: 7, nextReviewAt: null },
    'snooze',
    NOW,
  );
  assert.equal(transition.review_state, 'active');
  assert.equal(transition.review_count, 3);
});

test('unknown review actions are rejected', () => {
  assert.throws(() => computeReviewTransition({ review_count: 0, review_state: 'active' }, 'explode', NOW));
});

// ---------------------------------------------------------------------------
// deck composition
// ---------------------------------------------------------------------------

test('limit 4 fills exactly half due and half fresh cards', () => {
  const deck = composeReviewDeck(cards('due', 5), cards('new', 5), cards('stale', 5), 4);
  assert.deepEqual(
    deck.map((card) => card.id),
    ['due0', 'due1', 'new0', 'new1'],
  );
});

test('limit 5 uses stale cards for the leftover quota', () => {
  const deck = composeReviewDeck(cards('due', 5), cards('new', 5), cards('stale', 5), 5);
  assert.deepEqual(
    deck.map((card) => card.id),
    ['due0', 'due1', 'new0', 'new1', 'stale0'],
  );
});

test('a short due pool leaves room for stale cards instead of overfilling fresh', () => {
  const deck = composeReviewDeck(cards('due', 1), cards('new', 5), cards('stale', 4), 5);
  assert.deepEqual(
    deck.map((card) => card.id),
    ['due0', 'new0', 'new1', 'stale0', 'stale1'],
  );
});

test('deck composition is globally de-duplicated by id and keeps first occurrence', () => {
  const due = [{ id: 'a' }, { id: 'a' }];
  const fresh = [{ id: 'a' }, { id: 'c' }];
  const stale = [{ id: 'c' }, { id: 'd' }];

  const deck = composeReviewDeck(due, fresh, stale, 3);
  assert.deepEqual(
    deck.map((card) => card.id),
    ['a', 'c', 'd'],
  );
  assert.equal(new Set(deck.map((card) => card.id)).size, deck.length);
});

test('due and fresh pools are capped at half even when they have more entries', () => {
  const deck = composeReviewDeck(cards('due', 9), cards('new', 9), [], 6);
  assert.deepEqual(
    deck.map((card) => card.id),
    ['due0', 'due1', 'due2', 'new0', 'new1', 'new2'],
  );
});

test('limit 1 and non-positive limits still produce a one-card deck', () => {
  assert.deepEqual(
    composeReviewDeck(cards('due', 3), cards('new', 3), cards('stale', 3), 1).map((card) => card.id),
    ['due0'],
  );
  assert.deepEqual(
    composeReviewDeck(cards('due', 3), cards('new', 3), cards('stale', 3), 0).map((card) => card.id),
    ['due0'],
  );
  assert.deepEqual(composeReviewDeck([], [], [], 5), []);
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

test('normalizeTag collapses whitespace, trims and truncates at 40 code points', () => {
  assert.equal(normalizeTag('  hello   world  '), 'hello world');
  assert.equal(normalizeTag('\t中文\n标签 '), '中文 标签');
  assert.equal(normalizeTag('a'.repeat(45)), 'a'.repeat(40));
  assert.equal(normalizeTag('a'.repeat(39) + ' b'), 'a'.repeat(39));
  assert.equal(normalizeTag(''), '');
  assert.equal(normalizeTag('   '), '');
  assert.equal(Array.from(normalizeTag('😀'.repeat(45))).length, 40);
});

test('normalizeTags de-duplicates case-insensitively and keeps the first casing', () => {
  assert.deepEqual(
    normalizeTags(['  React ', 'react', 'JS', '', 'js  ', '中文   标签', '中文 标签']),
    ['React', 'JS', '中文 标签'],
  );
  assert.deepEqual(normalizeTags([]), []);
});

test('mergeTags unions without mutating the inputs', () => {
  const existing = ['A', 'b'];
  const extra = ['b', 'C', 'c'];
  assert.deepEqual(mergeTags(existing, extra), ['A', 'b', 'C']);
  assert.deepEqual(existing, ['A', 'b']);
  assert.deepEqual(extra, ['b', 'C', 'c']);
});
