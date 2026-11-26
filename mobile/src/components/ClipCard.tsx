import { Ionicons } from '@expo/vector-icons';
import { Image, Platform as RNPlatform, Pressable, StyleSheet, Text, View } from 'react-native';

import { mediaUrl } from '../api/client';
import { useSettings } from '../store/settings';
import { colors, elevation, fonts, platformMeta, radius, statusMeta } from '../theme';
import type { ClipSummary } from '../types';
import { formatRelative } from '../utils/format';
import { SpringPressable } from './Motion';

export function StatusPill({ status, label }: { status: keyof typeof statusMeta; label?: string }) {
  const meta = statusMeta[status] ?? statusMeta.ready;
  return (
    <View style={[styles.statusPill, { backgroundColor: meta.softColor }]}>
      <Text style={[styles.statusText, { color: meta.color }]}>{label ?? meta.label}</Text>
    </View>
  );
}

/** Physical vermilion paper clamp echoing the app icon, resting on top of each folio leaf. */
function CoralClamp() {
  return (
    <View style={styles.clampShadow} pointerEvents="none">
      <View style={styles.clampInner}>
        <View style={styles.clampTopRim} />
        <View style={styles.clampHighlight} />
      </View>
    </View>
  );
}

type ClipCardClip = ClipSummary & { key_points?: string[] };

interface ClipCardProps {
  clip: ClipCardClip;
  variant?: 'list' | 'feature';
  queueLabel?: string;
  keyPoints?: string[];
  onPress?: () => void;
  onLongPress?: () => void;
  /** When provided, a zoom badge on the feature cover opens the full-screen viewer. */
  onPreviewImage?: () => void;
  /**
   * Feature only: stretch the leaf to the height of its parent stage. The cover
   * flexes between 200–360px, the body absorbs the remaining space and the
   * footer sticks to the bottom edge. Defaults to false so list / detail
   * layouts keep their intrinsic height.
   */
  fillHeight?: boolean;
}

