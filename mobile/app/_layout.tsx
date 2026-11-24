import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '../src/components/Toast';
import { useShareCapture } from '../src/hooks/useShareCapture';
import { SettingsProvider } from '../src/store/settings';
import { colors, fonts } from '../src/theme';

/** No UI: just keeps the native share sheet wired to the backend. */
function ShareCaptureGate() {
  useShareCapture();
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ToastProvider>
          <ShareIntentProvider options={{ scheme: 'jiancang', resetOnBackground: false }}>
            <ShareCaptureGate />
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
            </Stack>
          </ShareIntentProvider>
        </ToastProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
