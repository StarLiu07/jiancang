import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { ClipCard } from '../../src/components/ClipCard';
import { ClipboardBanner } from '../../src/components/ClipboardBanner';
import { useToast } from '../../src/components/Toast';
import { useClipboardLink } from '../../src/hooks/useClipboardLink';
import { useSettings } from '../../src/store/settings';
import { colors, radius, spacing } from '../../src/theme';
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

interface ActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  disabled?: boolean;
  onPress: () => void;
}

function ActionButton({ icon, label, color, disabled, onPress }: ActionButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionButton,
        { borderColor: `${color}3D`, backgroundColor: `${color}14` },
        (pressed || disabled) && styles.actionButtonMuted,
      ]}
    >
      <Ionicons name={icon} size={19} color={color} />
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </Pressable>
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
  const [error, setError] = useState<string | null>(null);

  const requestRef = useRef(0);
  const loadedRef = useRef(false);
  const { link, dismiss, refresh: refreshClipboard } = useClipboardLink(ready);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!ready) return;
      const requestId = ++requestRef.current;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
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
    [ready, config.baseUrl, config.token],
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

  const handleAction = async (action: ReviewActionType) => {
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
  };

  const openDetail = (id: string) => {
    router.push({ pathname: '/clip/[id]', params: { id } });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surface}
          />
        }
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.title}>今日回顾</Text>
            <Text style={styles.subtitle}>{todayLabel()}</Text>
          </View>
          <Pressable
            onPress={() => void load('refresh')}
            style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
            hitSlop={8}
          >
            <Ionicons name="refresh" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.progressCard}>
          <View style={styles.progressTopRow}>
            <Text style={styles.progressLabel}>
              今日已回顾 <Text style={styles.progressStrong}>{reviewedToday}</Text>
              <Text style={styles.progressMuted}> / {dailyTarget}</Text>
            </Text>
            <Text style={styles.progressHint}>
              {totalActive > 0 ? `在库 ${totalActive} 条` : '收藏库还是空的'}
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: progressWidth }]} />
          </View>
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
        ) : null}

        {loading && !refreshing ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>正在准备今天的回顾…</Text>
          </View>
        ) : finished ? (
          <View style={styles.doneCard}>
            <View style={styles.doneIcon}>
              <Ionicons name="checkmark-done" size={30} color={colors.success} />
            </View>
            <Text style={styles.doneTitle}>
              {reviewedToday >= dailyTarget ? '今天的回顾完成啦' : '暂时没有待回顾的剪藏'}
            </Text>
            <Text style={styles.doneText}>
              {reviewedToday >= dailyTarget
                ? `已完成 ${reviewedToday} / ${dailyTarget}，让收藏真正沉淀下来。`
                : '可以去收藏库挑几条，或者等下一次提醒。'}
            </Text>
            <View style={styles.doneActions}>
              <Pressable
                onPress={() => void load('initial')}
                style={({ pressed }) => [styles.donePrimary, pressed && styles.pressed]}
              >
                <Ionicons name="refresh" size={16} color="#1A0D08" />
                <Text style={styles.donePrimaryText}>再拉一批</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/library')}
                style={({ pressed }) => [styles.doneSecondary, pressed && styles.pressed]}
              >
                <Ionicons name="albums-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.doneSecondaryText}>去收藏库</Text>
              </Pressable>
            </View>
          </View>
        ) : current ? (
          <View style={styles.reviewBlock}>
            <View style={styles.queueRow}>
              <Text style={styles.queueText}>
                第 {Math.min(index + 1, items.length)} / {items.length} 张
              </Text>
              {remaining > 0 ? <Text style={styles.queueHint}>接下来还有 {remaining} 张</Text> : null}
            </View>

            <ClipCard clip={current} variant="feature" onPress={() => openDetail(current.id)} />

            <View style={styles.actions}>
              <ActionButton
                icon="time-outline"
                label="以后再看"
                color={colors.warning}
                disabled={acting}
                onPress={() => void handleAction('snooze')}
              />
              <ActionButton
                icon="checkmark-circle-outline"
                label="已消化"
                color={colors.success}
                disabled={acting}
                onPress={() => void handleAction('archive')}
              />
              <ActionButton
                icon="trash-outline"
                label="删除"
                color={colors.danger}
                disabled={acting}
                onPress={() => void handleAction('delete')}
              />
            </View>

            {acting ? (
              <View style={styles.syncingRow}>
                <ActivityIndicator size="small" color={colors.muted} />
                <Text style={styles.syncingText}>正在同步到后端…</Text>
              </View>
            ) : null}
          </View>
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
    padding: spacing.lg,
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
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12,
    letterSpacing: 0.4,
  },
  refreshButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
  progressCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  progressTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  progressLabel: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  progressStrong: {
    color: colors.accent,
    fontWeight: '800',
    fontSize: 15,
  },
  progressMuted: {
    color: colors.muted,
  },
  progressHint: {
    color: colors.faint,
    fontSize: 11,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: `${colors.danger}44`,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorBody: {
    flex: 1,
    gap: 3,
  },
  errorTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  errorRetry: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
  },
  errorRetryText: {
    color: '#1A0D08',
    fontSize: 11,
    fontWeight: '800',
  },
  loadingBox: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 70,
  },
  loadingText: {
    color: colors.muted,
    fontSize: 12,
  },
  reviewBlock: {
    gap: spacing.md,
  },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  queueText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  queueHint: {
    color: colors.faint,
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  actionButtonMuted: {
    opacity: 0.5,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  syncingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  syncingText: {
    color: colors.faint,
    fontSize: 11,
  },
  doneCard: {
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  doneIcon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  doneText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
  },
  doneActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  donePrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  donePrimaryText: {
    color: '#1A0D08',
    fontSize: 12,
    fontWeight: '800',
  },
  doneSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  doneSecondaryText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
});
