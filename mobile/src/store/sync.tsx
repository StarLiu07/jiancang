/**
 * Sync state for the whole app.
 *
 * Manual runs come from the settings screen; background runs happen on mount
 * and whenever Android brings the app back to the foreground. Background runs
 * are silent (no toasts) and debounced with a 30s cooldown so switching apps
 * never spams the NUC.
 */

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
import { AppState } from 'react-native';

import { pickErrorMessage } from '../api/client';
import { countPendingSync, getSyncState } from '../local/db';
import {
  formatSyncSummary,
  runBidirectionalSync,
  type SyncRunResult,
  type SyncStatus,
} from '../sync/engine';
import { useSettings } from './settings';

const AUTO_SYNC_COOLDOWN_MS = 30_000;
const AUTO_SYNC_START_DELAY_MS = 1_200;
const LAST_SYNC_AT_KEY = 'last_sync_at';

export interface SyncContextValue {
  status: SyncStatus;
  lastSyncAt: string | null;
  pendingCount: number;
  lastMessage: string;
  /** Runs one sync; returns `null` when a run is already in flight. */
  syncNow: (options?: { silent?: boolean }) => Promise<SyncRunResult | null>;
  refreshPendingCount: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

function failureResult(error: unknown): SyncRunResult {
  return {
    status: 'error',
    message: pickErrorMessage(error, '同步失败，请稍后再试'),
    pushed: 0,
    pulled: 0,
    uploadedMedia: 0,
    downloadedMedia: 0,
    queuedAi: 0,
    pendingCount: 0,
    changed: false,
    lastSyncAt: null,
  };
}

export function SyncProvider({
  children,
  onDataSynced,
}: {
  children: ReactNode;
  onDataSynced?: () => void;
}) {
  const { settings, ready, config } = useSettings();

  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastMessage, setLastMessage] = useState('');

  // Single-flight lock: a second tap while a run is in progress is ignored.
  const runningRef = useRef(false);
  const configRef = useRef(config);
  const onDataSyncedRef = useRef(onDataSynced);
  const lastAutoSyncAtRef = useRef(0);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    onDataSyncedRef.current = onDataSynced;
  }, [onDataSynced]);

  const refreshPendingCount = useCallback(async () => {
    try {
      const count = await countPendingSync();
      setPendingCount(count);
    } catch {
      // The local DB may still be migrating; the next call retries.
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [count, stamp] = await Promise.all([
          countPendingSync(),
          getSyncState(LAST_SYNC_AT_KEY),
        ]);
        if (!active) return;
        setPendingCount(count);
        if (stamp) setLastSyncAt(stamp);
      } catch {
        // Sync metadata is best effort; never block first paint for it.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const syncNow = useCallback(async (options?: { silent?: boolean }): Promise<SyncRunResult | null> => {
    const silent = options?.silent === true;
    if (runningRef.current) return null;
    runningRef.current = true;
    setStatus('syncing');

    try {
      const result = await runBidirectionalSync(configRef.current, { silent });
      setStatus(result.status);
      setPendingCount(result.pendingCount);
      setLastMessage(formatSyncSummary(result));
      if (result.lastSyncAt) setLastSyncAt(result.lastSyncAt);
      if (result.changed) onDataSyncedRef.current?.();
      return result;
    } catch (error) {
      const result = failureResult(error);
      setStatus(result.status);
      setLastMessage(formatSyncSummary(result));
      return result;
    } finally {
      runningRef.current = false;
    }
  }, []);

  const autoSyncEnabled = ready && settings.syncEnabled && settings.autoSync;

  const triggerAutoSync = useCallback(() => {
    const now = Date.now();
    if (now - lastAutoSyncAtRef.current < AUTO_SYNC_COOLDOWN_MS) return;
    lastAutoSyncAtRef.current = now;
    void syncNow({ silent: true });
  }, [syncNow]);

  useEffect(() => {
    if (!autoSyncEnabled) return;
    const timer = setTimeout(triggerAutoSync, AUTO_SYNC_START_DELAY_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') triggerAutoSync();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [autoSyncEnabled, triggerAutoSync]);

  const value = useMemo<SyncContextValue>(
    () => ({
      status,
      lastSyncAt,
      pendingCount,
      lastMessage,
      syncNow,
      refreshPendingCount,
    }),
    [status, lastSyncAt, pendingCount, lastMessage, syncNow, refreshPendingCount],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error('useSync must be used inside <SyncProvider>');
  return value;
}
