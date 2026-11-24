import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

import {
  formatFileSize,
  GITHUB_LATEST_RELEASE_URL,
  GITHUB_REPO,
  parseGitHubRelease,
  type AppRelease,
} from './updateVersion';

const REQUEST_TIMEOUT_MS = 15_000;

const GITHUB_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'jiancang-mobile',
};

export type UpdateErrorCode =
  | 'timeout'
  | 'network'
  | 'not-found'
  | 'rate-limited'
  | 'invalid-release'
  | 'server'
  | 'download'
  | 'cancelled'
  | 'install';

export interface AppUpdateError extends Error {
  code: UpdateErrorCode;
  isAppUpdateError: true;
}

export function createUpdateError(code: UpdateErrorCode, message: string): AppUpdateError {
  const error = new Error(message) as AppUpdateError;
  error.name = 'AppUpdateError';
  error.code = code;
  error.isAppUpdateError = true;
  return error;
}

export function isAppUpdateError(error: unknown): error is AppUpdateError {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { isAppUpdateError?: boolean }).isAppUpdateError === true,
  );
}

export function toUpdateErrorMessage(error: unknown): string {
  if (isAppUpdateError(error)) return error.message;
  if (error instanceof Error && error.message) return `更新失败：${error.message}`;
  return '更新失败，请稍后重试';
}

/** Fetches and validates the latest public GitHub Release. */
export async function fetchLatestRelease(): Promise<AppRelease> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      method: 'GET',
      headers: GITHUB_HEADERS,
      signal: controller.signal,
    });

    if (response.status === 404) {
      throw createUpdateError(
        'not-found',
        `未找到正式 Release（404）。请确认 ${GITHUB_REPO} 仓库已公开且已发布正式版本。`,
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw createUpdateError(
        'rate-limited',
        `GitHub 接口访问受限（${response.status}），请稍后再试或前往 Release 页面手动下载。`,
      );
    }
    if (!response.ok) {
      throw createUpdateError(
        'server',
        `GitHub 返回异常状态 ${response.status}，请稍后重试。`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw createUpdateError('invalid-release', 'GitHub Release 数据解析失败，请稍后重试。');
    }

    const release = parseGitHubRelease(payload);
    if (!release) {
      throw createUpdateError(
        'invalid-release',
        '该版本未提供可用的 APK 安装包，请前往 Release 页面手动下载。',
      );
    }

    return release;
  } catch (error) {
    if (isAppUpdateError(error)) throw error;
    if (controller.signal.aborted) {
      throw createUpdateError('timeout', '检查更新超时，请检查网络或代理后重试。');
    }
    throw createUpdateError('network', '无法连接 GitHub，请检查网络或代理后重试。');
  } finally {
    clearTimeout(timer);
  }
}

export interface ApkDownloadProgress {
  bytesWritten: number;
  bytesTotal: number;
  percent: number;
}

export interface ApkDownloadResult {
  uri: string;
  size: number;
  fileName: string;
}

export interface ApkDownloadTask {
  promise: Promise<ApkDownloadResult>;
  cancel: () => Promise<void>;
}

function safeFileStem(version: string): string {
  const stem = version.replace(/[^0-9A-Za-z._-]/g, '-');
  return stem || 'latest';
}

async function deleteQuietly(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Cache cleanup is best effort; a stale .part file must not block retry.
  }
}

/**
 * Downloads an APK into the cache directory with progress, cancellation and
 * non-empty / expected-size validation so an HTML error page is never handed
 * to the Android installer.
 */
