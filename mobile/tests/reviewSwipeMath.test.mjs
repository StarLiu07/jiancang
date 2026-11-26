import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SWIPE_THRESHOLD_MAX,
  SWIPE_THRESHOLD_MIN,
  computeSwipeThreshold,
  resolveSwipeRelease,
  shouldCaptureHorizontalSwipe,
} from '../src/components/reviewSwipeMath.ts';

function assertClose(actual, expected, tolerance = 1e-9, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message || `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// computeSwipeThreshold
// ---------------------------------------------------------------------------

test('threshold uses 22% of the screen width on common phones', () => {
  assertClose(computeSwipeThreshold(320), 70.4);
  assertClose(computeSwipeThreshold(360), 79.2);
  assertClose(computeSwipeThreshold(390), 85.8);
});

test('threshold is capped at 86px so wide phones stay reachable one-handed', () => {
  assert.equal(computeSwipeThreshold(430), SWIPE_THRESHOLD_MAX);
  assert.equal(computeSwipeThreshold(768), SWIPE_THRESHOLD_MAX);
  assert.equal(computeSwipeThreshold(1200), SWIPE_THRESHOLD_MAX);
});

test('threshold never drops below 64px on tiny widths', () => {
  assert.equal(computeSwipeThreshold(290), SWIPE_THRESHOLD_MIN);
  assert.equal(computeSwipeThreshold(1), SWIPE_THRESHOLD_MIN);
});

test('threshold is strictly easier than the old min(108, width * 0.27) rule', () => {
  for (const width of [300, 320, 360, 390, 430, 600]) {
    const oldThreshold = Math.min(108, width * 0.27);
    assert.ok(
      computeSwipeThreshold(width) < oldThreshold,
      `width ${width}: new threshold should be smaller than the old rule`,
    );
  }
});

test('threshold falls back to the conservative cap for unusable widths', () => {
  assert.equal(computeSwipeThreshold(0), SWIPE_THRESHOLD_MAX);
  assert.equal(computeSwipeThreshold(-390), SWIPE_THRESHOLD_MAX);
  assert.equal(computeSwipeThreshold(Number.NaN), SWIPE_THRESHOLD_MAX);
  assert.equal(computeSwipeThreshold(Number.POSITIVE_INFINITY), SWIPE_THRESHOLD_MAX);
  assert.equal(computeSwipeThreshold(Number.NEGATIVE_INFINITY), SWIPE_THRESHOLD_MAX);
});

test('threshold is monotonic across phone widths', () => {
  let previous = 0;
  for (let width = 240; width <= 500; width += 10) {
    const current = computeSwipeThreshold(width);
    assert.ok(current >= previous, `width ${width} should not lower the threshold`);
    previous = current;
  }
});

// ---------------------------------------------------------------------------
// shouldCaptureHorizontalSwipe
// ---------------------------------------------------------------------------

test('pure taps never capture the swipe responder', () => {
  assert.equal(shouldCaptureHorizontalSwipe(0, 0), false);
  assert.equal(shouldCaptureHorizontalSwipe(2, 1), false);
  assert.equal(shouldCaptureHorizontalSwipe(-3, -2), false);
  assert.equal(shouldCaptureHorizontalSwipe(8, 0), false, '8px is not > 8');
});

test('clear horizontal drags capture in both directions', () => {
  assert.equal(shouldCaptureHorizontalSwipe(8.5, 0), true);
  assert.equal(shouldCaptureHorizontalSwipe(-9, 1), true);
  assert.equal(shouldCaptureHorizontalSwipe(40, 6), true);
  assert.equal(shouldCaptureHorizontalSwipe(-40, -6), true);
});

test('one-handed arc slides still capture once horizontal leads by 1.1x', () => {
  assert.equal(shouldCaptureHorizontalSwipe(23, 20), true);
  // Exactly 1.1x is not enough: the horizontal gesture must strictly lead.
  assert.equal(shouldCaptureHorizontalSwipe(22, 20), false);
  assert.equal(shouldCaptureHorizontalSwipe(21, 20), false);
  assert.equal(shouldCaptureHorizontalSwipe(-23, 20), true);
});

test('vertical scrolling and pull-to-refresh never capture', () => {
  assert.equal(shouldCaptureHorizontalSwipe(0, 60), false);
  assert.equal(shouldCaptureHorizontalSwipe(2, 80), false);
  assert.equal(shouldCaptureHorizontalSwipe(10, 10), false);
  assert.equal(shouldCaptureHorizontalSwipe(20, 40), false);
  assert.equal(shouldCaptureHorizontalSwipe(-6, -50), false);
});

test('non-finite deltas never capture', () => {
  assert.equal(shouldCaptureHorizontalSwipe(Number.NaN, 0), false);
  assert.equal(shouldCaptureHorizontalSwipe(20, Number.NaN), false);
  assert.equal(shouldCaptureHorizontalSwipe(Number.POSITIVE_INFINITY, 0), false);
  assert.equal(shouldCaptureHorizontalSwipe(20, Number.NEGATIVE_INFINITY), false);
});

// ---------------------------------------------------------------------------
// resolveSwipeRelease
// ---------------------------------------------------------------------------

test('dragging past the fixed threshold decides by direction', () => {
  const width = 430; // threshold is capped at 86
  assert.equal(resolveSwipeRelease(86, 0, width), 'archive');
  assert.equal(resolveSwipeRelease(120, 0, width), 'archive');
  assert.equal(resolveSwipeRelease(-86, 0, width), 'snooze');
  assert.equal(resolveSwipeRelease(-120, 0, width), 'snooze');
  assert.equal(resolveSwipeRelease(85.9, 0, width), null);
  assert.equal(resolveSwipeRelease(-85.9, 0, width), null);
});

test('dragging past the phone-width threshold decides by direction', () => {
  // 390px -> 85.8px threshold; 300px -> 66px threshold.
  assert.equal(resolveSwipeRelease(86, 0, 390), 'archive');
  assert.equal(resolveSwipeRelease(-86, 0, 390), 'snooze');
  assert.equal(resolveSwipeRelease(85, 0, 390), null);
  assert.equal(resolveSwipeRelease(66, 0, 300), 'archive');
  assert.equal(resolveSwipeRelease(-66, 0, 300), 'snooze');
  assert.equal(resolveSwipeRelease(65.9, 0, 300), null);
});

test('quick flicks commit even before the distance threshold', () => {
  const width = 390;
  assert.equal(resolveSwipeRelease(30, 0.45, width), 'archive');
  assert.equal(resolveSwipeRelease(44, 0.9, width), 'archive');
  assert.equal(resolveSwipeRelease(-30, -0.45, width), 'snooze');
  assert.equal(resolveSwipeRelease(-44, -0.9, width), 'snooze');
});

test('slow or backwards flicks snap back', () => {
  const width = 390;
  assert.equal(resolveSwipeRelease(30, 0.44, width), null);
  assert.equal(resolveSwipeRelease(-30, -0.44, width), null);
  assert.equal(resolveSwipeRelease(29, 0.9, width), null);
  assert.equal(resolveSwipeRelease(-29, -0.9, width), null);
  // Velocity and displacement must agree on the direction.
  assert.equal(resolveSwipeRelease(-40, 0.9, width), null);
  assert.equal(resolveSwipeRelease(40, -0.9, width), null);
});

test('distance wins even when the release velocity points the other way', () => {
  assert.equal(resolveSwipeRelease(100, -2, 390), 'archive');
  assert.equal(resolveSwipeRelease(-100, 2, 390), 'snooze');
});

test('taps and micro-movements release to nothing', () => {
  assert.equal(resolveSwipeRelease(0, 0, 390), null);
  assert.equal(resolveSwipeRelease(5, 0, 390), null);
  assert.equal(resolveSwipeRelease(-5, 0.9, 390), null);
});

test('non-finite release input never triggers an action', () => {
  assert.equal(resolveSwipeRelease(Number.NaN, 0, 390), null);
  assert.equal(resolveSwipeRelease(Number.POSITIVE_INFINITY, 0, 390), null);
  assert.equal(resolveSwipeRelease(10, Number.NaN, 390), null);
  assert.equal(resolveSwipeRelease(10, Number.POSITIVE_INFINITY, 390), null);
  assert.equal(resolveSwipeRelease(10, Number.NEGATIVE_INFINITY, 390), null);
});

test('unusable widths fall back to the 86px threshold', () => {
  assert.equal(resolveSwipeRelease(86, 0, Number.NaN), 'archive');
  assert.equal(resolveSwipeRelease(-86, 0, -1), 'snooze');
  assert.equal(resolveSwipeRelease(85, 0, Number.NaN), null);
});
