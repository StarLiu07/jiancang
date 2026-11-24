import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import { colors, elevation, radius, spacing } from '../../src/theme';
import type { HealthResponse } from '../../src/types';
import { formatClock, formatDateTime } from '../../src/utils/format';
import {
  cancelDailyReviewReminder,
  hasScheduledDailyReminder,
  scheduleDailyReviewReminder,
} from '../../src/utils/notifications';
import { isValidHttpUrl, normalizeBaseUrl } from '../../src/utils/url';

export default function SettingsScreen() {
  const { settings, ready, update } = useSettings();
  const { show } = useToast();

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

  const appVersion = Constants.expoConfig?.version ?? '0.1.0';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.header}>
          <Text style={styles.title}>设置</Text>
          <Text style={styles.subtitle}>连接家里的 NUC，或随时通过 Tailscale 回顾</Text>
        </View>

        <View style={styles.group}>
          <Text style={styles.groupTitle}>后端服务</Text>
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

            <View style={styles.presetRow}>
              {BASE_URL_PRESETS.map((preset) => {
                const selected = normalizedBaseUrl === preset.url;
                return (
                  <SpringPressable
                    key={preset.url}
                    onPress={() => applyPreset(preset.url)}
                    scaleTo={0.96}
                    style={styles.presetFlex}
                    contentStyle={[styles.presetButton, selected && styles.presetButtonSelected]}
                  >
                    <Text style={[styles.presetLabel, selected && styles.presetLabelSelected]}>{preset.label}</Text>
                    <Text style={styles.presetHint} numberOfLines={1}>
                      {preset.url}
                    </Text>
                  </SpringPressable>
                );
              })}
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
                <Text style={styles.switchLabel}>每天提醒我回顾</Text>
                <Text style={styles.switchHint}>
                  {reminderEnabled
                    ? `每天 ${formatClock(hour, minute)} 推送一条本地提醒`
                    : '开启后会在设定时间收到本地通知'}
                </Text>
              </View>
              <Switch
                value={reminderEnabled}
                onValueChange={setReminderEnabled}
                trackColor={{ false: colors.surfaceRaised, true: colors.accentBorder }}
                thumbColor={reminderEnabled ? colors.accent : '#C5CCD9'}
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
                <Text style={styles.timeHintPrimary}>小时 / 分钟</Text>
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
              <Ionicons name="save-outline" size={17} color={colors.onAccent} />
              <Text style={styles.saveText}>{dirty ? '保存设置' : '设置已是最新'}</Text>
            </>
          )}
        </SpringPressable>

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
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 40,
    gap: 22,
  },
  header: {
    gap: 4,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12.5,
  },
  group: {
    gap: 8,
  },
  groupTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginLeft: 4,
  },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
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
    borderColor: colors.borderSubtle,
    paddingHorizontal: 14,
    paddingVertical: 11,
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
    backgroundColor: colors.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  presetFlex: {
    flex: 1,
  },
  presetButton: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 12,
    gap: 4,
  },
  presetButtonSelected: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSoft,
  },
  presetLabel: {
    color: colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '700',
  },
  presetLabelSelected: {
    color: colors.accent,
  },
  presetHint: {
    color: colors.faint,
    fontSize: 10.5,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
  },
  testButtonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  resultCard: {
    backgroundColor: colors.successSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.success}3D`,
    padding: spacing.md,
    gap: 5,
  },
  resultCardError: {
    backgroundColor: colors.dangerSoft,
    borderColor: `${colors.danger}3D`,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  resultDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  resultTitle: {
    color: colors.text,
    fontSize: 12.5,
    fontWeight: '700',
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
    gap: 3,
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
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  disabled: {
    opacity: 0.42,
  },
  timeColumn: {
    alignItems: 'center',
    gap: 6,
  },
  stepButton: {
    width: 34,
    height: 26,
    borderRadius: radius.sm,
    backgroundColor: colors.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeValue: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    minWidth: 48,
    textAlign: 'center',
  },
  timeColon: {
    color: colors.faint,
    fontSize: 22,
    fontWeight: '700',
  },
  timeHint: {
    gap: 3,
    marginLeft: spacing.sm,
  },
  timeHintPrimary: {
    color: colors.muted,
    fontSize: 11.5,
    fontWeight: '600',
  },
  timeHintText: {
    color: colors.faint,
    fontSize: 10.5,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: 15,
    ...elevation.accent,
  },
  saveButtonDisabled: {
    opacity: 0.34,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.78,
  },
  about: {
    gap: 6,
    paddingHorizontal: spacing.xs,
  },
  aboutTitle: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '700',
  },
  aboutText: {
    color: colors.faint,
    fontSize: 11.5,
    lineHeight: 18,
  },
  aboutMuted: {
    color: colors.faint,
    fontSize: 10.5,
  },
});
