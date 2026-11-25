import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pickErrorMessage } from '../../src/api/client';
import { MarkdownText } from '../../src/components/MarkdownText';
import { FadeSlideIn, SpringPressable } from '../../src/components/Motion';
import { useToast } from '../../src/components/Toast';
import {
  appendReplyToNoteText,
  resolveChatChannel,
  STARTER_PROMPTS,
  type ChatChannel,
} from '../../src/local/chat';
import { localRepo } from '../../src/local/repository';
import { useSettings } from '../../src/store/settings';
import { colors, elevation, fonts, platformMeta, radius, spacing } from '../../src/theme';
import type { ChatMessageItem, ClipDetail } from '../../src/types';

/** Matches the concrete stack header so iOS padding never overshoots. */
const IOS_KEYBOARD_OFFSET = 92;

const CHANNEL_META: Record<
  ChatChannel,
  { label: string; color: string; soft: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  local: {
    label: '本机 AI',
    color: colors.success,
    soft: colors.successSoft,
    icon: 'phone-portrait-outline',
  },
  server: {
    label: 'NUC AI',
    color: colors.info,
    soft: colors.infoSoft,
    icon: 'server-outline',
  },
  none: {
    label: '未配置 AI',
    color: colors.accent,
    soft: colors.accentSoft,
    icon: 'alert-circle-outline',
  },
};

interface SendFailure {
  message: string;
  prompt: string;
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const clipId = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { settings, config, localAiConfig } = useSettings();
  const { show } = useToast();

  const [clip, setClip] = useState<ClipDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const [clearing, setClearing] = useState(false);
  const [appendingId, setAppendingId] = useState<string | null>(null);

  const listRef = useRef<FlatList<ChatMessageItem>>(null);
  const clipRef = useRef<ClipDetail | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const appendingRef = useRef(false);

  const channel = resolveChatChannel(localAiConfig, config, settings.syncEnabled);
  const channelMeta = CHANNEL_META[channel];

  clipRef.current = clip;

  // Initial hydrate: article + persisted conversation in one pass.
  useEffect(() => {
    let active = true;

    const hydrate = async () => {
      if (!clipId) {
        setLoadError('缺少文章信息');
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const detail = await localRepo.getClip(clipId);
        if (!active) return;
        setClip(detail);
        // The article is the reason this screen exists; a broken history read
        // must never hide it behind an error state.
        try {
          const history = await localRepo.listChatMessages(clipId);
          if (active) setMessages(history);
        } catch {
          if (active) show('读取历史对话失败，可以继续重新开聊', 'error');
        }
      } catch (err) {
        if (!active) return;
        setLoadError(pickErrorMessage(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    void hydrate();
    return () => {
      active = false;
      // Never leave an in-flight request running after leaving the screen.
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [clipId]);

  // Keep the newest turn in view on arrival and while the reply is thinking.
  useEffect(() => {
    if (!messages.length && !sending) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 60);
    return () => clearTimeout(timer);
  }, [messages.length, sending]);

  const send = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || sendingRef.current) return;
    const target = clipRef.current;
    if (!target) return;

    if (channel === 'none') {
      setSendFailure({
        message: '还没有可用的 AI：请先在「设置」中填写本机 AI 接口，或开启 NUC 同步后重试。',
        prompt: text,
      });
      show('请先在设置中配置 AI', 'info');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    cancelledRef.current = false;
    sendingRef.current = true;
    setSending(true);
    setSendFailure(null);
    setPendingPrompt(text);
    setDraft('');

    try {
      const result = await localRepo.sendChatMessage(target, text, {
        localAiConfig,
        apiConfig: config,
        syncEnabled: settings.syncEnabled,
        signal: controller.signal,
      });
      setMessages((prev) => [...prev, result.userMessage, result.assistantMessage]);
      setPendingPrompt(null);
    } catch (err) {
      setPendingPrompt(null);
      if (cancelledRef.current) {
        // Give the question back instead of swallowing what the user typed.
        setDraft((prev) => (prev.trim() ? prev : text));
        show('已取消这次提问', 'info');
      } else {
        setSendFailure({ message: pickErrorMessage(err), prompt: text });
      }
    } finally {
      abortRef.current = null;
      sendingRef.current = false;
      setSending(false);
    }
  };

  const cancelSend = () => {
    if (!abortRef.current) return;
    cancelledRef.current = true;
    abortRef.current.abort();
  };

  const clearConversation = () => {
    const target = clipRef.current;
    if (!target || clearing || sendingRef.current) return;

    Alert.alert('清空这段对话？', '会删除这篇文章下的全部 AI 问答记录，且无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          setClearing(true);
          void localRepo
            .clearChatMessages(target.id)
            .then(() => {
              setMessages([]);
              setSendFailure(null);
              show('对话已清空', 'success');
            })
            .catch((err: unknown) => show(pickErrorMessage(err), 'error'))
            .finally(() => setClearing(false));
        },
      },
    ]);
  };

  const copyReply = async (content: string) => {
    try {
      await Clipboard.setStringAsync(content);
      show('已复制回答', 'success');
    } catch {
      show('复制失败，请长按选择文字', 'error');
    }
  };

  const appendToNote = async (item: ChatMessageItem) => {
    const target = clipRef.current;
    if (!target || appendingRef.current) return;
    appendingRef.current = true;
    setAppendingId(item.id);
    try {
      // Re-read first so a note edited elsewhere is never overwritten.
      const latest = await localRepo.getClip(target.id);
      const nextNote = appendReplyToNoteText(latest.user_note, item.content);
      const updated = await localRepo.updateClip(target.id, { user_note: nextNote });
      setClip(updated);
      show('已追加到个人笔记', 'success');
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      appendingRef.current = false;
      setAppendingId(null);
    }
  };

  const goToSettings = () => router.push('/(tabs)/settings');

  const handleStarter = (prompt: string) => {
    if (channel === 'none') {
      show('先在设置中配置 AI，再来一键提问', 'info');
      goToSettings();
      return;
    }
    void send(prompt);
  };

  const canSend = draft.trim().length > 0 && !sending;
  const hasBody = Boolean(clip?.content_markdown.trim());
  const bodyChars = clip?.content_markdown.length ?? 0;

  const headerOptions = {
    title: '文章问答',
    headerStyle: { backgroundColor: colors.sheet },
    headerRight:
      messages.length > 0 && !sending
        ? () => (
            <SpringPressable
              onPress={clearConversation}
              disabled={clearing}
              scaleTo={0.92}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="清空对话"
              contentStyle={styles.headerAction}
            >
              {clearing ? (
                <ActivityIndicator size="small" color={colors.muted} />
              ) : (
                <Ionicons name="trash-outline" size={17} color={colors.muted} />
              )}
            </SpringPressable>
          )
        : undefined,
  };

  if (loading) {
    return (
      <>
        <Stack.Screen options={headerOptions} />
        <View style={styles.center}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.centerHint}>正在翻开这篇文章…</Text>
        </View>
      </>
    );
  }

