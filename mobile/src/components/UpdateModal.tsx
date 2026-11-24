import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, elevation, fonts, radius, spacing } from '../theme';
import { formatFileSize, type AppRelease } from '../utils/updateVersion';
import { MarkdownText } from './MarkdownText';
import { MOTION, SpringPressable } from './Motion';
import { useAppUpdate } from '../store/update';

const SHEET_OFFSET = 520;

/**
 * Warm-paper update drawer. Mirrors QuickAddModal's bottom sheet motion so a
 * new version feels like another page of the same folio, not a system alert.
 */
export function UpdateModal() {
  const {
    visible,
    release,
    phase,
    progress,
    error,
    closeModal,
    startDownload,
    cancelDownload,
    installReadyApk,
    ignoreVersion,
    openReleasePage,
  } = useAppUpdate();

  const [mounted, setMounted] = useState(visible);
  const [snapshot, setSnapshot] = useState<AppRelease | null>(release);
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const sheetY = useRef(new Animated.Value(SHEET_OFFSET)).current;

  useEffect(() => {
    if (release) setSnapshot(release);
  }, [release]);

  useEffect(() => {
    if (visible) {
      if (!mounted) {
        setMounted(true);
        backdropOpacity.setValue(0);
        sheetY.setValue(SHEET_OFFSET);

        Animated.parallel([
          Animated.timing(backdropOpacity, {
            toValue: 1,
            duration: 210,
            easing: MOTION.easeOut,
            useNativeDriver: true,
          }),
          Animated.spring(sheetY, {
            toValue: 0,
            ...MOTION.springGentle,
          }),
        ]).start();
      }
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 180,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
        Animated.timing(sheetY, {
          toValue: SHEET_OFFSET,
          duration: 190,
          easing: MOTION.easeIn,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, backdropOpacity, sheetY]);

  if (!mounted || !snapshot) return null;

  const isAndroid = Platform.OS === 'android';
  const downloading = phase === 'downloading';
  const installing = phase === 'installing';
  const ready = phase === 'ready';
  const busy = downloading || installing;
  const dismissible = !busy;
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  const progressWidth = `${percent}%` as `${number}%`;
  const sizeLabel = formatFileSize(snapshot.apkSizeBytes);
  const notes = snapshot.notes.trim();

  const handlePrimary = () => {
    if (busy) return;
    if (!isAndroid) {
      void openReleasePage();
      return;
    }
    if (ready) {
      void installReadyApk();
      return;
    }
    void startDownload();
  };

  const handleRequestClose = () => {
    if (dismissible) closeModal();
  };

  const primaryLabel = !isAndroid
    ? '前往 GitHub 查看'
    : installing
      ? '正在唤起系统安装…'
      : downloading
        ? `下载中 ${percent}%`
        : ready
          ? '立即安装'
          : error
            ? '重试下载'
            : '立即更新';

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleRequestClose}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismissible ? closeModal : undefined}
          />
        </Animated.View>

        <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetY }] }]}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <View style={styles.seal}>
              <Ionicons name="cloud-download-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>GITHUB RELEASE</Text>
              <Text style={styles.title}>发现新版本 v{snapshot.version}</Text>
              <Text style={styles.subtitle}>
                {isAndroid ? `${sizeLabel} · 应用内下载安装` : `${sizeLabel} · 前往 Release 页面下载`}
              </Text>
            </View>
            {dismissible ? (
              <SpringPressable
                onPress={closeModal}
                hitSlop={10}
                scaleTo={0.9}
                contentStyle={styles.closeButton}
              >
                <Ionicons name="close" size={18} color={colors.muted} />
              </SpringPressable>
            ) : null}
          </View>

          <View style={styles.versionStrip}>
            <View style={styles.versionChip}>
              <Ionicons name="pricetag-outline" size={12} color={colors.textSecondary} />
              <Text style={styles.versionChipText}>{snapshot.tagName}</Text>
            </View>
            <View style={styles.versionChip}>
              <Ionicons name="logo-android" size={12} color={colors.textSecondary} />
              <Text style={styles.versionChipText}>arm64-v8a</Text>
            </View>
            <View style={styles.versionChip}>
              <Ionicons name="archive-outline" size={12} color={colors.textSecondary} />
              <Text style={styles.versionChipText}>{sizeLabel}</Text>
            </View>
          </View>

          <View style={styles.notesCard}>
            <View style={styles.notesHeader}>
              <Ionicons name="reader-outline" size={13} color={colors.muted} />
              <Text style={styles.notesTitle}>更新日志</Text>
            </View>
            <ScrollView
              style={styles.notesScroll}
              contentContainerStyle={styles.notesContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {notes ? (
                <MarkdownText content={notes} />
              ) : (
                <Text style={styles.notesEmpty}>本次更新暂无详细说明，安装后即可体验最新版本。</Text>
              )}
            </ScrollView>
          </View>

          {downloading ? (
            <View style={styles.progressBlock}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: progressWidth }]} />
              </View>
              <View style={styles.progressRow}>
                <Text style={styles.progressText}>
                  {percent}% · {formatFileSize(progress.bytesWritten)} /{' '}
                  {formatFileSize(progress.bytesTotal)}
                </Text>
                <SpringPressable
                  onPress={() => void cancelDownload()}
                  hitSlop={8}
                  scaleTo={0.94}
                  contentStyle={styles.cancelButton}
                >
                  <Text style={styles.cancelText}>取消下载</Text>
                </SpringPressable>
              </View>
            </View>
          ) : null}

          {ready ? (
            <View style={styles.readyBox}>
              <Ionicons name="checkmark-circle" size={15} color={colors.success} />
              <Text style={styles.readyText}>
                安装包已就绪 · {formatFileSize(progress.bytesTotal || snapshot.apkSizeBytes)}
              </Text>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorBox}>
              <View style={styles.errorHeader}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={styles.errorTitle}>更新未完成</Text>
              </View>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable onPress={() => void openReleasePage()} hitSlop={6}>
                <Text style={styles.errorLink}>改用浏览器打开 Release 页面 →</Text>
              </Pressable>
            </View>
          ) : null}

          <SpringPressable
            onPress={handlePrimary}
            disabled={busy}
            scaleTo={0.97}
            contentStyle={[styles.primaryButton, busy && styles.primaryButtonBusy]}
          >
            {downloading || installing ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Ionicons
                name={!isAndroid ? 'open-outline' : ready ? 'phone-portrait-outline' : 'download-outline'}
                size={17}
                color={colors.onAccent}
              />
            )}
            <Text style={styles.primaryText}>{primaryLabel}</Text>
          </SpringPressable>

          {!busy ? (
            <View style={styles.secondaryRow}>
              <SpringPressable
                onPress={closeModal}
                scaleTo={0.97}
                style={styles.secondaryFlex}
                contentStyle={styles.secondaryButton}
              >
                <Text style={styles.secondaryText}>稍后再说</Text>
              </SpringPressable>
              {phase === 'idle' ? (
                <SpringPressable
                  onPress={() => void ignoreVersion()}
                  scaleTo={0.97}
                  style={styles.secondaryFlex}
                  contentStyle={styles.secondaryButton}
                >
                  <Text style={styles.secondaryMutedText}>忽略此版本</Text>
                </SpringPressable>
              ) : (
                <SpringPressable
                  onPress={() => void openReleasePage()}
                  scaleTo={0.97}
                  style={styles.secondaryFlex}
                  contentStyle={styles.secondaryButton}
                >
                  <Text style={styles.secondaryMutedText}>浏览器打开</Text>
                </SpringPressable>
              )}
            </View>
          ) : null}

          <Text style={styles.footnote}>
            {isAndroid
              ? '首次安装需允许「安装未知来源应用」；安装包仅从本项目 GitHub Release 下载。'
              : 'iOS 暂不支持应用内安装，请在 GitHub Release 页面查看。'}
          </Text>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    maxHeight: '90%',
    ...elevation.floating,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  seal: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    color: colors.accent,
    fontSize: 9.5,
    fontWeight: '600',
    letterSpacing: 1.2,
  },
  title: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 19,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  versionStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.md,
  },
  versionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  versionChipText: {
    fontFamily: fonts.mono,
    color: colors.textSecondary,
    fontSize: 10,
  },
  notesCard: {
    marginTop: spacing.md,
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: spacing.xs,
  },
  notesTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  notesScroll: {
    maxHeight: 214,
  },
  notesContent: {
    paddingBottom: spacing.sm,
  },
  notesEmpty: {
    color: colors.muted,
    fontSize: 12.5,
    lineHeight: 19,
    paddingVertical: spacing.xs,
  },
  progressBlock: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  progressTrack: {
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  progressText: {
    fontFamily: fonts.mono,
    color: colors.textSecondary,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
  },
  cancelButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    fontWeight: '600',
  },
  readyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
    backgroundColor: colors.successSoft,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${colors.success}2E`,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  readyText: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  errorBox: {
    marginTop: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.danger}33`,
    padding: 10,
    gap: 4,
  },
  errorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  errorTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    color: colors.textSecondary,
    fontSize: 11.5,
    lineHeight: 17,
  },
  errorLink: {
    color: colors.accent,
    fontSize: 11.5,
    fontWeight: '600',
    marginTop: 2,
  },
  primaryButton: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    marginTop: spacing.lg,
    ...elevation.accent,
  },
  primaryButtonBusy: {
    opacity: 0.82,
  },
  primaryText: {
    color: colors.onAccent,
    fontSize: 14.5,
    fontWeight: '600',
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  secondaryFlex: {
    flex: 1,
  },
  secondaryButton: {
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  secondaryText: {
    color: colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  secondaryMutedText: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '600',
  },
  footnote: {
    color: colors.faint,
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
