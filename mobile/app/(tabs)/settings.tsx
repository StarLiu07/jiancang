import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, pickErrorMessage } from '../../src/api/client';
import { FadeSlideIn, SpringPressable } from '../../src/components/Motion';
import { useToast } from '../../src/components/Toast';
import { BASE_URL_PRESETS, type AppSettings } from '../../src/storage/settings';
import { useSettings } from '../../src/store/settings';
import { useAppUpdate } from '../../src/store/update';
import { colors, elevation, fonts, radius, spacing } from '../../src/theme';
import type { HealthResponse } from '../../src/types';
import { formatClock, formatDateTime } from '../../src/utils/format';
import { formatFileSize } from '../../src/utils/updateVersion';
import {
  cancelDailyReviewReminder,
  hasScheduledDailyReminder,
  scheduleDailyReviewReminder,
} from '../../src/utils/notifications';
import { isValidHttpUrl, normalizeBaseUrl } from '../../src/utils/url';

const APP_ICON = require('../../assets/icon.png');

export default function SettingsScreen() {
  const { settings, ready, update } = useSettings();
  const { show } = useToast();
  const appUpdate = useAppUpdate();

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState(settings.token);
  const [revealToken, setRevealToken] = useState(false);
  const [reminderEnabled, setReminderEnabled] = useState(settings.reminderEnabled);
  const [hour, setHour] = useState(settings.reminderHour);
  const [minute, setMinute] = useState(settings.reminderMinute);

  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scheduled, setScheduled] = useState(false);

  useEffect(() => {
    if (!ready) return;
    setBaseUrl(settings.baseUrl);
    setToken(settings.token);
    setReminderEnabled(settings.reminderEnabled);
    setHour(settings.reminderHour);
    setMinute(settings.reminderMinute);
  }, [
    ready,
    settings.baseUrl,
    settings.token,
    settings.reminderEnabled,
    settings.reminderHour,
    settings.reminderMinute,
  ]);

  useFocusEffect(
    useCallback(() => {
      void hasScheduledDailyReminder().then(setScheduled);
    }, []),
  );

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const dirty =
    normalizedBaseUrl !== settings.baseUrl ||
    token.trim() !== settings.token ||
    reminderEnabled !== settings.reminderEnabled ||
    hour !== settings.reminderHour ||
    minute !== settings.reminderMinute;

  const applyPreset = (url: string) => {
    setBaseUrl(url);
    setHealth(null);
    setTestError(null);
  };

  const testConnection = async () => {
    const url = normalizeBaseUrl(baseUrl);
    if (!isValidHttpUrl(url)) {
      setHealth(null);
      setTestError('后端地址格式不正确，示例：http://192.168.31.98:8420');
      return;
    }
    setTesting(true);
    setHealth(null);
    setTestError(null);
    try {
      const result = await api.health({ baseUrl: url, token: token.trim() });
      setHealth(result);
    } catch (err) {
      setTestError(pickErrorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const url = normalizeBaseUrl(baseUrl);
    if (!isValidHttpUrl(url)) {
      show('请填写有效的后端地址，如 http://192.168.31.98:8420', 'error');
      return;
    }

    setSaving(true);
    try {
      let enabled = reminderEnabled;
      if (enabled) {
        const granted = await scheduleDailyReviewReminder(hour, minute);
        if (!granted) {
          enabled = false;
          show('未获得通知权限，每日提醒未开启', 'error');
        }
      } else {
        await cancelDailyReviewReminder();
      }

      const next: AppSettings = await update({
        baseUrl: url,
        token: token.trim(),
        reminderEnabled: enabled,
        reminderHour: hour,
        reminderMinute: minute,
      });

      setBaseUrl(next.baseUrl);
      setToken(next.token);
      setReminderEnabled(next.reminderEnabled);
      setHour(next.reminderHour);
      setMinute(next.reminderMinute);
      setScheduled(next.reminderEnabled);
      setHealth(null);
      setTestError(null);
      show('设置已保存', 'success');
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const appVersion = Constants.expoConfig?.version ?? '0.4.0';
  const hasUpdate = appUpdate.release !== null;
  const updateHint = appUpdate.checking
    ? '正在查询 GitHub 最新 Release…'
    : appUpdate.release
      ? `发现 v${appUpdate.release.version} · ${formatFileSize(appUpdate.release.apkSizeBytes)}`
      : appUpdate.checkStatus === 'up-to-date'
        ? `已是最新版本 v${appVersion}`
        : appUpdate.checkStatus === 'ignored'
          ? `已忽略 v${appUpdate.ignoredVersion ?? ''}，可手动再次检查`
          : appUpdate.checkStatus === 'error'
            ? '上次检查失败，请检查网络或代理后重试'
            : '冷启动会静默检查 GitHub Release，也可手动查询';
  // 未测试时保持中性墨色，避免未测试就亮绿点
  const statusColor = health ? colors.success : testError ? colors.danger : colors.muted;
  const statusSummary = health
    ? `${health.app || '家用 NUC'} 已连通${health.ai_enabled ? ' · AI 提炼开启' : ''}`
    : testError
      ? '连接未通过 · 请检查后端线路'
      : `v${appVersion} · 家用 NUC 与 Tailscale 同步`;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.header}>
          <Text style={styles.title}>设置</Text>
          <Text style={styles.subtitle}>连接家里的 NUC，或通过 Tailscale 随时同步</Text>
        </View>

        <View style={styles.identityCard}>
          <Image source={APP_ICON} style={styles.identityIcon} />
          <View style={styles.identityText}>
            <Text style={styles.identityTitle}>剪藏 · 清晨折页</Text>
            <View style={styles.identityStatusRow}>
              <View style={[styles.identityDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.identityStatus, { color: statusColor }]} numberOfLines={1}>
                {statusSummary}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.group}>
          <Text style={styles.groupTitle}>后端线路</Text>
          <View style={styles.presetRow}>
            {BASE_URL_PRESETS.map((preset) => {
              const selected = normalizedBaseUrl === preset.url;
              return (
                <SpringPressable
                  key={preset.url}
                  onPress={() => applyPreset(preset.url)}
                  scaleTo={0.97}
                  style={styles.presetFlex}
                  contentStyle={[styles.presetButton, selected && styles.presetButtonSelected]}
                >
                  <Text style={[styles.presetLabel, selected && styles.presetLabelSelected]}>
                    {preset.label}
                  </Text>
                  <Text style={styles.presetHint} numberOfLines={1}>
                    {preset.url.replace(/^https?:\/\//, '')}
                  </Text>
                </SpringPressable>
              );
            })}
          </View>

          <View style={styles.section}>
            <View style={styles.field}>
              <Text style={styles.label}>服务地址</Text>
              <TextInput
                value={baseUrl}
                onChangeText={(value) => {
                  setBaseUrl(value);
                  setHealth(null);
                  setTestError(null);
                }}
                placeholder="http://192.168.31.98:8420"
                placeholderTextColor={colors.faint}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                inputMode="url"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>API Token（可选）</Text>
              <View style={styles.tokenRow}>
                <TextInput
                  value={token}
                  onChangeText={setToken}
                  placeholder="后端开启鉴权时填写"
                  placeholderTextColor={colors.faint}
                  style={[styles.input, styles.tokenInput]}
                  secureTextEntry={!revealToken}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable
                  onPress={() => setRevealToken((value) => !value)}
                  hitSlop={8}
                  style={styles.eyeButton}
                >
                  <Ionicons name={revealToken ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.muted} />
                </Pressable>
              </View>
            </View>

            <SpringPressable
              onPress={() => void testConnection()}
              disabled={testing}
              scaleTo={0.97}
              contentStyle={[styles.testButton, testing && styles.pressed]}
            >
              {testing ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Ionicons name="pulse-outline" size={16} color={colors.textSecondary} />
              )}
              <Text style={styles.testButtonText}>测试连接</Text>
            </SpringPressable>

            {health ? (
              <FadeSlideIn distance={8} duration={220}>
                <View style={styles.resultCard}>
                  <View style={styles.resultHeader}>
                    <View style={styles.resultDot} />
                    <Text style={styles.resultTitle}>{health.app || '剪藏 API'} 已连通</Text>
                  </View>
                  <Text style={styles.resultLine}>状态：{health.status}</Text>
                  <Text style={styles.resultLine}>AI 提炼：{health.ai_enabled ? '已启用' : '未启用'}</Text>
                  <Text style={styles.resultLine}>接口鉴权：{health.auth_enabled ? '已开启' : '未开启'}</Text>
                </View>
              </FadeSlideIn>
            ) : null}

            {testError ? (
              <FadeSlideIn distance={8} duration={220}>
                <View style={[styles.resultCard, styles.resultCardError]}>
                  <View style={styles.resultHeader}>
                    <View style={[styles.resultDot, { backgroundColor: colors.danger }]} />
                    <Text style={styles.resultTitle}>连接失败</Text>
                  </View>
                  <Text style={styles.resultLine}>{testError}</Text>
                </View>
              </FadeSlideIn>
            ) : null}
          </View>
        </View>

        <View style={styles.group}>
          <Text style={styles.groupTitle}>每日回顾提醒</Text>
          <View style={styles.section}>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>每日提醒翻阅</Text>
                <Text style={styles.switchHint}>
                  {reminderEnabled
                    ? `每天 ${formatClock(hour, minute)} 发送一条本地通知`
                    : '开启后会在设定时间收到本地通知'}
                </Text>
              </View>
              <Switch
                value={reminderEnabled}
                onValueChange={setReminderEnabled}
                trackColor={{ false: colors.surfaceAlt, true: colors.accent }}
                thumbColor={colors.onAccent}
              />
            </View>

            <View style={[styles.timeRow, !reminderEnabled && styles.disabled]}>
              <View style={styles.timeColumn}>
                <SpringPressable
                  onPress={() => setHour((value) => (value + 1) % 24)}
                  disabled={!reminderEnabled}
                  hitSlop={6}
                  scaleTo={0.86}
                  contentStyle={styles.stepButton}
                >
                  <Ionicons name="chevron-up" size={16} color={colors.textSecondary} />
                </SpringPressable>
                <Text style={styles.timeValue}>{formatClock(hour, minute).slice(0, 2)}</Text>
                <SpringPressable
                  onPress={() => setHour((value) => (value + 23) % 24)}
                  disabled={!reminderEnabled}
                  hitSlop={6}
                  scaleTo={0.86}
                  contentStyle={styles.stepButton}
                >
                  <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
                </SpringPressable>
              </View>

              <Text style={styles.timeColon}>:</Text>

              <View style={styles.timeColumn}>
                <SpringPressable
                  onPress={() => setMinute((value) => (value + 5) % 60)}
                  disabled={!reminderEnabled}
                  hitSlop={6}
                  scaleTo={0.86}
                  contentStyle={styles.stepButton}
                >
                  <Ionicons name="chevron-up" size={16} color={colors.textSecondary} />
                </SpringPressable>
                <Text style={styles.timeValue}>{formatClock(hour, minute).slice(3, 5)}</Text>
                <SpringPressable
                  onPress={() => setMinute((value) => (value + 55) % 60)}
                  disabled={!reminderEnabled}
                  hitSlop={6}
                  scaleTo={0.86}
                  contentStyle={styles.stepButton}
                >
                  <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
                </SpringPressable>
              </View>

              <View style={styles.timeHint}>
                <Text style={styles.timeHintPrimary}>提醒时段</Text>
                <Text style={styles.timeHintText}>
                  {scheduled && reminderEnabled ? '提醒已注册到系统' : '保存后生效'}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <SpringPressable
          onPress={() => void save()}
          disabled={saving || !dirty}
          scaleTo={0.97}
          contentStyle={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <>
              <Ionicons name="checkmark" size={17} color={colors.onAccent} />
              <Text style={styles.saveText}>{dirty ? '保存设置' : '设置已是最新'}</Text>
            </>
          )}
        </SpringPressable>

        <View style={styles.group}>
          <Text style={styles.groupTitle}>应用更新</Text>
          <View style={styles.section}>
            <View style={styles.updateRow}>
              <View style={styles.updateSeal}>
                <Ionicons name="cloud-download-outline" size={18} color={colors.accent} />
              </View>
              <View style={styles.updateText}>
                <Text style={styles.switchLabel}>剪藏 · v{appVersion}</Text>
                <Text style={styles.switchHint}>{updateHint}</Text>
              </View>
              {hasUpdate ? (
                <View style={styles.updateBadge}>
                  <Text style={styles.updateBadgeText}>新版本</Text>
                </View>
              ) : null}
            </View>

            {hasUpdate ? (
              <SpringPressable
                onPress={appUpdate.openModal}
                scaleTo={0.97}
                contentStyle={styles.updateAvailableButton}
              >
                <Ionicons name="sparkles-outline" size={15} color={colors.accent} />
                <Text style={styles.updateAvailableText}>
                  查看 v{appUpdate.release?.version} 更新
                </Text>
              </SpringPressable>
            ) : null}

            <SpringPressable
              onPress={() => void appUpdate.checkForUpdate()}
              disabled={appUpdate.checking}
              scaleTo={0.97}
              contentStyle={[styles.testButton, appUpdate.checking && styles.pressed]}
            >
              {appUpdate.checking ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Ionicons name="refresh-outline" size={16} color={colors.textSecondary} />
              )}
              <Text style={styles.testButtonText}>
                {appUpdate.checking ? '正在检查 GitHub Release…' : '检查更新'}
              </Text>
            </SpringPressable>
          </View>
        </View>

        <View style={styles.about}>
          <Text style={styles.aboutTitle}>剪藏 · v{appVersion}</Text>
          <Text style={styles.aboutText}>
            从小红书、公众号、X 分享到「剪藏」即可静默入库；局域网与 Tailscale 直连 HTTP，无需 HTTPS。
          </Text>
          <Text style={styles.aboutMuted}>最近同步：{formatDateTime(new Date().toISOString())}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 40,
    gap: 18,
  },
  header: {
    gap: 3,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  title: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12.5,
  },

  identityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.sheet,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  identityIcon: {
    width: 46,
    height: 46,
    borderRadius: 11,
  },
  identityText: {
    flex: 1,
    gap: 3,
  },
  identityTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  identityStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  identityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  identityStatus: {
    fontSize: 12,
    flexShrink: 1,
  },

  group: {
    gap: 10,
  },
  groupTitle: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '600',
    marginLeft: 2,
  },
  section: {
    backgroundColor: colors.sheet,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 15,
    gap: 14,
  },
  field: {
    gap: 6,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 2,
  },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tokenInput: {
    flex: 1,
  },
  eyeButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
  },
  presetFlex: {
    flex: 1,
  },
  presetButton: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingVertical: 11,
    paddingHorizontal: 12,
    gap: 3,
  },
  presetButtonSelected: {
    backgroundColor: colors.sheet,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  presetLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  presetLabelSelected: {
    color: colors.accent,
  },
  presetHint: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 10.5,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 11,
  },
  testButtonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  resultCard: {
    backgroundColor: colors.successSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.success}2E`,
    padding: spacing.md,
    gap: 4,
  },
  resultCardError: {
    backgroundColor: colors.dangerSoft,
    borderColor: `${colors.danger}2E`,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  resultDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  resultTitle: {
    color: colors.text,
    fontSize: 12.5,
    fontWeight: '600',
  },
  resultLine: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  switchLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  switchHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  disabled: {
    opacity: 0.45,
  },
  timeColumn: {
    alignItems: 'center',
    gap: 5,
  },
  stepButton: {
    width: 32,
    height: 26,
    borderRadius: 7,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeValue: {
    fontFamily: fonts.mono,
    color: colors.text,
    fontSize: 24,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 44,
    textAlign: 'center',
  },
  timeColon: {
    fontFamily: fonts.mono,
    color: colors.muted,
    fontSize: 20,
    fontWeight: '600',
  },
  timeHint: {
    gap: 2,
    marginLeft: spacing.sm,
  },
  timeHintPrimary: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  timeHintText: {
    color: colors.muted,
    fontSize: 11,
  },
  saveButton: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: 10,
    ...elevation.accent,
  },
  saveButtonDisabled: {
    opacity: 0.36,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveText: {
    color: colors.onAccent,
    fontSize: 14.5,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.78,
  },
  about: {
    gap: 5,
    paddingHorizontal: 2,
  },
  aboutTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  aboutText: {
    color: colors.muted,
    fontSize: 11.5,
    lineHeight: 18,
  },
  aboutMuted: {
    color: colors.muted,
    fontSize: 10.5,
  },
  updateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  updateSeal: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateText: {
    flex: 1,
    gap: 2,
  },
  updateBadge: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentBorder,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  updateBadgeText: {
    color: colors.accent,
    fontSize: 10.5,
    fontWeight: '600',
  },
  updateAvailableButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    paddingVertical: 10,
  },
  updateAvailableText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
});
