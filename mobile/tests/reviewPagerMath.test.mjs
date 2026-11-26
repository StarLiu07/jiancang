import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPagerHint,
  clampPageIndex,
  computeAfterRemoveIndex,
  resolvePageIndexFromOffset,
} from '../src/components/reviewPagerMath.ts';

// ---------------------------------------------------------------------------
// clampPageIndex
// ---------------------------------------------------------------------------

test('clampPageIndex keeps in-range indexes untouched', () => {
  assert.equal(clampPageIndex(0, 5), 0);
  assert.equal(clampPageIndex(2, 5), 2);
  assert.equal(clampPageIndex(4, 5), 4);
  assert.equal(clampPageIndex(0, 1), 0);
});

test('clampPageIndex clamps negative and oversized indexes into the deck', () => {
  assert.equal(clampPageIndex(-1, 5), 0);
  assert.equal(clampPageIndex(-40, 5), 0);
  assert.equal(clampPageIndex(5, 5), 4);
  assert.equal(clampPageIndex(99, 5), 4);
  assert.equal(clampPageIndex(1, 1), 0);
});

test('clampPageIndex truncates fractional indexes toward zero first', () => {
  assert.equal(clampPageIndex(2.9, 5), 2);
  assert.equal(clampPageIndex(2.1, 5), 2);
  assert.equal(clampPageIndex(0.7, 5), 0);
  assert.equal(clampPageIndex(-0.5, 5), 0);
  assert.equal(clampPageIndex(4.99, 5), 4);
});

test('clampPageIndex floors a fractional count before clamping', () => {
  assert.equal(clampPageIndex(9, 2.7), 1);
  assert.equal(clampPageIndex(1, 2.7), 1);
  assert.equal(clampPageIndex(1, 0.5), 0);
});

test('clampPageIndex collapses unusable counts to page 0', () => {
  assert.equal(clampPageIndex(0, 0), 0);
  assert.equal(clampPageIndex(3, 0), 0);
  assert.equal(clampPageIndex(2, -4), 0);
  assert.equal(clampPageIndex(2, Number.NaN), 0);
  assert.equal(clampPageIndex(2, Number.POSITIVE_INFINITY), 0);
  assert.equal(clampPageIndex(2, Number.NEGATIVE_INFINITY), 0);
});

test('clampPageIndex collapses non-finite indexes to page 0', () => {
  assert.equal(clampPageIndex(Number.NaN, 5), 0);
  assert.equal(clampPageIndex(Number.POSITIVE_INFINITY, 5), 0);
  assert.equal(clampPageIndex(Number.NEGATIVE_INFINITY, 5), 0);
});

// ---------------------------------------------------------------------------
// resolvePageIndexFromOffset
// ---------------------------------------------------------------------------

test('resolvePageIndexFromOffset maps exact page boundaries', () => {
  const height = 600;
  assert.equal(resolvePageIndexFromOffset(0, height, 5), 0);
  assert.equal(resolvePageIndexFromOffset(600, height, 5), 1);
  assert.equal(resolvePageIndexFromOffset(1200, height, 5), 2);
  assert.equal(resolvePageIndexFromOffset(2400, height, 5), 4);
});

test('resolvePageIndexFromOffset snaps at 50%, not before', () => {
  const height = 400;
  assert.equal(resolvePageIndexFromOffset(height * 0.49, height, 5), 0);
  assert.equal(resolvePageIndexFromOffset(height * 0.49 + 0.1, height, 5), 0);
  assert.equal(resolvePageIndexFromOffset(height * 0.5, height, 5), 1);
  assert.equal(resolvePageIndexFromOffset(height * 0.51, height, 5), 1);
  assert.equal(resolvePageIndexFromOffset(height * 1.49, height, 5), 1);
  assert.equal(resolvePageIndexFromOffset(height * 1.51, height, 5), 2);
});

test('resolvePageIndexFromOffset clamps rubber-band offsets into range', () => {
  assert.equal(resolvePageIndexFromOffset(-320, 600, 5), 0);
  assert.equal(resolvePageIndexFromOffset(-1, 600, 5), 0);
  assert.equal(resolvePageIndexFromOffset(9000, 600, 5), 4);
});

