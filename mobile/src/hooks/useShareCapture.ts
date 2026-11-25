import { useShareIntent } from 'expo-share-intent';
import { useEffect, useRef } from 'react';

import { pickErrorMessage } from '../api/client';
import { useToast } from '../components/Toast';
import type { RemoteExtractFallback } from '../local/ingest';
import { localRepo } from '../local/repository';
import { useSettings } from '../store/settings';
import { buildSharePayload } from '../utils/url';

/**
 * Bridges Android's system share sheet into the local-first repository.
 *
 * The clip lands in on-device SQLite the moment the user shares it (no network,
 * no NUC required), then the background ingestion pipeline extracts content and
 * optionally enriches it with the configured public LLM endpoint.
 *
 * expo-share-intent uses `requireOptionalNativeModule`, so in Expo Go (or any
 * build without the native module) `useShareIntent` simply never becomes ready
 * and this hook stays inert instead of crashing.
 */
export function useShareCapture(): void {
  const { localAiConfig, config, settings, ready } = useSettings();
  const { show } = useToast();
  const { isReady, hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    scheme: 'jiancang',
    resetOnBackground: false,
  });

  const busyRef = useRef(false);
  const submittingRef = useRef<string | null>(null);
  const aiConfigRef = useRef(localAiConfig);
  const remoteFallbackRef = useRef<RemoteExtractFallback | null>(null);

  aiConfigRef.current = localAiConfig;
  remoteFallbackRef.current = { apiConfig: config, syncEnabled: settings.syncEnabled };

  useEffect(() => {
    if (!ready || !isReady || !hasShareIntent) return;

    const payload = buildSharePayload(shareIntent.webUrl, shareIntent.text);
    if (!payload) {
      resetShareIntent();
      return;
    }
    if (busyRef.current || submittingRef.current === payload) {
      resetShareIntent();
      return;
    }

    busyRef.current = true;
    submittingRef.current = payload;

    const submit = async () => {
      try {
        const result = await localRepo.createClip(
          { input: payload },
          aiConfigRef.current,
          // A share arriving on 5G may be blocked locally but readable from home.
          remoteFallbackRef.current ?? undefined,
        );
        show(result.deduplicated ? '已在收藏库' : '已剪藏', result.deduplicated ? 'info' : 'success');
      } catch (error) {
        show(`提交失败：${pickErrorMessage(error)}`, 'error');
      } finally {
        resetShareIntent();
        submittingRef.current = null;
        busyRef.current = false;
      }
    };

    void submit();
  }, [ready, isReady, hasShareIntent, shareIntent, resetShareIntent, show]);
}
