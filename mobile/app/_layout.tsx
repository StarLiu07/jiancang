import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '../src/components/Toast';
import { useShareCapture } from '../src/hooks/useShareCapture';
import {
  localRepo,
  notifyLocalChange,
  subscribeLocalChanges,
} from '../src/local/repository';
import { SettingsProvider, useSettings } from '../src/store/settings';
import { SyncProvider, useSync } from '../src/store/sync';
import { UpdateProvider } from '../src/store/update';
import { colors, fonts } from '../src/theme';

/** Coalesce bursts of local writes before re-reading the pending-sync count. */
const PENDING_COUNT_REFRESH_MS = 250;

/** No UI: just keeps the native share sheet wired to the local repository. */
function ShareCaptureGate() {
  useShareCapture();
  return null;
}

/**
 * No UI: local-first lifecycle glue.
 *
 * - After settings hydrate, resume clips whose local ingestion was interrupted
 *   (app killed mid-extract) exactly once per launch.
 * - Re-read the pending-sync count whenever local rows change so the settings
 *   badge stays accurate without polling.
 */
function LocalLifecycleGate() {
  const { ready, localAiConfig } = useSettings();
  const { refreshPendingCount } = useSync();

  const resumedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready || resumedRef.current) return;
    resumedRef.current = true;
    // Never rejects by contract; the catch is a last-resort safety net.
    void localRepo.resumePending(localAiConfig).catch(() => undefined);
  }, [ready, localAiConfig]);

  useEffect(() => {
    const unsubscribe = subscribeLocalChanges(() => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void refreshPendingCount();
      }, PENDING_COUNT_REFRESH_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [refreshPendingCount]);

  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ToastProvider>
          <UpdateProvider>
            <SyncProvider onDataSynced={notifyLocalChange}>
              <ShareIntentProvider options={{ scheme: 'jiancang', resetOnBackground: false }}>
                <ShareCaptureGate />
                <LocalLifecycleGate />
                <StatusBar style="dark" backgroundColor={colors.bg} />
                <Stack
                  screenOptions={{
                    headerStyle: { backgroundColor: colors.bg },
                    headerTintColor: colors.text,
                    headerTitleStyle: { fontSize: 16, fontWeight: '700', fontFamily: fonts.serif },
                    headerShadowVisible: false,
                    contentStyle: { backgroundColor: colors.bg },
                    animation: 'slide_from_right',
                  }}
                >
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="clip/[id]" options={{ title: '剪藏详情', headerBackTitle: '返回' }} />
                  <Stack.Screen name="chat/[id]" options={{ title: '文章问答', headerBackTitle: '返回' }} />
                </Stack>
              </ShareIntentProvider>
            </SyncProvider>
          </UpdateProvider>
        </ToastProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