export function startApkDownload(
  release: AppRelease,
  onProgress: (progress: ApkDownloadProgress) => void,
): ApkDownloadTask {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw createUpdateError('download', '无法访问应用缓存目录，请重启应用后重试。');
  }

  const fileName = `jiancang-${safeFileStem(release.version)}.apk`;
  const finalUri = `${cacheDirectory}${fileName}`;
  const partUri = `${finalUri}.part`;

  let cancelled = false;
  const expectedSize = release.apkSizeBytes;

  const cleanup = async () => {
    await deleteQuietly(partUri);
    await deleteQuietly(finalUri);
  };

  const download = FileSystem.createDownloadResumable(
    release.apkUrl,
    partUri,
    {},
    (data) => {
      if (cancelled) return;
      const total =
        data.totalBytesExpectedToWrite > 0
          ? data.totalBytesExpectedToWrite
          : expectedSize;
      const percent =
        total > 0
          ? Math.min(100, Math.round((data.totalBytesWritten / total) * 100))
          : 0;
      onProgress({
        bytesWritten: data.totalBytesWritten,
        bytesTotal: total,
        percent,
      });
    },
  );

  const promise = (async (): Promise<ApkDownloadResult> => {
    await cleanup();
    if (cancelled) {
      throw createUpdateError('cancelled', '已取消下载。');
    }

    let result: FileSystem.FileSystemDownloadResult | undefined;
    try {
      result = await download.downloadAsync();
    } catch (error) {
      await cleanup();
      if (cancelled) throw createUpdateError('cancelled', '已取消下载。');
      const detail = error instanceof Error && error.message ? `：${error.message}` : '';
      throw createUpdateError('download', `下载安装包失败${detail}。请检查网络后重试。`);
    }

    if (cancelled || !result) {
      await cleanup();
      throw createUpdateError('cancelled', '已取消下载。');
    }

    if (result.status < 200 || result.status >= 300) {
      await cleanup();
      throw createUpdateError(
        'download',
        `下载安装包失败（HTTP ${result.status}），请稍后重试或前往 Release 页面手动下载。`,
      );
    }

    if (result.mimeType && /text\/html/i.test(result.mimeType)) {
      await cleanup();
      throw createUpdateError('download', '下载到的不是 APK 文件，请稍后重试或前往 Release 页面手动下载。');
    }

    const info = await FileSystem.getInfoAsync(partUri, { size: true });
    if (!info.exists || info.isDirectory || !(info.size > 0)) {
      await cleanup();
      throw createUpdateError('download', '安装包校验失败：下载文件为空，请重新下载。');
    }

    if (expectedSize > 0) {
      const ratio = info.size / expectedSize;
      if (ratio < 0.9 || ratio > 1.1) {
        await cleanup();
        throw createUpdateError(
          'download',
          `安装包校验失败：实际 ${formatFileSize(info.size)} 与预期 ${formatFileSize(expectedSize)} 不符，请重新下载。`,
        );
      }
    }

    if (cancelled) {
      await cleanup();
      throw createUpdateError('cancelled', '已取消下载。');
    }

    await deleteQuietly(finalUri);
    try {
      await FileSystem.moveAsync({ from: partUri, to: finalUri });
    } catch {
      await cleanup();
      throw createUpdateError('download', '安装包保存失败，请检查存储空间后重试。');
    }

    return { uri: finalUri, size: info.size, fileName };
  })();

  const cancel = async () => {
    cancelled = true;
    try {
      await download.cancelAsync();
    } catch {
      // The task may have already finished; cleanup below still applies.
    }
    await cleanup();
  };

  return { promise, cancel };
}

/** Opens the Android package installer for a downloaded APK. */
export async function installApk(localUri: string): Promise<void> {
  if (Platform.OS !== 'android') {
    throw createUpdateError('install', '当前平台不支持应用内安装，请前往 GitHub 下载最新版本。');
  }

  const info = await FileSystem.getInfoAsync(localUri);
  if (!info.exists || !(info.size > 0)) {
    throw createUpdateError('install', '安装包已不存在或为空，请重新下载后再安装。');
  }

  let contentUri: string;
  try {
    contentUri = await FileSystem.getContentUriAsync(localUri);
  } catch {
    throw createUpdateError('install', '无法读取安装包，请重新下载后再试。');
  }

  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: 1 | 0x10000000,
      type: 'application/vnd.android.package-archive',
    });
  } catch {
    throw createUpdateError(
      'install',
      '无法唤起系统安装器，请允许「安装未知来源应用」后点击「立即安装」重试。',
    );
  }
}
