import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api, mediaUrl, pickErrorMessage } from '../../src/api/client';
import { StatusPill } from '../../src/components/ClipCard';
import { MarkdownText } from '../../src/components/MarkdownText';
import { FadeSlideIn, SkeletonDetail, SpringPressable } from '../../src/components/Motion';
import { PlatformBadge } from '../../src/components/PlatformBadge';
import { useToast } from '../../src/components/Toast';
import { useSettings } from '../../src/store/settings';
import { colors, elevation, radius, spacing } from '../../src/theme';
import type { ClipDetail, ClipUpdateInput } from '../../src/types';
import { formatDateTime, formatTags, parseTags } from '../../src/utils/format';

interface FormState {
  title: string;
  summary: string;
  content: string;
  note: string;
  tags: string;
}

const EMPTY_FORM: FormState = { title: '', summary: '', content: '', note: '', tags: '' };

function toForm(clip: ClipDetail): FormState {
  return {
    title: clip.title,
    summary: clip.summary,
    content: clip.content_markdown,
    note: clip.user_note,
    tags: formatTags(clip.tags),
  };
}

const AI_STATUS_LABEL: Record<ClipDetail['ai_status'], string> = {
  pending: '提炼中',
  done: '已完成',
  skipped: '未启用 AI',
  failed: '提炼失败',
};

