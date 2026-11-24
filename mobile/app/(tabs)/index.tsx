import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, pickErrorMessage } from '../../src/api/client';
import { ClipboardBanner } from '../../src/components/ClipboardBanner';
import { FadeSlideIn, MOTION, SkeletonHeroCard, SpringPressable } from '../../src/components/Motion';
import { ReviewDeck, type ReviewDeckHandle } from '../../src/components/ReviewDeck';
import { useToast } from '../../src/components/Toast';
import { useClipboardLink } from '../../src/hooks/useClipboardLink';
import { useSettings } from '../../src/store/settings';
import { colors, elevation, radius, spacing } from '../../src/theme';
import type { ClipDetail, ReviewActionType } from '../../src/types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function todayLabel(): string {
  const now = new Date();
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAYS[now.getDay()]}`;
}

const ACTION_LABEL: Record<ReviewActionType, string> = {
  snooze: '已推迟到下次',
  archive: '已消化',
  delete: '已删除',
};

function ProgressSegment({ done, current }: { done: boolean; current: boolean }) {
  const fill = useRef(new Animated.Value(done ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: done ? 1 : 0,
      duration: 280,
      easing: MOTION.easeOut,
      useNativeDriver: true,
    }).start();
  }, [done, fill]);

  return (
    <View style={[styles.segmentBar, current && styles.segmentBarCurrent]}>
      <Animated.View
        style={[
          styles.segmentBarFill,
          {
            opacity: fill,
            transform: [{ scaleX: fill }],
          },
        ]}
      />
    </View>
  );
}

export default function ReviewTodayScreen() {
  const { config, ready } = useSettings();
  const { show } = useToast();
  const router = useRouter();

  const [items, setItems] = useState<ClipDetail[]>([]);
  const [index, setIndex] = useState(0);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [dailyTarget, setDailyTarget] = useState(5);
  const [totalActive, setTotalActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [deckDragging, setDeckDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestRef = useRef(0);
  const loadedRef = useRef(false);
  const deckRef = useRef<ReviewDeckHandle>(null);
  const refreshSpin = useRef(new Animated.Value(0)).current;
  const doneBadgeScale = useRef(new Animated.Value(0.7)).current;

  const { link, dismiss, refresh: refreshClipboard } = useClipboardLink(ready);

  const spinRefreshIcon = useCallback(() => {
    refreshSpin.setValue(0);
    Animated.timing(refreshSpin, {
      toValue: 1,
      duration: 460,
      easing: MOTION.easeOut,
      useNativeDriver: true,
    }).start();
  }, [refreshSpin]);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!ready) return;
      const requestId = ++requestRef.current;
      if (mode === 'refresh') {
        setRefreshing(true);
        spinRefreshIcon();
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const data = await api.reviewToday({ baseUrl: config.baseUrl, token: config.token }, 5);
        if (requestId !== requestRef.current) return;
        setItems(data.items);
        setIndex(0);
        setReviewedToday(data.reviewed_today);
        setDailyTarget(data.daily_target || 5);
        setTotalActive(data.total_active);
        loadedRef.current = true;
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(pickErrorMessage(err));
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [ready, config.baseUrl, config.token, spinRefreshIcon],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useFocusEffect(
    useCallback(() => {
      if (readyRef.current && loadedRef.current) void loadRef.current('initial');
    }, []),
  );

  useEffect(() => {
    if (ready) void loadRef.current('initial');
  }, [ready]);

  const current = index < items.length ? items[index] : null;
  const remaining = Math.max(0, items.length - index - 1);
  const finished = !loading && !error && index >= items.length;
  const percent = dailyTarget > 0 ? Math.min(100, Math.round((reviewedToday / dailyTarget) * 100)) : 0;
  const progressWidth = `${percent}%` as DimensionValue;
  const useSegments = dailyTarget > 0 && dailyTarget <= 10;

  useEffect(() => {
    if (!finished) return;
    doneBadgeScale.setValue(0.68);
    Animated.spring(doneBadgeScale, { toValue: 1, ...MOTION.springPop }).start();
  }, [finished, doneBadgeScale]);

  const captureClipboard = async () => {
    if (!link || capturing) return;
    setCapturing(true);
    try {
      const result = await api.createClip({ baseUrl: config.baseUrl, token: config.token }, { input: link });
      show(result.deduplicated ? '已在收藏库' : '已剪藏', result.deduplicated ? 'info' : 'success');
      await dismiss(link);
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      setCapturing(false);
      void refreshClipboard();
    }
  };

  const commitAction = useCallback(
    async (action: ReviewActionType) => {
      const clip = items[index];
      if (!clip || acting) return;

      const previousIndex = index;
      const previousReviewed = reviewedToday;

      setActing(true);
      setIndex(previousIndex + 1);
      setReviewedToday(previousReviewed + 1);

      try {
        const result = await api.reviewAction(
          { baseUrl: config.baseUrl, token: config.token },
          clip.id,
          { action },
        );
        setReviewedToday(result.reviewed_today);
        setDailyTarget(result.daily_target || dailyTarget);
        setTotalActive((value) => Math.max(0, value - (action === 'snooze' ? 0 : 1)));
        show(ACTION_LABEL[action], 'success');
      } catch (err) {
        setIndex(previousIndex);
        setReviewedToday(previousReviewed);
        show(pickErrorMessage(err), 'error');
      } finally {
        setActing(false);
      }
    },
    [items, index, acting, reviewedToday, config.baseUrl, config.token, dailyTarget, show],
  );

  const handleButtonAction = (action: ReviewActionType) => {
    if (acting) return;
    if (deckRef.current) {
      deckRef.current.triggerAction(action);
    } else {
      void commitAction(action);
    }
  };

  const openDetail = (id: string) => {
    router.push({ pathname: '/clip/[id]', params: { id } });
  };

  const spinInterpolate = refreshSpin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        scrollEnabled={!deckDragging}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surfaceElevated}
          />
        }
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>{todayLabel()}</Text>
            <Text style={styles.title}>今日回顾</Text>
          </View>
          <SpringPressable
            onPress={() => void load('refresh')}
            scaleTo={0.9}
            hitSlop={8}
            contentStyle={styles.refreshButton}
            accessibilityLabel="刷新今日回顾"
          >
            <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
              <Ionicons name="refresh" size={17} color={colors.textSecondary} />
            </Animated.View>
          </SpringPressable>
        </View>

        <View style={styles.progressSection}>
          <View style={styles.progressTopRow}>
            <Text style={styles.progressLabel}>
              已回顾 <Text style={styles.progressStrong}>{reviewedToday}</Text>
              <Text style={styles.progressMuted}> / {dailyTarget}</Text>
            </Text>
            <Text style={styles.progressHint}>
              {totalActive > 0 ? `收藏库 ${totalActive} 条` : '收藏库还是空的'}
            </Text>
          </View>

          {useSegments ? (
            <View style={styles.segmentTrack}>
              {Array.from({ length: dailyTarget }).map((_, idx) => (
                <ProgressSegment
                  key={idx}
                  done={idx < reviewedToday}
                  current={idx === reviewedToday && !finished}
                />
              ))}
            </View>
          ) : (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: progressWidth }]} />
            </View>
          )}
        </View>

        {link ? (
          <ClipboardBanner
            url={link}
            busy={capturing}
            onCapture={() => void captureClipboard()}
            onDismiss={() => void dismiss(link)}
          />
        ) : null}

        {error ? (
          <FadeSlideIn distance={8}>
            <View style={styles.errorCard}>
              <Ionicons name="cloud-offline-outline" size={20} color={colors.danger} />
              <View style={styles.errorBody}>
                <Text style={styles.errorTitle}>没能连上剪藏服务</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
              <Pressable onPress={() => void load('initial')} style={styles.errorRetry} hitSlop={6}>
                <Text style={styles.errorRetryText}>重试</Text>
              </Pressable>
            </View>
          </FadeSlideIn>
        ) : null}

        {loading && !refreshing ? (
          <SkeletonHeroCard />
        ) : finished ? (
          <FadeSlideIn distance={14} duration={300}>
            <View style={styles.doneCard}>
              <Animated.View style={[styles.doneIcon, { transform: [{ scale: doneBadgeScale }] }]}>
                <Ionicons name="checkmark-done" size={28} color={colors.success} />
              </Animated.View>
              <Text style={styles.doneTitle}>
                {reviewedToday >= dailyTarget ? '今天的回顾完成啦' : '暂时没有待回顾的剪藏'}
              </Text>
              <Text style={styles.doneText}>
                {reviewedToday >= dailyTarget
                  ? `已完成 ${reviewedToday} / ${dailyTarget}，让收藏真正沉淀下来。`
                  : '可以去收藏库挑几条，或者等下一次提醒。'}
              </Text>
              <View style={styles.doneActions}>
                <SpringPressable
                  onPress={() => void load('initial')}
                  scaleTo={0.95}
                  contentStyle={styles.donePrimary}
                >
                  <Ionicons name="refresh" size={16} color={colors.onAccent} />
                  <Text style={styles.donePrimaryText}>再拉一批</Text>
                </SpringPressable>
                <SpringPressable
                  onPress={() => router.push('/library')}
                  scaleTo={0.95}
                  contentStyle={styles.doneSecondary}
                >
                  <Ionicons name="albums-outline" size={16} color={colors.textSecondary} />
                  <Text style={styles.doneSecondaryText}>去收藏库</Text>
                </SpringPressable>
              </View>
            </View>
          </FadeSlideIn>
        ) : current ? (
          <FadeSlideIn distance={12} duration={260} style={styles.reviewBlock}>
            <ReviewDeck
              ref={deckRef}
              clip={current}
              queueLabel={`${Math.min(index + 1, items.length)} / ${items.length}`}
              remaining={remaining}
              disabled={acting}
              onOpenDetail={() => openDetail(current.id)}
              onAction={(action) => void commitAction(action)}
              onDraggingChange={setDeckDragging}
            />

            <View style={styles.actions}>
              <SpringPressable
                onPress={() => handleButtonAction('snooze')}
                disabled={acting}
                scaleTo={0.95}
                style={styles.secondaryActionFlex}
                contentStyle={[styles.secondaryAction, acting && styles.actionMuted]}
              >
                <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
                <Text style={styles.secondaryActionLabel}>以后再看</Text>
              </SpringPressable>

              <SpringPressable
                onPress={() => handleButtonAction('archive')}
                disabled={acting}
                scaleTo={0.95}
                style={styles.primaryActionFlex}
                contentStyle={[styles.primaryAction, acting && styles.actionMuted]}
              >
                <Ionicons name="checkmark-circle" size={19} color={colors.onAccent} />
                <Text style={styles.primaryActionLabel}>已消化</Text>
              </SpringPressable>

              <SpringPressable
                onPress={() => handleButtonAction('delete')}
                disabled={acting}
                scaleTo={0.92}
                contentStyle={[styles.ghostDangerAction, acting && styles.actionMuted]}
                accessibilityLabel="删除剪藏"
              >
                <Ionicons name="trash-outline" size={18} color={colors.muted} />
              </SpringPressable>
            </View>

            {acting ? (
              <View style={styles.syncingRow}>
                <ActivityIndicator size="small" color={colors.faint} />
                <Text style={styles.syncingText}>正在同步…</Text>
              </View>
            ) : (
              <Text style={styles.remainingHint}>
                {remaining > 0
                  ? `右滑已消化 · 左滑以后再看 · 还有 ${remaining} 条`
                  : '右滑已消化 · 左滑以后再看'}
              </Text>
            )}
          </FadeSlideIn>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: 3,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  refreshButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },

  progressSection: {
    gap: 8,
    marginTop: -4,
  },
  progressTopRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  progressLabel: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '500',
  },
  progressStrong: {
    color: colors.accent,
    fontWeight: '800',
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  progressMuted: {
    color: colors.faint,
    fontVariant: ['tabular-nums'],
  },
  progressHint: {
    color: colors.faint,
    fontSize: 11.5,
  },
  segmentTrack: {
    flexDirection: 'row',
    gap: 6,
  },
  segmentBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.glassStrong,
    overflow: 'hidden',
  },
  segmentBarCurrent: {
    backgroundColor: colors.accentBorder,
  },
  segmentBarFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.glassStrong,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.accent,
  },

  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: `${colors.danger}40`,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  errorBody: {
    flex: 1,
    gap: 3,
  },
  errorTitle: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '700',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  errorRetry: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
  },
  errorRetryText: {
    color: colors.onAccent,
    fontSize: 11.5,
    fontWeight: '800',
  },

  reviewBlock: {
    gap: spacing.lg,
  },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  secondaryActionFlex: {
    flex: 1,
  },
  secondaryAction: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.rimTop,
    borderRadius: radius.lg,
  },
  secondaryActionLabel: {
    color: colors.textSecondary,
    fontSize: 13.5,
    fontWeight: '700',
  },
  primaryActionFlex: {
    flex: 1.45,
  },
  primaryAction: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    ...elevation.accent,
  },
  primaryActionLabel: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  ghostDangerAction: {
    width: 52,
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionMuted: {
    opacity: 0.52,
  },
  syncingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  syncingText: {
    color: colors.faint,
    fontSize: 11.5,
  },
  remainingHint: {
    color: colors.faint,
    fontSize: 11.5,
    textAlign: 'center',
  },

  doneCard: {
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.rimTop,
    borderRadius: radius.xl,
    paddingVertical: 36,
    paddingHorizontal: spacing.xl,
    ...elevation.card,
  },
  doneIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.successSoft,
    borderWidth: 1,
    borderColor: `${colors.success}35`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    textAlign: 'center',
  },
  doneText: {
    color: colors.muted,
    fontSize: 13.5,
    lineHeight: 21,
    textAlign: 'center',
  },
  doneActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: spacing.sm,
  },
  donePrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    paddingVertical: 11,
    ...elevation.accent,
  },
  donePrimaryText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '800',
  },
  doneSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.glass,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: colors.border,
  },
  doneSecondaryText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
});