export function ClipCard({
  clip,
  variant = 'list',
  queueLabel,
  keyPoints,
  onPress,
  onLongPress,
  onPreviewImage,
  fillHeight = false,
}: ClipCardProps) {
  const { config } = useSettings();
  const cover = mediaUrl(config, clip.cover_media_url);
  const meta = platformMeta[clip.platform];
  const tagList = clip.tags.slice(0, variant === 'feature' ? 3 : 3);
  const hasStatusBadge = clip.status !== 'ready';
  const points = (keyPoints ?? clip.key_points ?? []).slice(0, 2);
  const compactQueue = queueLabel ? queueLabel.replace(/\s*\/\s*/g, '/') : undefined;
  const sourceLine = clip.author ? `${meta.label} · ${clip.author}` : meta.label;

  if (variant === 'feature') {
    const summaryFallback =
      clip.ai_status === 'pending'
        ? 'AI 正在提炼核心要点…'
        : '还没有摘要，点开查看存档正文。';

    return (
      <SpringPressable
        onPress={onPress}
        onLongPress={onLongPress}
        scaleTo={0.988}
        style={fillHeight ? styles.featurePressableFill : undefined}
        contentStyle={[styles.featureOuter, fillHeight && styles.featureOuterFill]}
      >
        <View style={[styles.featureCard, fillHeight && styles.featureCardFill]}>
          {cover ? (
            <>
              <View style={[styles.featureCoverPad, fillHeight && styles.featureCoverPadFill]}>
                <View
                  style={fillHeight ? styles.featureCoverFrameFill : styles.featureCoverFrame}
                >
                  <Image source={{ uri: cover }} style={styles.featureImage} resizeMode="cover" />
                  {onPreviewImage ? (
                    <Pressable
                      onPress={(event) => {
                        // Keep the card's own press handler out of the picture.
                        event.stopPropagation?.();
                        onPreviewImage();
                      }}
                      style={({ pressed }) => [
                        styles.coverZoomBadge,
                        pressed && styles.coverZoomBadgePressed,
                      ]}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel="放大查看图片"
                    >
                      <Ionicons name="expand-outline" size={14} color={colors.onAccent} />
                    </Pressable>
                  ) : null}
                </View>
              </View>

              <View style={[styles.featureBody, fillHeight && styles.featureBodyFill]}>
                <View style={styles.metaRow}>
                  <View style={styles.metaLeft}>
                    <View style={[styles.metaDot, { backgroundColor: meta.color }]} />
                    <Text style={styles.metaSource} numberOfLines={1}>
                      {sourceLine}
                    </Text>
                    {hasStatusBadge ? <StatusPill status={clip.status} /> : null}
                  </View>
                  {compactQueue ? <Text style={styles.queueMono}>{compactQueue}</Text> : null}
                </View>

                <Text style={styles.featureTitle} numberOfLines={3}>
                  {clip.title || '未命名剪藏'}
                </Text>

                <Text style={styles.featureSummary} numberOfLines={4}>
                  {clip.summary || summaryFallback}
                </Text>

                <View style={[styles.featureFooter, fillHeight && styles.featureFooterFill]}>
                  <View style={styles.footerTags}>
                    {tagList.length ? (
                      tagList.map((tag) => (
                        <Text key={tag} style={styles.footerTagText} numberOfLines={1}>
                          #{tag}
                        </Text>
                      ))
                    ) : (
                      <Text style={styles.footerTagText}>{formatRelative(clip.created_at)}</Text>
                    )}
                  </View>
                  <Text style={styles.expandAction}>展开全文</Text>
                </View>
              </View>
            </>
          ) : (
            <View style={[styles.excerptBody, fillHeight && styles.excerptBodyFill]}>
              <View style={styles.metaRow}>
                <View style={styles.metaLeft}>
                  <View style={[styles.metaDot, { backgroundColor: meta.color }]} />
                  <Text style={styles.metaSource} numberOfLines={1}>
                    {sourceLine}
                  </Text>
                  {hasStatusBadge ? <StatusPill status={clip.status} /> : null}
                </View>
                <Text style={styles.queueMono}>
                  {compactQueue ? `纯文摘录 ${compactQueue}` : '纯文摘录'}
                </Text>
              </View>

              <View style={styles.excerptMain}>
                <Text style={styles.excerptTitle} numberOfLines={3}>
                  {clip.title || '未命名剪藏'}
                </Text>

                <View style={styles.excerptRule} />

                <Text style={styles.excerptQuote} numberOfLines={points.length > 0 ? 4 : 6}>
                  {clip.summary ? `「${clip.summary}」` : summaryFallback}
                </Text>

                {points.length ? (
                  <View style={styles.excerptPoints}>
                    {points.map((pt, idx) => (
                      <View key={`${idx}-${pt.slice(0, 12)}`} style={styles.excerptPointRow}>
                        <Text style={styles.excerptPointDash}>—</Text>
                        <Text style={styles.excerptPointText} numberOfLines={2}>
                          {pt}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>

              <View style={styles.excerptFooter}>
                <View style={styles.footerTags}>
                  {tagList.length ? (
                    tagList.map((tag) => (
                      <Text key={tag} style={styles.footerTagText} numberOfLines={1}>
                        #{tag}
                      </Text>
                    ))
                  ) : (
                    <Text style={styles.footerTagText}>{formatRelative(clip.created_at)}</Text>
                  )}
                </View>
                <Text style={styles.expandAction}>展开正文</Text>
              </View>
            </View>
          )}
        </View>

        <CoralClamp />
      </SpringPressable>
    );
  }

  return (
    <SpringPressable
      onPress={onPress}
      onLongPress={onLongPress}
      scaleTo={0.985}
      contentStyle={styles.row}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowMeta}>
          <View style={[styles.rowDot, { backgroundColor: meta.color }]} />
          <Text style={styles.rowMetaText}>{meta.label}</Text>
          <Text style={styles.rowMetaSep}>·</Text>
          <Text style={styles.rowMetaText}>{formatRelative(clip.created_at)}</Text>
          {hasStatusBadge ? <StatusPill status={clip.status} /> : null}
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
          <View style={styles.rowTags}>
            {tagList.map((tag) => (
              <Text key={tag} style={styles.rowTagText} numberOfLines={1}>
                #{tag}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {cover ? (
        <Image source={{ uri: cover }} style={styles.thumbImage} resizeMode="cover" />
      ) : null}
    </SpringPressable>
  );
}

const styles = StyleSheet.create({
  featurePressableFill: {
    flexGrow: 1,
  },
  featureOuter: {
    paddingTop: 6,
    position: 'relative',
  },
  featureOuterFill: {
    flexGrow: 1,
  },
  featureCard: {
    backgroundColor: colors.sheet,
    borderRadius: 14,
    ...elevation.card,
  },
  featureCardFill: {
    flexGrow: 1,
  },
  clampShadow: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    zIndex: 5,
    width: 44,
    height: 22,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    backgroundColor: colors.accent,
    ...RNPlatform.select({
      ios: {
        shadowColor: colors.accentDeep,
        shadowOpacity: 0.28,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
      },
      default: {
        elevation: 4,
        shadowColor: colors.accentDeep,
      },
    }),
  },
  clampInner: {
    ...StyleSheet.absoluteFillObject,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    overflow: 'hidden',
  },
  clampTopRim: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.32)',
  },
  clampHighlight: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 5,
    height: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.30)',
  },

  featureCoverPad: {
    paddingHorizontal: 14,
    paddingTop: 22,
  },
  featureCoverPadFill: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 222,
    maxHeight: 382,
  },
  featureCoverFrame: {
    borderRadius: 8,
    overflow: 'hidden',
    aspectRatio: 4 / 2.65,
    backgroundColor: colors.surface,
  },
  featureCoverFrameFill: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 200,
    maxHeight: 360,
  },
  coverZoomBadge: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(31, 28, 24, 0.46)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 251, 247, 0.32)',
  },
  coverZoomBadgePressed: {
    backgroundColor: 'rgba(31, 28, 24, 0.68)',
  },
  featureImage: {
    width: '100%',
    height: '100%',
  },

  featureBody: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 10,
  },
  featureBodyFill: {
    flexGrow: 1,
    flexShrink: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metaLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
  },
  metaSource: {
    color: colors.muted,
    fontSize: 12,
    flexShrink: 1,
  },
  queueMono: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  featureTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 19,
    lineHeight: 27,
    fontWeight: '700',
  },
  featureSummary: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 24,
  },
  featureFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 2,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  featureFooterFill: {
    marginTop: 'auto',
  },
  footerTags: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  footerTagText: {
    color: colors.muted,
    fontSize: 12,
  },
  expandAction: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 0,
  },

  excerptBody: {
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 20,
    minHeight: 360,
    justifyContent: 'space-between',
    gap: 14,
  },
  excerptBodyFill: {
    flexGrow: 1,
    flexShrink: 1,
  },
  excerptMain: {
    gap: 14,
    paddingVertical: 4,
  },
  excerptTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 22.5,
    lineHeight: 31.5,
    fontWeight: '700',
  },
  excerptRule: {
    width: 28,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.accent,
  },
  excerptQuote: {
    fontFamily: fonts.serif,
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 27,
  },
  excerptPoints: {
    gap: 6,
    paddingTop: 4,
  },
  excerptPointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  excerptPointDash: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 19.5,
  },
  excerptPointText: {
    flex: 1,
    color: colors.muted,
    fontSize: 12.5,
    lineHeight: 19.5,
  },
  excerptFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 15,
  },
  rowBody: {
    flex: 1,
    gap: 6,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  rowDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  rowMetaText: {
    color: colors.muted,
    fontSize: 12,
  },
  rowMetaSep: {
    color: colors.faint,
    fontSize: 12,
  },
  rowTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 22,
    fontWeight: '700',
  },
  rowSummary: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 21,
  },
  rowTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 1,
  },
  rowTagText: {
    color: colors.muted,
    fontSize: 12,
  },
  thumbImage: {
    width: 68,
    height: 68,
    borderRadius: 8,
    marginTop: 4,
    backgroundColor: colors.surface,
    flexShrink: 0,
  },

  statusPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  statusText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
});