  if (!clip) {
    return (
      <>
        <Stack.Screen options={headerOptions} />
        <View style={styles.center}>
          <Ionicons name="document-text-outline" size={26} color={colors.faint} />
          <Text style={styles.centerTitle}>没有找到这篇文章</Text>
          <Text style={styles.centerHint}>{loadError ?? '它可能已经被删除。'}</Text>
          <SpringPressable
            onPress={() => router.back()}
            scaleTo={0.95}
            contentStyle={styles.centerButton}
          >
            <Text style={styles.centerButtonText}>返回</Text>
          </SpringPressable>
        </View>
      </>
    );
  }

  const meta = platformMeta[clip.platform];
  const emptyVisible = messages.length === 0 && !sending;

  const renderEmpty = () => (
    <View style={styles.emptyWrap}>
      <View style={styles.welcomeCard}>
        <Text style={styles.welcomeEyebrow}>ARTICLE CHAT</Text>
        <Text style={styles.welcomeTitle}>与这篇文章聊一聊</Text>
        <Text style={styles.welcomeText}>
          可以围绕正文自由追问、拆解作者的观点，或让 AI 帮你顺出一份可执行的笔记。
          回答会保存在这篇文章下，随时可以回来接着聊。
        </Text>
      </View>

      {channel === 'none' ? (
        <View style={styles.guideCard}>
          <View style={styles.guideHeader}>
            <Ionicons name="alert-circle-outline" size={15} color={colors.accent} />
            <Text style={styles.guideTitle}>还差一步就能开聊</Text>
          </View>
          <Text style={styles.guideText}>
            在「设置」里填写本机 AI 接口（Base URL 与 API Key），或者开启 NUC 同步并填好服务地址，
            问答就会自动选用可用的通道。
          </Text>
          <SpringPressable
            onPress={goToSettings}
            scaleTo={0.96}
            contentStyle={styles.guideButton}
            accessibilityRole="button"
          >
            <Text style={styles.guideButtonText}>前往设置</Text>
            <Ionicons name="chevron-forward" size={13} color={colors.onAccent} />
          </SpringPressable>
        </View>
      ) : null}

      <Text style={styles.starterLabel}>可以这样问</Text>
      <View style={styles.chipsWrap}>
        {STARTER_PROMPTS.map((item) => {
          const disabled = channel === 'none';
          return (
            <Pressable
              key={item.label}
              onPress={() => handleStarter(item.prompt)}
              disabled={sending}
              accessibilityRole="button"
              style={[styles.chip, disabled && styles.chipDisabled]}
            >
              <Text style={[styles.chipText, disabled && styles.chipTextDisabled]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const renderMessage = ({ item }: ListRenderItemInfo<ChatMessageItem>) => {
    if (item.role === 'user') {
      return (
        <View style={styles.rowUser}>
          <View style={styles.userBubble}>
            <Text style={styles.userText} selectable>
              {item.content}
            </Text>
          </View>
        </View>
      );
    }

    const appending = appendingId === item.id;
    return (
      <View style={styles.rowAi}>
        <View style={styles.aiBubble}>
          <View style={styles.aiHeader}>
            <Ionicons name="sparkles" size={11} color={colors.accent} />
            <Text style={styles.aiTag}>AI 助读</Text>
          </View>

          <MarkdownText content={item.content} selectable compact />

          <View style={styles.aiActions}>
            <SpringPressable
              onPress={() => void copyReply(item.content)}
              scaleTo={0.94}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="复制回答"
              contentStyle={styles.aiAction}
            >
              <Ionicons name="copy-outline" size={13} color={colors.muted} />
              <Text style={styles.aiActionText}>复制</Text>
            </SpringPressable>

            <SpringPressable
              onPress={() => void appendToNote(item)}
              disabled={appendingId !== null}
              scaleTo={0.94}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="追加到个人笔记"
              contentStyle={styles.aiAction}
            >
              {appending ? (
                <ActivityIndicator size="small" color={colors.muted} />
              ) : (
                <Ionicons name="bookmark-outline" size={13} color={colors.muted} />
              )}
              <Text style={styles.aiActionText}>{appending ? '追加中…' : '追加到笔记'}</Text>
            </SpringPressable>
          </View>
        </View>
      </View>
    );
  };

  const renderFooter = () => (
    <View style={styles.footerWrap}>
      {sending && pendingPrompt ? (
        <View style={styles.thinkingBlock}>
          <View style={styles.rowUser}>
            <View style={styles.userBubble}>
              <Text style={styles.userText}>{pendingPrompt}</Text>
            </View>
          </View>

          <View style={styles.rowAi}>
            <View style={styles.aiBubble}>
              <View style={styles.aiHeader}>
                <Ionicons name="sparkles" size={11} color={colors.accent} />
                <Text style={styles.aiTag}>AI 助读</Text>
              </View>
              <View style={styles.thinkingRow}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={styles.thinkingText}>正在结合正文思考…</Text>
              </View>
              <Pressable onPress={cancelSend} hitSlop={8} style={styles.cancelHit}>
                <Text style={styles.cancelText}>取消</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {sendFailure ? (
        <FadeSlideIn distance={6} duration={200}>
          <View style={styles.errorCard}>
            <View style={styles.errorHeader}>
              <Ionicons name="warning-outline" size={15} color={colors.danger} />
              <Text style={styles.errorTitle}>这次没答上来</Text>
            </View>
            <Text style={styles.errorText}>{sendFailure.message}</Text>
            <View style={styles.errorActions}>
              <SpringPressable
                onPress={() => void send(sendFailure.prompt)}
                disabled={sending}
                scaleTo={0.95}
                contentStyle={styles.errorPrimary}
              >
                <Ionicons name="refresh" size={12} color={colors.bg} />
                <Text style={styles.errorPrimaryText}>重试</Text>
              </SpringPressable>
              {channel === 'none' || /设置|配置/.test(sendFailure.message) ? (
                <SpringPressable
                  onPress={goToSettings}
                  scaleTo={0.95}
                  contentStyle={styles.errorGhost}
                >
                  <Ionicons name="settings-outline" size={12} color={colors.textSecondary} />
                  <Text style={styles.errorGhostText}>去设置</Text>
                </SpringPressable>
              ) : null}
            </View>
          </View>
        </FadeSlideIn>
      ) : null}
    </View>
  );

  return (
    <>
      <Stack.Screen options={headerOptions} />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? IOS_KEYBOARD_OFFSET : 0}
      >
        <View style={styles.contextBar}>
          <View style={[styles.contextDot, { backgroundColor: meta.color }]} />
          <View style={styles.contextText}>
            <Text style={styles.contextTitle} numberOfLines={1}>
              {clip.title || '未命名剪藏'}
            </Text>
            <Text style={styles.contextMeta} numberOfLines={1}>
              {hasBody ? `${bodyChars} 字` : '正文暂缺 · 将基于标题与笔记作答'}
            </Text>
          </View>
          <Pressable
            onPress={channel === 'none' ? goToSettings : undefined}
            disabled={channel !== 'none'}
            accessibilityRole={channel === 'none' ? 'button' : undefined}
            accessibilityLabel={channel === 'none' ? '未配置 AI，前往设置' : channelMeta.label}
            style={[styles.channelBadge, { backgroundColor: channelMeta.soft }]}
          >
            <Ionicons name={channelMeta.icon} size={11} color={channelMeta.color} />
            <Text style={[styles.channelText, { color: channelMeta.color }]}>
              {channelMeta.label}
            </Text>
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={emptyVisible ? renderEmpty : null}
          ListFooterComponent={renderFooter}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          onContentSizeChange={() => {
            if (messages.length || sending) listRef.current?.scrollToEnd({ animated: false });
          }}
        />

        <SafeAreaView edges={['bottom']} style={styles.composerSafe}>
          <View style={styles.composerRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={2000}
              placeholder="基于这篇文章向 AI 提问…"
              placeholderTextColor={colors.faint}
              style={styles.input}
              editable={!clearing}
            />
            <SpringPressable
              onPress={() => void send(draft)}
              disabled={!canSend}
              scaleTo={0.92}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="发送提问"
              contentStyle={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
            >
              {sending ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <Ionicons name="arrow-up" size={18} color={colors.onAccent} />
              )}
            </SpringPressable>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: spacing.xxl,
    backgroundColor: colors.bg,
  },
  centerTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  centerHint: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  centerButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.text,
    borderRadius: radius.sm,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  centerButtonText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '600',
  },

  headerAction: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },

  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: spacing.xs,
    paddingBottom: 11,
    backgroundColor: colors.sheet,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  contextDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 1,
  },
  contextText: {
    flex: 1,
    gap: 2,
  },
  contextTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 14.5,
    fontWeight: '700',
  },
  contextMeta: {
    color: colors.muted,
    fontSize: 11,
  },
  channelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  channelText: {
    fontSize: 11,
    fontWeight: '600',
  },

  list: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: spacing.lg,
    gap: 14,
  },

  emptyWrap: {
    gap: 14,
    paddingTop: 2,
  },
  welcomeCard: {
    backgroundColor: colors.sheet,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  welcomeEyebrow: {
    fontFamily: fonts.mono,
    color: colors.accent,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  welcomeTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  welcomeText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 21,
  },
  guideCard: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    padding: 14,
    gap: 8,
  },
  guideHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  guideTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  guideText: {
    color: colors.textSecondary,
    fontSize: 12.5,
    lineHeight: 20,
  },
  guideButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 13,
    paddingVertical: 7,
    marginTop: 1,
  },
  guideButtonText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '600',
  },
  starterLabel: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '600',
    marginTop: 2,
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.bg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    paddingHorizontal: 12,
    paddingVertical: spacing.sm,
  },
  chipDisabled: {
    borderColor: colors.border,
    opacity: 0.55,
  },
  chipText: {
    color: colors.accent,
    fontSize: 12.5,
    fontWeight: '600',
  },
  chipTextDisabled: {
    color: colors.muted,
  },

