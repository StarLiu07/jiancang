import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ApiConfig, LocalAiConfig } from '../types';
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings,
} from '../storage/settings';

interface SettingsContextValue {
  settings: AppSettings;
  config: ApiConfig;
  localAiConfig: LocalAiConfig;
  ready: boolean;
  reload: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const stored = await loadSettings();
    setSettings(stored);
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await saveSettings({ ...settings, ...patch });
    setSettings(next);
    return next;
  }, [settings]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      ready,
      config: { baseUrl: settings.baseUrl, token: settings.token },
      localAiConfig: {
        baseUrl: settings.llmBaseUrl.trim(),
        apiKey: settings.llmApiKey.trim(),
        model: settings.llmModel.trim() || DEFAULT_LLM_MODEL,
      },
      reload,
      update,
    }),
    [settings, ready, reload, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside <SettingsProvider>');
  return value;
}
