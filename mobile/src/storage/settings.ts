import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeBaseUrl } from '../utils/url';

export interface AppSettings {
  baseUrl: string;
  token: string;
  reminderEnabled: boolean;
  reminderHour: number;
  reminderMinute: number;
  /** OpenAI-compatible LLM endpoint for on-device AI enrichment ('' = off). */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Master switch for talking to the NUC at all. */
  syncEnabled: boolean;
  /** Silent background sync on mount / app foreground. */
  autoSync: boolean;
  /** Clip a link found on the clipboard as soon as the app becomes ready. */
  autoCaptureClipboard: boolean;
}

export const DEFAULT_BASE_URL = 'http://192.168.31.98:8420';

export const DEFAULT_LLM_MODEL = 'deepseek/deepseek-v4.1-flash';

export const BASE_URL_PRESETS: { label: string; hint: string; url: string }[] = [
  { label: '家里局域网', hint: 'NUC · 同一 WiFi 下最快', url: 'http://192.168.31.98:8420' },
  { label: 'Tailscale 远程', hint: '出门在外也能用', url: 'http://100.74.86.65:8420' },
];

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: DEFAULT_BASE_URL,
  token: '',
  reminderEnabled: false,
  reminderHour: 21,
  reminderMinute: 0,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: DEFAULT_LLM_MODEL,
  syncEnabled: true,
  autoSync: true,
  autoCaptureClipboard: false,
};

const SETTINGS_KEY = 'jiancang:settings:v1';
const CLIPBOARD_DISMISSED_KEY = 'jiancang:clipboard-dismissed:v1';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Coerce any stored JSON shape into `AppSettings`.
 *
 * `baseUrl` is intentionally allowed to be empty: only a fresh install (no
 * stored JSON at all) receives `DEFAULT_BASE_URL`, so clearing the field in
 * settings must survive a reload.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const value = (raw ?? {}) as Partial<Record<keyof AppSettings, unknown>>;
  const llmModel = text(value.llmModel);
  return {
    baseUrl: typeof value.baseUrl === 'string' ? normalizeBaseUrl(value.baseUrl) : '',
    token: text(value.token),
    reminderEnabled: value.reminderEnabled === true,
    reminderHour: clampInt(value.reminderHour, 0, 23, DEFAULT_SETTINGS.reminderHour),
    reminderMinute: clampInt(value.reminderMinute, 0, 59, DEFAULT_SETTINGS.reminderMinute),
    llmBaseUrl: typeof value.llmBaseUrl === 'string' ? normalizeBaseUrl(value.llmBaseUrl) : '',
    llmApiKey: text(value.llmApiKey),
    llmModel: llmModel || DEFAULT_LLM_MODEL,
    syncEnabled: value.syncEnabled !== false,
    autoSync: value.autoSync !== false,
    // Opt-in only: an absent / truthy-string value must never enable it.
    autoCaptureClipboard: value.autoCaptureClipboard === true,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!stored) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(stored);
    return sanitizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized = sanitizeSettings(settings);
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function loadDismissedClipboardUrl(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CLIPBOARD_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export type DismissedClipboardUrlListener = (url: string) => void;

const dismissedClipboardUrlListeners = new Set<DismissedClipboardUrlListener>();

/**
 * Listen for in-app dismissals (manual "忽略" or a quick-clip inbox entry that
 * landed while the home screen was already mounted).
 *
 * Storage itself is async, so subscribers are notified synchronously when the
 * save is requested; the write stays best effort. Returns an idempotent
 * unsubscribe function.
 */
export function subscribeDismissedClipboardUrl(
  listener: DismissedClipboardUrlListener,
): () => void {
  if (typeof listener !== 'function') return () => undefined;
  dismissedClipboardUrlListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    dismissedClipboardUrlListeners.delete(listener);
  };
}

function notifyDismissedClipboardUrl(url: string): void {
  for (const listener of Array.from(dismissedClipboardUrlListeners)) {
    try {
      listener(url);
    } catch {
      // A broken subscriber must never block the save.
    }
  }
}

export async function saveDismissedClipboardUrl(url: string): Promise<void> {
  const value = typeof url === 'string' ? url : '';
  notifyDismissedClipboardUrl(value);
  try {
    await AsyncStorage.setItem(CLIPBOARD_DISMISSED_KEY, value);
  } catch {
    // Best effort only: dismissing the banner must never break the screen.
  }
}
