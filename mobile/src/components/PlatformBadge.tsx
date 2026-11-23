import { StyleSheet, Text, View } from 'react-native';

import { platformMeta, radius, spacing } from '../theme';
import type { Platform } from '../types';

interface PlatformBadgeProps {
  platform: Platform;
  size?: 'sm' | 'md';
  muted?: boolean;
}

export function PlatformBadge({ platform, size = 'sm', muted = false }: PlatformBadgeProps) {
  const meta = platformMeta[platform];
  const compact = size === 'sm';
  const isX = platform === 'x';
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: muted ? 'rgba(255,255,255,0.06)' : isX ? '#111318' : meta.softColor,
          borderColor: muted ? 'transparent' : isX ? '#4A5364' : `${meta.color}44`,
          paddingHorizontal: compact ? 7 : 10,
          paddingVertical: compact ? 2 : 4,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: meta.color }]} />
      <Text
        style={[
          styles.label,
          { color: muted ? '#B9BFCC' : isX ? '#F3F4F6' : meta.color, fontSize: compact ? 10 : 12 },
        ]}
      >
        {meta.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
