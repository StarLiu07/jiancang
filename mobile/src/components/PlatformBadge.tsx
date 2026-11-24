import { StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, radius, spacing } from '../theme';
import type { Platform } from '../types';

interface PlatformBadgeProps {
  platform: Platform;
  size?: 'sm' | 'md';
  muted?: boolean;
  glass?: boolean;
}

export function PlatformBadge({
  platform,
  size = 'sm',
  muted = false,
  glass = false,
}: PlatformBadgeProps) {
  const meta = platformMeta[platform];
  const compact = size === 'sm';
  const isX = platform === 'x';

  const bg = glass
    ? 'rgba(9, 11, 15, 0.72)'
    : muted
      ? colors.glass
      : isX
        ? 'rgba(230, 234, 242, 0.08)'
        : meta.softColor;

  const borderColor = glass
    ? colors.borderStrong
    : muted
      ? 'transparent'
      : isX
        ? 'rgba(230, 234, 242, 0.22)'
        : `${meta.color}38`;

  const textColor = glass
    ? colors.text
    : muted
      ? colors.textSecondary
      : isX
        ? colors.text
        : meta.color;

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: bg,
          borderColor,
          paddingHorizontal: compact ? 8 : 10,
          paddingVertical: compact ? 3 : 4,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: meta.color }]} />
      <Text style={[styles.label, { color: textColor, fontSize: compact ? 10.5 : 11.5 }]}>
        {meta.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 5.5,
    height: 5.5,
    borderRadius: 3,
  },
  label: {
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
