import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type ListRenderItemInfo,
  type PanResponderGestureState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DISMISS_DISTANCE_PX,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  applyRubberBand,
  clamp,
  clampTranslation,
  computeDismissBackdropOpacity,
  computeFocalZoom,
  computeStepZoom,
  computeTouchMetrics,
  shouldDismissOnRelease,
  type LightboxImageItem,
} from './imageZoomMath';

/** Scale above which a page counts as zoomed (paging is locked). */
const ZOOM_THRESHOLD = 1.02;
/** Two taps closer than this are treated as a double tap. */
const DOUBLE_TAP_DELAY_MS = 300;
const DOUBLE_TAP_RADIUS_PX = 36;
/** Vertical movement before a pull-down-to-dismiss gesture is claimed. */
const DISMISS_START_PX = 8;
const BACKDROP_COLOR = 'rgba(18, 16, 14, 0.96)';
const INK = '#F7F2E8';

type GestureMode = 'none' | 'pinch' | 'pan' | 'dismiss';
type ImageLoadState = 'loading' | 'loaded' | 'error';

interface PinchAnchor {
  startDistance: number;
  startCenterX: number;
  startCenterY: number;
  startScale: number;
  startTranslateX: number;
  startTranslateY: number;
}

interface PanAnchor {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface ZoomUiState {
  /** Rounded to one decimal, used by the "1.0×" readout. */
  label: number;
  /** Rounded to two decimals, used to disable the +/− buttons precisely. */
  precise: number;
  /** True while the page is zoomed enough to lock horizontal paging. */
  zoomed: boolean;
}

export interface ImageLightboxModalProps {
  visible: boolean;
  images: LightboxImageItem[];
  initialIndex?: number;
  onClose: () => void;
}

/**
 * Full-screen image viewer with pinch-to-zoom, double-tap zoom, panning,
 * pull-down-to-dismiss and horizontal paging between images.
 *
 * Everything is implemented with RN primitives (`PanResponder` + `Animated`)
 * so Android gets the exact same behaviour as iOS — no `ScrollView`
 * `maximumZoomScale`, no extra native dependency.
 */
export function ImageLightboxModal({
  visible,
  images,
  initialIndex = 0,
  onClose,
}: ImageLightboxModalProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const total = images.length;
  const startIndex = total > 0 ? clamp(Math.round(initialIndex), 0, total - 1) : 0;

  // ---------------------------------------------------------------------------
  // Refs: gesture values are mirrored in refs so the PanResponder (created once)
  // always reads fresh numbers without re-subscribing mid-gesture.
  // ---------------------------------------------------------------------------
  const scaleAnim = useRef(new Animated.Value(MIN_ZOOM)).current;
  const translateXAnim = useRef(new Animated.Value(0)).current;
  const translateYAnim = useRef(new Animated.Value(0)).current;
  const dismissYAnim = useRef(new Animated.Value(0)).current;
  const chromeOpacityAnim = useRef(new Animated.Value(1)).current;

  const scaleRef = useRef(MIN_ZOOM);
  const translateXRef = useRef(0);
  const translateYRef = useRef(0);
  const dismissDistanceRef = useRef(0);
  const dismissOriginRef = useRef(0);

  const gestureModeRef = useRef<GestureMode>('none');
  const pinchRef = useRef<PinchAnchor | null>(null);
  const panRef = useRef<PanAnchor | null>(null);
  const lastTouchCountRef = useRef(0);

  const activeIndexRef = useRef(startIndex);
  const chromeVisibleRef = useRef(true);
  const zoomUiRef = useRef<ZoomUiState>({ label: MIN_ZOOM, precise: MIN_ZOOM, zoomed: false });

  const listRef = useRef<FlatList<LightboxImageItem>>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const mountedRef = useRef(true);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // ---------------------------------------------------------------------------
  // Render state
  // ---------------------------------------------------------------------------
  const [activeIndex, setActiveIndex] = useState(startIndex);
  const [zoomUi, setZoomUi] = useState<ZoomUiState>(zoomUiRef.current);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [dismissing, setDismissing] = useState(false);
  const [loadStates, setLoadStates] = useState<Record<string, ImageLoadState>>({});
  const [reloadCounts, setReloadCounts] = useState<Record<string, number>>({});

  // ---------------------------------------------------------------------------
  // Animated derivatives (created once; Values above never change identity)
  // ---------------------------------------------------------------------------
  const backdropOpacity = useMemo(
    () =>
      dismissYAnim.interpolate({
        inputRange: [0, DISMISS_DISTANCE_PX],
        // Keep the animated fade numerically aligned with the pure helper.
        outputRange: [
          computeDismissBackdropOpacity(0),
          computeDismissBackdropOpacity(DISMISS_DISTANCE_PX),
        ],
        extrapolate: 'clamp',
      }),
    [dismissYAnim],
  );

  const dismissScale = useMemo(
    () =>
      dismissYAnim.interpolate({
        inputRange: [0, DISMISS_DISTANCE_PX],
        outputRange: [1, 0.86],
        extrapolate: 'clamp',
      }),
    [dismissYAnim],
  );

  const combinedTranslateY = useMemo(
    () => Animated.add(translateYAnim, dismissYAnim),
    [dismissYAnim, translateYAnim],
  );

  const combinedScale = useMemo(
    () => Animated.multiply(scaleAnim, dismissScale),
    [dismissScale, scaleAnim],
  );

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const clearTapTimer = useCallback(() => {
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  }, []);

  const publishScale = useCallback((value: number) => {
    const clamped = clamp(value, MIN_ZOOM, MAX_ZOOM);
    const label = Math.round(clamped * 10) / 10;
    const precise = Math.round(clamped * 100) / 100;
    const zoomed = clamped > ZOOM_THRESHOLD;
    const previous = zoomUiRef.current;
    if (previous.label === label && previous.precise === precise && previous.zoomed === zoomed) {
      return;
    }
    const next: ZoomUiState = { label, precise, zoomed };
    zoomUiRef.current = next;
    setZoomUi(next);
  }, []);

  const stopTransformAnimations = useCallback(() => {
    scaleAnim.stopAnimation();
    translateXAnim.stopAnimation();
    translateYAnim.stopAnimation();
  }, [scaleAnim, translateXAnim, translateYAnim]);

  const setTransformValues = useCallback(
    (scale: number, x: number, y: number) => {
      scaleRef.current = scale;
      translateXRef.current = x;
      translateYRef.current = y;
      scaleAnim.setValue(scale);
      translateXAnim.setValue(x);
      translateYAnim.setValue(y);
      publishScale(scale);
    },
    [publishScale, scaleAnim, translateXAnim, translateYAnim],
  );

  const animateTransform = useCallback(
    (targetScale: number, targetX: number, targetY: number) => {
      scaleRef.current = targetScale;
      translateXRef.current = targetX;
      translateYRef.current = targetY;
      publishScale(targetScale);
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: targetScale,
          tension: 220,
          friction: 26,
          useNativeDriver: true,
        }),
        Animated.spring(translateXAnim, {
          toValue: targetX,
          tension: 220,
          friction: 26,
          useNativeDriver: true,
        }),
        Animated.spring(translateYAnim, {
          toValue: targetY,
          tension: 220,
          friction: 26,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [publishScale, scaleAnim, translateXAnim, translateYAnim],
  );

  const animateFocalZoom = useCallback(
    (targetScale: number, focalX: number, focalY: number) => {
      const result = computeFocalZoom({
        scale: Math.max(scaleRef.current, 0.01),
        targetScale,
        translateX: translateXRef.current,
        translateY: translateYRef.current,
        focalX,
        focalY,
        viewportWidth: width,
        viewportHeight: height,
      });
      animateTransform(result.scale, result.translateX, result.translateY);
    },
    [animateTransform, height, width],
  );

  const resetZoom = useCallback(
    (animated: boolean) => {
      dismissDistanceRef.current = 0;
      dismissOriginRef.current = 0;
      if (animated) {
        Animated.spring(dismissYAnim, {
          toValue: 0,
          tension: 240,
          friction: 28,
          useNativeDriver: true,
        }).start();
        animateTransform(MIN_ZOOM, 0, 0);
        return;
      }
      dismissYAnim.stopAnimation();
      dismissYAnim.setValue(0);
      stopTransformAnimations();
      setTransformValues(MIN_ZOOM, 0, 0);
    },
    [animateTransform, dismissYAnim, setTransformValues, stopTransformAnimations],
  );

  const settleZoom = useCallback(() => {
    const targetScale = clamp(scaleRef.current, MIN_ZOOM, MAX_ZOOM);
    if (targetScale <= MIN_ZOOM) {
      animateTransform(MIN_ZOOM, 0, 0);
      return;
    }
    const result = computeFocalZoom({
      scale: Math.max(scaleRef.current, 0.01),
      targetScale,
      translateX: translateXRef.current,
      translateY: translateYRef.current,
      focalX: width / 2,
      focalY: height / 2,
      viewportWidth: width,
      viewportHeight: height,
    });
    animateTransform(result.scale, result.translateX, result.translateY);
  }, [animateTransform, height, width]);

  const stepZoom = useCallback(
    (direction: 'in' | 'out') => {
      if (closingRef.current) return;
      const target = computeStepZoom(scaleRef.current, direction);
      if (Math.abs(target - scaleRef.current) < 0.001) return;
      if (target <= MIN_ZOOM) {
        animateTransform(MIN_ZOOM, 0, 0);
        return;
      }
      animateFocalZoom(target, width / 2, height / 2);
    },
    [animateFocalZoom, animateTransform, height, width],
  );

  const applyChrome = useCallback(
    (nextVisible: boolean, animated = true) => {
      chromeVisibleRef.current = nextVisible;
      setChromeVisible(nextVisible);
      if (!animated) {
        chromeOpacityAnim.setValue(nextVisible ? 1 : 0);
        return;
      }
      Animated.timing(chromeOpacityAnim, {
        toValue: nextVisible ? 1 : 0,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    },
    [chromeOpacityAnim],
  );

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTapTimer();
    lastTapRef.current = null;
    onCloseRef.current();
  }, [clearTapTimer]);

  const animateDismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTapTimer();
    Animated.timing(dismissYAnim, {
      toValue: height + 120,
      duration: 210,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      if (mountedRef.current) onCloseRef.current();
    });
  }, [clearTapTimer, dismissYAnim, height]);

