import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { colors } from '../theme';
import type { ClipDetail, ReviewActionType } from '../types';
import { ClipCard } from './ClipCard';
import { MOTION } from './Motion';
import { clampPageIndex, resolvePageIndexFromOffset } from './reviewPagerMath';

export interface ReviewDeckHandle {
  triggerAction: (action: ReviewActionType) => void;
}

interface ReviewDeckProps {
  items: ClipDetail[];
  currentIndex: number;
  disabled?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onIndexChange: (index: number) => void;
  onOpenDetail: (clipId: string) => void;
  onPreviewImage?: (clip: ClipDetail) => void;
  onAction: (action: ReviewActionType, clipId: string) => void;
  onDraggingChange?: (dragging: boolean) => void;
}

interface ExitingState {
  clipId: string;
  action: ReviewActionType;
}

/** Native page-exit timing: short enough that paging never feels blocked. */
const EXIT_DURATION = 185;
const EXIT_OPACITY_DURATION = 175;
/** Release speed (px/ms) below which a drag already settled on a page. */
const SETTLED_VELOCITY = 0.05;

/**
 * Fire the leaf's native exit animation. `archive` floats up, `snooze` sinks
 * down and `delete` shrinks in place; every path fades to 0. Returns the
 * animation so the caller can stop it if the leaf unmounts mid-flight.
 */
function startPageExit(
  action: ReviewActionType,
  opacity: Animated.Value,
  translateY: Animated.Value,
  scale: Animated.Value,
  onDone: () => void,
): Animated.CompositeAnimation {
  const toTranslateY = action === 'archive' ? -36 : action === 'snooze' ? 28 : 0;
  const toScale = action === 'delete' ? 0.9 : 0.96;

  const animation = Animated.parallel([
    Animated.timing(opacity, {
      toValue: 0,
      duration: EXIT_OPACITY_DURATION,
      easing: MOTION.easeIn,
      useNativeDriver: true,
    }),
    Animated.timing(translateY, {
      toValue: toTranslateY,
      duration: EXIT_DURATION,
      easing: MOTION.easeIn,
      useNativeDriver: true,
    }),
    Animated.timing(scale, {
      toValue: toScale,
      duration: EXIT_DURATION,
      easing: MOTION.easeIn,
      useNativeDriver: true,
    }),
  ]);
  animation.start(({ finished }) => {
    if (finished) onDone();
  });
  return animation;
}

interface ReviewPageItemProps {
  clip: ClipDetail;
  pageHeight: number;
  queueLabel: string;
  exitingAction: ReviewActionType | null;
  onExitComplete: (clipId: string, action: ReviewActionType) => void;
  onOpenDetail: (clipId: string) => void;
  onPreviewImage?: (clip: ClipDetail) => void;
}

/**
 * One full-screen leaf. Each item keeps its own opacity / translateY / scale
 * values so a removal never re-uses a half-faded card: the neighbour that
 * slides into the freed slot is still at opacity 1.
 */
const ReviewPageItem = memo(function ReviewPageItem({
  clip,
  pageHeight,
  queueLabel,
  exitingAction,
  onExitComplete,
  onOpenDetail,
  onPreviewImage,
}: ReviewPageItemProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const exitingRef = useRef(false);

  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;
  // Keyed by `clip.id`: a silent refresh may hand over a new object for the
  // same leaf, which must not restart (or cancel) the exit choreography.
  const clipIdRef = useRef(clip.id);
  clipIdRef.current = clip.id;

  useEffect(() => {
    if (!exitingAction) {
      if (!exitingRef.current) return;
      exitingRef.current = false;
      // Defer the restore one frame: on the happy path the parent removes this
      // leaf in the same batch, so it unmounts before the timer fires and the
      // user never sees a half-faded card flash back. A rolled-back action
      // keeps the leaf mounted, so the timer does restore it.
      const timer = setTimeout(() => {
        opacity.setValue(1);
        translateY.setValue(0);
        scale.setValue(1);
      }, 0);
      return () => clearTimeout(timer);
    }
    // Defence in depth: one exit per mounted leaf.
    if (exitingRef.current) return;
    exitingRef.current = true;

    // Always exit from the resting pose, even after a rolled-back action.
    opacity.setValue(1);
    translateY.setValue(0);
    scale.setValue(1);

    const clipId = clipIdRef.current;
    const animation = startPageExit(exitingAction, opacity, translateY, scale, () => {
      onExitCompleteRef.current(clipId, exitingAction);
    });
    // Leaving the screen mid-exit must not fire the action afterwards.
    return () => animation.stop();
  }, [exitingAction, opacity, translateY, scale]);

  return (
    <View style={[styles.page, { height: pageHeight }]}>
      <Animated.View
        pointerEvents={exitingAction ? 'none' : 'auto'}
        style={[styles.pageCard, { opacity, transform: [{ translateY }, { scale }] }]}
      >
        <ClipCard
          clip={clip}
          variant="feature"
          fillHeight
          queueLabel={queueLabel}
          keyPoints={clip.key_points}
          onPress={() => onOpenDetail(clip.id)}
          onPreviewImage={onPreviewImage ? () => onPreviewImage(clip) : undefined}
        />
      </Animated.View>
    </View>
  );
});

