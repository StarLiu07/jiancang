import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { useToast } from '../components/Toast';
import { UpdateModal } from '../components/UpdateModal';
import {
  loadIgnoredUpdateVersion,
  saveIgnoredUpdateVersion,
} from '../storage/update';
import {
  fetchLatestRelease,
  installApk,
  startApkDownload,
  toUpdateErrorMessage,
  type ApkDownloadProgress,
  type ApkDownloadTask,
} from '../utils/updater';
import {
  compareSemver,
  GITHUB_RELEASES_PAGE_URL,
  isNewerVersion,
  type AppRelease,
} from '../utils/updateVersion';

export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'installing';
export type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'ignored' | 'error';

export interface AppUpdateContextValue {
  currentVersion: string;
  release: AppRelease | null;
  visible: boolean;
  phase: UpdatePhase;
  progress: ApkDownloadProgress;
  error: string | null;
  checking: boolean;
  checkStatus: UpdateCheckStatus;
  ignoredVersion: string | null;
  lastCheckedAt: number | null;
  openModal: () => void;
  closeModal: () => void;
  checkForUpdate: () => Promise<void>;
  startDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  installReadyApk: () => Promise<void>;
  ignoreVersion: () => Promise<void>;
  openReleasePage: () => Promise<void>;
}

const EMPTY_PROGRESS: ApkDownloadProgress = {
  bytesWritten: 0,
  bytesTotal: 0,
  percent: 0,
};

const CURRENT_VERSION = (Constants.expoConfig?.version ?? '0.4.0').replace(/^v/i, '');

