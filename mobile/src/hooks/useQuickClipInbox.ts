import { useCallback, useEffect, useRef } from 'react';
import { AppState, DeviceEventEmitter } from 'react-native';

import type { RemoteExtractFallback } from '../local/ingest';
import { drainQuickClipInbox, QUICK_CLIP_EVENT_NAME } from '../local/quickClipInbox';
import { useSettings } from '../store/settings';

/**
 * No-UI glue for the native quick-clip inbox.
 *
 * The native control-center tile / launcher shortcut / `jiancang-clip://clipboard`
 * deep link writes a JSON entry and fires `QUICK_CLIP_EVENT_NAME`; Android may
 * also deliver the intent while the app was backgrounded. Draining:
 *
 * - on the first render after settings hydrate,
 * - whenever the native event fires, and
 * - whenever the app returns to the foreground (missed events / retries).
 *
 * Refs mirror the latest settings so a single listener always drains with fresh
 * AI / NUC-fallback config instead of resubscribing on every save.
 */
export function useQuickClipInbox(): void {
  const { ready, localAiConfig, config, settings } = useSettings();

  const readyRef = useRef(ready);
  const aiConfigRef = useRef(localAiConfig);
  const remoteFallbackRef = useRef<RemoteExtractFallback>({
    apiConfig: config,
    syncEnabled: settings.syncEnabled,
  });

  readyRef.current = ready;
  aiConfigRef.current = localAiConfig;
  remoteFallbackRef.current = {
    apiConfig: config,
    syncEnabled: settings.syncEnabled,
  };

  const drain = useCallback(() => {
    if (!readyRef.current) return;
    // Never throws by contract, but background work must stay silent anyway.
    void drainQuickClipInbox(aiConfigRef.current, remoteFallbackRef.current).catch(
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (ready) drain();
  }, [ready, drain]);

  useEffect(() => {
    const eventSubscription = DeviceEventEmitter.addListener(
      QUICK_CLIP_EVENT_NAME,
      drain,
    );
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') drain();
    });

    return () => {
      eventSubscription.remove();
      appStateSubscription.remove();
    };
  }, [drain]);
}
