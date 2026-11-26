/**
 * Pure gesture math for the Today Review swipe deck.
 *
 * This module deliberately has **no React Native imports**: every helper is a
 * plain deterministic function so it can be unit-tested with `node:test`
 * (`mobile/tests/reviewSwipeMath.test.mjs`) and shared by `ReviewDeck`.
 *
 * The deck is driven by a thumb resting in the lower half of the screen. That
 * means:
 * - the commit distance is smaller than a full arm swipe (22% of the width);
 * - a diagonal, arc-shaped slide still counts as horizontal once `dx` leads
 *   `dy` by 10%, so one-handed strokes are not dropped mid-gesture;
 * - a quick flick can commit before the finger travels the full distance.
 */

/** Upper bound of the commit distance (wide phones / tablets). */
export const SWIPE_THRESHOLD_MAX = 86;
/** Lower bound of the commit distance (tiny screens). */
export const SWIPE_THRESHOLD_MIN = 64;
/** Commit distance as a fraction of the screen width. */
export const SWIPE_THRESHOLD_RATIO = 0.22;

/** Minimum horizontal travel before the deck takes over the gesture. */
const CAPTURE_MIN_DISTANCE = 8;
/** Horizontal delta must lead the vertical delta by this factor. */
const CAPTURE_HORIZONTAL_RATIO = 1.1;
/** Release velocity (px/ms) that counts as a decisive flick. */
const FLICK_VELOCITY = 0.45;
/** A flick still needs this much travel so taps never commit. */
const FLICK_MIN_DISTANCE = 30;

export type SwipeReleaseAction = 'archive' | 'snooze';

/**
 * Commit distance for the current screen width.
 *
 * `min(86, max(64, width * 0.22))`: 86px on wide phones keeps the card
 * reachable with a thumb, 64px on tiny screens avoids hair-trigger swipes.
 * Unusable widths (0/negative/NaN/Infinity) fall back to the conservative cap
 * so a broken measurement can never create an accidental action.
 */
export function computeSwipeThreshold(screenWidth: number): number {
  if (!Number.isFinite(screenWidth) || screenWidth <= 0) return SWIPE_THRESHOLD_MAX;
  const ratioDistance = screenWidth * SWIPE_THRESHOLD_RATIO;
  return Math.min(SWIPE_THRESHOLD_MAX, Math.max(SWIPE_THRESHOLD_MIN, ratioDistance));
}

/**
 * Whether a drag should be captured as a horizontal card swipe.
 *
 * Requires 8px of horizontal travel and `abs(dx) > abs(dy) * 1.1`. The strict
 * leader keeps vertical scrolling / pull-to-refresh (where `dy` dominates)
 * entirely in the ScrollView, while a one-handed arc still captures.
 */
export function shouldCaptureHorizontalSwipe(dx: number, dy: number): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  return horizontal > CAPTURE_MIN_DISTANCE && horizontal > vertical * CAPTURE_HORIZONTAL_RATIO;
}

/**
 * Decide what a released drag means.
 *
 * Distance first (`|dx| >= threshold`); otherwise a decisive flick in the same
 * direction as the travel (`vx >= 0.45 && dx >= 30` archive, mirror for
 * snooze). Everything else returns `null` so the card springs back.
 */
export function resolveSwipeRelease(
  dx: number,
  vx: number,
  screenWidth: number,
): SwipeReleaseAction | null {
  if (!Number.isFinite(dx) || !Number.isFinite(vx)) return null;

  const threshold = computeSwipeThreshold(screenWidth);
  if (Math.abs(dx) >= threshold) {
    return dx > 0 ? 'archive' : 'snooze';
  }

  if (vx >= FLICK_VELOCITY && dx >= FLICK_MIN_DISTANCE) return 'archive';
  if (vx <= -FLICK_VELOCITY && dx <= -FLICK_MIN_DISTANCE) return 'snooze';
  return null;
}