const UpdateContext = createContext<AppUpdateContextValue | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const { show } = useToast();

  const [release, setRelease] = useState<AppRelease | null>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [progress, setProgress] = useState<ApkDownloadProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkStatus, setCheckStatus] = useState<UpdateCheckStatus>('idle');
  const [ignoredVersion, setIgnoredVersion] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);

  const checkingRef = useRef(false);
  const ignoredRef = useRef<string | null>(null);
  const taskRef = useRef<ApkDownloadTask | null>(null);
  const downloadRunRef = useRef(0);
  const readyFileRef = useRef<{ version: string; uri: string } | null>(null);

  useEffect(() => {
    let active = true;
    void loadIgnoredUpdateVersion().then((stored) => {
      if (!active) return;
      ignoredRef.current = stored;
      setIgnoredVersion(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const runCheck = useCallback(
    async (silent: boolean) => {
      if (checkingRef.current) return;
      if (taskRef.current) {
        if (!silent) setVisible(true);
        return;
      }
      checkingRef.current = true;
      setChecking(true);
      setCheckStatus('checking');

      try {
        const latest = await fetchLatestRelease();
        setLastCheckedAt(Date.now());

        if (!isNewerVersion(latest.version, CURRENT_VERSION)) {
          setRelease(null);
          setCheckStatus('up-to-date');
          if (!silent) {
            show(`当前已是最新版本 v${CURRENT_VERSION}`, 'success');
          }
          return;
        }

        let ignored = ignoredRef.current;
        if (!ignored) {
          ignored = await loadIgnoredUpdateVersion();
          ignoredRef.current = ignored;
          setIgnoredVersion(ignored);
        }

        if (silent && ignored && compareSemver(ignored, latest.version) === 0) {
          setRelease(null);
          setCheckStatus('ignored');
          return;
        }

        const sameReady =
          readyFileRef.current &&
          compareSemver(readyFileRef.current.version, latest.version) === 0;

        setRelease(latest);
        setVisible(true);
        setError(null);
        setCheckStatus('available');
        if (sameReady && readyFileRef.current) {
          setLocalUri(readyFileRef.current.uri);
          setPhase('ready');
        } else {
          readyFileRef.current = null;
          setPhase('idle');
          setProgress(EMPTY_PROGRESS);
          setLocalUri(null);
        }
      } catch (err) {
        setCheckStatus('error');
        // Cold-start checks stay silent; manual checks explain what happened.
        if (!silent) show(toUpdateErrorMessage(err), 'error');
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [show],
  );

  useEffect(() => {
    // One quiet check shortly after cold start, without blocking first paint.
    const timer = setTimeout(() => {
      void runCheck(true);
    }, 1200);
    return () => clearTimeout(timer);
  }, [runCheck]);

  const openModal = useCallback(() => {
    if (!release) return;
    setError(null);
    setVisible(true);
  }, [release]);

  const closeModal = useCallback(() => {
    if (phase === 'downloading' || phase === 'installing') return;
    setVisible(false);
    setError(null);
  }, [phase]);

  const openReleasePage = useCallback(async () => {
    const url = release?.htmlUrl || GITHUB_RELEASES_PAGE_URL;
    try {
      await Linking.openURL(url);
    } catch {
      show('无法打开浏览器，请手动访问 GitHub Releases 页面。', 'error');
    }
  }, [release, show]);

  const startDownload = useCallback(async () => {
    if (!release) return;

    if (Platform.OS !== 'android') {
      await openReleasePage();
      return;
    }
    if (taskRef.current) return;

    const runId = downloadRunRef.current + 1;
    downloadRunRef.current = runId;
    setPhase('downloading');
    setError(null);
    setProgress(EMPTY_PROGRESS);
    setLocalUri(null);

    let task: ApkDownloadTask;
    try {
      task = startApkDownload(release, (next) => {
        if (downloadRunRef.current === runId) setProgress(next);
      });
    } catch (err) {
      setPhase('idle');
      setError(toUpdateErrorMessage(err));
      return;
    }

    taskRef.current = task;

    try {
      const result = await task.promise;
      if (downloadRunRef.current !== runId) return;

      readyFileRef.current = { version: release.version, uri: result.uri };
      setLocalUri(result.uri);
      setProgress({
        bytesWritten: result.size,
        bytesTotal: result.size,
        percent: 100,
      });
      setPhase('installing');

      try {
        await installApk(result.uri);
      } catch (err) {
        setError(toUpdateErrorMessage(err));
      } finally {
        if (downloadRunRef.current === runId) setPhase('ready');
      }
    } catch (err) {
      if (downloadRunRef.current !== runId) return;
      setError(toUpdateErrorMessage(err));
      setPhase('idle');
      setProgress(EMPTY_PROGRESS);
    } finally {
      if (taskRef.current === task) taskRef.current = null;
    }
  }, [release, openReleasePage]);

  const cancelDownload = useCallback(async () => {
    // Invalidate the in-flight run before awaiting native cancellation so a
    // late rejection from the old task cannot disturb a fresh retry.
    downloadRunRef.current += 1;
    const task = taskRef.current;
    taskRef.current = null;

    if (task) {
      try {
        await task.cancel();
      } catch {
        // Cancellation is best effort; UI state below is authoritative.
      }
    }

    readyFileRef.current = null;
    setPhase('idle');
    setProgress(EMPTY_PROGRESS);
    setError(null);
    setLocalUri(null);
  }, []);

  const installReadyApk = useCallback(async () => {
    if (!localUri) {
      await startDownload();
      return;
    }
    if (phase === 'installing') return;

    setError(null);
    setPhase('installing');
    try {
      await installApk(localUri);
    } catch (err) {
      setError(toUpdateErrorMessage(err));
    } finally {
      setPhase('ready');
    }
  }, [localUri, phase, startDownload]);

  const ignoreVersion = useCallback(async () => {
    if (!release) {
      setVisible(false);
      return;
    }

    const ignored = release.version;
    await saveIgnoredUpdateVersion(ignored);
    ignoredRef.current = ignored;
    setIgnoredVersion(ignored);
    setRelease(null);
    setVisible(false);
    readyFileRef.current = null;
    setPhase('idle');
    setProgress(EMPTY_PROGRESS);
    setError(null);
    setLocalUri(null);
    setCheckStatus('ignored');
    show(`已忽略 v${ignored}，下次手动检查仍会提示`, 'info');
  }, [release, show]);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      currentVersion: CURRENT_VERSION,
      release,
      visible,
      phase,
      progress,
      error,
      checking,
      checkStatus,
      ignoredVersion,
      lastCheckedAt,
      openModal,
      closeModal,
      checkForUpdate: () => runCheck(false),
      startDownload,
      cancelDownload,
      installReadyApk,
      ignoreVersion,
      openReleasePage,
    }),
    [
      release,
      visible,
      phase,
      progress,
      error,
      checking,
      checkStatus,
      ignoredVersion,
      lastCheckedAt,
      openModal,
      closeModal,
      runCheck,
      startDownload,
      cancelDownload,
      installReadyApk,
      ignoreVersion,
      openReleasePage,
    ],
  );

  return (
    <UpdateContext.Provider value={value}>
      {children}
      <UpdateModal />
    </UpdateContext.Provider>
  );
}

export function useAppUpdate(): AppUpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('useAppUpdate must be used inside <UpdateProvider>');
  return value;
}
