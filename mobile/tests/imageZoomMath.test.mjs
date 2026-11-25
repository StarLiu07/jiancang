import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISMISS_DISTANCE_PX,
  DISMISS_VELOCITY,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  applyRubberBand,
  buildLightboxItems,
  clamp,
  clampTranslation,
  computeDismissBackdropOpacity,
  computeFocalZoom,
  computePanBounds,
  computeStepZoom,
  computeTouchMetrics,
  shouldDismissOnRelease,
} from '../src/components/imageZoomMath.ts';

function assertClose(actual, expected, tolerance = 1e-9, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message || `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function assertInsideBounds(result, viewportWidth, viewportHeight, scale) {
  const bounds = computePanBounds(viewportWidth, viewportHeight, scale);
  assert.ok(
    Math.abs(result.translateX) <= bounds.maxX + 1e-9,
    `translateX ${result.translateX} exceeded maxX ${bounds.maxX}`,
  );
  assert.ok(
    Math.abs(result.translateY) <= bounds.maxY + 1e-9,
    `translateY ${result.translateY} exceeded maxY ${bounds.maxY}`,
  );
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test('zoom constants match the lightbox contract', () => {
  assert.equal(MIN_ZOOM, 1);
  assert.equal(MAX_ZOOM, 4);
  assert.equal(DOUBLE_TAP_ZOOM, 2.5);
  assert.deepEqual([...ZOOM_STEPS], [1, 1.5, 2, 3, 4]);
  assert.equal(DISMISS_DISTANCE_PX, 120);
  assert.equal(DISMISS_VELOCITY, 0.85);
});

// ---------------------------------------------------------------------------
// clamp / rubber band
// ---------------------------------------------------------------------------

test('clamp keeps in-range values untouched and pins out-of-range values', () => {
  assert.equal(clamp(2, 1, 4), 2);
  assert.equal(clamp(1, 1, 4), 1);
  assert.equal(clamp(4, 1, 4), 4);
  assert.equal(clamp(0.25, 1, 4), 1);
  assert.equal(clamp(9, 1, 4), 4);
  assert.equal(clamp(-3, -2, 2), -2);
  assert.equal(clamp(0, -2, 2), 0);
  // Zero is normalised so callers never observe -0.
  assert.equal(Object.is(clamp(-0, -1, 1), 0), true);
});

test('applyRubberBand is lossless inside the range', () => {
  for (const value of [1, 1.2, 2, 2.75, 3.99, 4]) {
    assert.equal(applyRubberBand(value, 1, 4), value);
  }
});

test('applyRubberBand damps overshoot instead of letting it run away', () => {
  const below = applyRubberBand(0.2, 1, 4);
  assert.ok(below < 1, 'below-range value should stay below the minimum');
  assert.ok(below > 0.2, 'below-range value must be pulled back toward the minimum');

  const above = applyRubberBand(9, 1, 4);
  assert.ok(above > 4, 'above-range value should stay above the maximum');
  assert.ok(above < 9, 'above-range value must be damped toward the maximum');

  // More overflow still produces more visible give, but never beyond one span.
  const small = applyRubberBand(4.5, 1, 4);
  const large = applyRubberBand(40, 1, 4);
  assert.ok(large > small);
  assert.ok(large <= 4 + (4 - 1) + 1e-9);

  // Monotonic and bounded for a long tail of overshoot.
  let previous = 4;
  for (const overflow of [0.1, 0.5, 1, 5, 50, 500]) {
    const damped = applyRubberBand(4 + overflow, 1, 4);
    assert.ok(damped >= previous);
    assert.ok(damped < 7.0000001);
    previous = damped;
  }
});

test('applyRubberBand honours resistance and degenerate ranges', () => {
  assert.equal(applyRubberBand(9, 1, 4, 0), 4);
  assert.equal(applyRubberBand(0, 1, 4, 0), 1);
  // Higher resistance is springier (further from the edge).
  assert.ok(applyRubberBand(9, 1, 4, 0.8) > applyRubberBand(9, 1, 4, 0.2));
  // Inverted bounds are normalised rather than producing NaN.
  assert.equal(applyRubberBand(2, 4, 1), 2);
  assert.ok(applyRubberBand(5, 4, 1) > 4);
  // A zero-width range cannot divide by zero.
  assert.ok(Number.isFinite(applyRubberBand(3, 2, 2)));
});

// ---------------------------------------------------------------------------
// pan bounds
// ---------------------------------------------------------------------------

test('computePanBounds is strictly zero until the image is zoomed past 1x', () => {
  assert.deepEqual(computePanBounds(400, 800, 1), { maxX: 0, maxY: 0 });
  assert.deepEqual(computePanBounds(400, 800, 0.5), { maxX: 0, maxY: 0 });
  assert.deepEqual(computePanBounds(400, 800, 1.0000001), {
    maxX: ((1.0000001 - 1) * 400) / 2,
    maxY: ((1.0000001 - 1) * 800) / 2,
  });
});

test('computePanBounds grows linearly with the scale factor', () => {
  assert.deepEqual(computePanBounds(400, 800, 2), { maxX: 200, maxY: 400 });
  assert.deepEqual(computePanBounds(400, 800, 4), { maxX: 600, maxY: 1200 });
  assert.deepEqual(computePanBounds(360, 640, 2.5), { maxX: 270, maxY: 480 });
});

test('clampTranslation pins an unzoomed image to the centre', () => {
  assert.deepEqual(clampTranslation(120, -240, 400, 800, 1), { x: 0, y: 0 });
  assert.deepEqual(clampTranslation(0, 0, 400, 800, 0.4), { x: 0, y: 0 });
});

test('clampTranslation keeps pan inside the computed bounds', () => {
  assert.deepEqual(clampTranslation(999, -999, 400, 800, 2), { x: 200, y: -400 });
  assert.deepEqual(clampTranslation(-999, 999, 400, 800, 2), { x: -200, y: 400 });
  assert.deepEqual(clampTranslation(120, 80, 400, 800, 2), { x: 120, y: 80 });
});

// ---------------------------------------------------------------------------
// focal zoom
// ---------------------------------------------------------------------------

test('computeFocalZoom keeps the anchor pixel pinned for off-centre focal points', () => {
  const viewportWidth = 400;
  const viewportHeight = 800;
  const cases = [
    { scale: 1, targetScale: 2.5, tx: 0, ty: 0, focalX: 300, focalY: 200 },
    { scale: 1, targetScale: 2, tx: 0, ty: 0, focalX: 80, focalY: 120 },
    { scale: 1, targetScale: 2, tx: 0, ty: 0, focalX: 330, focalY: 600 },
    { scale: 1.5, targetScale: 2.5, tx: -40, ty: 60, focalX: 250, focalY: 300 },
  ];

  for (const item of cases) {
    const result = computeFocalZoom({
      scale: item.scale,
      targetScale: item.targetScale,
      translateX: item.tx,
      translateY: item.ty,
      focalX: item.focalX,
      focalY: item.focalY,
      viewportWidth,
      viewportHeight,
    });

    assert.equal(result.scale, item.targetScale);
    assertInsideBounds(result, viewportWidth, viewportHeight, result.scale);

    // Content coordinate that currently sits under the focal point.
    const contentX = (item.focalX - viewportWidth / 2 - item.tx) / item.scale;
    const contentY = (item.focalY - viewportHeight / 2 - item.ty) / item.scale;
    const screenX = viewportWidth / 2 + contentX * result.scale + result.translateX;
    const screenY = viewportHeight / 2 + contentY * result.scale + result.translateY;

    assertClose(screenX, item.focalX, 1e-9, 'anchor X drifted');
    assertClose(screenY, item.focalY, 1e-9, 'anchor Y drifted');
  }
});

test('computeFocalZoom at the viewport centre leaves a centred image centred', () => {
  const result = computeFocalZoom({
    scale: 1,
    targetScale: DOUBLE_TAP_ZOOM,
    translateX: 0,
    translateY: 0,
    focalX: 200,
    focalY: 400,
    viewportWidth: 400,
    viewportHeight: 800,
  });
  assert.deepEqual(result, { scale: 2.5, translateX: 0, translateY: 0 });
});

test('computeFocalZoom zooming out to 1x clears every translation', () => {
  const result = computeFocalZoom({
    scale: 3,
    targetScale: 1,
    translateX: 560,
    translateY: -900,
    focalX: 40,
    focalY: 760,
    viewportWidth: 400,
    viewportHeight: 800,
  });
  assert.deepEqual(result, { scale: 1, translateX: 0, translateY: 0 });
});

test('computeFocalZoom clamps the resulting pan to the target-scale bounds', () => {
  // Already panned to the maximum on the x axis, then zooming in at the centre
  // would ask for twice the allowable offset: it must be clamped.
  const zoomIn = computeFocalZoom({
    scale: 2,
    targetScale: 4,
    translateX: 200,
    translateY: 0,
    focalX: 200,
    focalY: 400,
    viewportWidth: 400,
    viewportHeight: 800,
  });
  assert.equal(zoomIn.scale, 4);
  assert.deepEqual(zoomIn, { scale: 4, translateX: 400, translateY: 0 });

  const zoomOut = computeFocalZoom({
    scale: 4,
    targetScale: 2,
    translateX: 600,
    translateY: -1200,
    focalX: 200,
    focalY: 400,
    viewportWidth: 400,
    viewportHeight: 800,
  });
  assert.deepEqual(zoomOut, { scale: 2, translateX: 200, translateY: -400 });
  assertInsideBounds(zoomOut, 400, 800, zoomOut.scale);
});

test('computeFocalZoom treats the corner focal as an extreme but bounded anchor', () => {
  const result = computeFocalZoom({
    scale: 1,
    targetScale: 4,
    translateX: 0,
    translateY: 0,
    focalX: 0,
    focalY: 0,
    viewportWidth: 400,
    viewportHeight: 800,
  });
  assert.deepEqual(result, { scale: 4, translateX: 600, translateY: 1200 });
  assertInsideBounds(result, 400, 800, 4);
});

// ---------------------------------------------------------------------------
// touch metrics
// ---------------------------------------------------------------------------

test('computeTouchMetrics needs exactly two fingers', () => {
  assert.equal(computeTouchMetrics([]), null);
  assert.equal(computeTouchMetrics([{ pageX: 12, pageY: 34 }]), null);
  assert.equal(computeTouchMetrics(undefined), null);
});

test('computeTouchMetrics returns Euclidean distance and midpoint', () => {
  assert.deepEqual(
    computeTouchMetrics([
      { pageX: 10, pageY: 20 },
      { pageX: 40, pageY: 60 },
    ]),
    { distance: 50, centerX: 25, centerY: 40 },
  );

  const horizontal = computeTouchMetrics([
    { pageX: 0, pageY: 500 },
    { pageX: 300, pageY: 500 },
  ]);
  assert.equal(horizontal.distance, 300);
  assert.equal(horizontal.centerX, 150);

  // Extra fingers are ignored: pinch math only ever uses the first pair.
  assert.deepEqual(
    computeTouchMetrics([
      { pageX: 0, pageY: 0 },
      { pageX: 0, pageY: 200 },
      { pageX: 999, pageY: 999 },
    ]),
    { distance: 200, centerX: 0, centerY: 100 },
  );
});

// ---------------------------------------------------------------------------
// step zoom
// ---------------------------------------------------------------------------

test('computeStepZoom walks ZOOM_STEPS in both directions', () => {
  assert.equal(computeStepZoom(1, 'in'), 1.5);
  assert.equal(computeStepZoom(1.5, 'in'), 2);
  assert.equal(computeStepZoom(2, 'in'), 3);
  assert.equal(computeStepZoom(3, 'in'), 4);

  assert.equal(computeStepZoom(4, 'out'), 3);
  assert.equal(computeStepZoom(3, 'out'), 2);
  assert.equal(computeStepZoom(2, 'out'), 1.5);
  assert.equal(computeStepZoom(1.5, 'out'), 1);
});

test('computeStepZoom parks at 1 and 4', () => {
  assert.equal(computeStepZoom(1, 'out'), 1);
  assert.equal(computeStepZoom(0.4, 'out'), 1);
  assert.equal(computeStepZoom(4, 'in'), 4);
  assert.equal(computeStepZoom(9, 'in'), 4);
});

test('computeStepZoom survives floating point noise around a step', () => {
  assert.equal(computeStepZoom(2.0000000001, 'in'), 3);
  assert.equal(computeStepZoom(2.0000000001, 'out'), 1.5);
  assert.equal(computeStepZoom(1.4999999999, 'in'), 2);
  assert.equal(computeStepZoom(1.4999999999, 'out'), 1);
  assert.equal(computeStepZoom(3.9999999999, 'in'), 4);
  assert.equal(computeStepZoom(3.9999999999, 'out'), 3);
});

test('computeStepZoom picks the neighbour step for in-between scales', () => {
  assert.equal(computeStepZoom(3.4, 'in'), 4);
  assert.equal(computeStepZoom(3.4, 'out'), 3);
  assert.equal(computeStepZoom(1.2, 'in'), 1.5);
  assert.equal(computeStepZoom(1.2, 'out'), 1);
  assert.equal(computeStepZoom(2.98, 'in'), 3);
  assert.equal(computeStepZoom(2.98, 'out'), 2);
});

// ---------------------------------------------------------------------------
// dismiss gesture
// ---------------------------------------------------------------------------

test('shouldDismissOnRelease needs enough distance or enough downward fling', () => {
  assert.equal(shouldDismissOnRelease(0, 0), false);
  assert.equal(shouldDismissOnRelease(DISMISS_DISTANCE_PX - 1, 0), false);
  assert.equal(shouldDismissOnRelease(DISMISS_DISTANCE_PX, 0), true);
  assert.equal(shouldDismissOnRelease(DISMISS_DISTANCE_PX + 1, -3), true);

  assert.equal(shouldDismissOnRelease(60, DISMISS_VELOCITY), true);
  assert.equal(shouldDismissOnRelease(60, DISMISS_VELOCITY - 0.01), false);
  assert.equal(shouldDismissOnRelease(41, 2.4), true);
  assert.equal(shouldDismissOnRelease(40, 2.4), false);
  assert.equal(shouldDismissOnRelease(80, 0.84), false);
  // Upward gestures never dismiss, no matter how fast.
  assert.equal(shouldDismissOnRelease(-200, 5), false);
});

test('computeDismissBackdropOpacity fades with the downward drag and bottoms out at 0.25', () => {
  assert.equal(computeDismissBackdropOpacity(0), 1);
  assert.equal(computeDismissBackdropOpacity(-40), 1);
  assertClose(computeDismissBackdropOpacity(60), 0.625);
  assert.equal(computeDismissBackdropOpacity(DISMISS_DISTANCE_PX), 0.25);
  assert.equal(computeDismissBackdropOpacity(DISMISS_DISTANCE_PX * 3), 0.25);

  let previous = 1;
  for (const dy of [0, 10, 30, 60, 90, 120, 200]) {
    const opacity = computeDismissBackdropOpacity(dy);
    assert.ok(opacity <= previous);
    assert.ok(opacity >= 0.25 && opacity <= 1);
    previous = opacity;
  }
});

// ---------------------------------------------------------------------------
// lightbox items
// ---------------------------------------------------------------------------

test('buildLightboxItems filters unresolvable media and keeps the original order', () => {
  const media = [
    { id: 'a', url: '/api/media/a', mime_type: 'image/jpeg', sort_order: 0 },
    { id: 'b', url: '/api/media/b', mime_type: 'image/png', sort_order: 1 },
    { id: 'c', url: null, mime_type: 'image/webp', sort_order: 2 },
    { id: 'd', url: '/api/media/d', mime_type: 'image/gif', sort_order: 3 },
  ];

  const resolved = [];
  const { items, indexMap } = buildLightboxItems(media, (url) => {
    resolved.push(url);
    if (!url || url === '/api/media/b') return null;
    return `https://cdn.example.test${url}`;
  });

  assert.deepEqual(resolved, ['/api/media/a', '/api/media/b', null, '/api/media/d']);
  assert.deepEqual(items, [
    { id: 'a', uri: 'https://cdn.example.test/api/media/a', caption: '#1 · JPEG' },
    { id: 'd', uri: 'https://cdn.example.test/api/media/d', caption: '#4 · GIF' },
  ]);

  // Original media index -> preview index (only for surviving images).
  assert.equal(indexMap.get(0), 0);
  assert.equal(indexMap.has(1), false);
  assert.equal(indexMap.has(2), false);
  assert.equal(indexMap.get(3), 1);
  assert.equal(indexMap.size, 2);
});

test('buildLightboxItems returns an empty preview list for empty or broken media', () => {
  assert.deepEqual(buildLightboxItems([], () => 'https://x.test/1.jpg'), {
    items: [],
    indexMap: new Map(),
  });

  const broken = buildLightboxItems(
    [
      { id: 'a', url: '/api/media/a', mime_type: 'image/jpeg', sort_order: 0 },
      { id: 'b', url: '/api/media/b', mime_type: 'image/jpeg', sort_order: 1 },
    ],
    () => null,
  );
  assert.deepEqual(broken.items, []);
  assert.equal(broken.indexMap.size, 0);
});

test('buildLightboxItems does not renumber captions after filtering', () => {
  const { items, indexMap } = buildLightboxItems(
    [
      { id: 'a', url: '/a', mime_type: 'image/jpeg', sort_order: 0 },
      { id: 'b', url: '/b', mime_type: 'image/png', sort_order: 1 },
      { id: 'c', url: '/c', mime_type: 'image/webp', sort_order: 2 },
    ],
    (url) => (url === '/b' ? null : `local://${url}`),
  );

  assert.deepEqual(
    items.map((item) => item.caption),
    ['#1 · JPEG', '#3 · WEBP'],
  );
  assert.equal(indexMap.get(2), 1);
});
