import type { MediaItem } from '../types';

/**
 * Pure geometry / gesture math for the full-screen image lightbox.
 *
 * This module deliberately has **no React Native imports**: every helper is a
 * plain deterministic function so it can be unit-tested with `node:test`
 * (`mobile/tests/imageZoomMath.test.mjs`) and reused by both the modal and the
 * business screens.
 *
 * Coordinate conventions used by `ImageLightboxModal`:
 * - the image is centred in a viewport-sized page (`resizeMode="contain"`);
 * - `scale` is applied around the viewport centre, then `translateX/Y` shifts
 *   the scaled image in viewport pixels;
 * - `focalX/focalY` are viewport coordinates (top-left origin).
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;
export const DISMISS_DISTANCE_PX = 120;
export const DISMISS_VELOCITY = 0.85;

/** Default overshoot resistance while pinching past the zoom limits. */
const DEFAULT_RUBBER_BAND_RESISTANCE = 0.35;
/**
 * Tolerance used to recognise "already on a step" despite float noise.
 * Pinch math produces values such as 1.9999999997, and pressing `+` there must
 * step to 3 instead of re-selecting 2.
 */
const STEP_EPSILON = 1e-3;
/** Lowest backdrop opacity while the image is being dragged down to dismiss. */
const MIN_DISMISS_BACKDROP_OPACITY = 0.25;

export interface TouchMetrics {
  distance: number;
  centerX: number;
  centerY: number;
}

export interface FocalZoomParams {
  scale: number;
  targetScale: number;
  translateX: number;
  translateY: number;
  focalX: number;
  focalY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface FocalZoomResult {
  scale: number;
  translateX: number;
  translateY: number;
}

export interface LightboxImageItem {
  id: string;
  uri: string;
  caption?: string;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function safeViewportSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Normalises `-0` so equality checks and UI labels never see a negative zero. */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Clamps `value` into `[min, max]`. Inverted bounds are tolerated and `NaN`
 * collapses to the lower bound so a broken gesture can never poison the UI.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return Math.min(min, max);
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return normalizeZero(Math.min(Math.max(value, lower), upper));
}

/**
 * Damped overshoot ("rubber band") used while pinching beyond `[min, max]`.
 *
 * Values inside the range are returned untouched. Outside it the overshoot is
 * compressed by `resistance`, asymptotically approaching one full span instead
 * of growing without bound, which keeps the elastic feel predictable.
 */
export function applyRubberBand(
  value: number,
  min: number,
  max: number,
  resistance: number = DEFAULT_RUBBER_BAND_RESISTANCE,
): number {
  if (Number.isNaN(value)) return Math.min(min, max);

  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  if (value >= lower && value <= upper) return value;
  if (!Number.isFinite(value)) return value > upper ? upper : lower;

  const strength = clamp(resistance, 0, 1);
  if (strength <= 0) return value > upper ? upper : lower;

  const span = Math.max(1, upper - lower);
  const overflow = value > upper ? value - upper : lower - value;
  const damped = (overflow * strength * span) / (span + overflow * strength);

  return normalizeZero(value > upper ? upper + damped : lower - damped);
}

/**
 * Maximum pan distance from the centre for a scaled image.
 * `scale <= 1` pins the image to the centre.
 */
export function computePanBounds(
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): { maxX: number; maxY: number } {
  if (!(scale > MIN_ZOOM)) return { maxX: 0, maxY: 0 };

  const width = safeViewportSize(viewportWidth);
  const height = safeViewportSize(viewportHeight);
  return {
    maxX: ((scale - 1) * width) / 2,
    maxY: ((scale - 1) * height) / 2,
  };
}

/** Clamps a pan offset to the pan bounds of the given scale. */
export function clampTranslation(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): { x: number; y: number } {
  const { maxX, maxY } = computePanBounds(viewportWidth, viewportHeight, scale);
  return {
    x: clamp(x, -maxX, maxX),
    y: clamp(y, -maxY, maxY),
  };
}

/**
 * Zoom anchored on a viewport point.
 *
 * The content currently underneath `(focalX, focalY)` stays underneath that
 * same point while `scale` animates to `targetScale`; the resulting translation
 * is then clamped so the image never leaves the viewport. Zooming back to 1x
 * always resets the translation to zero.
 */
export function computeFocalZoom(params: FocalZoomParams): FocalZoomResult {
  const viewportWidth = safeViewportSize(params.viewportWidth);
  const viewportHeight = safeViewportSize(params.viewportHeight);
  const currentScale =
    Number.isFinite(params.scale) && params.scale > 0 ? params.scale : MIN_ZOOM;
  const targetScale = clamp(params.targetScale, MIN_ZOOM, MAX_ZOOM);
  const translateX = finiteOr(params.translateX, 0);
  const translateY = finiteOr(params.translateY, 0);
  const focalX = finiteOr(params.focalX, viewportWidth / 2);
  const focalY = finiteOr(params.focalY, viewportHeight / 2);

  if (targetScale <= MIN_ZOOM) {
    return { scale: MIN_ZOOM, translateX: 0, translateY: 0 };
  }

  const ratio = targetScale / currentScale;
  const offsetX = focalX - viewportWidth / 2;
  const offsetY = focalY - viewportHeight / 2;

  // Content point under the focal: c = (offset - translate) / scale.
  // Keep it under the focal: offset === c * targetScale + nextTranslate.
  const nextX = offsetX - (offsetX - translateX) * ratio;
  const nextY = offsetY - (offsetY - translateY) * ratio;
  const bounded = clampTranslation(nextX, nextY, viewportWidth, viewportHeight, targetScale);

  return { scale: targetScale, translateX: bounded.x, translateY: bounded.y };
}

/**
 * Distance and midpoint of the first two active touches.
 * Returns `null` for zero/one-finger states so callers can fall back to panning.
 */
export function computeTouchMetrics(
  touches: ReadonlyArray<{ pageX: number; pageY: number }> | null | undefined,
): TouchMetrics | null {
  if (!touches || touches.length < 2) return null;

  const [first, second] = touches;
  const dx = second.pageX - first.pageX;
  const dy = second.pageY - first.pageY;

  return {
    distance: Math.hypot(dx, dy),
    centerX: (first.pageX + second.pageX) / 2,
    centerY: (first.pageY + second.pageY) / 2,
  };
}

/**
 * Next/previous zoom step for the +/− controls.
 * Values that already sit on a step (within `STEP_EPSILON`) move one step;
 * in-between values snap to the adjacent step above/below.
 */
export function computeStepZoom(currentScale: number, direction: 'in' | 'out'): number {
  const scale = Number.isFinite(currentScale) ? currentScale : MIN_ZOOM;

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ZOOM_STEPS.length; index += 1) {
    const distance = Math.abs(ZOOM_STEPS[index] - scale);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  const onStep = nearestDistance <= STEP_EPSILON;

  if (direction === 'in') {
    if (onStep) {
      return ZOOM_STEPS[Math.min(nearestIndex + 1, ZOOM_STEPS.length - 1)];
    }
    for (const step of ZOOM_STEPS) {
      if (step > scale + STEP_EPSILON) return step;
    }
    return MAX_ZOOM;
  }

  if (onStep) {
    return ZOOM_STEPS[Math.max(nearestIndex - 1, 0)];
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index] < scale - STEP_EPSILON) return ZOOM_STEPS[index];
  }
  return MIN_ZOOM;
}

