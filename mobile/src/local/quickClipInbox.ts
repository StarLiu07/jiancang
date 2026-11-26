/**
 * Maildir-style quick-clip inbox consumer.
 *
 * Fast native entry points (control-center tile, launcher shortcut, deep link)
 * cannot wait for React Native to boot, so the Android service drops one JSON
 * file per request into `<documentDirectory>/quick_clip_inbox/`. This module
 * drains that directory into the local-first repository:
 *
 * - `.json` entries are consumed in ascending filename order (the native side
 *   names them with a monotonic prefix, so this is FIFO);
 * - a successfully ingested entry is deleted and its URL is dismissed, so the
 *   clipboard banner does not re-appear on the home screen;
 * - corrupt / URL-less entries (JSON parse failure, 422) are deleted so one bad
 *   file can never block the queue;
 * - transient failures (SQLite busy, IO error) keep the file for the next pass.
 *
 * The directory / repository / settings modules are loaded lazily: importing
 * this file (and the pure helpers below) never touches a native module, which
 * keeps `mobile/tests/*.test.mjs` runnable in plain Node.
 */

import type {
  ClipCreateInput,
  ClipCreateResponse,
  LocalAiConfig,
} from '../types';
import type { RemoteExtractFallback } from './ingest';
import { extractUrl } from './urlUtils';

/** Folder under `FileSystem.documentDirectory` written by the native side. */
export const QUICK_CLIP_INBOX_DIR = 'quick_clip_inbox';

/** DeviceEventEmitter event fired after a native entry was enqueued. */
export const QUICK_CLIP_EVENT_NAME = 'jiancang:quick-clip-inbox';

/** One request written by the native quick-clip entry point. */
export interface QuickClipInboxEntry {
  /** Verbatim clipboard / share text (title + 口令 kept intact). */
  rawInput: string;
  /** Extra native metadata (timestamp, source, ...) is passed through unused. */
  [key: string]: unknown;
}

export interface QuickClipInboxDrainResult {
  /** Entries handled to a terminal state (created, deduplicated or discarded). */
  processed: number;
  /** Newly created clips. */
  created: number;
  /** Entries whose normalized URL already existed in the library. */
  deduplicated: number;
  /** Entries kept on disk because of a transient error (retried next pass). */
  failed: number;
}

/** Injectable side effects so the drain loop is unit-testable in plain Node. */
export interface QuickClipInboxDeps {
  /** Raw directory listing (non-`.json` names are filtered by the drain). */
  listEntries: () => Promise<readonly string[]>;
  readEntry: (name: string) => Promise<string>;
  removeEntry: (name: string) => Promise<void>;
  createClip: (
    input: ClipCreateInput,
    aiConfig: LocalAiConfig,
    remoteFallback?: RemoteExtractFallback,
  ) => Promise<ClipCreateResponse>;
  /** Dismiss a URL so the clipboard banner stops offering it. */
  markUrlDismissed: (url: string) => Promise<void>;
}

