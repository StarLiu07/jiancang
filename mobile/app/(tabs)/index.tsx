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

import { pickErrorMessage } from '../../src/api/client';
import { ClipboardBanner } from '../../src/components/ClipboardBanner';
import { FadeSlideIn, MOTION, SkeletonHeroCard, SpringPressable } from '../../src/components/Motion';
import { ReviewDeck, type ReviewDeckHandle } from '../../src/components/ReviewDeck';
import { useToast } from '../../src/components/Toast';
import { useClipboardLink } from '../../src/hooks/useClipboardLink';
import { localRepo, subscribeLocalChanges } from '../../src/local/repository';
import { useSettings } from '../../src/store/settings';
import { useSync } from '../../src/store/sync';
import { colors, elevation, fonts, radius, spacing } from '../../src/theme';
import type { ClipDetail, ReviewActionType } from '../../src/types';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** Debounce proof of background ingestion finishing / sync pulling new cards. */
const SILENT_REFRESH_DEBOUNCE_MS = 260;
/** Retry later while the user is mid-swipe or a review action is in flight. */
const SILENT_REFRESH_RETRY_MS = 400;

function pad2(n: number): string {
  return String(Math.max(0, n)).padStart(2, '0');
}

function todayLabel(): string {
  const now = new Date();
  return `${pad2(now.getMonth() + 1)}.${pad2(now.getDate())} ${WEEKDAYS[now.getDay()]}`;
}

const ACTION_LABEL: Record<ReviewActionType, string> = {
  snooze: '已留待下次翻阅',
  archive: '已消化',
  delete: '已删除',
};