  const handlePageTap = useCallback(
    (x: number, y: number) => {
      if (!visible || closingRef.current) return;

      const now = Date.now();
      const last = lastTapRef.current;
      const isDoubleTap =
        !!last &&
        now - last.at <= DOUBLE_TAP_DELAY_MS &&
        Math.abs(x - last.x) <= DOUBLE_TAP_RADIUS_PX &&
        Math.abs(y - last.y) <= DOUBLE_TAP_RADIUS_PX;

      if (isDoubleTap) {
        clearTapTimer();
        lastTapRef.current = null;
        if (scaleRef.current <= 1.05) {
          animateFocalZoom(DOUBLE_TAP_ZOOM, x, y);
        } else {
          animateTransform(MIN_ZOOM, 0, 0);
        }
        return;
      }

      lastTapRef.current = { at: now, x, y };
      clearTapTimer();
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        lastTapRef.current = null;
        if (!mountedRef.current) return;
        applyChrome(!chromeVisibleRef.current);
      }, DOUBLE_TAP_DELAY_MS);
    },
    [animateFocalZoom, animateTransform, applyChrome, clearTapTimer, visible],
  );

  const retryImage = useCallback((imageKey: string) => {
    setLoadStates((previous) => ({ ...previous, [imageKey]: 'loading' }));
    setReloadCounts((previous) => ({ ...previous, [imageKey]: (previous[imageKey] ?? 0) + 1 }));
  }, []);

  const markImageState = useCallback((imageKey: string, state: ImageLoadState) => {
    setLoadStates((previous) =>
      previous[imageKey] === state ? previous : { ...previous, [imageKey]: state },
    );
  }, []);

  const markImageLoadEnd = useCallback((imageKey: string) => {
    setLoadStates((previous) => {
      const current = previous[imageKey];
      if (current === 'error' || current === 'loaded') return previous;
      return { ...previous, [imageKey]: 'loaded' };
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Open / close lifecycle: reset transforms so every open starts at 1x.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTapTimer();
    };
  }, [clearTapTimer]);

  // Reset transforms before the modal's first frame so reopening always starts
  // at 1x with no flash of the previous session's zoom.
  useLayoutEffect(() => {
    if (!visible) {
      // Keep timers from firing while the modal fades out / stays hidden.
      clearTapTimer();
      lastTapRef.current = null;
      gestureModeRef.current = 'none';
      pinchRef.current = null;
      panRef.current = null;
      lastTouchCountRef.current = 0;
      setDismissing(false);
      return;
    }

    closingRef.current = false;
    activeIndexRef.current = startIndex;
    setActiveIndex(startIndex);
    setDismissing(false);
    resetZoom(false);
    applyChrome(true, false);
    // `startIndex` is derived from initialIndex/images.length; include both.
  }, [applyChrome, clearTapTimer, images.length, resetZoom, startIndex, visible]);

  // Land on the requested page even if FlatList was already mounted.
  useEffect(() => {
    if (!visible || total === 0 || width <= 0) return undefined;
    const frame = requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToOffset({ offset: startIndex * width, animated: false });
      } catch {
        // The list may not be laid out yet; initialScrollIndex covers that case.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [startIndex, total, visible, width]);

  // Reset the page indicator when a fresh media list arrives while open.
  useEffect(() => {
    if (activeIndexRef.current <= total - 1) return;
    const nextIndex = Math.max(0, total - 1);
    activeIndexRef.current = nextIndex;
    setActiveIndex(nextIndex);
  }, [total]);

  const syncPageFromOffset = useCallback(
    (offsetX: number) => {
      if (total === 0 || width <= 0 || !Number.isFinite(offsetX)) return;
      const candidate = clamp(Math.round(offsetX / width), 0, total - 1);
      if (candidate === activeIndexRef.current) return;
      // Only commit once the pager is basically resting on the page boundary.
      if (Math.abs(offsetX - candidate * width) > 2) return;
      activeIndexRef.current = candidate;
      setActiveIndex(candidate);
      if (
        Math.abs(scaleRef.current - MIN_ZOOM) > 0.001 ||
        Math.abs(translateXRef.current) > 0.5 ||
        Math.abs(translateYRef.current) > 0.5
      ) {
        resetZoom(true);
      }
    },
    [resetZoom, total, width],
  );

  // ---------------------------------------------------------------------------
  // PanResponder: 2 fingers = pinch, zoomed 1 finger = pan, 1 finger down =
  // dismiss pull. Horizontal swipes are left to the FlatList pager.
  // ---------------------------------------------------------------------------
  const panResponder = useMemo(() => {
    const shouldClaimMove = (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (event.nativeEvent.touches.length >= 2) return true;
      if (scaleRef.current > ZOOM_THRESHOLD) {
        return Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3;
      }
      return gesture.dy > DISMISS_START_PX && gesture.dy > Math.abs(gesture.dx) * 1.2;
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length >= 2,
      onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: shouldClaimMove,
      onMoveShouldSetPanResponderCapture: shouldClaimMove,
      onPanResponderGrant: (event, gesture) => {
        stopTransformAnimations();
        const metrics = computeTouchMetrics(event.nativeEvent.touches);
        lastTouchCountRef.current = event.nativeEvent.touches.length;

        if (metrics) {
          pinchRef.current = {
            startDistance: Math.max(metrics.distance, 1),
            startCenterX: metrics.centerX,
            startCenterY: metrics.centerY,
            startScale: scaleRef.current,
            startTranslateX: translateXRef.current,
            startTranslateY: translateYRef.current,
          };
          gestureModeRef.current = 'pinch';
          return;
        }

        if (scaleRef.current > ZOOM_THRESHOLD) {
          panRef.current = {
            startX: translateXRef.current,
            startY: translateYRef.current,
            originX: gesture.dx,
            originY: gesture.dy,
          };
          gestureModeRef.current = 'pan';
          return;
        }

        gestureModeRef.current = 'dismiss';
        dismissOriginRef.current = Math.max(0, gesture.dy);
        dismissDistanceRef.current = 0;
        setDismissing(true);
      },
      onPanResponderMove: (event, gesture) => {
        const touchCount = event.nativeEvent.touches.length;
        const metrics = computeTouchMetrics(event.nativeEvent.touches);

        if (metrics) {
          const joinedMidGesture =
            !pinchRef.current ||
            gestureModeRef.current !== 'pinch' ||
            touchCount !== lastTouchCountRef.current;
          lastTouchCountRef.current = touchCount;

          if (joinedMidGesture) {
            // Re-anchor from the current transform so the image never jumps.
            pinchRef.current = {
              startDistance: Math.max(metrics.distance, 1),
              startCenterX: metrics.centerX,
              startCenterY: metrics.centerY,
              startScale: scaleRef.current,
              startTranslateX: translateXRef.current,
              startTranslateY: translateYRef.current,
            };
            gestureModeRef.current = 'pinch';
            setDismissing(false);
            dismissDistanceRef.current = 0;
            dismissYAnim.setValue(0);
            return;
          }

          const pinch = pinchRef.current;
          if (!pinch) return;

          const rawScale = pinch.startScale * (metrics.distance / pinch.startDistance);
          const nextScale = applyRubberBand(rawScale, MIN_ZOOM, MAX_ZOOM);
          const ratio = nextScale / pinch.startScale;

          const anchorOffsetX = pinch.startCenterX - width / 2;
          const anchorOffsetY = pinch.startCenterY - height / 2;
          let nextX = anchorOffsetX - (anchorOffsetX - pinch.startTranslateX) * ratio;
          let nextY = anchorOffsetY - (anchorOffsetY - pinch.startTranslateY) * ratio;

          // Two-finger drag also pans the image.
          nextX += metrics.centerX - pinch.startCenterX;
          nextY += metrics.centerY - pinch.startCenterY;

          if (nextScale > MIN_ZOOM) {
            const bounded = clampTranslation(nextX, nextY, width, height, nextScale);
            nextX = bounded.x;
            nextY = bounded.y;
          }

          setTransformValues(nextScale, nextX, nextY);
          return;
        }

        lastTouchCountRef.current = touchCount;

        if (gestureModeRef.current === 'pan' && panRef.current) {
          const pan = panRef.current;
          const nextX = pan.startX + (gesture.dx - pan.originX);
          const nextY = pan.startY + (gesture.dy - pan.originY);
          const bounded = clampTranslation(nextX, nextY, width, height, scaleRef.current);
          setTransformValues(scaleRef.current, bounded.x, bounded.y);
          return;
        }

        if (gestureModeRef.current === 'dismiss') {
          const dy = Math.max(0, gesture.dy - dismissOriginRef.current);
          dismissDistanceRef.current = dy;
          dismissYAnim.setValue(dy);
        }
      },
      onPanResponderRelease: (_event, gesture) => {
        const mode = gestureModeRef.current;
        gestureModeRef.current = 'none';
        pinchRef.current = null;
        panRef.current = null;
        lastTouchCountRef.current = 0;

        if (mode === 'pinch' || mode === 'pan') {
          setDismissing(false);
          settleZoom();
          return;
        }

        if (mode === 'dismiss') {
          const dy = dismissDistanceRef.current;
          setDismissing(false);
          if (shouldDismissOnRelease(dy, gesture.vy)) {
            animateDismiss();
          } else {
            Animated.spring(dismissYAnim, {
              toValue: 0,
              tension: 240,
              friction: 28,
              useNativeDriver: true,
            }).start(() => {
              dismissDistanceRef.current = 0;
            });
          }
        }
      },
      onPanResponderTerminate: () => {
        const mode = gestureModeRef.current;
        gestureModeRef.current = 'none';
        pinchRef.current = null;
        panRef.current = null;
        lastTouchCountRef.current = 0;
        setDismissing(false);

        if (mode === 'dismiss') {
          Animated.spring(dismissYAnim, {
            toValue: 0,
            tension: 240,
            friction: 28,
            useNativeDriver: true,
          }).start(() => {
            dismissDistanceRef.current = 0;
          });
          return;
        }
        if (mode === 'pinch' || mode === 'pan') settleZoom();
      },
      onPanResponderTerminationRequest: () => gestureModeRef.current === 'none',
    });
  }, [
    animateDismiss,
    dismissYAnim,
    height,
    setTransformValues,
    settleZoom,
    stopTransformAnimations,
    width,
  ]);

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const safeActiveIndex = total > 0 ? Math.min(activeIndex, total - 1) : 0;
  const currentImage = total > 0 ? images[safeActiveIndex] : null;

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<LightboxImageItem>) => {
      const imageKey = `${item.id}:${item.uri}`;
      const state = loadStates[imageKey] ?? 'loading';
      const reload = reloadCounts[imageKey] ?? 0;
      const isActive = index === safeActiveIndex;

      return (
        <View style={{ width, height, overflow: 'hidden' }}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={(event: GestureResponderEvent) =>
              handlePageTap(
                event.nativeEvent.pageX ?? event.nativeEvent.locationX,
                event.nativeEvent.pageY ?? event.nativeEvent.locationY,
              )
            }
            accessibilityRole="imagebutton"
            accessibilityLabel={item.caption ? `查看图片 ${item.caption}` : '查看图片'}
          >
            {state === 'error' ? (
              <View style={styles.errorState}>
                <Ionicons name="image-outline" size={34} color="rgba(247, 242, 232, 0.5)" />
                <Text style={styles.errorTitle}>图片加载失败</Text>
                <Text style={styles.errorHint}>本地存档可能已清理，或当前网络暂时不可用。</Text>
                <Pressable
                  onPress={() => retryImage(imageKey)}
                  style={styles.retryButton}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="重新加载图片"
                >
                  <Ionicons name="refresh" size={14} color={INK} />
                  <Text style={styles.retryText}>重新加载</Text>
                </Pressable>
              </View>
            ) : (
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  isActive
                    ? {
                        transform: [
                          { translateX: translateXAnim },
                          { translateY: combinedTranslateY },
                          { scale: combinedScale },
                        ],
                      }
                    : null,
                ]}
              >
                <Image
                  key={`${imageKey}-${reload}`}
                  source={{ uri: item.uri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="contain"
                  onLoadStart={() => markImageState(imageKey, 'loading')}
                  onLoad={() => markImageState(imageKey, 'loaded')}
                  onLoadEnd={() => markImageLoadEnd(imageKey)}
                  onError={() => markImageState(imageKey, 'error')}
                />
                {state === 'loading' ? (
                  <View style={styles.loadingOverlay} pointerEvents="none">
                    <ActivityIndicator size="small" color="rgba(247, 242, 232, 0.8)" />
                  </View>
                ) : null}
              </Animated.View>
            )}
          </Pressable>
        </View>
      );
    },
    [
      combinedScale,
      combinedTranslateY,
      handlePageTap,
      height,
      loadStates,
      markImageLoadEnd,
      markImageState,
      reloadCounts,
      retryImage,
      safeActiveIndex,
      translateXAnim,
      width,
    ],
  );

  const listKey = `lightbox-${startIndex}-${total}`;

  const getItemLayout = useCallback(
    (_data: ArrayLike<LightboxImageItem> | null | undefined, index: number) => ({
      length: width,
      offset: width * index,
      index,
    }),
    [width],
  );

  const handleListScroll = useCallback(
    (offsetX: number) => syncPageFromOffset(offsetX),
    [syncPageFromOffset],
  );

  const handleScrollToIndexFailed = useCallback(
    ({ index }: { index: number }) => {
      try {
        listRef.current?.scrollToOffset({ offset: index * width, animated: false });
      } catch {
        // Layout not ready yet; the next frame/effect retries.
      }
    },
    [width],
  );

  const keyExtractor = useCallback((item: LightboxImageItem) => item.id, []);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={handleClose}
    >
      <View style={styles.root}>
        <Animated.View
          style={[styles.backdrop, { opacity: backdropOpacity }]}
          pointerEvents="none"
        />

        <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
          {total > 0 ? (
            <FlatList
              key={listKey}
              ref={listRef}
              data={images}
              extraData={safeActiveIndex}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              scrollEnabled={!zoomUi.zoomed && !dismissing}
              getItemLayout={getItemLayout}
              initialScrollIndex={startIndex}
              onScrollToIndexFailed={handleScrollToIndexFailed}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              scrollEventThrottle={32}
              onScroll={(event) => handleListScroll(event.nativeEvent.contentOffset.x)}
              onMomentumScrollEnd={(event) => handleListScroll(event.nativeEvent.contentOffset.x)}
              windowSize={5}
              initialNumToRender={3}
            />
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="images-outline" size={34} color="rgba(247, 242, 232, 0.5)" />
              <Text style={styles.emptyText}>暂无可预览的图片</Text>
            </View>
          )}
        </View>

        <Animated.View
          style={[
            styles.topBar,
            { paddingTop: Math.max(insets.top, 8) + 10, opacity: chromeOpacityAnim },
          ]}
          pointerEvents={chromeVisible ? 'box-none' : 'none'}
        >
          <View style={styles.counterPill}>
            <Text style={styles.counterText}>
              {total > 0 ? `${safeActiveIndex + 1} / ${total}` : '0 / 0'}
            </Text>
          </View>

          <Pressable
            onPress={handleClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="关闭图片预览"
          >
            <Ionicons name="close" size={20} color={INK} />
          </Pressable>
        </Animated.View>

        <Animated.View
          style={[
            styles.bottomBar,
            { paddingBottom: Math.max(insets.bottom, 12) + 12, opacity: chromeOpacityAnim },
          ]}
          pointerEvents={chromeVisible ? 'box-none' : 'none'}
        >
          {currentImage?.caption ? (
            <Text style={styles.caption} numberOfLines={1}>
              {currentImage.caption}
            </Text>
          ) : null}

          <View style={styles.zoomCapsule}>
            <Pressable
              onPress={() => stepZoom('out')}
              disabled={zoomUi.precise <= MIN_ZOOM + 0.01}
              style={({ pressed }) => [
                styles.zoomButton,
                zoomUi.precise <= MIN_ZOOM + 0.01 && styles.zoomButtonDisabled,
                pressed && styles.pressed,
              ]}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="缩小图片"
            >
              <Ionicons name="remove" size={19} color={INK} />
            </Pressable>

            <Pressable
              onPress={() => animateTransform(MIN_ZOOM, 0, 0)}
              style={({ pressed }) => [styles.zoomReadout, pressed && styles.pressed]}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`当前 ${zoomUi.label.toFixed(1)} 倍，点击复位`}
            >
              <Text style={styles.zoomReadoutText}>{`${zoomUi.label.toFixed(1)}×`}</Text>
            </Pressable>

            <Pressable
              onPress={() => stepZoom('in')}
              disabled={zoomUi.precise >= MAX_ZOOM - 0.01}
              style={({ pressed }) => [
                styles.zoomButton,
                zoomUi.precise >= MAX_ZOOM - 0.01 && styles.zoomButtonDisabled,
                pressed && styles.pressed,
              ]}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="放大图片"
            >
              <Ionicons name="add" size={19} color={INK} />
            </Pressable>
          </View>

          <Text style={styles.gestureHint}>双击放大 · 双指缩放 · 下拉关闭</Text>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BACKDROP_COLOR,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 18,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counterPill: {
    minWidth: 62,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(18, 16, 14, 0.46)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(247, 242, 232, 0.18)',
    alignItems: 'center',
  },
  counterText: {
    color: INK,
    fontSize: 12.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18, 16, 14, 0.46)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(247, 242, 232, 0.2)',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 16,
    alignItems: 'center',
    gap: 10,
  },
  caption: {
    maxWidth: '86%',
    color: 'rgba(247, 242, 232, 0.78)',
    fontSize: 12.5,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  zoomCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(18, 16, 14, 0.62)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(247, 242, 232, 0.18)',
  },
  zoomButton: {
    width: 42,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomButtonDisabled: {
    opacity: 0.28,
  },
  zoomReadout: {
    minWidth: 62,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomReadoutText: {
    color: INK,
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  gestureHint: {
    color: 'rgba(247, 242, 232, 0.42)',
    fontSize: 11,
    letterSpacing: 0.3,
  },
  pressed: {
    opacity: 0.62,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorState: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 40,
  },
  errorTitle: {
    color: INK,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
  errorHint: {
    color: 'rgba(247, 242, 232, 0.56)',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(247, 242, 232, 0.36)',
    backgroundColor: 'rgba(247, 242, 232, 0.08)',
  },
  retryText: {
    color: INK,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emptyText: {
    color: 'rgba(247, 242, 232, 0.62)',
    fontSize: 13,
  },
});
