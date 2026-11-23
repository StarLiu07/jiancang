import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { mediaUrl } from '../api/client';
import { useSettings } from '../store/settings';
import { colors, platformMeta, radius, spacing, statusMeta } from '../theme';
import type { ClipSummary, Platform } from '../types';
import { formatRelative } from '../utils/format';
import { PlatformBadge } from './PlatformBadge';

const PLATFORM_ICON: Record<Platform, keyof typeof Ionicons.glyphMap> = {
  xiaohongshu: 'heart',
  wechat: 'chatbubbles',
  x: 'at',
  web: 'globe-outline',
};

export function StatusPill({ status, label }: { status: keyof typeof statusMeta; label?: string }) {
  const meta = statusMeta[status] ?? statusMeta.ready;
  return (
    <View style={[styles.statusPill, { backgroundColor: meta.softColor, borderColor: `${meta.color}45` }]}>
      <Text style={[styles.statusText, { color: meta.color }]}>{label ?? meta.label}</Text>
    </View>
  );
}

interface ClipCardProps {
  clip: ClipSummary;
  variant?: 'list' | 'feature';
  onPress?: () => void;
  onLongPress?: () => void;
}

export function ClipCard({ clip, variant = 'list', onPress, onLongPress }: ClipCardProps) {
  const { config } = useSettings();
  const cover = mediaUrl(config, clip.cover_media_url);
  const meta = platformMeta[clip.platform];
  const tagList = clip.tags.slice(0, variant === 'feature' ? 4 : 3);
  const hasStatusBadge = clip.status !== 'ready';

  if (variant === 'feature') {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.feature, pressed && styles.pressed]}
      >
        <View style={[styles.featureCover, { backgroundColor: meta.softColor }]}>
          {cover ? (
            <Image source={{ uri: cover }} style={styles.featureImage} resizeMode="cover" />
          ) : (
            <View style={styles.coverPlaceholder}>
              <Ionicons name={PLATFORM_ICON[clip.platform]} size={34} color={meta.color} />
              <Text style={[styles.coverPlaceholderText, { color: meta.color }]}>{meta.label}</Text>
            </View>
          )}
        </View>

        <View style={styles.featureBody}>
          <View style={styles.badgeRow}>
            <PlatformBadge platform={clip.platform} size="md" />
            {hasStatusBadge ? <StatusPill status={clip.status} /> : null}
            <View style={styles.grow} />
            <Text style={styles.timeText}>{formatRelative(clip.created_at)}</Text>
          </View>

          <Text style={styles.featureTitle} numberOfLines={3}>
            {clip.title || '未命名剪藏'}
          </Text>

          {clip.author ? (
            <Text style={styles.author} numberOfLines={1}>
              @{clip.author}
            </Text>
          ) : null}

          <Text style={styles.featureSummary} numberOfLines={4}>
            {clip.summary || (clip.ai_status === 'pending' ? 'AI 正在提炼要点…' : '还没有摘要，点开看看原文。')}
          </Text>

          {tagList.length ? (
            <View style={styles.tagRow}>
              {tagList.map((tag) => (
                <View key={tag} style={styles.tagChip}>
                  <Text style={styles.tagText}>#{tag}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.thumb, { backgroundColor: meta.softColor }]}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.thumbImage} resizeMode="cover" />
        ) : (
          <Ionicons name={PLATFORM_ICON[clip.platform]} size={22} color={meta.color} />
        )}
      </View>

      <View style={styles.rowBody}>
        <View style={styles.badgeRow}>
          <PlatformBadge platform={clip.platform} />
          {hasStatusBadge ? <StatusPill status={clip.status} /> : null}
          <View style={styles.grow} />
          <Text style={styles.timeText}>{formatRelative(clip.created_at)}</Text>
        </View>

        <Text style={styles.rowTitle} numberOfLines={2}>
          {clip.title || '未命名剪藏'}
        </Text>

        {clip.summary ? (
          <Text style={styles.rowSummary} numberOfLines={2}>
            {clip.summary}
          </Text>
        ) : null}

        {tagList.length ? (
          <View style={styles.tagRow}>
            {tagList.map((tag) => (
              <View key={tag} style={styles.tagChip}>
                <Text style={styles.tagText}>#{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.995 }] },

  feature: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  featureCover: {
    width: '100%',
    aspectRatio: 16 / 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  featureImage: {
    width: '100%',
    height: '100%',
  },
  coverPlaceholder: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  coverPlaceholderText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    opacity: 0.85,
  },
  featureBody: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  featureTitle: {
    color: colors.text,
    fontSize: 19,
    lineHeight: 27,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  author: {
    color: colors.muted,
    fontSize: 12,
  },
  featureSummary: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 21,
  },

  row: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  thumb: {
    width: 76,
    height: 76,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  rowBody: {
    flex: 1,
    gap: 5,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
  },
  rowSummary: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },

  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  timeText: {
    color: colors.faint,
    fontSize: 11,
  },
  statusPill: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tagChip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tagText: {
    color: colors.textSecondary,
    fontSize: 11,
  },
});
