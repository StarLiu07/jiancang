import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  BASE_URL_PRESETS,
  DEFAULT_LLM_MODEL,
  type AppSettings,
} from '../../src/storage/settings';
import { useSettings } from '../../src/store/settings';
import { useSync } from '../../src/store/sync';
import { useAppUpdate } from '../../src/store/update';
import { formatSyncSummary, type SyncStatus } from '../../src/sync/engine';
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

const SYNC_STATUS_META: Record<SyncStatus, { label: string; color: string; soft: string }> = {
  idle: { label: '空闲', color: colors.muted, soft: colors.surface },
  syncing: { label: '同步中', color: colors.info, soft: colors.infoSoft },
  success: { label: '已同步', color: colors.success, soft: colors.successSoft },
  offline: { label: '离线已跳过', color: colors.warning, soft: colors.warningSoft },
  error: { label: '异常', color: colors.danger, soft: colors.dangerSoft },
};

const SYNC_STATUS_ICON: Record<SyncStatus, keyof typeof Ionicons.glyphMap> = {
  idle: 'cloud-outline',
  syncing: 'sync-outline',
  success: 'cloud-done-outline',
  offline: 'cloud-offline-outline',
  error: 'alert-circle-outline',
};

/**
 * Public LLM gateways are usually HTTPS; unlike the LAN-only NUC presets we
 * default a scheme-less value to https so `api.deepseek.com/v1` just works.
 */
function normalizeLlmUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return normalizeBaseUrl(trimmed);
  return `https://${trimmed.replace(/\/+$/, '')}`;
}

