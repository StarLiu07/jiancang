import { Ionicons } from '@expo/vector-icons';
import { Image, StyleSheet, Text, View } from 'react-native';

import { mediaUrl } from '../api/client';
import { useSettings } from '../store/settings';
import { colors, elevation, platformMeta, radius, spacing, statusMeta } from '../theme';
import type { ClipSummary, Platform } from '../types';
import { formatRelative } from '../utils/format';
import { SpringPressable } from './Motion';
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
    <View style={[styles.statusPill, { backgroundColor: meta.softColor, borderColor: `${meta.color}40` }]}>
      <Text style={[styles.statusText, { color: meta.color }]}>{label ?? meta.label}</Text>
    </View>
  );
}

interface ClipCardProps {
  clip: ClipSummary;
  variant?: 'list' | 'feature';
  queueLabel?: string;
  onPress?: () => void;
  onLongPress?: () => void;
}

export function ClipCard({ clip, variant = 'list', queueLabel, onPress, onLongPress }: ClipCardProps) {
  const { config } = useSettings();
  const cover = mediaUrl(config, clip.cover_media_url);
  const meta = platformMeta[clip.platform];
  const tagList = clip.tags.slice(0, variant === 'feature' ? 4 : 3);
  const hasStatusBadge = clip.status !== 'ready';

  if (variant === 'feature') {
    return (
      <SpringPressable
        onPress={onPress}
        onLongPress={onLongPress}
        scaleTo={0.986}
        contentStyle={styles.feature}
      >
        <View style={styles.featureCover}>
          {cover ? (
            <>
              <Image source={{ uri: cover }} style={styles.featureImage} resizeMode="cover" />
              <View style={styles.coverScrimTop} />
              <View style={styles.coverScrimBottom} />
            </>
          ) : (
            <View style={styles.coverPlaceholder}>
              <View style={[styles.placeholderGlow, { backgroundColor: meta.softColor }]} />
              <View style={styles.placeholderIconRing}>
                <Ionicons name={PLATFORM_ICON[clip.platform]} size={28} color={meta.color} />
              </View>
              <Text style={styles.coverPlaceholderText}>{meta.label} · 文本剪藏</Text>
            </View>
          )}

          <View style={styles.coverOverlayTop}>
            <View style={styles.overlayLeft}>
              <PlatformBadge platform={clip.platform} size="md" glass />
              {hasStatusBadge ? <StatusPill status={clip.status} /> : null}
            </View>
            {queueLabel ? (
              <View style={styles.queuePill}>
                <Text style={styles.queuePillText}>{queueLabel}</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.featureBody}>
          <Text style={styles.featureTitle} numberOfLines={3}>
            {clip.title || '未命名剪藏'}
          </Text>

          {clip.author ? (
            <Text style={styles.author} numberOfLines={1}>
              @{clip.author}
            </Text>
          ) : null}

          <Text style={styles.featureSummary} numberOfLines={4}>
            {clip.summary || (clip.ai_status === 'pending' ? 'AI 正在提炼核心要点…' : '还没有摘要，点开查看存档正文。')}
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

          <View style={styles.featureFooter}>
            <Text style={styles.timeText}>{formatRelative(clip.created_at)}</Text>
            <View style={styles.readMoreHint}>
              <Text style={styles.readMoreText}>阅读详情</Text>
              <Ionicons name="chevron-forward" size={13} color={colors.muted} />
            </View>
          </View>
        </View>
      </SpringPressable>
    );
  }

  return (
    <SpringPressable
      onPress={onPress}
      onLongPress={onLongPress}
      scaleTo={0.978}
      contentStyle={styles.row}
    >
      <View style={styles.thumb}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.thumbImage} resizeMode="cover" />
        ) : (
          <View style={[styles.thumbFallback, { backgroundColor: meta.softColor }]}>
            <Ionicons name={PLATFORM_ICON[clip.platform]} size={21} color={meta.color} />
          </View>
        )}
      </View>

      <View style={styles.rowBody}>
        <View style={styles.badgeRow}>
          <PlatformBadge platform={clip.platform} muted />
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
              <View key={tag} style={styles.tagChipQuiet}>
                <Text style={styles.tagTextQuiet}>#{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </SpringPressable>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },

  feature: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.rimTop,
    overflow: 'hidden',
    ...elevation.hero,
  },
  featureCover: {
    width: '100%',
    aspectRatio: 16 / 9.2,
    backgroundColor: colors.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  featureImage: {
    width: '100%',
    height: '100%',
  },
  coverScrimTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 64,
    backgroundColor: 'rgba(9, 11, 15, 0.28)',
  },
  coverScrimBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 44,
    backgroundColor: 'rgba(23, 29, 41, 0.36)',
  },
  coverOverlayTop: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  overlayLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  queuePill: {
    backgroundColor: 'rgba(9, 11, 15, 0.72)',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.borderStrong,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  queuePillText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  coverPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: '#131824',
  },
  placeholderGlow: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    opacity: 0.55,
  },
  placeholderIconRing: {
    width: 58,
    height: 58,
    borderRadius: 20,
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverPlaceholderText: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  featureBody: {
    padding: spacing.xl,
    gap: 10,
  },
  featureTitle: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  author: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '500',
    marginTop: -4,
  },
  featureSummary: {
    color: colors.textSecondary,
    fontSize: 14.5,
    lineHeight: 23,
  },
  featureFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  readMoreHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  readMoreText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },

  row: {
    flexDirection: 'row',
    gap: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 14,
  },
  thumb: {
    width: 82,
    height: 82,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 6,
    justifyContent: 'center',
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 22,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  rowSummary: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },

  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  timeText: {
    color: colors.faint,
    fontSize: 11.5,
  },
  statusPill: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  tagChip: {
    backgroundColor: colors.glass,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  tagText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    fontWeight: '500',
  },
  tagChipQuiet: {
    backgroundColor: colors.glass,
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  tagTextQuiet: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
  },
});
