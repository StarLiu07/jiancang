import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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

import { pickErrorMessage } from '../../src/api/client';
import { ClipCard } from '../../src/components/ClipCard';
import { FadeSlideIn, SkeletonList, SpringPressable } from '../../src/components/Motion';
import { QuickAddModal, type QuickAddPayload } from '../../src/components/QuickAddModal';
import { useToast } from '../../src/components/Toast';
import { localRepo, subscribeLocalChanges } from '../../src/local/repository';
import { useSettings } from '../../src/store/settings';
import { useSync } from '../../src/store/sync';
import { colors, elevation, fonts, radius, spacing } from '../../src/theme';
import type { ClipListQuery, ClipSummary, Platform, ReviewState, TagItem } from '../../src/types';

const PAGE_SIZE = 20;
/** Largest page the local repository accepts (see `MAX_LIST_LIMIT` in db.ts). */
const MAX_PAGE_SIZE = 100;
/** Debounce for background ingestion / sync pulling new rows. */
const SILENT_REFRESH_DEBOUNCE_MS = 200;

const PLATFORM_FILTERS: { key: Platform | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'wechat', label: '公众号' },
  { key: 'web', label: '网页' },
  { key: 'x', label: 'X' },
];

function ListSeparator() {
  return <View style={styles.separator} />;
}

