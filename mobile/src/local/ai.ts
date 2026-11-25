/**
 * Optional AI enrichment via an OpenAI-compatible `/chat/completions` API.
 *
 * 1:1 port of `backend/app/services/ai.py`:
 * - strictly best-effort: failures throw `AIEnrichmentError`, the scraped clip is never lost;
 * - `User-Agent` is always set explicitly (some gateways reject unknown UAs);
 * - models love markdown fences, so JSON is extracted defensively.
 */

import type { ArticleChatContext, ChatTurnInput, LocalAiConfig } from '../types';

const MAX_CONTENT_CHARS = 6000;
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
const DEFAULT_USER_AGENT = 'jiancang/0.1';
const DEFAULT_TIMEOUT_MS = 45_000;

/** Article body budget for one chat turn (mirrors the backend). */
export const MAX_CHAT_CONTENT_CHARS = 12000;
/** How many past turns are replayed as context (mirrors the backend). */
export const MAX_CHAT_HISTORY_MESSAGES = 20;
/** Chat turns run a full LLM round-trip, so they get a wider budget. */
export const CHAT_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT =
  '你是一名中文「内容整理助手」，负责把剪藏的网页/公众号/推文正文压缩成可复习的卡片。\n' +
  '只输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块之外的文字。\n' +
  'JSON 结构：\n' +
  '{"summary": "一句话中文摘要（<=60字）", ' +
  '"key_points": ["要点1", "要点2", "要点3"], ' +
  '"tags": ["标签1", "标签2"]}\n' +
  '要求：\n' +
  '1. summary 必须是 <=60 字的中文一句话，直接说结论，不要写“本文介绍了”。\n' +
  '2. key_points 3~5 条，每条 <=40 字，具体、可验证，不要空话。\n' +
  '3. tags 2~4 个短标签（每个 2~6 字），优先复用用户已有标签中语义一致的。\n' +
  '4. 不要编造正文里没有的事实；正文信息不足时给出更泛化的摘要与要点。';

const JSON_OBJECT_RE = /\{[\s\S]*\}/;
const CODE_FENCE_RE = /^```(?:json|JSON)?\s*|\s*```$/g;

/**
 * System prompt for article chat (1:1 with the backend `_CHAT_SYSTEM_PROMPT`).
 *
 * The assistant must stay grounded in the clipped article and clearly separate
 * what the article says from background knowledge / inference.
 */
const CHAT_SYSTEM_PROMPT =
  '你是一名「文章精读与讨论助手」，帮助用户深入理解并讨论他剪藏的文章。\n' +
  '回答原则：\n' +
  '1. 优先严格基于下面提供的文章标题、摘要、要点、正文和个人笔记作答，引用原文细节时不要改写事实。\n' +
  '2. 明确区分「文章中提到的信息」与「补充背景/推论」：凡是正文没有出现的内容，绝不声称是原文所述，需要时明确标注为补充或推测。\n' +
  '3. 正文不足时直接说明，并结合标题/摘要/笔记给出谨慎回答，不要编造细节。\n' +
  '4. 回答简洁、有条理，必要时用短列表；默认使用中文，若用户用其他语言提问则跟随用户语言。';

/** Raised when the LLM call or its JSON payload cannot be used. */
export class AIEnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIEnrichmentError';
  }
}

/** Raised when an article chat turn cannot produce a usable reply. */
export class AIChatError extends AIEnrichmentError {
  constructor(message: string) {
    super(message);
    this.name = 'AIChatError';
  }
}