export function emptyQuickClipInboxResult(): QuickClipInboxDrainResult {
  return { processed: 0, created: 0, deduplicated: 0, failed: 0 };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether a directory entry is a consumable inbox item.
 *
 * Only plain `<name>.json` files qualify: `.tmp` staging files (still being
 * written by the native side) and hidden files are ignored.
 */
export function isInboxEntryFilename(name: string): boolean {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value || value.startsWith('.')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return /\.json$/i.test(value);
}

/** Parse one inbox file, returning null for anything that is not a rawInput. */
export function parseInboxEntry(rawJson: string): QuickClipInboxEntry | null {
  if (typeof rawJson !== 'string' || !rawJson.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const rawInput = typeof record.rawInput === 'string' ? record.rawInput.trim() : '';
  if (!rawInput) return null;

  return { ...record, rawInput };
}

/** Ascending filename order == the order the native side enqueued entries. */
function compareEntryNames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 422 means the entry will never become a valid clip: drop it. */
function isHopelessEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return Number((error as { status?: unknown }).status) === 422;
}

function mergeResults(
  target: QuickClipInboxDrainResult,
  source: QuickClipInboxDrainResult,
): void {
  target.processed += source.processed;
  target.created += source.created;
  target.deduplicated += source.deduplicated;
  target.failed += source.failed;
}

async function removeEntryQuietly(
  deps: QuickClipInboxDeps,
  name: string,
): Promise<void> {
  try {
    await deps.removeEntry(name);
  } catch {
    // Deleting is best effort: a stale file is re-deduplicated next pass.
  }
}

async function drainPass(
  deps: QuickClipInboxDeps,
  aiConfig: LocalAiConfig,
  remoteFallback?: RemoteExtractFallback,
): Promise<QuickClipInboxDrainResult> {
  const result = emptyQuickClipInboxResult();

  let names: readonly string[];
  try {
    names = await deps.listEntries();
  } catch {
    return result;
  }

  const files = Array.from(names ?? [])
    .filter(isInboxEntryFilename)
    .sort(compareEntryNames);

  for (const name of files) {
    let rawJson: string;
    try {
      rawJson = await deps.readEntry(name);
    } catch {
      // IO hiccup: keep the file and retry on the next drain.
      result.failed += 1;
      continue;
    }

    const entry = parseInboxEntry(rawJson);
    if (!entry) {
      // Corrupt payload can never succeed: drop it instead of blocking the queue.
      result.processed += 1;
      await removeEntryQuietly(deps, name);
      continue;
    }

    try {
      const created = await deps.createClip({ input: entry.rawInput }, aiConfig, remoteFallback);
      result.processed += 1;
      if (created?.deduplicated) result.deduplicated += 1;
      else result.created += 1;

      const url = extractUrl(entry.rawInput) ?? String(created?.clip?.url ?? '').trim();
      if (url) {
        try {
          await deps.markUrlDismissed(url);
        } catch {
          // Dismissal is cosmetic: never keep an ingested entry around for it.
        }
      }

      await removeEntryQuietly(deps, name);
    } catch (error) {
      if (isHopelessEntryError(error)) {
        result.processed += 1;
        await removeEntryQuietly(deps, name);
      } else {
        // Transient (SQLite busy, etc.): leave the file for the next pass.
        result.failed += 1;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// serialized drain loop
// ---------------------------------------------------------------------------

let activeDrain: Promise<QuickClipInboxDrainResult> | null = null;
let rerunRequested = false;

/**
 * Drain the inbox with injected side effects.
 *
 * Concurrent calls are serialized: a call made while a drain is running only
 * schedules one extra pass, which runs after the current one (and is included
 * in the shared promise). This keeps two foreground events from ingesting the
 * same entry twice while still picking up files written mid-pass.
 */
export function drainQuickClipInboxWithDeps(
  deps: QuickClipInboxDeps,
  aiConfig: LocalAiConfig,
  remoteFallback?: RemoteExtractFallback,
): Promise<QuickClipInboxDrainResult> {
  if (activeDrain) {
    rerunRequested = true;
    return activeDrain;
  }

  const aggregate = emptyQuickClipInboxResult();

  const run = (async () => {
    for (;;) {
      rerunRequested = false;
      mergeResults(aggregate, await drainPass(deps, aiConfig, remoteFallback));
      if (!rerunRequested) break;
    }
    return aggregate;
  })().finally(() => {
    if (activeDrain === run) activeDrain = null;
    if (rerunRequested) {
      // A trigger landed after the last pass decided to stop: run it detached
      // (its caller already received this promise).
      rerunRequested = false;
      void drainQuickClipInboxWithDeps(deps, aiConfig, remoteFallback).catch(
        () => undefined,
      );
    }
  });

  activeDrain = run;
  return run;
}

// ---------------------------------------------------------------------------
// default (native) adapter
// ---------------------------------------------------------------------------

type FileSystemModule = typeof import('expo-file-system');
type RepositoryModule = typeof import('./repository');
type SettingsModule = typeof import('../storage/settings');

interface NativeModules {
  fileSystem: FileSystemModule;
  localRepo: RepositoryModule['localRepo'];
  saveDismissedClipboardUrl: SettingsModule['saveDismissedClipboardUrl'];
}

function isWebPlatform(): boolean {
  try {
    const rn = require('react-native') as typeof import('react-native');
    return rn?.Platform?.OS === 'web';
  } catch {
    // Plain Node (unit tests): not a browser.
    return false;
  }
}

function loadNativeModules(): NativeModules {
  // Metro resolves these at bundle time; Node tests never reach them.
  const fileSystem = require('expo-file-system') as FileSystemModule;
  const repository = require('./repository') as RepositoryModule;
  const settings = require('../storage/settings') as SettingsModule;
  return {
    fileSystem,
    localRepo: repository.localRepo,
    saveDismissedClipboardUrl: settings.saveDismissedClipboardUrl,
  };
}

/**
 * Consume `<documentDirectory>/quick_clip_inbox/*.json` into the local library.
 *
 * Never throws: web, a missing directory, or an unavailable native module all
 * resolve to an empty result. Transient ingestion errors keep the file so the
 * next foreground event retries.
 */
export async function drainQuickClipInbox(
  aiConfig: LocalAiConfig,
  remoteFallback?: RemoteExtractFallback,
): Promise<QuickClipInboxDrainResult> {
  if (isWebPlatform()) return emptyQuickClipInboxResult();

  let modules: NativeModules;
  try {
    modules = loadNativeModules();
  } catch {
    return emptyQuickClipInboxResult();
  }

  const { fileSystem } = modules;
  const base = fileSystem.documentDirectory;
  if (!base) return emptyQuickClipInboxResult();

  const dir = `${base}${QUICK_CLIP_INBOX_DIR}/`;
  try {
    const info = await fileSystem.getInfoAsync(dir);
    if (!info.exists || info.isDirectory === false) return emptyQuickClipInboxResult();
  } catch {
    return emptyQuickClipInboxResult();
  }

  return drainQuickClipInboxWithDeps(
    {
      listEntries: () => fileSystem.readDirectoryAsync(dir),
      readEntry: (name) => fileSystem.readAsStringAsync(`${dir}${name}`),
      removeEntry: (name) => fileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }),
      createClip: (input, config, fallback) =>
        modules.localRepo.createClip(input, config, fallback),
      markUrlDismissed: (url) => modules.saveDismissedClipboardUrl(url),
    },
    aiConfig,
    remoteFallback,
  );
}