test('resolvePageIndexFromOffset rejects unusable page heights', () => {
  assert.equal(resolvePageIndexFromOffset(600, 0, 5), 0);
  assert.equal(resolvePageIndexFromOffset(600, -1, 5), 0);
  assert.equal(resolvePageIndexFromOffset(600, Number.NaN, 5), 0);
  assert.equal(resolvePageIndexFromOffset(600, Number.POSITIVE_INFINITY, 5), 0);
  assert.equal(resolvePageIndexFromOffset(600, Number.NEGATIVE_INFINITY, 5), 0);
});

test('resolvePageIndexFromOffset rejects unusable counts', () => {
  assert.equal(resolvePageIndexFromOffset(600, 600, 0), 0);
  assert.equal(resolvePageIndexFromOffset(600, 600, -3), 0);
  assert.equal(resolvePageIndexFromOffset(600, 600, Number.NaN), 0);
  assert.equal(resolvePageIndexFromOffset(600, 600, Number.POSITIVE_INFINITY), 0);
});

test('resolvePageIndexFromOffset rejects non-finite offsets', () => {
  assert.equal(resolvePageIndexFromOffset(Number.NaN, 600, 5), 0);
  assert.equal(resolvePageIndexFromOffset(Number.POSITIVE_INFINITY, 600, 5), 0);
  assert.equal(resolvePageIndexFromOffset(Number.NEGATIVE_INFINITY, 600, 5), 0);
});

test('resolvePageIndexFromOffset floors a fractional count', () => {
  // 3 usable pages out of count 3.8 -> last reachable index 2.
  assert.equal(resolvePageIndexFromOffset(600, 600, 3.8), 1);
  assert.equal(resolvePageIndexFromOffset(1800, 600, 3.8), 2);
});

// ---------------------------------------------------------------------------
// computeAfterRemoveIndex
// ---------------------------------------------------------------------------

test('computeAfterRemoveIndex keeps the same slot when the current leaf is removed', () => {
  assert.equal(computeAfterRemoveIndex(2, 2, 5), 2);
  assert.equal(computeAfterRemoveIndex(0, 0, 5), 0);
  assert.equal(computeAfterRemoveIndex(1, 1, 3), 1);
});

test('computeAfterRemoveIndex shifts up when a leaf above the current one is removed', () => {
  assert.equal(computeAfterRemoveIndex(3, 1, 5), 2);
  assert.equal(computeAfterRemoveIndex(4, 0, 5), 3);
  assert.equal(computeAfterRemoveIndex(1, 0, 2), 0);
});

test('computeAfterRemoveIndex stays put when a leaf below the current one is removed', () => {
  assert.equal(computeAfterRemoveIndex(1, 3, 5), 1);
  assert.equal(computeAfterRemoveIndex(0, 4, 5), 0);
  assert.equal(computeAfterRemoveIndex(2, 4, 5), 2);
});

test('computeAfterRemoveIndex walks back when the last current leaf is removed', () => {
  assert.equal(computeAfterRemoveIndex(4, 4, 5), 3);
  assert.equal(computeAfterRemoveIndex(2, 2, 3), 1);
  assert.equal(computeAfterRemoveIndex(1, 1, 2), 0);
});

test('computeAfterRemoveIndex empties a single-leaf or empty batch to 0', () => {
  assert.equal(computeAfterRemoveIndex(0, 0, 1), 0);
  assert.equal(computeAfterRemoveIndex(0, 0, 0), 0);
  assert.equal(computeAfterRemoveIndex(3, 2, 0), 0);
  assert.equal(computeAfterRemoveIndex(3, 2, -1), 0);
});