export interface LocalAiEnrichment {
  summary: string;
  key_points: string[];
  tags: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalChatResult {
  reply: string;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOr(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

/** Format the article snapshot embedded in the chat `system` message. */
function articleChatContext(article: ArticleChatContext): string {
  const points = Array.isArray(article.key_points)
    ? article.key_points.map((point) => String(point).trim()).filter(Boolean)
    : [];

  let body = String(article.content_text ?? '').trim();
  // Python (backend) slices by code points; `Array.from` keeps that 1:1 and
  // avoids splitting surrogate pairs (emoji) at the truncation boundary.
  const bodyChars = Array.from(body);
  if (bodyChars.length > MAX_CHAT_CONTENT_CHARS) {
    body = `${bodyChars.slice(0, MAX_CHAT_CONTENT_CHARS).join('')}\n...(正文已截断)`;
  }

  const lines = [
    '以下是用户正在精读的文章资料：',
    `标题：${textOr(article.title, '（无标题）')}`,
    `作者：${textOr(article.author, '（未知）')}`,
    `来源平台：${String(article.platform ?? '')}`,
    `原文链接：${textOr(article.url, '（无）')}`,
    `摘要：${textOr(article.summary, '（无）')}`,
    '要点：',
    ...(points.length ? points.map((point) => `- ${point}`) : ['- （无）']),
    `个人笔记：${textOr(article.user_note, '（无）')}`,
    '正文：',
    body || '（正文暂缺，请结合标题/摘要/笔记回答并向用户说明正文不足）',
  ];
  return lines.join('\n');
}

/** Mirrors backend `settings.ai_enabled`: base URL + API key present. */
export function isLocalAiConfigured(config: LocalAiConfig): boolean {
  return Boolean(config && config.baseUrl && config.baseUrl.trim() && config.apiKey && config.apiKey.trim());
}

export function buildMessages(title: string, contentText: string, existingTags: string[]): ChatMessage[] {
  let body = (contentText || '').trim();
  if (body.length > MAX_CONTENT_CHARS) {
    body = `${body.slice(0, MAX_CONTENT_CHARS)}\n...(正文已截断)`;
  }
  const tagsHint = existingTags && existingTags.length ? existingTags.join('、') : '（无）';
  const userPrompt =
    `标题：${(title || '').trim() || '（无标题）'}\n` +
    `用户已有标签：${tagsHint}\n` +
    '请阅读下面的正文并输出 JSON：\n' +
    '----正文开始----\n' +
    `${body || '（正文为空）'}\n` +
    '----正文结束----';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Build the OpenAI-style message list for one article chat turn.
 *
 * Blank history turns are dropped and only the most recent
 * `MAX_CHAT_HISTORY_MESSAGES` turns are kept, mirroring the backend.
 */
export function buildArticleChatMessages(
  article: ArticleChatContext,
  history: readonly ChatTurnInput[],
): ChatMessage[] {
  const system: ChatMessage = {
    role: 'system',
    content: `${CHAT_SYSTEM_PROMPT}\n\n${articleChatContext(article)}`,
  };

  const turns: ChatMessage[] = [];
  for (const turn of history ?? []) {
    if (!turn) continue;
    const content = typeof turn.content === 'string' ? turn.content.trim() : '';
    if (!content) continue;
    turns.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content });
  }

  return [system, ...turns.slice(-MAX_CHAT_HISTORY_MESSAGES)];
}

export function stripCodeFence(text: string): string {
  const stripped = (text || '').trim();
  if (!stripped.startsWith('```')) return stripped;
  return stripped.replace(CODE_FENCE_RE, '').trim();
}

/** Pull the first JSON object out of a possibly chatty model reply. */
export function extractJsonObject(text: string): Record<string, unknown> {
  if (!text || !text.trim()) {
    throw new AIEnrichmentError('empty model response');
  }
  const candidate = stripCodeFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = null;
  }
  if (isRecord(parsed)) return parsed;

  const match = JSON_OBJECT_RE.exec(candidate);
  if (match === null) {
    throw new AIEnrichmentError('no JSON object in model response');
  }
  try {
    parsed = JSON.parse(match[0]);
  } catch (error) {
    throw new AIEnrichmentError(
      `invalid JSON in model response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new AIEnrichmentError('model response JSON is not an object');
  }
  return parsed;
}

function coerceList(value: unknown, limit: number): string[] {
  let pieces: unknown[];
  if (typeof value === 'string') {
    pieces = value.split(/[,，;；\n]+/);
  } else if (Array.isArray(value)) {
    pieces = value;
  } else if (value instanceof Set) {
    pieces = Array.from(value);
  } else {
    return [];
  }

  const items: string[] = [];
  for (const piece of pieces) {
    const text = String(piece).split(/\s+/).filter(Boolean).join(' ');
    if (!text) continue;
    if (!items.includes(text)) items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

function coerceSummary(value: unknown): string {
  if (typeof value !== 'string') return '';
  let summary = value.split(/\s+/).filter(Boolean).join(' ');
  if (summary.length > 120) summary = `${summary.slice(0, 119)}…`;
  return summary;
}

export function parseEnrichment(payload: Record<string, unknown>): LocalAiEnrichment {
  const summary = coerceSummary(payload.summary || payload.abstract || '');
  const keyPoints = coerceList(payload.key_points || payload.points, 5);
  const tags = coerceList(payload.tags, 4);
  if (!summary && !keyPoints.length && !tags.length) {
    throw new AIEnrichmentError('model response contained no usable fields');
  }
  return { summary, key_points: keyPoints, tags };
}

function messageContent(data: Record<string, unknown>): string {
  const choices = data.choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new AIEnrichmentError('model response has no choices');
  }
  const first = choices[0];
  let message: Record<string, unknown> = isRecord(first) ? first : {};
  if (isRecord(first) && isRecord(first.message)) {
    message = first.message;
  }

  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') {
        parts.push(part.text);
      } else if (typeof part === 'string') {
        parts.push(part);
      }
    }
    return parts.join('');
  }
  throw new AIEnrichmentError('model response message has no text content');
}

function requestFailedMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError' || name === 'TypeError') {
    return `llm request failed: ${message || name}`;
  }
  return `llm enrichment failed: ${message || name}`;
}

/**
 * Ask the LLM for a summary / key points / tags.
 *
 * Returns `null` when AI is not configured. Raises `AIEnrichmentError` when the
 * call or the payload fails.
 */
export async function enrichClipLocally(
  title: string,
  contentText: string,
  existingTags: string[],
  config: LocalAiConfig,
): Promise<LocalAiEnrichment | null> {
  if (!isLocalAiConfigured(config)) return null;
  if (!(contentText || '').trim() && !(title || '').trim()) {
    throw new AIEnrichmentError('nothing to enrich');
  }

  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${config.apiKey.trim()}`,
    'User-Agent': DEFAULT_USER_AGENT,
  };
  const payload = {
    model: config.model.trim() || DEFAULT_MODEL,
    messages: buildMessages(title, contentText, Array.isArray(existingTags) ? existingTags : []),
    temperature: 0.2,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (response.status >= 400) {
      const text = await response.text().catch(() => '');
      throw new AIEnrichmentError(`llm http ${response.status}: ${text.slice(0, 200)}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AIEnrichmentError('llm returned non-JSON body');
    }
    if (!isRecord(data)) {
      throw new AIEnrichmentError('llm returned unexpected payload');
    }
    return parseEnrichment(extractJsonObject(messageContent(data)));
  } catch (error) {
    if (error instanceof AIEnrichmentError) throw error;
    throw new AIEnrichmentError(requestFailedMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the LLM a question about one article (multi-turn, stateless).
 *
 * Throws `AIChatError` when the local AI is not configured, the history has no
 * user turn, or the call / reply is unusable.
 */
export async function chatWithArticleLocally(
  article: ArticleChatContext,
  history: readonly ChatTurnInput[],
  config: LocalAiConfig,
  signal?: AbortSignal,
): Promise<LocalChatResult> {
  if (!isLocalAiConfigured(config)) {
    throw new AIChatError('本机未配置 AI 接口');
  }

  const messages = buildArticleChatMessages(article, history);
  if (!messages.some((message) => message.role === 'user')) {
    throw new AIChatError('请输入要提问的内容');
  }

  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const requestModel = config.model.trim() || DEFAULT_MODEL;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${config.apiKey.trim()}`,
    'User-Agent': DEFAULT_USER_AGENT,
  };
  const payload = {
    model: requestModel,
    messages,
    temperature: 0.5,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  const externalSignal = signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else if (typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', onExternalAbort);
    }
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (response.status >= 400) {
      const text = await response.text().catch(() => '');
      throw new AIChatError(`llm http ${response.status}: ${text.slice(0, 200)}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AIChatError('llm returned non-JSON body');
    }
    if (!isRecord(data)) {
      throw new AIChatError('llm returned unexpected payload');
    }

    const reply = messageContent(data).trim();
    if (!reply) {
      throw new AIChatError('empty model reply');
    }
    const responseModel = typeof data.model === 'string' ? data.model.trim() : '';
    return { reply, model: responseModel || requestModel };
  } catch (error) {
    if (error instanceof AIChatError) throw error;
    if (error instanceof AIEnrichmentError) throw new AIChatError(error.message);
    const name = error instanceof Error ? error.name : '';
    const detail = error instanceof Error ? error.message : String(error);
    const prefix = name === 'AbortError' || name === 'TypeError'
      ? 'llm request failed'
      : 'llm chat failed';
    throw new AIChatError(`${prefix}: ${detail || name}`);
  } finally {
    clearTimeout(timer);
    if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT, MAX_CONTENT_CHARS };
