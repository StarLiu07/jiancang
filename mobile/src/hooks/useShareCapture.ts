import { useShareIntent } from 'expo-share-intent';
import { useEffect, useRef } from 'react';

import { api, pickErrorMessage } from '../api/client';
import { useToast } from '../components/Toast';
import { useSettings } from '../store/settings';
import { buildSharePayload } from '../utils/url';

/**
 * Bridges Android's system share sheet into `POST /api/clips`.
 *
 * expo-share-intent uses `requireOptionalNativeModule`, so in Expo Go (or any
 * build without the native module) `useShareIntent` simply never becomes ready
 * and this hook stays inert instead of crashing.
 */
export function useShareCapture(): void {
  const { settings, ready } = useSettings();
  const { show } = useToast();
  const { isReady, hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    scheme: 'jiancang',
    resetOnBackground: false,
  });

  const busyRef = useRef(false);
  const submittingRef = useRef<string | null>(null);
  const baseUrlRef = useRef(settings.baseUrl);
  const tokenRef = useRef(settings.token);

  baseUrlRef.current = settings.baseUrl;
  tokenRef.current = settings.token;

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
        const result = await api.createClip(
          { baseUrl: baseUrlRef.current, token: tokenRef.current },
          { input: payload },
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