export default function LibraryScreen() {
  const { localAiConfig, settings, config, ready } = useSettings();
  const { syncNow } = useSync();  const { show } = useToast();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
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

  const offsetRef = useRef(0);
  const requestRef = useRef(0);

  const queryBase: ClipListQuery = {
    q: debouncedQuery || undefined,
    platform: platform === 'all' ? undefined : platform,
    tag: tag ?? undefined,
    review_state: reviewState,
  };
  const queryBaseRef = useRef(queryBase);
  queryBaseRef.current = queryBase;

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
        const result = await localRepo.listClips({
          q: debouncedQuery || undefined,
          platform: platform === 'all' ? undefined : platform,
          tag: tag ?? undefined,
          review_state: reviewState,
          limit: PAGE_SIZE,
          offset,
        });
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
    [ready, debouncedQuery, platform, reviewState, tag],
  );

  const loadTags = useCallback(async () => {
    if (!ready) return;
    try {
      const result = await localRepo.listTags();
      setTags([...result.tags].sort((a, b) => b.count - a.count).slice(0, 16));
    } catch {
      // Tags are a convenience: swallow failures so the list still works.
    }
  }, [ready]);

  /**
   * Silent refresh after background ingestion / sync: re-reads the pages the
   * user already has on screen, so the list never jumps back to page one and
   * newly pulled cards show up without a visible loading state.
   */
  const refreshSilently = useCallback(async () => {
    if (!ready) return;
    const generation = requestRef.current;
    const loadedAtStart = offsetRef.current;
    const target = Math.max(loadedAtStart, PAGE_SIZE);
    const collected: ClipSummary[] = [];
    let total = 0;

    try {
      while (collected.length < target) {
        const limit = Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, target - collected.length));
        const result = await localRepo.listClips({
          ...queryBaseRef.current,
          limit,
          offset: collected.length,
        });
        collected.push(...result.items);
        total = result.total;
        if (result.items.length === 0 || collected.length >= result.total) break;
      }
    } catch {
      return;
    }

    // A user-initiated load took over (or appended a page) while we were
    // reading: let it win so the visible list never shrinks by accident.
    if (requestRef.current !== generation || offsetRef.current !== loadedAtStart) return;
    offsetRef.current = collected.length;
    setItems(collected);
    setTotal(total);
    void loadTags();
  }, [ready, loadTags]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeLocalChanges(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshSilently();
      }, SILENT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshSilently]);

  useFocusEffect(
    useCallback(() => {
      void loadPage('reset');
      void loadTags();
    }, [loadPage, loadTags]),
  );

  const refreshAll = useCallback(() => {
    void loadPage('refresh');
    void loadTags();
    if (settings.syncEnabled && settings.baseUrl.trim()) {
      // Best effort: an unreachable NUC resolves quietly, never a toast.
      void syncNow({ silent: true }).catch(() => undefined);
    }
  }, [loadPage, loadTags, settings.syncEnabled, settings.baseUrl, syncNow]);

  const handleEndReached = () => {
    if (loading || loadingMore || refreshing) return;
    if (items.length >= total) return;
    void loadPage('more');
  };

  const submitQuickAdd = async (payload: QuickAddPayload) => {
    setAdding(true);
    setQuickAddError(null);
    try {
      const result = await localRepo.createClip(
        {
          input: payload.input,
          user_note: payload.user_note || undefined,
          tags: payload.tags.length ? payload.tags : undefined,
        },
        localAiConfig,
        // Rescue blocked local extractions (XHS login wall) through the NUC.
        { apiConfig: config, syncEnabled: settings.syncEnabled },
      );
      show(result.deduplicated ? '已在收藏目录' : '已收进书房，正在整理', result.deduplicated ? 'info' : 'success');
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>收藏目录</Text>

          <View style={styles.stateTabs}>
            <Pressable
              onPress={() => setReviewState('active')}
              hitSlop={6}
              style={[styles.stateTab, reviewState === 'active' && styles.stateTabActive]}
            >
              <Text style={[styles.stateTabText, reviewState === 'active' && styles.stateTabTextActive]}>
                在库{reviewState === 'active' && !loading ? ` ${total}` : ''}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setReviewState('archived')}
              hitSlop={6}
              style={[styles.stateTab, reviewState === 'archived' && styles.stateTabActive]}
            >
              <Text style={[styles.stateTabText, reviewState === 'archived' && styles.stateTabTextActive]}>
                已归档{reviewState === 'archived' && !loading ? ` ${total}` : ''}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.searchBar}>
          <Ionicons name="search" size={15} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="检索篇名、摘要或标签"
            placeholderTextColor={colors.faint}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => setDebouncedQuery(query.trim())}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          keyboardShouldPersistTaps="handled"
        >
          {PLATFORM_FILTERS.map((filter) => {
            const selected = platform === filter.key;
            return (
              <Pressable
                key={filter.key}
                onPress={() => setPlatform(filter.key)}
                hitSlop={6}
                style={styles.filterItem}
              >
                <Text style={[styles.filterText, selected && styles.filterTextSelected]}>
                  {filter.label}
                </Text>
              </Pressable>
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
                <Pressable
                  key={item.name}
                  onPress={() => setTag(selected ? null : item.name)}
                  hitSlop={4}
                  style={styles.tagItem}
                >
                  <Text style={[styles.tagText, selected && styles.tagTextSelected]}>
                    #{item.name}
                    <Text style={[styles.tagCount, selected && styles.tagCountSelected]}> {item.count}</Text>
                  </Text>
                </Pressable>
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
        ItemSeparatorComponent={ListSeparator}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshAll}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.sheet}
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
                <Ionicons name="file-tray-outline" size={24} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>
                {activeFilterCount ? '这一栏里还没有对应的剪藏' : '收藏目录还是空的'}
              </Text>
              <Text style={styles.emptyText}>
                {activeFilterCount
                  ? '换个关键词或清空筛选条件试试。'
                  : '从小红书、公众号、X 分享，或点右下角 + 手动收入书房。剪藏先存在这台手机上，联网时再同步到 NUC。'}
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
        accessibilityLabel="手动剪藏"
      >
        <Ionicons name="add" size={22} color={colors.onAccent} />
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
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 24,
    fontWeight: '700',
  },
  stateTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  stateTab: {
    paddingBottom: 3,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  stateTabActive: {
    borderBottomColor: colors.accent,
  },
  stateTabText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '400',
  },
  stateTabTextActive: {
    color: colors.text,
    fontWeight: '700',
  },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: 9,
    paddingHorizontal: 11,
    height: 38,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13.5,
    padding: 0,
  },

  filterRow: {
    gap: 16,
    paddingRight: spacing.lg,
    paddingVertical: 1,
  },
  filterItem: {
    paddingVertical: 2,
  },
  filterText: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '400',
  },
  filterTextSelected: {
    color: colors.accent,
    fontWeight: '600',
  },

  tagRow: {
    gap: 12,
    paddingRight: spacing.lg,
    marginTop: -2,
  },
  tagItem: {
    paddingVertical: 2,
  },
  tagText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '400',
  },
  tagTextSelected: {
    color: colors.accent,
    fontWeight: '600',
  },
  tagCount: {
    color: colors.faint,
    fontSize: 11,
  },
  tagCountSelected: {
    color: colors.accent,
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: 18,
    marginTop: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.danger}29`,
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
    fontWeight: '700',
  },

  listContent: {
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 96,
  },
  listEmptyContent: {
    flexGrow: 1,
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
  },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 64,
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.text,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  emptyButtonText: {
    color: colors.bg,
    fontSize: 12.5,
    fontWeight: '600',
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
    right: 16,
    bottom: 16,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.accent,
  },
});
