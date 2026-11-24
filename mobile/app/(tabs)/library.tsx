import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, pickErrorMessage } from '../../src/api/client';
import { ClipCard } from '../../src/components/ClipCard';
import { FadeSlideIn, MOTION, SkeletonList, SpringPressable } from '../../src/components/Motion';
import { QuickAddModal, type QuickAddPayload } from '../../src/components/QuickAddModal';
import { useToast } from '../../src/components/Toast';
import { useSettings } from '../../src/store/settings';
import { colors, elevation, platformMeta, radius, spacing } from '../../src/theme';
import type { ClipSummary, Platform, ReviewState, TagItem } from '../../src/types';

const PAGE_SIZE = 20;

const PLATFORM_FILTERS: { key: Platform | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'wechat', label: '公众号' },
  { key: 'x', label: 'X' },
  { key: 'web', label: '网页' },
];

export default function LibraryScreen() {
  const { config, ready } = useSettings();
  const { show } = useToast();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [platform, setPlatform] = useState<Platform | 'all'>('all');
  const [reviewState, setReviewState] = useState<Extract<ReviewState, 'active' | 'archived'>>('active');
  const [tag, setTag] = useState<string | null>(null);
  const [tags, setTags] = useState<TagItem[]>([]);

  const [items, setItems] = useState<ClipSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quickAddVisible, setQuickAddVisible] = useState(false);
  const [quickAddError, setQuickAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [segmentWidth, setSegmentWidth] = useState(0);
  const segmentSlide = useRef(new Animated.Value(0)).current;

  const offsetRef = useRef(0);
  const requestRef = useRef(0);

  useEffect(() => {
    Animated.spring(segmentSlide, {
      toValue: reviewState === 'active' ? 0 : 1,
      ...MOTION.springSnappy,
    }).start();
  }, [reviewState, segmentSlide]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const loadPage = useCallback(
    async (mode: 'reset' | 'more' | 'refresh') => {
      if (!ready) return;
      const requestId = ++requestRef.current;

      if (mode === 'reset') setLoading(true);
      else if (mode === 'refresh') setRefreshing(true);
      else setLoadingMore(true);
      if (mode !== 'more') setError(null);

      try {
        const offset = mode === 'more' ? offsetRef.current : 0;
        const result = await api.listClips(
          { baseUrl: config.baseUrl, token: config.token },
          {
            q: debouncedQuery || undefined,
            platform: platform === 'all' ? undefined : platform,
            tag: tag ?? undefined,
            review_state: reviewState,
            limit: PAGE_SIZE,
            offset,
          },
        );
        if (requestId !== requestRef.current) return;
        offsetRef.current = offset + result.items.length;
        setItems((previous) => (mode === 'more' ? [...previous, ...result.items] : result.items));
        setTotal(result.total);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(pickErrorMessage(err));
        if (mode === 'reset') {
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [ready, config.baseUrl, config.token, debouncedQuery, platform, reviewState, tag],
  );

  const loadTags = useCallback(async () => {
    if (!ready) return;
    try {
      const result = await api.listTags({ baseUrl: config.baseUrl, token: config.token });
      setTags([...result.tags].sort((a, b) => b.count - a.count).slice(0, 16));
    } catch {
      // Tags are a convenience: swallow failures so the list still works.
    }
  }, [ready, config.baseUrl, config.token]);

  useFocusEffect(
    useCallback(() => {
      void loadPage('reset');
      void loadTags();
    }, [loadPage, loadTags]),
  );

  const refreshAll = () => {
    void loadPage('refresh');
    void loadTags();
  };

  const handleEndReached = () => {
    if (loading || loadingMore || refreshing) return;
    if (items.length >= total) return;
    void loadPage('more');
  };

  const submitQuickAdd = async (payload: QuickAddPayload) => {
    setAdding(true);
    setQuickAddError(null);
    try {
      const result = await api.createClip(
        { baseUrl: config.baseUrl, token: config.token },
        {
          input: payload.input,
          user_note: payload.user_note || undefined,
          tags: payload.tags.length ? payload.tags : undefined,
        },
      );
      show(result.deduplicated ? '已在收藏库' : '已剪藏', result.deduplicated ? 'info' : 'success');
      setQuickAddVisible(false);
      void loadPage('refresh');
      void loadTags();
    } catch (err) {
      setQuickAddError(pickErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const openClip = (id: string) => {
    router.push({ pathname: '/clip/[id]', params: { id } });
  };

  const activeFilterCount = (platform === 'all' ? 0 : 1) + (tag ? 1 : 0) + (debouncedQuery ? 1 : 0);
  const pillTranslateX = segmentSlide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, segmentWidth],
  });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.titleText}>
            <Text style={styles.title}>收藏库</Text>
            <Text style={styles.subtitle}>
              {loading ? '正在同步…' : `共 ${total} 条${activeFilterCount ? ' · 已筛选' : ''}`}
            </Text>
          </View>

          <View
            style={styles.segmented}
            onLayout={(e) => {
              const inner = Math.max(0, e.nativeEvent.layout.width - 6);
              setSegmentWidth(inner / 2);
            }}
          >
            {segmentWidth > 0 ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.segmentIndicator,
                  { width: segmentWidth, transform: [{ translateX: pillTranslateX }] },
                ]}
              />
            ) : null}
            <Pressable onPress={() => setReviewState('active')} style={styles.segment}>
              <Text style={[styles.segmentText, reviewState === 'active' && styles.segmentTextActive]}>在库</Text>
            </Pressable>
            <Pressable onPress={() => setReviewState('archived')} style={styles.segment}>
              <Text style={[styles.segmentText, reviewState === 'archived' && styles.segmentTextActive]}>已归档</Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.searchBar, searchFocused && styles.searchBarFocused]}>
          <Ionicons
            name="search"
            size={16}
            color={searchFocused ? colors.textSecondary : colors.faint}
          />
          <TextInput
            value={query}
            onChangeText={setQuery}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="搜标题、摘要、标签…"
            placeholderTextColor={colors.faint}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => setDebouncedQuery(query.trim())}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          keyboardShouldPersistTaps="handled"
        >
          {PLATFORM_FILTERS.map((filter) => {
            const selected = platform === filter.key;
            const dotColor = filter.key === 'all' ? colors.textSecondary : platformMeta[filter.key].color;
            return (
              <SpringPressable
                key={filter.key}
                onPress={() => setPlatform(filter.key)}
                scaleTo={0.94}
                contentStyle={[styles.chip, selected && styles.chipSelected]}
              >
                {filter.key !== 'all' ? <View style={[styles.chipDot, { backgroundColor: dotColor }]} /> : null}
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{filter.label}</Text>
              </SpringPressable>
            );
          })}
        </ScrollView>

        {tags.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tagRow}
            keyboardShouldPersistTaps="handled"
          >
            {tags.map((item) => {
              const selected = tag === item.name;
              return (
                <SpringPressable
                  key={item.name}
                  onPress={() => setTag(selected ? null : item.name)}
                  scaleTo={0.94}
                  contentStyle={[styles.tagChip, selected && styles.tagChipSelected]}
                >
                  <Text style={[styles.tagText, selected && styles.tagTextSelected]}>
                    #{item.name}
                    <Text style={[styles.tagCount, selected && styles.tagCountSelected]}> {item.count}</Text>
                  </Text>
                </SpringPressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      {error ? (
        <FadeSlideIn distance={8}>
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
            <Text style={styles.errorText} numberOfLines={2}>
              {error}
            </Text>
            <Pressable onPress={() => void loadPage('reset')} hitSlop={6}>
              <Text style={styles.errorRetry}>重试</Text>
            </Pressable>
          </View>
        </FadeSlideIn>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ClipCard clip={item} onPress={() => openClip(item.id)} />}
        contentContainerStyle={[styles.listContent, !items.length && styles.listEmptyContent]}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshAll}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surfaceElevated}
          />
        }
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          loading ? (
            <SkeletonList count={4} />
          ) : (
            <FadeSlideIn distance={12} style={styles.emptyBox}>
              <View style={styles.emptyIcon}>
                <Ionicons name="albums-outline" size={28} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>{activeFilterCount ? '没有匹配的剪藏' : '收藏库还是空的'}</Text>
              <Text style={styles.emptyText}>
                {activeFilterCount ? '换个关键词或清掉筛选试试。' : '从小红书 / 公众号 / X 分享，或点右下角 + 手动剪藏。'}
              </Text>
              {activeFilterCount ? (
                <SpringPressable
                  onPress={() => {
                    setQuery('');
                    setPlatform('all');
                    setTag(null);
                  }}
                  scaleTo={0.95}
                  contentStyle={styles.emptyButton}
                >
                  <Text style={styles.emptyButtonText}>清空筛选</Text>
                </SpringPressable>
              ) : null}
            </FadeSlideIn>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator size="small" color={colors.muted} />
            </View>
          ) : items.length && items.length >= total ? (
            <Text style={styles.footerEnd}>已展示全部 {total} 条</Text>
          ) : null
        }
      />

      <SpringPressable
        onPress={() => {
          setQuickAddError(null);
          setQuickAddVisible(true);
        }}
        scaleTo={0.9}
        style={styles.fabAnchor}
        contentStyle={styles.fab}
        accessibilityLabel="快速剪藏"
      >
        <Ionicons name="add" size={26} color={colors.onAccent} />
      </SpringPressable>

      <QuickAddModal
        visible={quickAddVisible}
        busy={adding}
        error={quickAddError}
        onClose={() => setQuickAddVisible(false)}
        onSubmit={submitQuickAdd}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  titleText: {
    gap: 2,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.faint,
    fontSize: 12,
    fontWeight: '500',
  },
  segmented: {
    position: 'relative',
    flexDirection: 'row',
    width: 132,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 3,
  },
  segmentIndicator: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  segmentText: {
    color: colors.faint,
    fontSize: 12,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.text,
    fontWeight: '700',
  },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 14,
    height: 44,
  },
  searchBarFocused: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    padding: 0,
  },

  chipRow: {
    gap: 7,
    paddingRight: spacing.lg,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipSelected: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentBorder,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chipText: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: colors.accent,
    fontWeight: '700',
  },

  tagRow: {
    gap: 4,
    paddingRight: spacing.lg,
    marginTop: -2,
  },
  tagChip: {
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  tagChipSelected: {
    backgroundColor: colors.glassStrong,
  },
  tagText: {
    color: colors.faint,
    fontSize: 12,
    fontWeight: '500',
  },
  tagTextSelected: {
    color: colors.text,
    fontWeight: '700',
  },
  tagCount: {
    color: colors.faint,
    fontSize: 10.5,
    opacity: 0.75,
  },
  tagCountSelected: {
    color: colors.accent,
    opacity: 1,
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.danger}40`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  errorText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
  },
  errorRetry: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '800',
  },

  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
    paddingBottom: 112,
  },
  listEmptyContent: {
    flexGrow: 1,
  },
  separator: {
    height: 10,
  },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 70,
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
  },
  emptyButtonText: {
    color: colors.text,
    fontSize: 12.5,
    fontWeight: '700',
  },
  footerLoading: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  footerEnd: {
    color: colors.faint,
    fontSize: 11.5,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },

  fabAnchor: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.xl,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.accent,
  },
});
