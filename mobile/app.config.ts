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
  version: '0.6.0',
  orientation: 'portrait',
  scheme: 'jiancang',
  icon: './assets/icon.png',
  backgroundColor: '#F6F2E8',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    // 保留 #0E1014 以贴合原 splash-icon.png 的深色羽化圆底，避免浅色底露出暗边
    backgroundColor: '#0E1014',
  },
  androidStatusBar: {
    barStyle: 'dark-content',
    backgroundColor: '#F6F2E8',
  },
  androidNavigationBar: {
    backgroundColor: '#F6F2E8',
    barStyle: 'dark-content',
  },
  android: {
    package: 'com.sheldon.jiancang',
    backgroundColor: '#F6F2E8',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/monochrome-icon.png',
      // 保留 #0E1014 以贴合原 adaptive-icon.png 的深色羽化圆底
      backgroundColor: '#0E1014',
    },
  },
  ios: {
    bundleIdentifier: 'com.sheldon.jiancang',
    supportsTablet: true,
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#D44E30',
      },
    ],
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
    './plugins/withApkInstall',
  ],
});
