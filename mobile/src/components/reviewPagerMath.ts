/**
 * Pure paging math for the Today Review vertical folio pager.
 *
 * This module deliberately has **no React Native imports**: every helper is a
 * plain deterministic function so it can be unit-tested with `node:test`
 * (`mobile/tests/reviewPagerMath.test.mjs`) and shared by `ReviewDeck`.
 *
 * The deck is one full-screen leaf per page, snapped by a native vertical
 * `FlatList` (`pagingEnabled`). That means the only things this layer owns are:
 * - which page index an offset belongs to (50% snap boundary, not 49%);
 * - what slot to show after the reviewed leaf has been removed from the batch;
 * - the one-line footer hint that tells the thumb where paging goes next.
 */

/**
 * Defensive page index: non-finite input collapses to the first page and the
 * result is always inside `[0, floor(count) - 1]`. A broken measurement must
 * never produce an out-of-range `scrollToOffset` target.
 */
export function clampPageIndex(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  const lastIndex = Math.max(0, Math.floor(count) - 1);
  return Math.min(lastIndex, Math.max(0, Math.trunc(index)));
}

/**
 * Snap a vertical scroll offset to a page index.
 *
 * `Math.round(offsetY / pageHeight)` puts the boundary at exactly 50%, so
 * 49% stays on the current leaf while 51% advances. Usable only with a
 * positive page height; everything else falls back to page 0.
 */
export function resolvePageIndexFromOffset(
  offsetY: number,
  pageHeight: number,
  count: number,
): number {
  if (!Number.isFinite(offsetY) || !Number.isFinite(pageHeight) || !Number.isFinite(count)) {
    return 0;
  }
  if (pageHeight <= 0 || count <= 0) return 0;
  return clampPageIndex(Math.round(offsetY / pageHeight), count);
}

/**
 * Which slot to show after one leaf leaves the batch.
 *
 * `totalCount` is the **pre-removal** length. Removing the current leaf keeps
 * the same slot (the next leaf slides up into it); removing a leaf above it
 * shifts the slot up by one; removing the last current leaf walks back to the
 * new last page. Removing the only leaf empties the deck (index 0).
 */
export function computeAfterRemoveIndex(
  currentIndex: number,
  removedIndex: number,
  totalCount: number,
): number {
  if (!Number.isFinite(totalCount)) return 0;

  const nextCount = Math.max(0, Math.floor(totalCount) - 1);
  if (nextCount <= 0) return 0;

  const current = clampPageIndex(currentIndex, totalCount);
  const removed = clampPageIndex(removedIndex, totalCount);

  if (removed < current) return clampPageIndex(current - 1, nextCount);
  return clampPageIndex(current, nextCount);
}

/** One-line paging hint under the fixed action bar. */
export function buildPagerHint(
  currentIndex: number,
  totalCount: number,
  totalActive: number,
): string {
  const total = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0;

  if (total <= 1) {
    return totalActive > 1 ? `仅余本页 · 在库 ${totalActive} 条` : '本批最后 1 页';
  }

  const position = clampPageIndex(currentIndex, total);
  if (position === 0) return `上滑翻下一页 · 第 1/${total} 页`;
  if (position === total - 1) return `下滑回看上一页 · 第 ${total}/${total} 页`;
  return `上下滑动翻页 · 第 ${position + 1}/${total} 页`;
}
