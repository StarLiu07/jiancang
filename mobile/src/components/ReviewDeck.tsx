import { Ionicons } from '@expo/vector-icons';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { colors, radius, spacing } from '../theme';
import type { ClipDetail, ReviewActionType } from '../types';
import { ClipCard } from './ClipCard';
import { MOTION } from './Motion';
import {
  computeSwipeThreshold,
  resolveSwipeRelease,
  shouldCaptureHorizontalSwipe,
} from './reviewSwipeMath';

/** Extra travel past the screen edge while the card flies out. */
const FLY_OUT_GUTTER = 90;

export interface ReviewDeckHandle {
  triggerAction: (action: ReviewActionType) => void;
}

interface ReviewDeckProps {
  clip: ClipDetail;
  queueLabel: string;
  remaining: number;
  disabled?: boolean;
  /** Bottom action bar + hint, rendered inside the same swipe stage as the card. */
  footer?: ReactNode;
  onOpenDetail: () => void;
  onPreviewImage?: () => void;
  onAction: (action: ReviewActionType) => void;
  onDraggingChange?: (dragging: boolean) => void;
}

/**
 * Interactive stacked card deck for Today Review:
 * - Drag right to Archive ("已消化"), drag left to Snooze ("留待下次")
 * - Behind-card deck layers rise & scale smoothly as you drag
 * - Also exposes imperative `triggerAction` so bottom buttons drive the same physics
 */