function ProgressSegment({ done, current }: { done: boolean; current: boolean }) {
  const fill = useRef(new Animated.Value(done ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: done ? 1 : 0,
      duration: 240,
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
  const { localAiConfig, settings, ready } = useSettings();
  const { syncNow } = useSync();
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

  // Refs mirror state so the change-bus listener can read fresh values without
  // resubscribing (a resubscribe mid-swipe would lose the pending debounce).
  const itemsRef = useRef<ClipDetail[]>(items);
  const indexRef = useRef(index);
  const loadingRef = useRef(loading);
  const refreshingRef = useRef(refreshing);
  const draggingRef = useRef(deckDragging);
  const actingRef = useRef(acting);
  const mountedRef = useRef(true);
  const silentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  itemsRef.current = items;
  indexRef.current = index;
  loadingRef.current = loading;
  refreshingRef.current = refreshing;
  draggingRef.current = deckDragging;
  actingRef.current = acting;

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
        const data = await localRepo.reviewToday(5);
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
    [ready, spinRefreshIcon],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  /**
   * Silent deck refresh: keeps the card the user is looking at in place (a
   * freshly finished extraction updates it by id) and never surfaces errors.
   */
  const refreshDeckSilently = useCallback(async () => {
    if (!readyRef.current || !loadedRef.current) return;
    if (loadingRef.current || refreshingRef.current || draggingRef.current || actingRef.current) {
      return;
    }

    const generation = requestRef.current;
    const currentId = itemsRef.current[indexRef.current]?.id ?? null;

    try {
      const data = await localRepo.reviewToday(5);
      // A user-initiated load took over while we were reading: let it win.
      if (!mountedRef.current || requestRef.current !== generation) return;

      setReviewedToday(data.reviewed_today);
      setDailyTarget(data.daily_target || 5);
      setTotalActive(data.total_active);

      if (!currentId) {
        // Empty or finished screen: newly arrived cards may now be reviewable.
        setItems(data.items);
        setIndex(0);
        return;
      }

      const position = data.items.findIndex((item) => item.id === currentId);
      if (position < 0) {
        // The open card left the queue (deleted/archived elsewhere). Keep it on
        // screen instead of yanking it away mid-read; the user's next action
        // re-syncs the deck.
        return;
      }

      setItems(data.items);
      setIndex(position);
    } catch {
      // Silent by contract: the next local change retries.
    }
  }, []);

  const scheduleSilentRefresh = useCallback(
    (delay = SILENT_REFRESH_DEBOUNCE_MS) => {
      if (silentTimerRef.current) clearTimeout(silentTimerRef.current);
      silentTimerRef.current = setTimeout(() => {
        silentTimerRef.current = null;
        if (!mountedRef.current) return;
        if (loadingRef.current || refreshingRef.current || draggingRef.current || actingRef.current) {
          scheduleSilentRefresh(SILENT_REFRESH_RETRY_MS);
          return;
        }
        void refreshDeckSilently();
      }, delay);
    },
    [refreshDeckSilently],
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeLocalChanges(() => {
      if (!readyRef.current || !loadedRef.current) return;
      scheduleSilentRefresh();
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (silentTimerRef.current) {
        clearTimeout(silentTimerRef.current);
        silentTimerRef.current = null;
      }
    };
  }, [scheduleSilentRefresh]);

  const requestSilentSync = useCallback(() => {
    if (!settings.syncEnabled || !settings.baseUrl.trim()) return;
    // `syncNow({ silent: true })` is best effort and resolves offline quietly.
    void syncNow({ silent: true }).catch(() => undefined);
  }, [settings.syncEnabled, settings.baseUrl, syncNow]);

  const refreshDeck = useCallback(() => {
    void loadRef.current('refresh');
    requestSilentSync();
  }, [requestSilentSync]);

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
      const result = await localRepo.createClip({ input: link }, localAiConfig);
      show(result.deduplicated ? '已在收藏目录' : '已收进书房', result.deduplicated ? 'info' : 'success');
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
        const result = await localRepo.reviewAction(clip.id, { action });
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
    [items, index, acting, reviewedToday, dailyTarget, show],
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

  const doneHeading =
    reviewedToday >= dailyTarget
      ? dailyTarget === 5
        ? '今日五页已读毕'
        : `今日 ${dailyTarget} 页已读毕`
      : '暂时没有待回顾的剪藏';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        scrollEnabled={!deckDragging}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshDeck}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.sheet}
          />
        }
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.dateMono}>{todayLabel()}</Text>
            <Text style={styles.title}>今日折页</Text>
          </View>

          <View style={styles.headerRight}>
            <View style={styles.progressCaptionRow}>
              <Text style={styles.progressCaption}>今日进度</Text>
              <SpringPressable
                onPress={refreshDeck}
                scaleTo={0.88}
                hitSlop={8}
                contentStyle={styles.refreshIconBtn}
                accessibilityLabel="刷新今日折页"
              >
                <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
                  <Ionicons name="refresh" size={13} color={colors.muted} />
                </Animated.View>
              </SpringPressable>
            </View>
            <Text style={styles.progressCounter}>
              <Text style={styles.progressStrong}>{pad2(reviewedToday)}</Text>
              <Text style={styles.progressMuted}> / {pad2(dailyTarget)}</Text>
            </Text>
          </View>
        </View>

        <View style={styles.progressSection}>
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
              <Ionicons name="alert-circle-outline" size={19} color={colors.danger} />
              <View style={styles.errorBody}>
                <Text style={styles.errorTitle}>本机收藏暂时读不出来</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
              <Pressable onPress={() => void loadRef.current('initial')} style={styles.errorRetry} hitSlop={6}>
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
                <Ionicons name="checkmark" size={20} color={colors.accent} />
              </Animated.View>
              <Text style={styles.doneTitle}>{doneHeading}</Text>
              <Text style={styles.doneText}>
                {reviewedToday >= dailyTarget
                  ? '这一批剪藏已经安放妥当，明天清晨再为你挑出新的一批。'
                  : totalActive > 0
                    ? `书房里还有 ${totalActive} 条剪藏，可以去收藏目录翻看。`
                    : '从分享菜单或右下角 + 收进几条，本机就能开始回顾。'}
              </Text>
              <View style={styles.doneActions}>
                <SpringPressable
                  onPress={refreshDeck}
                  scaleTo={0.95}
                  contentStyle={styles.donePrimary}
                >
                  <Ionicons name="refresh" size={14} color={colors.bg} />
                  <Text style={styles.donePrimaryText}>再拉一批</Text>
                </SpringPressable>
                <SpringPressable
                  onPress={() => router.push('/library')}
                  scaleTo={0.95}
                  contentStyle={styles.doneSecondary}
                >
                  <Ionicons name="file-tray-outline" size={14} color={colors.textSecondary} />
                  <Text style={styles.doneSecondaryText}>去收藏目录</Text>
                </SpringPressable>
              </View>
            </View>
          </FadeSlideIn>
        ) : current ? (
          <FadeSlideIn distance={12} duration={260} style={styles.reviewBlock}>
            <ReviewDeck
              ref={deckRef}
              clip={current}
              queueLabel={`${Math.min(index + 1, items.length)}/${items.length}`}
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
                <Ionicons name="time-outline" size={15} color={colors.muted} />
                <Text style={styles.secondaryActionLabel}>留待下次</Text>
              </SpringPressable>

              <SpringPressable
                onPress={() => handleButtonAction('archive')}
                disabled={acting}
                scaleTo={0.95}
                style={styles.primaryActionFlex}
                contentStyle={[styles.primaryAction, acting && styles.actionMuted]}
              >
                <Ionicons name="checkmark" size={16} color={colors.onAccent} />
                <Text style={styles.primaryActionLabel}>已消化</Text>
              </SpringPressable>

              <SpringPressable
                onPress={() => handleButtonAction('delete')}
                disabled={acting}
                scaleTo={0.92}
                contentStyle={[styles.ghostDangerAction, acting && styles.actionMuted]}
                accessibilityLabel="删除剪藏"
              >
                <Ionicons name="trash-outline" size={16} color={colors.muted} />
              </SpringPressable>
            </View>

            {acting ? (
              <View style={styles.syncingRow}>
                <ActivityIndicator size="small" color={colors.muted} />
                <Text style={styles.syncingText}>正在归档…</Text>
              </View>
            ) : (
              <Text style={styles.remainingHint}>
                {remaining > 0
                  ? `右滑已消化 · 左滑留待下次 · 余 ${remaining} 页`
                  : totalActive > 0
                    ? `右滑已消化 · 左滑留待下次 · 在库 ${totalActive} 条`
                    : '右滑已消化 · 左滑留待下次'}
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
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: spacing.xxl,
    gap: 14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  dateMono: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 12,
  },
  title: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '700',
  },
  headerRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  progressCaptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  progressCaption: {
    color: colors.muted,
    fontSize: 12,
  },
  refreshIconBtn: {
    padding: 2,
  },
  progressCounter: {
    fontFamily: fonts.mono,
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  progressStrong: {
    color: colors.accent,
  },
  progressMuted: {
    color: colors.muted,
  },

  progressSection: {
    marginTop: -4,
  },
  segmentTrack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  segmentBar: {
    flex: 1,
    height: 2,
    borderRadius: 2,
    backgroundColor: 'rgba(31, 28, 24, 0.12)',
    overflow: 'hidden',
  },
  segmentBarCurrent: {
    height: 3,
    backgroundColor: colors.accent,
  },
  segmentBarFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(31, 28, 24, 0.12)',
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
    borderColor: `${colors.danger}29`,
    borderRadius: 12,
    padding: spacing.md,
  },
  errorBody: {
    flex: 1,
    gap: 2,
  },
  errorTitle: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '600',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  errorRetry: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.danger,
  },
  errorRetryText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '600',
  },

  reviewBlock: {
    gap: 14,
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
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.sheet,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
  },
  secondaryActionLabel: {
    color: colors.textSecondary,
    fontSize: 13.5,
    fontWeight: '600',
  },
  primaryActionFlex: {
    flex: 1.35,
  },
  primaryAction: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: 10,
    ...elevation.accent,
  },
  primaryActionLabel: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '600',
  },
  ghostDangerAction: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionMuted: {
    opacity: 0.52,
    // 禁用态不挂阴影，避免 Android 上透出灰影
    shadowOpacity: 0,
    elevation: 0,
  },
  syncingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  syncingText: {
    color: colors.muted,
    fontSize: 11.5,
  },
  remainingHint: {
    color: colors.muted,
    fontSize: 11.5,
    textAlign: 'center',
  },

  doneCard: {
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.sheet,
    borderRadius: radius.lg,
    paddingVertical: 36,
    paddingHorizontal: 24,
    ...elevation.card,
  },
  doneIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  doneText: {
    color: colors.textSecondary,
    fontSize: 13.5,
    lineHeight: 23,
    textAlign: 'center',
  },
  doneActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  donePrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.text,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  donePrimaryText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '600',
  },
  doneSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  doneSecondaryText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
});
