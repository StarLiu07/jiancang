import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeBaseUrl } from '../utils/url';

export interface AppSettings {
  baseUrl: string;
  token: string;
  reminderEnabled: boolean;
  reminderHour: number;
  reminderMinute: number;
}

export const DEFAULT_BASE_URL = 'http://192.168.31.98:8420';

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
};

const SETTINGS_KEY = 'jiancang:settings:v1';
const CLIPBOARD_DISMISSED_KEY = 'jiancang:clipboard-dismissed:v1';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function sanitize(raw: unknown): AppSettings {
  const value = (raw ?? {}) as Partial<Record<keyof AppSettings, unknown>>;
  const baseUrl = typeof value.baseUrl === 'string' && value.baseUrl.trim() ? normalizeBaseUrl(value.baseUrl) : DEFAULT_SETTINGS.baseUrl;
  return {
    baseUrl: baseUrl || DEFAULT_SETTINGS.baseUrl,
    token: typeof value.token === 'string' ? value.token.trim() : '',
    reminderEnabled: value.reminderEnabled === true,
    reminderHour: clampInt(value.reminderHour, 0, 23, DEFAULT_SETTINGS.reminderHour),
    reminderMinute: clampInt(value.reminderMinute, 0, 59, DEFAULT_SETTINGS.reminderMinute),
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!stored) return DEFAULT_SETTINGS;
    return sanitize(JSON.parse(stored));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized = sanitize(settings);
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

export async function saveDismissedClipboardUrl(url: string): Promise<void> {
  try {
    await AsyncStorage.setItem(CLIPBOARD_DISMISSED_KEY, url);
  } catch {
    // Best effort only: dismissing the banner must never break the screen.
  }
}