test('computeAfterRemoveIndex normalizes out-of-range and fractional input', () => {
  assert.equal(computeAfterRemoveIndex(9, 9, 5), 3);
  assert.equal(computeAfterRemoveIndex(-3, 2, 5), 0);
  assert.equal(computeAfterRemoveIndex(4, 99, 5), 3);
  assert.equal(computeAfterRemoveIndex(1, 1, 2.8), 0);
  assert.equal(computeAfterRemoveIndex(2.9, 2.1, 5), 2);
});

test('computeAfterRemoveIndex falls back to 0 for non-finite input', () => {
  assert.equal(computeAfterRemoveIndex(Number.NaN, 1, 5), 0);
  assert.equal(computeAfterRemoveIndex(2, Number.NaN, 5), 1);
  assert.equal(computeAfterRemoveIndex(2, 2, Number.NaN), 0);
  assert.equal(computeAfterRemoveIndex(2, 2, Number.POSITIVE_INFINITY), 0);
  assert.equal(computeAfterRemoveIndex(2, 2, Number.NEGATIVE_INFINITY), 0);
  assert.equal(computeAfterRemoveIndex(Number.POSITIVE_INFINITY, 2, 5), 0);
});

test('computeAfterRemoveIndex never exceeds the post-removal deck', () => {
  for (let total = 1; total <= 6; total += 1) {
    for (let current = 0; current < total; current += 1) {
      for (let removed = 0; removed < total; removed += 1) {
        const next = computeAfterRemoveIndex(current, removed, total);
        assert.ok(next >= 0, `next must not be negative (${current},${removed},${total})`);
        assert.ok(
          next <= Math.max(0, total - 2),
          `next must stay inside the new deck (${current},${removed},${total} -> ${next})`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// buildPagerHint
// ---------------------------------------------------------------------------

test('buildPagerHint points up on the first page', () => {
  assert.equal(buildPagerHint(0, 5, 12), '上滑翻下一页 · 第 1/5 页');
  assert.equal(buildPagerHint(0, 2, 3), '上滑翻下一页 · 第 1/2 页');
  // Out-of-range / negative indexes normalize to the first page.
  assert.equal(buildPagerHint(-4, 5, 12), '上滑翻下一页 · 第 1/5 页');
  assert.equal(buildPagerHint(Number.NaN, 5, 12), '上滑翻下一页 · 第 1/5 页');
});

test('buildPagerHint explains both directions in the middle', () => {
  assert.equal(buildPagerHint(1, 5, 12), '上下滑动翻页 · 第 2/5 页');
  assert.equal(buildPagerHint(2, 5, 12), '上下滑动翻页 · 第 3/5 页');
  assert.equal(buildPagerHint(1, 3, 12), '上下滑动翻页 · 第 2/3 页');
});

test('buildPagerHint points down on the last page', () => {
  assert.equal(buildPagerHint(4, 5, 12), '下滑回看上一页 · 第 5/5 页');
  assert.equal(buildPagerHint(99, 5, 12), '下滑回看上一页 · 第 5/5 页');
  assert.equal(buildPagerHint(1, 2, 12), '下滑回看上一页 · 第 2/2 页');
});

test('buildPagerHint marks the single page as the batch tail', () => {
  assert.equal(buildPagerHint(0, 1, 1), '本批最后 1 页');
  assert.equal(buildPagerHint(0, 1, 0), '本批最后 1 页');
  assert.equal(buildPagerHint(0, 0, 0), '本批最后 1 页');
  assert.equal(buildPagerHint(3, 0, 0), '本批最后 1 页');
});

test('buildPagerHint mentions the library when more clips wait behind a single page', () => {
  assert.equal(buildPagerHint(0, 1, 7), '仅余本页 · 在库 7 条');
  assert.equal(buildPagerHint(0, 1, 2), '仅余本页 · 在库 2 条');
  assert.equal(buildPagerHint(0, 0, 9), '仅余本页 · 在库 9 条');
});

test('buildPagerHint falls back to the batch tail for a non-finite count', () => {
  assert.equal(buildPagerHint(0, Number.NaN, 1), '本批最后 1 页');
  assert.equal(buildPagerHint(0, Number.POSITIVE_INFINITY, 4), '仅余本页 · 在库 4 条');
});
