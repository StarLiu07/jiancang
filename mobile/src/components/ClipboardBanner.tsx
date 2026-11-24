import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, elevation, radius } from '../theme';
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
    <FadeSlideIn distance={-10} duration={240}>
      <View style={styles.container}>
        <View style={styles.accentBar} />
        <View style={styles.iconWrap}>
          <Ionicons name="link" size={17} color={colors.accent} />
        </View>

        <View style={styles.body}>
          <Text style={styles.title}>检测到剪贴板链接</Text>
          <Text style={styles.host} numberOfLines={1}>
            {truncateMiddle(host, 34)}
          </Text>
        </View>

        <SpringPressable
          onPress={onCapture}
          disabled={busy}
          scaleTo={0.93}
          contentStyle={[styles.captureButton, busy && styles.buttonMuted]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <>
              <Ionicons name="add" size={15} color={colors.onAccent} />
              <Text style={styles.captureText}>剪藏</Text>
            </>
          )}
        </SpringPressable>

        <SpringPressable onPress={onDismiss} hitSlop={10} scaleTo={0.86} contentStyle={styles.closeButton}>
          <Ionicons name="close" size={16} color={colors.faint} />
        </SpringPressable>
      </View>
    </FadeSlideIn>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    paddingVertical: 11,
    paddingLeft: 14,
    paddingRight: 10,
    overflow: 'hidden',
    ...elevation.card,
  },
  accentBar: {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 3,
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: colors.accent,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
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
    fontWeight: '700',
  },
  host: {
    color: colors.muted,
    fontSize: 11.5,
  },
  captureButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 13,
    paddingVertical: 7,
    minWidth: 64,
    justifyContent: 'center',
  },
  buttonMuted: {
    opacity: 0.72,
  },
  captureText: {
    color: colors.onAccent,
    fontSize: 12,
    fontWeight: '800',
  },
  closeButton: {
    padding: 4,
  },
});