export default function ClipDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const clipId = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { config } = useSettings();
  const { show } = useToast();

  const [clip, setClip] = useState<ClipDetail | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContentEditor, setShowContentEditor] = useState(false);

  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!clipId) return;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const detail = await api.getClip({ baseUrl: config.baseUrl, token: config.token }, clipId);
        setClip(detail);
        if (!dirtyRef.current || !loadedRef.current) {
          setForm(toForm(detail));
        }
        loadedRef.current = true;
      } catch (err) {
        setError(pickErrorMessage(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [clipId, config.baseUrl, config.token],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const nextTags = parseTags(form.tags);
  const dirty =
    !!clip &&
    (form.title.trim() !== clip.title ||
      form.summary.trim() !== clip.summary ||
      form.content !== clip.content_markdown ||
      form.note !== clip.user_note ||
      nextTags.join('|') !== clip.tags.join('|'));
  dirtyRef.current = dirty;

  const needsRepair = clip ? clip.status === 'partial' || clip.status === 'failed' : false;
  const editingContent = needsRepair || showContentEditor;

  const openOriginal = async () => {
    if (!clip?.url) return;
    try {
      await Linking.openURL(clip.url);
    } catch {
      show('无法打开原文链接', 'error');
    }
  };

  const save = async () => {
    if (!clip || !dirty) return;
    const patch: ClipUpdateInput = {};
    const title = form.title.trim();
    const summary = form.summary.trim();

    if (title !== clip.title) patch.title = title;
    if (summary !== clip.summary) patch.summary = summary;
    if (form.content !== clip.content_markdown) patch.content_markdown = form.content;
    if (form.note !== clip.user_note) patch.user_note = form.note;
    if (nextTags.join('|') !== clip.tags.join('|')) patch.tags = nextTags;

    if (!Object.keys(patch).length) {
      show('没有需要保存的修改', 'info');
      return;
    }

    setSaving(true);
    try {
      const updated = await api.updateClip(
        { baseUrl: config.baseUrl, token: config.token },
        clip.id,
        patch,
      );
      setClip(updated);
      setForm(toForm(updated));
      show('已保存', 'success');
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    if (!clip || retrying) return;
    setRetrying(true);
    try {
      const updated = await api.retryClip(
        { baseUrl: config.baseUrl, token: config.token },
        clip.id,
      );
      setClip(updated);
      setForm(toForm(updated));
      show('已重新提交抓取', 'success');
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      setRetrying(false);
    }
  };

  const toggleArchive = async () => {
    if (!clip || archiveBusy) return;
    const nextState = clip.review_state === 'archived' ? 'active' : 'archived';
    setArchiveBusy(true);
    try {
      await api.updateClip(
        { baseUrl: config.baseUrl, token: config.token },
        clip.id,
        { review_state: nextState },
      );
      show(nextState === 'archived' ? '已归档' : '已放回收藏库', 'success');
      if (nextState === 'archived') router.back();
      else setClip({ ...clip, review_state: nextState });
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      setArchiveBusy(false);
    }
  };

  const remove = () => {
    if (!clip || deleteBusy) return;
    Alert.alert('删除这条剪藏？', '会从收藏库移除，可在后端恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          setDeleteBusy(true);
          void api
            .deleteClip({ baseUrl: config.baseUrl, token: config.token }, clip.id)
            .then(() => {
              show('已删除', 'success');
              router.back();
            })
            .catch((err: unknown) => show(pickErrorMessage(err), 'error'))
            .finally(() => setDeleteBusy(false));
        },
      },
    ]);
  };

  const title = clip?.title ? (clip.title.length > 16 ? `${clip.title.slice(0, 16)}…` : clip.title) : '剪藏详情';

  if (loading && !clip) {
    return (
      <>
        <Stack.Screen options={{ title: '剪藏详情' }} />
        {error ? (
          <View style={styles.center}>
            <Text style={styles.errorTitle}>加载失败</Text>
            <Text style={styles.errorText}>{error}</Text>
            <SpringPressable onPress={() => void load('initial')} scaleTo={0.95} contentStyle={styles.retryButton}>
              <Text style={styles.retryButtonText}>重试</Text>
            </SpringPressable>
          </View>
        ) : (
          <SkeletonDetail />
        )}
      </>
    );
  }

  if (!clip) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: '剪藏详情' }} />
        <Text style={styles.errorTitle}>没有找到这条剪藏</Text>
        <Text style={styles.errorText}>{error ?? '它可能已经被删除。'}</Text>
        <Pressable onPress={() => router.back()} style={styles.retryButton}>
          <Text style={styles.retryButtonText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
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
        <FadeSlideIn distance={10} duration={240} style={styles.hero}>
          <View style={styles.heroBadges}>
            <PlatformBadge platform={clip.platform} size="md" />
            {clip.status !== 'ready' ? <StatusPill status={clip.status} /> : null}
            {clip.review_state === 'archived' ? (
              <View style={styles.archivedPill}>
                <Text style={styles.archivedText}>已归档</Text>
              </View>
            ) : null}
          </View>

          <Text style={styles.title}>{clip.title || '未命名剪藏'}</Text>

          {clip.author ? <Text style={styles.author}>@{clip.author}</Text> : null}

          <View style={styles.metaStrip}>
            <MetaItem label="收藏时间" value={formatDateTime(clip.created_at)} />
            <MetaItem label="发布时间" value={formatDateTime(clip.published_at)} />
            <MetaItem label="回顾次数" value={`${clip.review_count} 次`} />
            <MetaItem label="下次回顾" value={formatDateTime(clip.next_review_at)} />
          </View>

          <SpringPressable
            onPress={() => void openOriginal()}
            scaleTo={0.98}
            contentStyle={styles.linkButton}
          >
            <Ionicons name="open-outline" size={15} color={colors.textSecondary} />
            <Text style={styles.linkText}>打开原文</Text>
            <Text style={styles.linkHost} numberOfLines={1}>
              {clip.url.replace(/^https?:\/\//, '')}
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.faint} />
          </SpringPressable>
        </FadeSlideIn>

        {needsRepair ? (
          <FadeSlideIn delay={40} distance={10}>
            <View style={styles.warnCard}>
              <View style={styles.warnHeader}>
                <Ionicons name="warning-outline" size={18} color={colors.warning} />
                <Text style={styles.warnTitle}>
                  {clip.status === 'failed' ? '这条剪藏抓取失败了' : '这条剪藏只抓到了一部分'}
                </Text>
              </View>
              <Text style={styles.warnText}>
                {clip.error_message || '可以重新抓取一次，或在下方手动补全正文与备注。'}
              </Text>
              <SpringPressable
                onPress={() => void retry()}
                disabled={retrying}
                scaleTo={0.95}
                contentStyle={[styles.retryInline, retrying && styles.pressed]}
              >
                {retrying ? (
                  <ActivityIndicator size="small" color={colors.onAccent} />
                ) : (
                  <>
                    <Ionicons name="refresh" size={14} color={colors.onAccent} />
                    <Text style={styles.retryInlineText}>重新抓取</Text>
                  </>
                )}
              </SpringPressable>
            </View>
          </FadeSlideIn>
        ) : null}

        <FadeSlideIn delay={55} distance={12}>
          <View style={styles.aiCard}>
            <View style={styles.aiAccentBar} />
            <View style={styles.sectionHeader}>
              <Ionicons name="sparkles" size={15} color={colors.accent} />
              <Text style={styles.aiCardTitle}>AI 提炼</Text>
              <View style={styles.grow} />
              <Text style={styles.sectionHint}>{AI_STATUS_LABEL[clip.ai_status]}</Text>
            </View>

            {clip.summary ? (
              <Text style={styles.summary}>{clip.summary}</Text>
            ) : (
              <Text style={styles.placeholder}>
                {clip.ai_status === 'pending' ? 'AI 正在提炼要点，稍后下拉刷新。' : '这条还没有 AI 摘要。'}
              </Text>
            )}

            {clip.key_points.length ? (
              <View style={styles.points}>
                {clip.key_points.map((point, index) => (
                  <View key={`${index}-${point.slice(0, 12)}`} style={styles.pointRow}>
                    <View style={styles.pointDot} />
                    <Text style={styles.pointText}>{point}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </FadeSlideIn>

        {clip.media.length ? (
          <View style={styles.framelessSection}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionEyebrow}>存档图片</Text>
              <View style={styles.grow} />
              <Text style={styles.sectionHint}>{clip.media.length} 张 · 已本地化</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery}>
              {clip.media.map((item) => {
                const uri = mediaUrl(config, item.url);
                return (
                  <View key={item.id} style={styles.galleryItem}>
                    {uri ? (
                      <Image source={{ uri }} style={styles.galleryImage} resizeMode="cover" />
                    ) : (
                      <View style={[styles.galleryImage, styles.galleryFallback]}>
                        <Ionicons name="image-outline" size={24} color={colors.faint} />
                      </View>
                    )}
                    <Text style={styles.galleryLabel} numberOfLines={1}>
                      #{item.sort_order + 1} · {item.mime_type.replace('image/', '').toUpperCase()}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.articleSection}>
          <View style={styles.sectionDivider} />
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionEyebrow}>存档正文</Text>
            <View style={styles.grow} />
            <Text style={styles.sectionHint}>{clip.content_markdown.length} 字</Text>
          </View>
          {clip.content_markdown.trim() ? (
            <MarkdownText content={clip.content_markdown} selectable />
          ) : (
            <Text style={styles.placeholder}>还没有正文内容，可在下方手动补全。</Text>
          )}
        </View>

        <View style={styles.editorCard}>
          <View style={styles.sectionHeader}>
            <Ionicons name="create-outline" size={16} color={colors.muted} />
            <Text style={styles.editorTitle}>我的笔记与标签</Text>
            <View style={styles.grow} />
            {!needsRepair ? (
              <Pressable onPress={() => setShowContentEditor((value) => !value)} hitSlop={6}>
                <Text style={styles.toggleText}>{showContentEditor ? '收起编辑' : '编辑正文'}</Text>
              </Pressable>
            ) : null}
          </View>

          {editingContent ? (
            <>
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>标题</Text>
                <TextInput
                  value={form.title}
                  onChangeText={(value) => setForm((prev) => ({ ...prev, title: value }))}
                  style={styles.input}
                  placeholder="剪藏标题"
                  placeholderTextColor={colors.faint}
                  editable={!saving}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>一句话摘要</Text>
                <TextInput
                  value={form.summary}
                  onChangeText={(value) => setForm((prev) => ({ ...prev, summary: value }))}
                  style={styles.input}
                  placeholder="这条内容讲了什么？"
                  placeholderTextColor={colors.faint}
                  editable={!saving}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>正文（Markdown）</Text>
                <TextInput
                  value={form.content}
                  onChangeText={(value) => setForm((prev) => ({ ...prev, content: value }))}
                  style={[styles.input, styles.textarea]}
                  placeholder="把正文粘贴到这里，保存后即成为本地存档。"
                  placeholderTextColor={colors.faint}
                  multiline
                  textAlignVertical="top"
                  editable={!saving}
                />
              </View>
            </>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>个人笔记</Text>
            <TextInput
              value={form.note}
              onChangeText={(value) => setForm((prev) => ({ ...prev, note: value }))}
              style={[styles.input, styles.noteArea]}
              placeholder="写点自己的理解，或者下一步要做什么…"
              placeholderTextColor={colors.faint}
              multiline
              textAlignVertical="top"
              editable={!saving}
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>标签</Text>
            <TextInput
              value={form.tags}
              onChangeText={(value) => setForm((prev) => ({ ...prev, tags: value }))}
              style={styles.input}
              placeholder="AI, 设计, 稍后实践"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!saving}
            />
          </View>

          {nextTags.length ? (
            <View style={styles.previewTags}>
              {nextTags.map((tag) => (
                <View key={tag} style={styles.previewTag}>
                  <Text style={styles.previewTagText}>#{tag}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <SpringPressable
            onPress={() => void save()}
            disabled={!dirty || saving}
            scaleTo={0.97}
            contentStyle={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <>
                <Ionicons name="checkmark" size={16} color={colors.onAccent} />
                <Text style={styles.saveText}>{dirty ? '保存修改' : '没有未保存的修改'}</Text>
              </>
            )}
          </SpringPressable>
        </View>

        <View style={styles.footerActions}>
          <SpringPressable
            onPress={() => void toggleArchive()}
            disabled={archiveBusy}
            scaleTo={0.96}
            style={styles.footerFlex}
            contentStyle={[styles.footerButton, archiveBusy && styles.pressed]}
          >
            {archiveBusy ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Ionicons
                name={clip.review_state === 'archived' ? 'arrow-undo-outline' : 'archive-outline'}
                size={16}
                color={colors.textSecondary}
              />
            )}
            <Text style={styles.footerButtonText}>
              {clip.review_state === 'archived' ? '移回收藏库' : '快速归档'}
            </Text>
          </SpringPressable>

          <SpringPressable
            onPress={remove}
            disabled={deleteBusy}
            scaleTo={0.96}
            style={styles.footerFlex}
            contentStyle={[styles.footerButton, styles.footerDanger, deleteBusy && styles.pressed]}
          >
            {deleteBusy ? (
              <ActivityIndicator size="small" color={colors.danger} />
            ) : (
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
            )}
            <Text style={[styles.footerButtonText, { color: colors.danger }]}>删除</Text>
          </SpringPressable>
        </View>

        {error && clip ? <Text style={styles.staleHint}>同步提示：{error}</Text> : null}
      </ScrollView>
    </>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value || '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 44,
    gap: 22,
  },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
  },
  errorTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  errorText: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '800',
  },

  hero: {
    gap: 12,
  },
  heroBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  archivedPill: {
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  archivedText: {
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: '600',
  },
  title: {
    color: colors.text,
    fontSize: 24,
    lineHeight: 33,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  author: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '500',
    marginTop: -4,
  },
  metaStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingVertical: 12,
    rowGap: 10,
  },
  metaItem: {
    width: '50%',
    gap: 2,
  },
  metaLabel: {
    color: colors.faint,
    fontSize: 10.5,
    fontWeight: '600',
  },
  metaValue: {
    color: colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  linkText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  linkHost: {
    flex: 1,
    color: colors.faint,
    fontSize: 11.5,
    textAlign: 'right',
  },

  warnCard: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: `${colors.warning}44`,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  warnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  warnTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  warnText: {
    color: colors.textSecondary,
    fontSize: 12.5,
    lineHeight: 19,
  },
  retryInline: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.warning,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginTop: 2,
  },
  retryInlineText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '800',
  },

  aiCard: {
    position: 'relative',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.accentBorder,
    padding: spacing.xl,
    paddingLeft: 22,
    gap: 14,
    overflow: 'hidden',
    ...elevation.card,
  },
  aiAccentBar: {
    position: 'absolute',
    left: 0,
    top: 18,
    bottom: 18,
    width: 3,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: colors.accent,
  },
  aiCardTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sectionEyebrow: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  sectionHint: {
    color: colors.faint,
    fontSize: 11,
  },
  grow: {
    flex: 1,
  },
  summary: {
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 25,
    fontWeight: '600',
  },
  placeholder: {
    color: colors.muted,
    fontSize: 13.5,
    lineHeight: 21,
  },
  points: {
    gap: 10,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  pointDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accent,
    marginTop: 9,
  },
  pointText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },

  framelessSection: {
    gap: 12,
  },
  gallery: {
    gap: 10,
    paddingRight: spacing.lg,
  },
  galleryItem: {
    width: 216,
    gap: 6,
  },
  galleryImage: {
    width: 216,
    height: 276,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
  },
  galleryFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryLabel: {
    color: colors.faint,
    fontSize: 11,
  },

  articleSection: {
    gap: 14,
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginBottom: 2,
  },

  editorCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: 14,
  },
  editorTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  toggleText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '600',
    marginLeft: 2,
  },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  textarea: {
    minHeight: 160,
  },
  noteArea: {
    minHeight: 92,
  },
  previewTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  previewTag: {
    backgroundColor: colors.glass,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  previewTagText: {
    color: colors.textSecondary,
    fontSize: 11.5,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    ...elevation.accent,
  },
  saveButtonDisabled: {
    opacity: 0.34,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '800',
  },

  footerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  footerFlex: {
    flex: 1,
  },
  footerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingVertical: 13,
  },
  footerDanger: {
    backgroundColor: 'transparent',
    borderColor: `${colors.danger}33`,
  },
  footerButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  staleHint: {
    color: colors.faint,
    fontSize: 11,
    textAlign: 'center',
    paddingTop: spacing.xs,
  },
  pressed: {
    opacity: 0.78,
  },
});
