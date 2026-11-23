import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { loadDismissedClipboardUrl, saveDismissedClipboardUrl } from '../storage/settings';
import { detectClipboardLink } from '../utils/url';

const POLL_INTERVAL_MS = 4000;

interface ClipboardLinkState {
  /** The new clipboard link, or null when there is nothing to offer. */
  link: string | null;
  dismiss: (url: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Watches the clipboard while the app is in the foreground and surfaces a link
 * only when it differs from the last link the user explicitly dismissed.
 */
export function useClipboardLink(enabled = true): ClipboardLinkState {
  const [link, setLink] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadDismissedClipboardUrl().then((value) => {
      if (active && value) setDismissed(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const check = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      const next = detectClipboardLink(text);
      setLink((previous) => (previous === next ? previous : next));
    } catch {
      // Reading the clipboard can be blocked by the OS; stay silent.
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLink(null);
      return;
    }

    void check();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') void check();
    }, POLL_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [enabled, check]);

  const dismiss = useCallback(async (url: string) => {
    setDismissed(url);
    await saveDismissedClipboardUrl(url);
  }, []);

  const visibleLink = link && link !== dismissed ? link : null;

  return { link: visibleLink, dismiss, refresh: check };
}
