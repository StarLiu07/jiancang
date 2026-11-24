import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, elevation, radius, spacing } from '../theme';

export const MOTION = {
  springSnappy: { tension: 260, friction: 22, useNativeDriver: true },
  springGentle: { tension: 150, friction: 20, useNativeDriver: true },
  springPop: { tension: 220, friction: 16, useNativeDriver: true },
  easeOut: Easing.out(Easing.cubic),
  easeIn: Easing.in(Easing.cubic),
} as const;

interface SpringPressableProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  activeOpacity?: number;
}

/**
 * Tactile pressable with spring scale-down and crisp release rebound.
 * Runs 100% on the native UI thread.
 */
export function SpringPressable({
  children,
  style,
  contentStyle,
  scaleTo = 0.968,
  activeOpacity = 0.92,
  disabled,
  onPressIn,
  onPressOut,
  ...rest
}: SpringPressableProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const handlePressIn: PressableProps['onPressIn'] = (event) => {
    if (!disabled) {
      Animated.parallel([
        Animated.spring(scale, { toValue: scaleTo, ...MOTION.springSnappy }),
        Animated.timing(opacity, {
          toValue: activeOpacity,
          duration: 90,
          easing: MOTION.easeOut,
          useNativeDriver: true,
        }),
      ]).start();
    }
    onPressIn?.(event);
  };

  const handlePressOut: PressableProps['onPressOut'] = (event) => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, ...MOTION.springSnappy }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 140,
        easing: MOTION.easeOut,
        useNativeDriver: true,
      }),
    ]).start();
    onPressOut?.(event);
  };

  return (
    <Pressable
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={style}
      {...rest}
    >
      <Animated.View style={[contentStyle, { transform: [{ scale }], opacity }]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

interface FadeSlideInProps {
  children: ReactNode;
  delay?: number;
  distance?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}

/** Smooth native-driven fade + vertical settle for staggered page entrances. */
export function FadeSlideIn({
  children,
  delay = 0,
  distance = 12,
  duration = 280,
  style,
}: FadeSlideInProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      easing: MOTION.easeOut,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, delay, duration]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [distance, 0],
  });

  return (
    <Animated.View style={[style, { opacity: progress, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

/** Shared warm-paper breathing shimmer value for skeleton loaders. */
function usePulse() {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.92,
          duration: 880,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.42,
          duration: 880,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return pulse;
}

function SkeletonBone({
  width,
  height,
  borderRadius = radius.sm,
  opacity,
  style,
}: {
  width: number | `${number}%`;
  height: number;
  borderRadius?: number;
  opacity: Animated.Value;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: colors.surfaceAlt,
          opacity,
        },
        style,
      ]}
    />
  );
}

export function SkeletonHeroCard() {
  const pulse = usePulse();
  return (
    <View style={styles.heroWrap}>
      <View style={styles.heroCard}>
        <View style={styles.heroCoverPad}>
          <Animated.View style={[styles.heroCover, { opacity: pulse }]} />
        </View>
        <View style={styles.heroBody}>
          <SkeletonBone width="40%" height={12} opacity={pulse} />
          <SkeletonBone width="92%" height={20} opacity={pulse} />
          <SkeletonBone width="68%" height={20} opacity={pulse} />
          <SkeletonBone width="100%" height={14} opacity={pulse} style={{ marginTop: 6 }} />
          <SkeletonBone width="86%" height={14} opacity={pulse} />
          <View style={styles.tagRow}>
            <SkeletonBone width={48} height={14} borderRadius={4} opacity={pulse} />
            <SkeletonBone width={56} height={14} borderRadius={4} opacity={pulse} />
          </View>
        </View>
      </View>
      <View style={styles.actionSkeletonRow}>
        <SkeletonBone width="34%" height={44} borderRadius={radius.md} opacity={pulse} />
        <SkeletonBone width="46%" height={44} borderRadius={radius.md} opacity={pulse} />
        <SkeletonBone width={44} height={44} borderRadius={radius.md} opacity={pulse} />
      </View>
    </View>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  const pulse = usePulse();
  return (
    <View style={styles.listWrap}>
      {Array.from({ length: count }).map((_, idx) => (
        <View
          key={idx}
          style={[styles.listRow, idx < count - 1 && styles.listRowBorder]}
        >
          <View style={styles.listBody}>
            <SkeletonBone width={96} height={12} opacity={pulse} />
            <SkeletonBone width="94%" height={16} opacity={pulse} />
            <SkeletonBone width="72%" height={14} opacity={pulse} />
            <SkeletonBone width="54%" height={12} opacity={pulse} />
          </View>
          <SkeletonBone width={68} height={68} borderRadius={radius.sm} opacity={pulse} style={{ marginTop: 4 }} />
        </View>
      ))}
    </View>
  );
}

export function SkeletonDetail() {
  const pulse = usePulse();
  return (
    <View style={styles.detailWrap}>
      <SkeletonBone width={140} height={13} opacity={pulse} />
      <SkeletonBone width="95%" height={24} opacity={pulse} />
      <SkeletonBone width="70%" height={24} opacity={pulse} />
      <View style={styles.detailDigestBox}>
        <SkeletonBone width={64} height={12} opacity={pulse} />
        <SkeletonBone width="100%" height={15} opacity={pulse} />
        <SkeletonBone width="88%" height={15} opacity={pulse} />
        <SkeletonBone width="76%" height={13} opacity={pulse} style={{ marginTop: 6 }} />
      </View>
      <SkeletonBone width="100%" height={15} opacity={pulse} />
      <SkeletonBone width="96%" height={15} opacity={pulse} />
      <SkeletonBone width="84%" height={15} opacity={pulse} />
    </View>
  );
}

const styles = StyleSheet.create({
  heroWrap: {
    gap: spacing.lg,
    marginTop: 6,
  },
  heroCard: {
    backgroundColor: colors.sheet,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...elevation.card,
  },
  heroCoverPad: {
    paddingHorizontal: 14,
    paddingTop: 18,
  },
  heroCover: {
    width: '100%',
    aspectRatio: 4 / 2.65,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  heroBody: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 10,
  },
  tagRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  actionSkeletonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  listWrap: {
    paddingTop: 4,
  },
  listRow: {
    flexDirection: 'row',
    gap: 14,
    paddingVertical: 15,
    alignItems: 'flex-start',
  },
  listRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  listBody: {
    flex: 1,
    gap: 8,
  },
  detailWrap: {
    flex: 1,
    backgroundColor: colors.sheet,
    paddingHorizontal: 22,
    paddingTop: 20,
    gap: 14,
  },
  detailDigestBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 16,
    gap: 10,
    marginVertical: 4,
  },
});
