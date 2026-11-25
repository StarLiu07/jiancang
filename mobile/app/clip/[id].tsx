import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { mediaUrl, pickErrorMessage } from '../../src/api/client';
import { StatusPill } from '../../src/components/ClipCard';
import { ImageLightboxModal } from '../../src/components/ImageLightboxModal';
import { MarkdownText } from '../../src/components/MarkdownText';
import { FadeSlideIn, SkeletonDetail, SpringPressable } from '../../src/components/Motion';
import { useToast } from '../../src/components/Toast';
import { buildLightboxItems } from '../../src/components/imageZoomMath';
import { localRepo, subscribeLocalChanges } from '../../src/local/repository';
import { useSettings } from '../../src/store/settings';
import { colors, elevation, fonts, platformMeta, radius, spacing } from '../../src/theme';
import type { ClipDetail, ClipUpdateInput } from '../../src/types';
import { formatDateTime, formatTags, parseTags } from '../../src/utils/format';

/** Debounce for background ingestion turning this clip into ready/partial/failed. */
const SILENT_RELOAD_DEBOUNCE_MS = 250;

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

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

export default function ClipDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const clipId = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { config, localAiConfig } = useSettings();
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
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [showContentEditor, setShowContentEditor] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [chatCount, setChatCount] = useState(0);

  // Filter unresolvable media once and keep the media-index -> preview-index map
  // so tapping the Nth gallery thumbnail opens the matching full-screen page.
  const lightbox = useMemo(
    () => buildLightboxItems(clip?.media ?? [], (url) => mediaUrl(config, url)),
    [clip?.media, config],
  );

  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent' = 'initial') => {
      if (!clipId) return;
      if (mode === 'refresh') setRefreshing(true);
      else if (mode === 'initial') setLoading(true);
      if (mode !== 'silent') setError(null);
      try {
        // The chat count is decorative: never let it fail the detail load.
        const [detail, chatTurns] = await Promise.all([
          localRepo.getClip(clipId),
          localRepo.countChatMessages(clipId).catch(() => 0),
        ]);
        setClip(detail);
        setChatCount(chatTurns);
        // Never overwrite a draft the user is actively editing.
        if (!dirtyRef.current || !loadedRef.current) {
          setForm(toForm(detail));
        }
        loadedRef.current = true;
      } catch (err) {
        // Silent reloads stay quiet: the clip is already on screen.
        if (mode !== 'silent') setError(pickErrorMessage(err));
      } finally {
        if (mode !== 'silent') {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [clipId],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const clipRef = useRef<ClipDetail | null>(clip);
  clipRef.current = clip;
  const loadRef = useRef(load);
  loadRef.current = load;

  // Coming back from the chat screen: re-read the note (a reply may have been
  // appended) and the conversation count without flashing a spinner. `load`
  // already refuses to overwrite an unsaved draft.
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (!clipId) return;
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      void loadRef.current('silent');
      void localRepo
        .countChatMessages(clipId)
        .then((count) => setChatCount(count))
        .catch(() => undefined);
    }, [clipId]),
  );

  // Re-read the detail while extraction / AI enrichment is still running, so
  // the body and digest appear without a manual pull-to-refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeLocalChanges(() => {
      const current = clipRef.current;
      if (!current) return;
      const unfinished =
        current.status === 'pending'
        || current.status === 'processing'
        || current.ai_status === 'pending';
      if (!unfinished) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadRef.current('silent');
      }, SILENT_RELOAD_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

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
  const isEditorOpen = needsRepair || editorExpanded || dirty;
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
      const updated = await localRepo.updateClip(clip.id, patch);
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
      const updated = await localRepo.retryClip(clip.id, localAiConfig);
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
      await localRepo.updateClip(clip.id, { review_state: nextState });
      show(nextState === 'archived' ? '已归档' : '已放回收藏目录', 'success');
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
    Alert.alert('删除这条剪藏？', '会从收藏库中移除，并同步删除记录。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          setDeleteBusy(true);
          void localRepo
            .deleteClip(clip.id)
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
        <Stack.Screen options={{ title: '剪藏详情', headerStyle: { backgroundColor: colors.sheet } }} />
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
        <Stack.Screen options={{ title: '剪藏详情', headerStyle: { backgroundColor: colors.sheet } }} />
        <Text style={styles.errorTitle}>没有找到这条剪藏</Text>
        <Text style={styles.errorText}>{error ?? '它可能已经被删除。'}</Text>
        <Pressable onPress={() => router.back()} style={styles.retryButton}>
          <Text style={styles.retryButtonText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  const meta = platformMeta[clip.platform];
  const createdShort = shortDate(clip.created_at);
  const hasExistingAnnotation = Boolean(clip.user_note.trim() || clip.tags.length);

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: colors.sheet },
          headerRight: () => (
            <SpringPressable
              onPress={() => router.push({ pathname: '/chat/[id]', params: { id: clip.id } })}
              scaleTo={0.94}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="问 AI"
              contentStyle={styles.headerChatButton}
            >
              <Ionicons name="sparkles-outline" size={13} color={colors.accent} />
              <Text style={styles.headerChatText}>问 AI</Text>
            </SpringPressable>
          ),
        }}
      />
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
            progressBackgroundColor={colors.sheet}
          />
        }
      >
        <FadeSlideIn distance={10} duration={240} style={styles.hero}>
          <View style={styles.heroMetaRow}>
            <View style={[styles.platformDot, { backgroundColor: meta.color }]} />
            <Text style={styles.heroMetaText}>{meta.label}</Text>
            {clip.author ? (
              <>
                <Text style={styles.heroMetaSep}>·</Text>
                <Text style={styles.heroMetaText} numberOfLines={1}>
                  {clip.author}
                </Text>
              </>
            ) : null}
            {createdShort ? (
              <>
                <Text style={styles.heroMetaSep}>·</Text>
                <Text style={styles.heroMetaDate}>{createdShort}</Text>
              </>
            ) : null}
            {clip.status !== 'ready' ? <StatusPill status={clip.status} /> : null}
            {clip.review_state === 'archived' ? (
              <View style={styles.archivedPill}>
                <Text style={styles.archivedText}>已归档</Text>
              </View>
            ) : null}
          </View>

          <Text style={styles.title}>{clip.title || '未命名剪藏'}</Text>

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
            <Ionicons name="open-outline" size={14} color={colors.muted} />
            <Text style={styles.linkText}>原文链接</Text>
            <Text style={styles.linkHost} numberOfLines={1}>
              {clip.url.replace(/^https?:\/\//, '')}
            </Text>
            <Ionicons name="chevron-forward" size={13} color={colors.faint} />
          </SpringPressable>
        </FadeSlideIn>

        {needsRepair ? (
          <FadeSlideIn delay={40} distance={10}>
            <View style={styles.warnCard}>
              <View style={styles.warnHeader}>
                <Ionicons name="warning-outline" size={17} color={colors.warning} />
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

        <FadeSlideIn delay={55} distance={10}>
          <View style={styles.digestBox}>
            <View style={styles.sectionHeader}>
              <Text style={styles.digestTitle}>编者提要</Text>
              <View style={styles.grow} />
              <Text style={styles.sectionHint}>{AI_STATUS_LABEL[clip.ai_status]}</Text>
            </View>

            {clip.summary ? (
              <Text style={styles.summary}>{clip.summary}</Text>
            ) : (
              <Text style={styles.placeholder}>
                {clip.ai_status === 'pending' ? '正在提炼要点，稍后下拉刷新。' : '这条还没有提要摘要。'}
              </Text>
            )}

            {clip.key_points.length ? (
              <View style={styles.points}>
                {clip.key_points.map((point, index) => (
                  <View key={`${index}-${point.slice(0, 12)}`} style={styles.pointRow}>
                    <Text style={styles.pointDash}>—</Text>
                    <Text style={styles.pointText}>{point}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </FadeSlideIn>

        <FadeSlideIn delay={70} distance={10}>
          <SpringPressable
            onPress={() => router.push({ pathname: '/chat/[id]', params: { id: clip.id } })}
            scaleTo={0.985}
            accessibilityRole="button"
            accessibilityLabel="与 AI 聊这篇文章"
            contentStyle={styles.chatEntryCard}
          >
            <View style={styles.chatEntryIconWrap}>
              <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.accent} />
            </View>
            <View style={styles.chatEntryText}>
              <Text style={styles.chatEntryTitle}>与 AI 聊这篇文章</Text>
              <Text style={styles.chatEntrySubtitle} numberOfLines={2}>
                {chatCount > 0
                  ? `已有 ${chatCount} 条对话 · 继续追问`
                  : '追问正文细节、提炼行动清单或生成笔记'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color={colors.faint} />
          </SpringPressable>
        </FadeSlideIn>

        {clip.media.length ? (
          <View style={styles.framelessSection}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionEyebrow}>存档图片</Text>
              <View style={styles.grow} />
              <Text style={styles.sectionHint}>{clip.media.length} 张 · 点击放大</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery}>
              {clip.media.map((item, mediaIndex) => {
                const uri = mediaUrl(config, item.url);
                const label = `#${item.sort_order + 1} · ${item.mime_type.replace('image/', '').toUpperCase()}`;

                if (!uri) {
                  return (
                    <View key={item.id} style={styles.galleryItem}>
                      <View style={[styles.galleryImage, styles.galleryFallback]}>
                        <Ionicons name="image-outline" size={24} color={colors.faint} />
                      </View>
                      <Text style={styles.galleryLabel} numberOfLines={1}>
                        {label}
                      </Text>
                    </View>
                  );
                }

                const previewIndex = lightbox.indexMap.get(mediaIndex);
                return (
                  <Pressable
                    key={item.id}
                    style={styles.galleryItem}
                    onPress={() => {
                      if (previewIndex !== undefined) setLightboxIndex(previewIndex);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`放大查看第 ${mediaIndex + 1} 张图片`}
                  >
                    <View style={styles.galleryImageWrap}>
                      <Image source={{ uri }} style={styles.galleryImage} resizeMode="cover" />
                      <View style={styles.galleryZoomBadge} pointerEvents="none">
                        <Ionicons name="expand-outline" size={12} color={colors.onAccent} />
                      </View>
                    </View>
                    <Text style={styles.galleryLabel} numberOfLines={1}>
                      {label}
                    </Text>
                  </Pressable>
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

        {!isEditorOpen ? (
          <SpringPressable
            onPress={() => setEditorExpanded(true)}
            scaleTo={0.985}
            contentStyle={styles.collapsedEditorBar}
          >
            <Ionicons name="create-outline" size={16} color={colors.accent} />
            <Text style={styles.collapsedEditorText}>写两句批注与标签</Text>
            <View style={styles.grow} />
            {hasExistingAnnotation ? (
              <Text style={styles.collapsedEditorMeta}>
                {clip.user_note.trim() && clip.tags.length
                  ? `已有批注 · ${clip.tags.length} 个标签`
                  : clip.user_note.trim()
                    ? '已有批注'
                    : `${clip.tags.length} 个标签`}
              </Text>
            ) : null}
            <Ionicons name="chevron-down" size={15} color={colors.muted} />
          </SpringPressable>
        ) : (
          <View style={styles.editorCard}>
            <View style={styles.sectionHeader}>
              <Ionicons name="create-outline" size={16} color={colors.accent} />
              <Text style={styles.editorTitle}>我的笔记与标签</Text>
              <View style={styles.grow} />
              {!needsRepair ? (
                <View style={styles.editorHeaderActions}>
                  <Pressable onPress={() => setShowContentEditor((value) => !value)} hitSlop={6}>
                    <Text style={styles.toggleText}>{showContentEditor ? '收起正文' : '编辑正文'}</Text>
                  </Pressable>
                  {!dirty ? (
                    <Pressable onPress={() => setEditorExpanded(false)} hitSlop={6}>
                      <Text style={styles.collapseText}>收起</Text>
                    </Pressable>
                  ) : null}
                </View>
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
                placeholder="三天后再看，你想记下哪两句话？"
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
                  <Text key={tag} style={styles.previewTagText}>
                    #{tag}
                  </Text>
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
        )}

        <View style={styles.footerActions}>
          <SpringPressable
            onPress={() => void toggleArchive()}
            disabled={archiveBusy}
            scaleTo={0.96}
            style={styles.footerFlex}
            contentStyle={[styles.footerArchiveButton, archiveBusy && styles.pressed]}
          >
            {archiveBusy ? (
              <ActivityIndicator size="small" color={colors.bg} />
            ) : (
              <Ionicons
                name={clip.review_state === 'archived' ? 'arrow-undo-outline' : 'archive-outline'}
                size={15}
                color={colors.bg}
              />
            )}
            <Text style={styles.footerArchiveText}>
              {clip.review_state === 'archived' ? '移回收藏目录' : '快速归档'}
            </Text>
          </SpringPressable>

          <SpringPressable
            onPress={remove}
            disabled={deleteBusy}
            scaleTo={0.96}
            style={styles.footerFlex}
            contentStyle={[styles.footerDeleteButton, deleteBusy && styles.pressed]}
          >
            {deleteBusy ? (
              <ActivityIndicator size="small" color={colors.danger} />
            ) : (
              <Ionicons name="trash-outline" size={15} color={colors.danger} />
            )}
            <Text style={styles.footerDeleteText}>删除</Text>
          </SpringPressable>
        </View>

        {error && clip ? <Text style={styles.staleHint}>刷新提示：{error}</Text> : null}
      </ScrollView>

      <ImageLightboxModal
        visible={lightboxIndex !== null}
        images={lightbox.items}
        initialIndex={lightboxIndex ?? 0}
        onClose={() => setLightboxIndex(null)}
      />
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
    backgroundColor: colors.sheet,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 44,
    gap: 18,
  },
  center: {
    flex: 1,
    backgroundColor: colors.sheet,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
  },
  errorTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 18,
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
    backgroundColor: colors.text,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '600',
  },

  hero: {
    gap: 12,
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
  },
  platformDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  heroMetaText: {
    color: colors.muted,
    fontSize: 12,
  },
  heroMetaSep: {
    color: colors.faint,
    fontSize: 12,
  },
  heroMetaDate: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 12,
  },
  archivedPill: {
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  archivedText: {
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: '600',
  },
  title: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 22,
    lineHeight: 31,
    fontWeight: '700',
  },
  metaStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingVertical: 10,
    rowGap: 8,
  },
  metaItem: {
    width: '50%',
    gap: 2,
  },
  metaLabel: {
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: '500',
  },
  metaValue: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  linkText: {
    color: colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  linkHost: {
    flex: 1,
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 11,
    textAlign: 'right',
  },

  warnCard: {
    backgroundColor: colors.warningSoft,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.warning}38`,
    padding: 14,
    gap: 8,
  },
  warnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  warnTitle: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '600',
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
    borderRadius: 8,
    paddingHorizontal: 13,
    paddingVertical: 7,
    marginTop: 2,
  },
  retryInlineText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '600',
  },

  digestBox: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 9,
  },
  digestTitle: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sectionEyebrow: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  sectionHint: {
    color: colors.muted,
    fontSize: 11,
  },
  grow: {
    flex: 1,
  },
  summary: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 24,
    fontWeight: '500',
  },
  placeholder: {
    color: colors.muted,
    fontSize: 13.5,
    lineHeight: 21,
  },
  points: {
    gap: 6,
    paddingTop: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  pointRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  pointDash: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 21.5,
  },
  pointText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 21.5,
  },

  framelessSection: {
    gap: 10,
  },
  gallery: {
    gap: 10,
    paddingRight: spacing.lg,
  },
  galleryItem: {
    width: 216,
    gap: 5,
  },
  galleryImage: {
    width: 216,
    height: 268,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  galleryImageWrap: {
    borderRadius: 8,
    overflow: 'hidden',
  },
  galleryZoomBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(31, 28, 24, 0.46)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 251, 247, 0.30)',
  },
  galleryFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryLabel: {
    fontFamily: fonts.mono,
    color: colors.faint,
    fontSize: 10.5,
  },

  articleSection: {
    gap: 14,
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
  },

  collapsedEditorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  collapsedEditorText: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '500',
  },
  collapsedEditorMeta: {
    color: colors.muted,
    fontSize: 12,
  },

  editorCard: {
    backgroundColor: colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 15,
    gap: 13,
  },
  editorTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  editorHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  toggleText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  collapseText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
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
    backgroundColor: colors.sheet,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  textarea: {
    minHeight: 150,
  },
  noteArea: {
    minHeight: 88,
  },
  previewTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  previewTagText: {
    color: colors.muted,
    fontSize: 12,
  },
  saveButton: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: 9,
    ...elevation.accent,
  },
  saveButtonDisabled: {
    opacity: 0.36,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveText: {
    color: colors.onAccent,
    fontSize: 13.5,
    fontWeight: '600',
  },

  footerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  footerFlex: {
    flex: 1,
  },
  footerArchiveButton: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.text,
    borderRadius: 10,
  },
  footerArchiveText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '600',
  },
  footerDeleteButton: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'transparent',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  footerDeleteText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  staleHint: {
    color: colors.danger,
    fontSize: 11,
    textAlign: 'center',
    paddingTop: spacing.xs,
  },

  headerChatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  headerChatText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  chatEntryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  chatEntryIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  chatEntryText: {
    flex: 1,
    gap: 3,
  },
  chatEntryTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 14.5,
    fontWeight: '700',
  },
  chatEntrySubtitle: {
    color: colors.muted,
    fontSize: 11.5,
    lineHeight: 17,
  },
  pressed: {
    opacity: 0.78,
  },
});
