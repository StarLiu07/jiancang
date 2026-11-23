import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';
import { hostOf, truncateMiddle } from '../utils/url';

interface ClipboardBannerProps {
  url: string;
  busy?: boolean;
  onCapture: () => void;
  onDismiss: () => void;
}

export function ClipboardBanner({ url, busy = false, onCapture, onDismiss }: ClipboardBannerProps) {
  const host = hostOf(url) || url;
  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        <Ionicons name="link" size={18} color={colors.accent} />
      </View>

      <View style={styles.body}>
        <Text style={styles.title}>检测到新链接，一键剪藏</Text>
        <Text style={styles.host} numberOfLines={1}>
          {truncateMiddle(host, 34)}
        </Text>
      </View>

      <Pressable
        onPress={onCapture}
        disabled={busy}
        style={({ pressed }) => [styles.captureButton, (pressed || busy) && styles.buttonPressed]}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#1A0D08" />
        ) : (
          <>
            <Ionicons name="add" size={15} color="#1A0D08" />
            <Text style={styles.captureText}>剪藏</Text>
          </>
        )}
      </Pressable>

      <Pressable onPress={onDismiss} hitSlop={10} style={styles.closeButton}>
        <Ionicons name="close" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.accent}44`,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  host: {
    color: colors.muted,
    fontSize: 11,
  },
  captureButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    minWidth: 62,
    justifyContent: 'center',
  },
  buttonPressed: {
    opacity: 0.75,
  },
  captureText: {
    color: '#1A0D08',
    fontSize: 12,
    fontWeight: '800',
  },
  closeButton: {
    padding: 2,
  },
});