/**
 * Today Review as a native vertical folio pager:
 * - swipe up for the next page, down to revisit the previous one;
 * - a paging `FlatList` owns the gesture, so there is no JS `PanResponder`
 *   fighting a `ScrollView` (and no Android edge-back conflict);
 * - browsing never triggers an action; the fixed footer buttons do, after the
 *   current leaf has animated out.
 */
export const ReviewDeck = forwardRef<ReviewDeckHandle, ReviewDeckProps>(function ReviewDeck(
  {
    items,
    currentIndex,
    disabled = false,
    refreshing = false,
    onRefresh,
    onIndexChange,
    onOpenDetail,
    onPreviewImage,
    onAction,
    onDraggingChange,
  },
  ref,
) {
  const [pageHeight, setPageHeight] = useState(0);
  const [exiting, setExiting] = useState<ExitingState | null>(null);

  const listRef = useRef<FlatList<ClipDetail>>(null);
  const draggingRef = useRef(false);
  const lastReportedIndexRef = useRef(clampPageIndex(currentIndex, items.length));
  const alignedOffsetRef = useRef<number | null>(null);
  const exitingRef = useRef<ExitingState | null>(null);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const indexRef = useRef(currentIndex);
  indexRef.current = currentIndex;
  const pageHeightRef = useRef(pageHeight);
  pageHeightRef.current = pageHeight;

  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const clampedIndex = clampPageIndex(currentIndex, items.length);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height);
    if (next <= 0) return;
    setPageHeight((previous) => (previous === next ? previous : next));
  }, []);

  const reportOffset = useCallback((offsetY: number): number => {
    const height = pageHeightRef.current;
    const next = resolvePageIndexFromOffset(offsetY, height, itemsRef.current.length);
    if (next !== lastReportedIndexRef.current) {
      lastReportedIndexRef.current = next;
      // Remember the page this offset belongs to so a later effect pass does
      // not mistake a user-driven page change for a stale external index.
      alignedOffsetRef.current = next * height;
      onIndexChangeRef.current(next);
    }
    return next;
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (pageHeightRef.current <= 0) return;
      reportOffset(event.nativeEvent.contentOffset.y);
    },
    [reportOffset],
  );

  const handleScrollBeginDrag = useCallback(() => {
    draggingRef.current = true;
    onDraggingChangeRef.current?.(true);
  }, []);

  /** Gesture is over (paging animation finished, or the thumb released slowly). */
  const settlePage = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (pageHeightRef.current <= 0) return;
      reportOffset(event.nativeEvent.contentOffset.y);
      draggingRef.current = false;
      onDraggingChangeRef.current?.(false);
    },
    [reportOffset],
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const velocityY = event.nativeEvent.velocity?.y ?? 0;
      // A slow release has no momentum left to wait for; a flick keeps
      // `draggingRef` until `onMomentumScrollEnd` so the external index effect
      // never snaps the deck mid-flight.
      if (Math.abs(velocityY) < SETTLED_VELOCITY) settlePage(event);
    },
    [settlePage],
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => settlePage(event),
    [settlePage],
  );

  // External driver (button action, silent refresh, rotation): align the native
  // offset with `currentIndex`, but never fight a finger that is still moving.
  useEffect(() => {
    if (pageHeight <= 0 || items.length === 0) return;
    if (draggingRef.current) return;

    const clamped = clampPageIndex(currentIndex, items.length);
    const offset = clamped * pageHeight;
    if (lastReportedIndexRef.current === clamped && alignedOffsetRef.current === offset) {
      return;
    }

    lastReportedIndexRef.current = clamped;
    alignedOffsetRef.current = offset;
    listRef.current?.scrollToOffset({ offset, animated: false });
  }, [currentIndex, items.length, pageHeight]);

  // Safety net: if the exiting leaf disappears from the batch (e.g. a silent
  // sync archived it from another device) its animation is stopped with the
  // leaf, so the pager must not stay locked forever.
  useEffect(() => {
    if (!exiting) return;
    if (items.some((item) => item.id === exiting.clipId)) return;
    exitingRef.current = null;
    setExiting(null);
  }, [exiting, items]);

  const triggerAction = useCallback((action: ReviewActionType) => {
    if (disabledRef.current || exitingRef.current) return;
    const list = itemsRef.current;
    const clip = list[clampPageIndex(indexRef.current, list.length)];
    if (!clip) return;

    const next: ExitingState = { clipId: clip.id, action };
    exitingRef.current = next;
    setExiting(next);
  }, []);

  useImperativeHandle(ref, () => ({ triggerAction }), [triggerAction]);

  const handleExitComplete = useCallback((clipId: string, action: ReviewActionType) => {
    if (exitingRef.current?.clipId === clipId) {
      exitingRef.current = null;
      setExiting(null);
    }
    onActionRef.current(action, clipId);
  }, []);

  const getItemLayout = useCallback(
    (_data: ArrayLike<ClipDetail> | null | undefined, index: number) => ({
      length: pageHeight,
      offset: pageHeight * index,
      index,
    }),
    [pageHeight],
  );

  const keyExtractor = useCallback((item: ClipDetail) => item.id, []);

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<ClipDetail>) => (
      <ReviewPageItem
        clip={item}
        pageHeight={pageHeight}
        queueLabel={`${index + 1}/${items.length}`}
        exitingAction={exiting && exiting.clipId === item.id ? exiting.action : null}
        onExitComplete={handleExitComplete}
        onOpenDetail={onOpenDetail}
        onPreviewImage={onPreviewImage}
      />
    ),
    [exiting, handleExitComplete, items.length, onOpenDetail, onPreviewImage, pageHeight],
  );

  const refreshControl = onRefresh ? (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.accent}
      colors={[colors.accent]}
      progressBackgroundColor={colors.sheet}
    />
  ) : undefined;

  return (
    <View style={styles.stage} onLayout={handleLayout}>
      {pageHeight > 0 ? (
        <FlatList
          ref={listRef}
          data={items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          extraData={exiting}
          pagingEnabled
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
          scrollEnabled={!disabled && exiting === null}
          scrollEventThrottle={32}
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          getItemLayout={getItemLayout}
          initialNumToRender={2}
          maxToRenderPerBatch={3}
          windowSize={3}
          style={styles.list}
          refreshControl={refreshControl}
        />
      ) : null}

      {pageHeight > 0 && items.length > 1 ? (
        <View pointerEvents="none" style={styles.pageDots}>
          {items.map((item, index) => (
            <View
              key={item.id}
              style={[styles.pageDot, index === clampedIndex && styles.pageDotActive]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    position: 'relative',
  },
  list: {
    flex: 1,
  },
  page: {
    // Full-screen leaf: vertical breathing room for the paper clamp and the
    // card shadow; the right 18px gutter holds the page dots.
    paddingHorizontal: 18,
    paddingTop: 2,
    paddingBottom: 10,
  },
  pageCard: {
    flex: 1,
  },
  pageDots: {
    position: 'absolute',
    right: 5,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  pageDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(31, 28, 24, 0.16)',
  },
  pageDotActive: {
    width: 4,
    height: 14,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
});