  rowUser: {
    alignItems: 'flex-end',
  },
  rowAi: {
    alignItems: 'flex-start',
  },
  userBubble: {
    maxWidth: '86%',
    backgroundColor: colors.text,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: {
    color: colors.bg,
    fontSize: 14.5,
    lineHeight: 22,
  },
  aiBubble: {
    maxWidth: '94%',
    backgroundColor: colors.sheet,
    borderRadius: radius.lg,
    borderTopLeftRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: spacing.sm,
  },
  aiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  aiTag: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  aiActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginTop: 1,
    paddingTop: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  aiAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  aiActionText: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '600',
  },

  footerWrap: {
    gap: 14,
  },
  thinkingBlock: {
    gap: 14,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  thinkingText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  cancelHit: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  cancelText: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '600',
  },

  errorCard: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(192, 57, 43, 0.24)',
    padding: 13,
    gap: 9,
  },
  errorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  errorTitle: {
    color: colors.danger,
    fontSize: 12.5,
    fontWeight: '700',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 12.5,
    lineHeight: 19,
  },
  errorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  errorPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.text,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
  },
  errorPrimaryText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '600',
  },
  errorGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: 13,
    paddingVertical: spacing.sm,
  },
  errorGhostText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },

  composerSafe: {
    backgroundColor: colors.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    paddingBottom: 10,
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 13,
    paddingTop: 10,
    paddingBottom: 10,
    color: colors.text,
    fontSize: 14.5,
    lineHeight: 20,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    ...elevation.accent,
  },
  sendButtonDisabled: {
    opacity: 0.32,
    shadowOpacity: 0,
    elevation: 0,
  },
});