export const ReviewDeck = forwardRef<ReviewDeckHandle, ReviewDeckProps>(function ReviewDeck(
  {
    clip,
    queueLabel,
    remaining,
    disabled = false,
    footer,
    onOpenDetail,
    onPreviewImage,
    onAction,
    onDraggingChange,
  },
  ref,
) {
  const { width: screenWidth } = useWindowDimensions();
  const swipeThreshold = useMemo(() => computeSwipeThreshold(screenWidth), [screenWidth]);

  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(1)).current;
  const cardOpacity = useRef(new Animated.Value(1)).current;

  const animatingRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;

  const hasMountedRef = useRef(false);

  // Settle newly promoted card smoothly from the stacked layer behind it
  useEffect(() => {
    animatingRef.current = false;
    panX.setValue(0);
    panY.setValue(0);

    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      cardScale.setValue(1);
      cardOpacity.setValue(1);
      return;
    }

    cardScale.setValue(0.955);
    panY.setValue(10);
    cardOpacity.setValue(0.75);

    Animated.parallel([
      Animated.spring(cardScale, { toValue: 1, ...MOTION.springGentle }),
      Animated.spring(panY, { toValue: 0, ...MOTION.springGentle }),
      Animated.timing(cardOpacity, {
        toValue: 1,
        duration: 210,
        easing: MOTION.easeOut,
        useNativeDriver: true,
      }),
    ]).start();
  }, [clip.id, panX, panY, cardScale, cardOpacity]);

  const flyOut = useCallback(
    (action: ReviewActionType) => {
      if (animatingRef.current || disabledRef.current) return;
      animatingRef.current = true;
      onDraggingChangeRef.current?.(false);

      if (action === 'delete') {
        Animated.parallel([
          Animated.timing(cardScale, {
            toValue: 0.9,
            duration: 185,
            easing: MOTION.easeIn,
            useNativeDriver: true,
          }),
          Animated.timing(panY, {
            toValue: 26,
            duration: 185,
            easing: MOTION.easeIn,
            useNativeDriver: true,
          }),
          Animated.timing(cardOpacity, {
            toValue: 0,
            duration: 175,
            easing: MOTION.easeIn,
            useNativeDriver: true,
          }),
        ]).start(() => {
          animatingRef.current = false;
          onActionRef.current(action);
        });
        return;
      }

      const flyOutDistance = screenWidth + FLY_OUT_GUTTER;
      const toX = action === 'archive' ? flyOutDistance : -flyOutDistance;
      Animated.parallel([
        Animated.timing(panX, {
          toValue: toX,
          duration: 230,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(panY, {
          toValue: -18,
          duration: 230,
          easing: MOTION.easeOut,
          useNativeDriver: true,
        }),
        Animated.timing(cardOpacity, {
          toValue: 0,
          duration: 210,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
      ]).start(() => {
        animatingRef.current = false;
        onActionRef.current(action);
      });
    },
    [panX, panY, cardScale, cardOpacity, screenWidth],
  );

  useImperativeHandle(ref, () => ({ triggerAction: flyOut }), [flyOut]);

  const snapBack = useCallback(() => {
    onDraggingChangeRef.current?.(false);
    Animated.parallel([
      Animated.spring(panX, { toValue: 0, ...MOTION.springPop }),
      Animated.spring(panY, { toValue: 0, ...MOTION.springPop }),
    ]).start();
  }, [panX, panY]);

  const panResponder = useMemo(() => {
    const canSwipe = () => !disabledRef.current && !animatingRef.current;
    const shouldCapture = (_evt: unknown, gesture: { dx: number; dy: number }) =>
      canSwipe() && shouldCaptureHorizontalSwipe(gesture.dx, gesture.dy);

    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Capture on the parent stage so a thumb that starts on the bottom action
      // bar still drags the card, even when a Pressable is under the finger.
      onMoveShouldSetPanResponderCapture: shouldCapture,
      onMoveShouldSetPanResponder: shouldCapture,
      // Never hand a committed swipe to the ScrollView halfway through an arc.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        onDraggingChangeRef.current?.(true);
      },
      onPanResponderMove: (_evt, gesture) => {
        panX.setValue(gesture.dx);
        panY.setValue(gesture.dy * 0.16);
      },
      onPanResponderRelease: (_evt, gesture) => {
        const action = resolveSwipeRelease(gesture.dx, gesture.vx, screenWidth);
        if (action) {
          flyOut(action);
        } else {
          snapBack();
        }
      },
      onPanResponderTerminate: () => {
        snapBack();
      },
    });
  }, [panX, panY, flyOut, snapBack, screenWidth]);

  const rotate = panX.interpolate({
    inputRange: [-240, 0, 240],
    outputRange: ['-8.5deg', '0deg', '8.5deg'],
    extrapolate: 'clamp',
  });

  const archiveStampOpacity = panX.interpolate({
    inputRange: [24, swipeThreshold],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const archiveStampScale = panX.interpolate({
    inputRange: [24, swipeThreshold],
    outputRange: [0.86, 1],
    extrapolate: 'clamp',
  });

  const snoozeStampOpacity = panX.interpolate({
    inputRange: [-swipeThreshold, -24],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const snoozeStampScale = panX.interpolate({
    inputRange: [-swipeThreshold, -24],
    outputRange: [1, 0.86],
    extrapolate: 'clamp',
  });

  // Behind-card deck promotion linked directly to horizontal drag progress
  const nearScale = panX.interpolate({
    inputRange: [-180, 0, 180],
    outputRange: [0.995, 0.945, 0.995],
    extrapolate: 'clamp',
  });

  const nearTranslateY = panX.interpolate({
    inputRange: [-180, 0, 180],
    outputRange: [-4, 0, -4],
    extrapolate: 'clamp',
  });

  const farTranslateY = panX.interpolate({
    inputRange: [-180, 0, 180],
    outputRange: [-4, 0, -4],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.deckWrap}>
      <View {...panResponder.panHandlers} style={styles.stage}>
        <View style={styles.cardStage}>
          {remaining >= 2 ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.deckGhostFar, { transform: [{ translateY: farTranslateY }] }]}
            />
          ) : null}

          {remaining >= 1 ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.deckGhostNear,
                { transform: [{ scale: nearScale }, { translateY: nearTranslateY }] },
              ]}
            />
          ) : null}

          <Animated.View
            style={[
              styles.cardWrap,
              {
                opacity: cardOpacity,
                transform: [
                  { translateX: panX },
                  { translateY: panY },
                  { rotate },
                  { scale: cardScale },
                ],
              },
            ]}
          >
            <ClipCard
              clip={clip}
              variant="feature"
              fillHeight
              queueLabel={queueLabel}
              keyPoints={clip.key_points}
              onPress={onOpenDetail}
              onPreviewImage={onPreviewImage}
            />

            {/* Swipe right intent stamp: 已消化 */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.stamp,
                styles.stampArchive,
                { opacity: archiveStampOpacity, transform: [{ scale: archiveStampScale }] },
              ]}
            >
              <Ionicons name="checkmark" size={16} color={colors.onAccent} />
              <Text style={styles.stampArchiveText}>已消化</Text>
            </Animated.View>

            {/* Swipe left intent stamp: 留待下次 */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.stamp,
                styles.stampSnooze,
                { opacity: snoozeStampOpacity, transform: [{ scale: snoozeStampScale }] },
              ]}
            >
              <Ionicons name="time-outline" size={15} color={colors.bg} />
              <Text style={styles.stampSnoozeText}>留待下次</Text>
            </Animated.View>
          </Animated.View>
        </View>

        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  deckWrap: {
    // flexGrow (not flex) keeps the intrinsic leaf height as the flex basis so
    // short screens can scroll; tall screens still fill the remaining stage.
    flexGrow: 1,
    position: 'relative',
    // ClipCard 内部已含 paddingTop: 6（纸夹预留位），此处不再叠加
    paddingTop: 0,
  },
  stage: {
    flexGrow: 1,
  },
  cardStage: {
    flexGrow: 1,
    // 留出卡组下层纸张探出的缝隙
    paddingBottom: 12,
  },
  deckGhostNear: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 6,
    height: 40,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  deckGhostFar: {
    position: 'absolute',
    left: 26,
    right: 26,
    bottom: 0,
    height: 32,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
  },
  cardWrap: {
    flexGrow: 1,
    position: 'relative',
  },
  footer: {
    gap: 10,
    paddingTop: 2,
  },
  stamp: {
    position: 'absolute',
    top: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  stampArchive: {
    left: spacing.md,
    backgroundColor: colors.accent,
  },
  stampArchiveText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '700',
  },
  stampSnooze: {
    right: spacing.md,
    backgroundColor: colors.text,
  },
  stampSnoozeText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '600',
  },
});
