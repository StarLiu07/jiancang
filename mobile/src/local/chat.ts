/**
 * Local-first article AI chat orchestration.
 *
 * Two channels are supported, in priority order:
 *
 * 1. `local`  — talk to the user's own OpenAI-compatible endpoint from the
 *    device (same prompt/truncation/window rules as the backend);
 * 2. `server` — when NUC sync is enabled but no local AI is configured, proxy
 *    the turn through `POST /api/ai/chat` (`api.statelessChat`).
 *
 * Messages are only persisted after a usable reply arrives, so a failed LLM
 * call never leaves a dangling user turn behind.
 *
 * Native modules (SQLite, file system) are loaded lazily — this module must stay
 * importable in plain Node so the pure helpers can be unit-tested.
 */

import type {
  ApiConfig,
  ArticleChatContext,
  ChatMessageItem,
  ChatTurnInput,
  ClipDetail,
  LocalAiConfig,
} from '../types';
import {
  chatWithArticleLocally,
  isLocalAiConfigured,
  MAX_CHAT_HISTORY_MESSAGES,
} from './ai';
import { api } from '../api/client';
import { nowIso, toIsoUtc } from './reviewLogic';

export type ChatChannel = 'local' | 'server' | 'none';

export interface StarterPrompt {
  label: string;
  prompt: string;
}

/** Four high-frequency reading questions shown above the composer. */
export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    label: '大白话讲透',
    prompt: '用大白话把这篇文章讲透：它到底解决了什么问题，结论是什么？',
  },
  {
    label: '提炼行动清单',
    prompt: '把文章里的方法提炼成一份可以立刻执行的行动清单，每条都要具体。',
  },
  {
    label: '批判性思考',
    prompt: '批判性分析这篇文章：它的论证有哪些漏洞，哪些结论被夸大了？',
  },
  {
    label: '延伸追问',
    prompt: '基于这篇文章，给我 3 个值得继续深挖的问题，并说明为什么值得追问。',
  },
];

export interface SendClipChatOptions {
  localAiConfig: LocalAiConfig;
  apiConfig: ApiConfig;
  syncEnabled: boolean;
  signal?: AbortSignal;
}

export interface SendClipChatResult {
  userMessage: ChatMessageItem;
  assistantMessage: ChatMessageItem;
  channel: 'local' | 'server';
  model: string;
}

// ---------------------------------------------------------------------------
// lazy native modules (keeps this module importable in Node unit tests)
// ---------------------------------------------------------------------------

type DbModule = typeof import('./db');
type IngestModule = typeof import('./ingest');

let cachedDb: DbModule | null = null;
let cachedIngest: IngestModule | null = null;

function localDb(): DbModule {
  if (!cachedDb) cachedDb = require('./db') as DbModule;
  return cachedDb;
}

function notifyLocalChange(): void {
  if (!cachedIngest) cachedIngest = require('./ingest') as IngestModule;
  cachedIngest.notifyLocalChange();
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Pick the chat channel: local AI wins, then NUC sync + a base URL, else none.
 */
export function resolveChatChannel(
  localAiConfig: LocalAiConfig,
  apiConfig: ApiConfig,
  syncEnabled: boolean,
): ChatChannel {
  if (isLocalAiConfigured(localAiConfig)) return 'local';
  if (syncEnabled && Boolean(apiConfig?.baseUrl?.trim())) return 'server';
  return 'none';
}

/** Snapshot the fields the LLM needs from a locally stored clip. */
export function buildArticleContextFromClip(clip: ClipDetail): ArticleChatContext {
  const keyPoints = Array.isArray(clip?.key_points) ? clip.key_points : [];
  return {
    title: String(clip?.title ?? '').trim(),
    author: String(clip?.author ?? '').trim(),
    platform: clip?.platform ?? 'web',
    url: String(clip?.url ?? '').trim(),
    summary: String(clip?.summary ?? '').trim(),
    key_points: keyPoints.map((point) => String(point ?? '').trim()).filter(Boolean),
    content_text: String(clip?.content_markdown ?? ''),
    user_note: String(clip?.user_note ?? ''),
  };
}

/**
 * Append an AI reply to the personal note as a quoted plain-text block.
 *
 * Empty replies leave the note untouched; an existing note keeps its content
 * but drops trailing whitespace before the new block.
 */
export function appendReplyToNoteText(existingNote: string, reply: string): string {
  const base = String(existingNote ?? '');
  const trimmedReply = String(reply ?? '').trim();
  if (!trimmedReply) return base;

  const block = `[AI 对话摘录]\n${trimmedReply}`;
  const trimmedNote = base.trim();
  return trimmedNote ? `${trimmedNote}\n\n${block}` : block;
}

/** Guarantee the assistant stamp sorts after the user stamp (1ms later). */
function nextMessageStamp(stamp: string): string {
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return stamp;
  return toIsoUtc(parsed + 1);
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

/**
 * Run one chat turn for a locally stored clip and persist both messages.
 *
 * @throws Error (plain) for invalid input / no configured channel; AI failures
 * bubble up as `AIChatError` (local) or `ApiError` (server) and never persist.
 */
export async function sendClipChatMessage(
  clip: ClipDetail,
  rawMessage: string,
  options: SendClipChatOptions,
): Promise<SendClipChatResult> {
  const message = String(rawMessage ?? '').trim();
  if (!message) throw new Error('请输入要提问的内容');
  if (!clip?.id) throw new Error('缺少文章信息，无法发起对话');

  const channel = resolveChatChannel(
    options.localAiConfig,
    options.apiConfig,
    options.syncEnabled,
  );
  if (channel === 'none') {
    throw new Error('未配置可用的 AI：请先在设置页配置本机 AI 接口，或启用 NUC 同步后重试');
  }

  const article = buildArticleContextFromClip(clip);
  const db = localDb();
  // The prompt builder needs the article once, so replay only the recent turns.
  const history = await db.listChatMessages(clip.id, MAX_CHAT_HISTORY_MESSAGES);
  const turns: ChatTurnInput[] = [
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: 'user', content: message },
  ];

  let reply: string;
  let model: string;
  if (channel === 'local') {
    const result = await chatWithArticleLocally(
      article,
      turns,
      options.localAiConfig,
      options.signal,
    );
    reply = result.reply;
    model = result.model;
  } else {
    const result = await api.statelessChat(
      options.apiConfig,
      { article, messages: turns },
      options.signal,
    );
    reply = String(result?.reply ?? '').trim();
    model = String(result?.model ?? '').trim();
  }

  if (!reply) throw new Error('AI 未返回有效回复');

  // Persist only after a usable reply: failed turns must not create dirty rows.
  const userStamp = nowIso();
  const userMessage = await db.addChatMessage(clip.id, 'user', message, {
    createdAt: userStamp,
  });
  const assistantMessage = await db.addChatMessage(clip.id, 'assistant', reply, {
    createdAt: nextMessageStamp(userStamp),
  });
  notifyLocalChange();

  return { userMessage, assistantMessage, channel, model };
}