/** Whether releasing a downward drag should dismiss the viewer. */
export function shouldDismissOnRelease(dy: number, vy: number): boolean {
  if (!Number.isFinite(dy)) return false;
  if (dy >= DISMISS_DISTANCE_PX) return true;
  return dy > 40 && Number.isFinite(vy) && vy >= DISMISS_VELOCITY;
}

/**
 * Backdrop opacity while pulling down to dismiss: fully opaque at rest and
 * fading smoothly to `0.25` at the dismiss distance (and beyond).
 */
export function computeDismissBackdropOpacity(dy: number): number {
  if (!Number.isFinite(dy) || dy <= 0) return 1;
  const progress = clamp(dy / DISMISS_DISTANCE_PX, 0, 1);
  return 1 - progress * (1 - MIN_DISMISS_BACKDROP_OPACITY);
}

export type LightboxMediaItem = Pick<MediaItem, 'id' | 'url' | 'mime_type' | 'sort_order'>;

/**
 * Converts clip media rows into the lightbox data source.
 *
 * Media whose URI cannot be resolved (offline/absent file, backend unavailable)
 * is skipped instead of rendering a dead page. `indexMap` maps the original
 * `media` index to the filtered preview index so a gallery tap can open the
 * tapped image directly.
 *
 * Caption format (matches the gallery label): `#1 · JPEG`.
 */
export function buildLightboxItems(
  media: ReadonlyArray<LightboxMediaItem>,
  resolveUrl: (url: string | null) => string | null,
): { items: LightboxImageItem[]; indexMap: Map<number, number> } {
  const items: LightboxImageItem[] = [];
  const indexMap = new Map<number, number>();

  media.forEach((item, mediaIndex) => {
    const uri = resolveUrl((item.url as string | null | undefined) ?? null);
    if (!uri) return;

    const sortOrder = Number.isFinite(item.sort_order) ? item.sort_order : mediaIndex;
    const mime = (item.mime_type || 'image/jpeg').replace('image/', '').toUpperCase();

    indexMap.set(mediaIndex, items.length);
    items.push({
      id: item.id,
      uri,
      caption: `#${sortOrder + 1} · ${mime}`,
    });
  });

  return { items, indexMap };
}
