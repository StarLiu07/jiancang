import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Expo config for 剪藏.
 *
 * Note: `android.usesCleartextTraffic` is applied by the local config plugin
 * `./plugins/withCleartextTraffic.js` because the field is not part of the
 * typed Expo config schema for SDK 52. It keeps plain HTTP working against the
 * LAN (192.168.31.98:8420) and Tailscale (100.74.86.65:8420) backends.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: '剪藏',
  slug: 'jiancang',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'jiancang',
  backgroundColor: '#0E1014',
  androidStatusBar: {
    barStyle: 'light-content',
  },
  androidNavigationBar: {
    backgroundColor: '#0E1014',
    barStyle: 'light-content',
  },
  android: {
    package: 'com.sheldon.jiancang',
    backgroundColor: '#0E1014',
  },
  ios: {
    bundleIdentifier: 'com.sheldon.jiancang',
    supportsTablet: true,
  },
  plugins: [
    'expo-router',
    ['expo-notifications', { color: '#FF6B4A' }],
    [
      'expo-share-intent',
      {
        androidIntentFilters: ['text/plain'],
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
        },
      },
    ],
    './plugins/withCleartextTraffic',
  ],
});
