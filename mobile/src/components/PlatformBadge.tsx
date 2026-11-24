import { StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, radius } from '../theme';
import type { Platform } from '../types';

interface PlatformBadgeProps {
  platform: Platform;
  size?: 'sm' | 'md';
  muted?: boolean;
  glass?: boolean;
}

/**
 * Lightweight editorial platform indicator: low-saturation dot + text.
 * Keeps `muted` and `glass` props compatible in warm-paper tones.
 */
export function PlatformBadge({
  platform,
  size = 'sm',
  muted = false,
  glass = false,
}: PlatformBadgeProps) {
  const meta = platformMeta[platform];
  const compact = size === 'sm';

  if (glass) {
    return (
      <View
        style={[
          styles.glassBadge,
          {
            paddingHorizontal: compact ? 8 : 10,
            paddingVertical: compact ? 3 : 4,
          },
        ]}
      >
        <View style={[styles.dot, compact && styles.dotCompact, { backgroundColor: meta.color }]} />
        <Text
          style={[
            styles.label,
            { color: colors.text, fontSize: compact ? 11.5 : 12 },
          ]}
        >
          {meta.label}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.plainBadge}>
      <View style={[styles.dot, compact && styles.dotCompact, { backgroundColor: meta.color }]} />
      <Text
        style={[
          styles.label,
          {
            color: muted ? colors.muted : colors.textSecondary,
            fontSize: compact ? 12 : 12.5,
          },
        ]}
      >
        {meta.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  plainBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  glassBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(252, 249, 242, 0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotCompact: {
    width: 5.5,
    height: 5.5,
    borderRadius: 2.75,
  },
  label: {
    fontWeight: '500',
    letterSpacing: 0.1,
  },
});