export default function SettingsScreen() {
  const { settings, ready, update } = useSettings();
  const sync = useSync();
  const { show } = useToast();
  const appUpdate = useAppUpdate();

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState(settings.token);
  const [revealToken, setRevealToken] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(settings.syncEnabled);
  const [autoSync, setAutoSync] = useState(settings.autoSync);
  const [autoCaptureClipboard, setAutoCaptureClipboard] = useState(
    settings.autoCaptureClipboard,
  );

  const [llmBaseUrl, setLlmBaseUrl] = useState(settings.llmBaseUrl);
  const [llmApiKey, setLlmApiKey] = useState(settings.llmApiKey);
  const [llmModel, setLlmModel] = useState(settings.llmModel);
  const [revealApiKey, setRevealApiKey] = useState(false);

  const [reminderEnabled, setReminderEnabled] = useState(settings.reminderEnabled);
  const [hour, setHour] = useState(settings.reminderHour);
  const [minute, setMinute] = useState(settings.reminderMinute);

  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [scheduled, setScheduled] = useState(false);

  // Only pull a field back into local state when its persisted value actually
  // changed (e.g. another screen saved, or our own partial save). This keeps
  // unsaved edits on unrelated fields alive when "立即同步" persists the
  // network fields only.
  const appliedSettingsRef = useRef<AppSettings>(settings);

  useEffect(() => {
    if (!ready) return;
    const prev = appliedSettingsRef.current;
    appliedSettingsRef.current = settings;
    if (settings.baseUrl !== prev.baseUrl) setBaseUrl(settings.baseUrl);
    if (settings.token !== prev.token) setToken(settings.token);
    if (settings.llmBaseUrl !== prev.llmBaseUrl) setLlmBaseUrl(settings.llmBaseUrl);
    if (settings.llmApiKey !== prev.llmApiKey) setLlmApiKey(settings.llmApiKey);
    if (settings.llmModel !== prev.llmModel) setLlmModel(settings.llmModel);
    if (settings.syncEnabled !== prev.syncEnabled) setSyncEnabled(settings.syncEnabled);
    if (settings.autoSync !== prev.autoSync) setAutoSync(settings.autoSync);
    if (settings.autoCaptureClipboard !== prev.autoCaptureClipboard) {
      setAutoCaptureClipboard(settings.autoCaptureClipboard);
    }
    if (settings.reminderEnabled !== prev.reminderEnabled) {
      setReminderEnabled(settings.reminderEnabled);
    }
    if (settings.reminderHour !== prev.reminderHour) setHour(settings.reminderHour);
    if (settings.reminderMinute !== prev.reminderMinute) setMinute(settings.reminderMinute);
  }, [ready, settings]);

  const { refreshPendingCount } = sync;

  useFocusEffect(
    useCallback(() => {
      void hasScheduledDailyReminder().then(setScheduled);
      void refreshPendingCount();
    }, [refreshPendingCount]),
  );

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedLlmBaseUrl = normalizeLlmUrl(llmBaseUrl);
  const normalizedModel = llmModel.trim() || DEFAULT_LLM_MODEL;
  const aiConfigured = Boolean(normalizedLlmBaseUrl && llmApiKey.trim());
  const aiStatusLabel = aiConfigured
    ? '已开启'
    : normalizedLlmBaseUrl
      ? '缺 API Key'
      : '未配置';

  const dirty =
    normalizedBaseUrl !== settings.baseUrl ||
    token.trim() !== settings.token ||
    syncEnabled !== settings.syncEnabled ||
    autoSync !== settings.autoSync ||
    autoCaptureClipboard !== settings.autoCaptureClipboard ||
    normalizedLlmBaseUrl !== settings.llmBaseUrl ||
    llmApiKey.trim() !== settings.llmApiKey ||
    normalizedModel !== settings.llmModel ||
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
      setTestError('NUC 地址格式不正确，示例：http://192.168.31.98:8420');
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
    // Pure-offline mode never dials the NUC, so a half-typed address must not
    // block saving; it only gets validated once sync is switched on.
    if (syncEnabled && url && !isValidHttpUrl(url)) {
      show('NUC 地址格式不正确，示例：http://192.168.31.98:8420', 'error');
      return;
    }
    const aiUrl = normalizeLlmUrl(llmBaseUrl);
    if (aiUrl && !isValidHttpUrl(aiUrl)) {
      show('AI 接口地址格式不正确，示例：https://api.deepseek.com/v1', 'error');
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
        llmBaseUrl: aiUrl,
        llmApiKey: llmApiKey.trim(),
        llmModel: normalizedModel,
        syncEnabled,
        autoSync,
        autoCaptureClipboard,
        reminderEnabled: enabled,
        reminderHour: hour,
        reminderMinute: minute,
      });

      setBaseUrl(next.baseUrl);
      setToken(next.token);
      setLlmBaseUrl(next.llmBaseUrl);
      setLlmApiKey(next.llmApiKey);
      setLlmModel(next.llmModel);
      setSyncEnabled(next.syncEnabled);
      setAutoSync(next.autoSync);
      setAutoCaptureClipboard(next.autoCaptureClipboard);
      setReminderEnabled(next.reminderEnabled);
      setHour(next.reminderHour);
      setMinute(next.reminderMinute);
      setScheduled(next.reminderEnabled);
      setHealth(null);
      setTestError(null);
      show(
        next.syncEnabled
          ? next.baseUrl
            ? '设置已保存'
            : '设置已保存 · 还没填 NUC 地址，暂时纯本地使用'
          : '设置已保存 · 纯本地模式',
        'success',
      );
    } catch (err) {
      show(pickErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Persists only the fields a manual sync needs, so unrelated unsaved edits
   * (AI key, reminder time) are not silently committed by tapping sync.
   */
  const persistNetworkInputs = async (): Promise<boolean> => {
    const url = normalizeBaseUrl(baseUrl);
    if (!isValidHttpUrl(url)) {
      show('请先填写有效的 NUC 地址，如 http://192.168.31.98:8420', 'error');
      return false;
    }
    try {
      const next = await update({
        baseUrl: url,
        token: token.trim(),
        syncEnabled,
        autoSync,
      });
      setBaseUrl(next.baseUrl);
      setToken(next.token);
      setSyncEnabled(next.syncEnabled);
      setAutoSync(next.autoSync);
      return true;
    } catch (err) {
      show(pickErrorMessage(err), 'error');
      return false;
    }
  };

  const runManualSync = async () => {
    if (syncing) return;
    if (!syncEnabled) {
      show('先开启「启用 NUC 同步」，再立即同步', 'info');
      return;
    }
    if (!isValidHttpUrl(normalizedBaseUrl)) {
      show('请先填写有效的 NUC 地址，再立即同步', 'error');
      return;
    }

    const needsPersist =
      normalizedBaseUrl !== settings.baseUrl ||
      token.trim() !== settings.token ||
      syncEnabled !== settings.syncEnabled ||
      autoSync !== settings.autoSync;

    setSyncing(true);
    try {
      if (needsPersist) {
        const saved = await persistNetworkInputs();
        if (!saved) return;
        // Let SyncProvider pick up the freshly saved config before running.
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
      }

      const result = await sync.syncNow({ silent: false });
      if (!result) {
        show('同步正在进行中，请稍候', 'info');
        return;
      }
      show(
        formatSyncSummary(result),
        result.status === 'success' ? 'success' : result.status === 'error' ? 'error' : 'info',
      );
    } catch (err) {
      show(pickErrorMessage(err, '同步失败，请稍后再试'), 'error');
    } finally {
      setSyncing(false);
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

  const syncMeta = SYNC_STATUS_META[sync.status];
  const syncBusy = syncing || sync.status === 'syncing';
  const statusColor = health
    ? colors.success
    : testError
      ? colors.danger
      : syncEnabled
        ? syncMeta.color
        : colors.muted;
  const statusSummary = health
    ? `${health.app || '家用 NUC'} 已连通${health.ai_enabled ? ' · AI 提炼开启' : ''}`
    : testError
      ? '连接未通过 · 请检查后端线路'
      : !syncEnabled
        ? '纯本地模式 · 剪藏只留在这台手机'
        : sync.status === 'syncing'
          ? '正在与 NUC 同步…'
          : sync.status === 'offline'
            ? '离线已跳过同步 · 本地记录安全'
            : sync.status === 'error'
              ? '同步异常 · 本地记录未丢失'
              : sync.status === 'success'
                ? '已同步 · NUC 与手机保持一致'
                : `v${appVersion} · 本地优先，可选云端同步`;

  const effectiveStatusLabel = syncEnabled ? syncMeta.label : '已关闭';
  const effectiveStatusColor = syncEnabled ? syncMeta.color : colors.muted;
  const effectiveStatusSoft = syncEnabled ? syncMeta.soft : colors.surface;
  const syncIcon = syncEnabled ? SYNC_STATUS_ICON[sync.status] : 'cloud-offline-outline';
  const lastSyncLabel = sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : '还未同步过';
  const syncSummaryLine = !syncEnabled
    ? '同步已关闭，剪藏与复习记录只保存在本机。'
    : sync.status === 'syncing'
      ? '正在与 NUC 交换变更，请稍候…'
      : sync.lastMessage
        ? sync.lastMessage
        : '还没有同步记录，点「立即同步」把本机剪藏送到 NUC。';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.header}>
          <Text style={styles.title}>设置</Text>
          <Text style={styles.subtitle}>本地优先剪藏，按需接入公网 AI 与家里的 NUC</Text>
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
          <View style={styles.groupHeading}>
            <Text style={styles.groupTitle}>本机 AI 提炼 · 可选</Text>
            <View
              style={[
                styles.miniBadge,
                aiConfigured ? styles.miniBadgeOn : styles.miniBadgeOff,
              ]}
            >
              <Text
                style={[
                  styles.miniBadgeText,
                  { color: aiConfigured ? colors.accent : colors.muted },
                ]}
              >
                {aiStatusLabel}
              </Text>
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.hintCard}>
              <Ionicons
                name="sparkles-outline"
                size={15}
                color={colors.accent}
                style={styles.hintIcon}
              />
              <Text style={styles.hintText}>
                填写后，日常剪藏与离线抓取会直接调用这个 OpenAI 兼容接口，生成摘要与标签；
                留空则本机跳过 AI，同步到 NUC 后由 NUC 自动补跑并回流。
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>API Base URL</Text>
              <TextInput
                value={llmBaseUrl}
                onChangeText={setLlmBaseUrl}
                placeholder="https://api.deepseek.com/v1"
                placeholderTextColor={colors.faint}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                inputMode="url"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>API Key</Text>
              <View style={styles.tokenRow}>
                <TextInput
                  value={llmApiKey}
                  onChangeText={setLlmApiKey}
                  placeholder="sk-…（只保存在本机）"
                  placeholderTextColor={colors.faint}
                  style={[styles.input, styles.tokenInput]}
                  secureTextEntry={!revealApiKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable
                  onPress={() => setRevealApiKey((value) => !value)}
                  hitSlop={8}
                  style={styles.eyeButton}
                >
                  <Ionicons
                    name={revealApiKey ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color={colors.muted}
                  />
                </Pressable>
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>模型名</Text>
              <TextInput
                value={llmModel}
                onChangeText={setLlmModel}
                placeholder={DEFAULT_LLM_MODEL}
                placeholderTextColor={colors.faint}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <Text style={styles.fieldHint}>
              Base URL 与 API Key 都填写后才会在本机启用 AI；密钥仅保存在本机，不会随同步上传。
            </Text>
          </View>
        </View>

        <View style={styles.group}>
          <View style={styles.groupHeading}>
            <Text style={styles.groupTitle}>NUC 云端同步 · 可选</Text>
            <Text style={styles.groupMeta}>{syncEnabled ? '双向同步' : '纯本地'}</Text>
          </View>

          <View style={styles.section}>
            <View
              style={[
                styles.syncPanel,
                {
                  backgroundColor: effectiveStatusSoft,
                  borderColor: `${effectiveStatusColor}33`,
                },
              ]}
            >
              <View style={styles.syncHeader}>
                <View style={styles.syncIconWrap}>
                  <Ionicons name={syncIcon} size={18} color={effectiveStatusColor} />
                </View>
                <View style={styles.syncHeaderText}>
                  <Text style={styles.syncTitle}>
                    NUC 同步 · {syncEnabled ? '已开启' : '未开启'}
                  </Text>
                  <Text style={styles.syncSubtitle} numberOfLines={2}>
                    {syncSummaryLine}
                  </Text>
                </View>
                <View
                  style={[styles.statusChip, { borderColor: `${effectiveStatusColor}44` }]}
                >
                  <View
                    style={[styles.statusDot, { backgroundColor: effectiveStatusColor }]}
                  />
                  <Text style={[styles.statusChipText, { color: effectiveStatusColor }]}>
                    {effectiveStatusLabel}
                  </Text>
                </View>
              </View>

              <View style={styles.syncMetaList}>
                <View style={styles.syncMetaRow}>
                  <Text style={styles.syncMetaLabel}>待同步变更</Text>
                  <Text style={styles.syncMetaValue}>{sync.pendingCount} 项</Text>
                </View>
                <View style={[styles.syncMetaRow, styles.syncMetaRowDivider]}>
                  <Text style={styles.syncMetaLabel}>上次同步</Text>
                  <Text style={styles.syncMetaValue}>{lastSyncLabel}</Text>
                </View>
              </View>
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>启用 NUC 同步</Text>
                <Text style={styles.switchHint}>
                  关闭后完全离线：剪藏只留本机，不访问任何服务器
                </Text>
              </View>
              <Switch
                value={syncEnabled}
                onValueChange={setSyncEnabled}
                trackColor={{ false: colors.surfaceAlt, true: colors.accent }}
                thumbColor={colors.onAccent}
              />
            </View>

            <View style={[styles.switchRow, !syncEnabled && styles.disabled]}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>打开 App 自动静默同步</Text>
                <Text style={styles.switchHint}>回到前台时静默补传，失败不打扰</Text>
              </View>
              <Switch
                value={autoSync}
                onValueChange={setAutoSync}
                disabled={!syncEnabled}
                trackColor={{ false: colors.surfaceAlt, true: colors.accent }}
                thumbColor={colors.onAccent}
              />
            </View>

            <View style={styles.sectionDivider} />

            <View style={styles.field}>
              <Text style={styles.label}>快捷线路</Text>
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
                      <Text
                        style={[styles.presetLabel, selected && styles.presetLabelSelected]}
                      >
                        {preset.label}
                      </Text>
                      <Text style={styles.presetHint} numberOfLines={1}>
                        {preset.url.replace(/^https?:\/\//, '')}
                      </Text>
                    </SpringPressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>NUC 服务地址</Text>
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
              <Text style={styles.fieldHint}>
                保持空白也可以保存：此时只在本机剪藏，不连接 NUC。
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>访问令牌（可选）</Text>
              <View style={styles.tokenRow}>
                <TextInput
                  value={token}
                  onChangeText={setToken}
                  placeholder="NUC 开启鉴权时填写"
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
                  <Ionicons
                    name={revealToken ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color={colors.muted}
                  />
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
                  <Text style={styles.resultLine}>
                    AI 提炼：{health.ai_enabled ? '已启用' : '未启用'}
                  </Text>
                  <Text style={styles.resultLine}>
                    接口鉴权：{health.auth_enabled ? '已开启' : '未开启'}
                  </Text>
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

            <SpringPressable
              onPress={() => void runManualSync()}
              disabled={!syncEnabled || syncBusy || saving}
              scaleTo={0.97}
              contentStyle={[
                styles.syncButton,
                (!syncEnabled || syncBusy || saving) && styles.syncButtonDisabled,
              ]}
            >
              {syncBusy ? (
                <ActivityIndicator size="small" color={colors.bg} />
              ) : (
                <Ionicons name="sync-outline" size={17} color={colors.bg} />
              )}
              <Text style={styles.syncButtonText}>
                {syncBusy ? '正在同步…' : '立即同步'}
              </Text>
            </SpringPressable>
            <Text style={styles.syncButtonHint}>
              {!syncEnabled
                ? '开启同步后可用；纯离线时本地剪藏会在下次同步时补传。'
                : normalizedBaseUrl
                  ? '地址或令牌有改动时，会先保存当前输入再同步。'
                  : '先填写 NUC 地址，再立即同步。'}
            </Text>
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

        <View style={styles.group}>
          <View style={styles.groupHeading}>
            <Text style={styles.groupTitle}>快捷剪藏</Text>
            <Text style={styles.groupMeta}>
              {autoCaptureClipboard ? '自动收录' : '手动收录'}
            </Text>
          </View>

          <View style={styles.section}>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.switchLabel}>进入 App 自动收进剪贴板链接</Text>
                <Text style={styles.switchHint}>
                  开启后从小红书 / 微信复制链接再打开剪藏，将自动收进书房，无需再点横幅。
                </Text>
              </View>
              <Switch
                value={autoCaptureClipboard}
                onValueChange={setAutoCaptureClipboard}
                trackColor={{ false: colors.surfaceAlt, true: colors.accent }}
                thumbColor={colors.onAccent}
              />
            </View>

            <View style={styles.quickClipCard}>
              <Text style={styles.quickClipTitle}>三种零切换收进方式</Text>

              <View style={styles.quickClipRow}>
                <Text style={styles.quickClipIndex}>01</Text>
                <Text style={styles.quickClipText}>
                  控制中心磁贴：下拉快捷开关 → 编辑 → 添加「剪藏」，复制链接后下拉一点即收。
                </Text>
              </View>

              <View style={styles.quickClipRow}>
                <Text style={styles.quickClipIndex}>02</Text>
                <Text style={styles.quickClipText}>
                  桌面 / 侧边栏 / 手势：长按图标拖出「收剪贴板」，或使用深链
                  jiancang-clip://clipboard。
                </Text>
              </View>

              <View style={styles.quickClipRow}>
                <Text style={styles.quickClipIndex}>03</Text>
                <Text style={styles.quickClipText}>
                  系统分享：在 X / 浏览器点分享 → 剪藏，静默入库不跳转页面。
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
            剪藏默认把内容留在本机，离线也能复习；开启 NUC 同步后自动双向补全。局域网与
            Tailscale 直连 HTTP，无需 HTTPS。
          </Text>
          <Text style={styles.aboutMuted}>
            最近同步：{sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : '还未同步过'}
          </Text>
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
  groupHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  groupTitle: {
    color: colors.muted,
    fontSize: 12.5,
    fontWeight: '600',
    marginLeft: 2,
  },
  groupMeta: {
    color: colors.faint,
    fontSize: 11,
  },
  miniBadge: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  miniBadgeOn: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentBorder,
  },
  miniBadgeOff: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSubtle,
  },
  miniBadgeText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  section: {
    backgroundColor: colors.sheet,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 15,
    gap: 14,
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
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
  fieldHint: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
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
  hintCard: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentBorder,
    padding: spacing.md,
  },
  hintIcon: {
    marginTop: 1,
  },
  hintText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11.5,
    lineHeight: 17,
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
  syncPanel: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.md,
  },
  syncHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  syncIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: colors.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncHeaderText: {
    flex: 1,
    gap: 3,
  },
  syncTitle: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '600',
  },
  syncSubtitle: {
    color: colors.textSecondary,
    fontSize: 11.5,
    lineHeight: 16,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.sheet,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusChipText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  syncMetaList: {
    backgroundColor: colors.sheet,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
  },
  syncMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 9,
  },
  syncMetaRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  syncMetaLabel: {
    color: colors.muted,
    fontSize: 11.5,
  },
  syncMetaValue: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
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
  syncButton: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.text,
    borderRadius: radius.md,
    ...elevation.card,
  },
  syncButtonDisabled: {
    opacity: 0.34,
    shadowOpacity: 0,
    elevation: 0,
  },
  syncButtonText: {
    color: colors.bg,
    fontSize: 14,
    fontWeight: '600',
  },
  syncButtonHint: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: -6,
    marginLeft: 2,
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
  quickClipCard: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    gap: 9,
  },
  quickClipTitle: {
    fontFamily: fonts.serif,
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '700',
    marginBottom: 1,
  },
  quickClipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  quickClipIndex: {
    fontFamily: fonts.mono,
    color: colors.accent,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
    minWidth: 18,
    letterSpacing: 0.4,
  },
  quickClipText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
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
