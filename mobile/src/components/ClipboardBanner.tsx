import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import { hostOf, truncateMiddle } from '../utils/url';
import { FadeSlideIn, SpringPressable } from './Motion';

interface ClipboardBannerProps {
  url: string;
  busy?: boolean;
  onCapture: () => void;
  onDismiss: () => void;
}

export function ClipboardBanner({ url, busy = false, onCapture, onDismiss }: ClipboardBannerProps) {
  const host = hostOf(url) || url;
  return (
    <FadeSlideIn distance={-8} duration={220}>
      <View style={styles.container}>
        <Text style={styles.message} numberOfLines={1}>
          剪贴板发现新链接：{truncateMiddle(host, 26)}
        </Text>

        <View style={styles.actions}>
          <SpringPressable
            onPress={onCapture}
            disabled={busy}
            hitSlop={6}
            scaleTo={0.94}
            contentStyle={[styles.captureButton, busy && styles.buttonMuted]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text style={styles.captureText}>收进书房</Text>
            )}
          </SpringPressable>

          <SpringPressable
            onPress={onDismiss}
            hitSlop={10}
            scaleTo={0.86}
            contentStyle={styles.closeButton}
            accessibilityLabel="忽略剪贴板链接"
          >
            <Ionicons name="close" size={15} color={colors.muted} />
          </SpringPressable>
        </View>
      </View>
    </FadeSlideIn>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  message: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12.5,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  captureButton: {
    paddingVertical: 2,
    paddingHorizontal: 2,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 50,
  },
  buttonMuted: {
    opacity: 0.65,
  },
  captureText: {
    color: colors.accent,
    fontSize: 12.5,
    fontWeight: '600',
  },
  closeButton: {
    padding: 2,
  },
});
