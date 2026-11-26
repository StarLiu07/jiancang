import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUICK_CLIP_EVENT_NAME,
  QUICK_CLIP_INBOX_DIR,
  drainQuickClipInbox,
  drainQuickClipInboxWithDeps,
  isInboxEntryFilename,
  parseInboxEntry,
} from '../src/local/quickClipInbox.ts';
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  saveDismissedClipboardUrl,
  subscribeDismissedClipboardUrl,
} from '../src/storage/settings.ts';

const AI_CONFIG = {
  baseUrl: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-local-test',
  model: 'test-model',
};

const REMOTE_FALLBACK = {
  apiConfig: { baseUrl: 'http://192.168.31.98:8420', token: 'nuc-token' },
  syncEnabled: true,
};

const EMPTY_RESULT = { processed: 0, created: 0, deduplicated: 0, failed: 0 };

function clipResponse(input, deduplicated = false) {
  return {
    clip: { url: 'https://example.com/fake', raw_input: input },
    deduplicated,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * In-memory stand-in for the native Maildir directory.
 *
 * `entries` is a `[name, rawJson]` list in *insertion* order so the sorting test
 * can prove the drain imposes ascending filename order itself.
 */
function makeInbox(entries = [], handlers = {}) {
  const files = new Map(entries);
  const calls = { read: [], created: [], removed: [], dismissed: [] };

  const deps = {
    async listEntries() {
      if (handlers.listEntries) return handlers.listEntries(files);
      return [...files.keys()];
    },
    async readEntry(name) {
      calls.read.push(name);
      if (handlers.readEntry) return handlers.readEntry(name, files);
      if (!files.has(name)) throw new Error(`missing entry: ${name}`);
      return files.get(name);
    },
    async removeEntry(name) {
      calls.removed.push(name);
      files.delete(name);
    },
    async createClip(input, aiConfig, remoteFallback) {
      calls.created.push({ input, aiConfig, remoteFallback });
      if (handlers.createClip) {
        return handlers.createClip(input, aiConfig, remoteFallback);
      }
      return clipResponse(input.input);
    },
    async markUrlDismissed(url) {
      calls.dismissed.push(url);
      if (handlers.markUrlDismissed) return handlers.markUrlDismissed(url);
    },
  };

  return { files, calls, deps };
}

// ---------------------------------------------------------------------------
// constants + pure helpers
// ---------------------------------------------------------------------------

test('exports the inbox directory and event name used by the native side', () => {
  assert.equal(QUICK_CLIP_INBOX_DIR, 'quick_clip_inbox');
  assert.equal(QUICK_CLIP_EVENT_NAME, 'jiancang:quick-clip-inbox');
});

test('isInboxEntryFilename only accepts plain .json files', () => {
  assert.equal(isInboxEntryFilename('0001.json'), true);
  assert.equal(isInboxEntryFilename('0001.JSON'), true);
  assert.equal(isInboxEntryFilename('0001.json.tmp'), false);
  assert.equal(isInboxEntryFilename('0001.tmp'), false);
  assert.equal(isInboxEntryFilename('.0001.json'), false);
  assert.equal(isInboxEntryFilename('.hidden'), false);
  assert.equal(isInboxEntryFilename('nested/0001.json'), false);
  assert.equal(isInboxEntryFilename('nested\\0001.json'), false);
  assert.equal(isInboxEntryFilename(''), false);
});

test('parseInboxEntry keeps rawInput and rejects unusable payloads', () => {
  assert.deepEqual(parseInboxEntry('{"rawInput":"  标题 https://example.com/a  "}'), {
    rawInput: '标题 https://example.com/a',
  });
  assert.deepEqual(
    parseInboxEntry('{"rawInput":"https://example.com/a","createdAt":"2026-11-26"}'),
    { rawInput: 'https://example.com/a', createdAt: '2026-11-26' },
  );

  assert.equal(parseInboxEntry('not json'), null);
  assert.equal(parseInboxEntry(''), null);
  assert.equal(parseInboxEntry('null'), null);
  assert.equal(parseInboxEntry('[]'), null);
  assert.equal(parseInboxEntry('"https://example.com/a"'), null);
  assert.equal(parseInboxEntry('{}'), null);
  assert.equal(parseInboxEntry('{"rawInput":""}'), null);
  assert.equal(parseInboxEntry('{"rawInput":"   "}'), null);
  assert.equal(parseInboxEntry('{"rawInput":42}'), null);
});

// ---------------------------------------------------------------------------
// drain loop
// ---------------------------------------------------------------------------

test('drain consumes .json entries in ascending filename order', async () => {
  const inbox = makeInbox([
    ['0003.json', '{"rawInput":"https://example.com/3"}'],
    ['0001.json', '{"rawInput":"https://example.com/1"}'],
    ['0002.json.tmp', '{"rawInput":"https://example.com/tmp"}'],
    ['.0004.json', '{"rawInput":"https://example.com/hidden"}'],
    ['notes.txt', '{"rawInput":"https://example.com/txt"}'],
    ['0002.json', '{"rawInput":"https://example.com/2"}'],
  ]);

  const result = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);

  assert.deepEqual(result, { processed: 3, created: 3, deduplicated: 0, failed: 0 });
  assert.deepEqual(inbox.calls.read, ['0001.json', '0002.json', '0003.json']);
  assert.deepEqual(
    inbox.calls.created.map((entry) => entry.input.input),
    ['https://example.com/1', 'https://example.com/2', 'https://example.com/3'],
  );
  assert.deepEqual(inbox.calls.removed, ['0001.json', '0002.json', '0003.json']);
  assert.deepEqual([...inbox.files.keys()], ['0002.json.tmp', '.0004.json', 'notes.txt']);
});

test('drain keeps the full clipboard text and dismisses the extracted URL', async () => {
  const rawInput =
    '在意大利吃到了人生披萨 https://xhslink.com/a/abc123 复制后打开【小红书】看看';
  const inbox = makeInbox([['0001.json', JSON.stringify({ rawInput })]]);

  const result = await drainQuickClipInboxWithDeps(
    inbox.deps,
    AI_CONFIG,
    REMOTE_FALLBACK,
  );

  assert.deepEqual(result, { processed: 1, created: 1, deduplicated: 0, failed: 0 });
  assert.equal(inbox.calls.created.length, 1);
  assert.equal(inbox.calls.created[0].input.input, rawInput);
  assert.deepEqual(inbox.calls.created[0].aiConfig, AI_CONFIG);
  assert.deepEqual(inbox.calls.created[0].remoteFallback, REMOTE_FALLBACK);
  assert.deepEqual(inbox.calls.dismissed, ['https://xhslink.com/a/abc123']);
  assert.deepEqual(inbox.calls.removed, ['0001.json']);
});

test('drain counts deduplicated clips and still dismisses + deletes them', async () => {
  const inbox = makeInbox(
    [['0001.json', '{"rawInput":"https://example.com/dup"}']],
    { createClip: async (input) => clipResponse(input.input, true) },
  );

  const result = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);

  assert.deepEqual(result, { processed: 1, created: 0, deduplicated: 1, failed: 0 });
  assert.deepEqual(inbox.calls.dismissed, ['https://example.com/dup']);
  assert.deepEqual(inbox.calls.removed, ['0001.json']);
});

test('drain discards corrupt JSON without blocking later entries', async () => {
  const inbox = makeInbox([
    ['0001.json', '{"rawInput":'],
    ['0002.json', '{"rawInput":"https://example.com/ok"}'],
  ]);

  const result = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);

  assert.deepEqual(result, { processed: 2, created: 1, deduplicated: 0, failed: 0 });
  assert.deepEqual(inbox.calls.read, ['0001.json', '0002.json']);
  assert.deepEqual(inbox.calls.removed, ['0001.json', '0002.json']);
  assert.equal(inbox.calls.created.length, 1);
});

test('drain discards 422 invalid-URL entries and keeps draining', async () => {
  const inbox = makeInbox(
    [
      ['0001.json', '{"rawInput":"没有链接的口令文案"}'],
      ['0002.json', '{"rawInput":"https://example.com/ok"}'],
    ],
    {
      createClip: async (input) => {
        if (!input.input.includes('http')) {
          const error = new Error('No valid URL found in the provided input');
          error.status = 422;
          throw error;
        }
        return clipResponse(input.input);
      },
    },
  );

  const result = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);

  assert.deepEqual(result, { processed: 2, created: 1, deduplicated: 0, failed: 0 });
  assert.deepEqual(inbox.calls.removed, ['0001.json', '0002.json']);
  assert.deepEqual(inbox.calls.dismissed, ['https://example.com/ok']);
});

test('drain keeps entries on transient errors and retries on the next pass', async () => {
  let failing = true;
  const inbox = makeInbox(
    [
      ['0001.json', '{"rawInput":"https://example.com/retry"}'],
      ['0002.json', '{"rawInput":"https://example.com/after"}'],
    ],
    {
      createClip: async (input) => {
        if (failing && input.input.includes('/retry')) {
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return clipResponse(input.input);
      },
    },
  );

  const first = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);
  assert.deepEqual(first, { processed: 1, created: 1, deduplicated: 0, failed: 1 });
  assert.deepEqual(inbox.calls.removed, ['0002.json']);
  assert.deepEqual([...inbox.files.keys()], ['0001.json']);

  failing = false;
  const second = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);
  assert.deepEqual(second, { processed: 1, created: 1, deduplicated: 0, failed: 0 });
  assert.deepEqual(inbox.calls.removed, ['0002.json', '0001.json']);
  assert.deepEqual([...inbox.files.keys()], []);
});

test('drain keeps entries whose read failed (IO hiccup)', async () => {
  let failing = true;
  const inbox = makeInbox(
    [['0001.json', '{"rawInput":"https://example.com/io"}']],
    {
      readEntry: async (name, files) => {
        if (failing) throw new Error('EIO');
        return files.get(name);
      },
    },
  );

  const first = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);
  assert.deepEqual(first, { processed: 0, created: 0, deduplicated: 0, failed: 1 });
  assert.deepEqual([...inbox.files.keys()], ['0001.json']);
  assert.equal(inbox.calls.created.length, 0);

  failing = false;
  const second = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);
  assert.deepEqual(second, { processed: 1, created: 1, deduplicated: 0, failed: 0 });
  assert.deepEqual([...inbox.files.keys()], []);
});

test('a list failure resolves to an empty result instead of rejecting', async () => {
  const inbox = makeInbox([], {
    listEntries: async () => {
      throw new Error('ENOENT');
    },
  });

  const result = await drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);
  assert.deepEqual(result, EMPTY_RESULT);
});

test('concurrent drains are serialized and run one follow-up pass', async () => {
  const started = deferred();
  const gate = deferred();
  let call = 0;

  const inbox = makeInbox([['0001.json', '{"rawInput":"https://example.com/1"}']], {
    createClip: async (input) => {
      call += 1;
      if (call === 1) {
        started.resolve();
        await gate.promise;
      }
      return clipResponse(input.input);
    },
  });

  const first = drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);
  await started.promise;

  // A native entry lands while the first pass is still blocked on SQLite.
  inbox.files.set('0002.json', '{"rawInput":"https://example.com/2"}');
  const second = drainQuickClipInboxWithDeps(inbox.deps, AI_CONFIG);

  gate.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { processed: 2, created: 2, deduplicated: 0, failed: 0 });
  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(
    inbox.calls.created.map((entry) => entry.input.input),
    ['https://example.com/1', 'https://example.com/2'],
  );
  assert.deepEqual([...inbox.files.keys()], []);
});

test('drainQuickClipInbox is inert without a native file system (plain Node)', async () => {
  // Node has no `require` for expo-file-system / react-native; the adapter must
  // degrade to an empty result rather than throwing.
  const result = await drainQuickClipInbox(AI_CONFIG, REMOTE_FALLBACK);
  assert.deepEqual(result, EMPTY_RESULT);
});

// ---------------------------------------------------------------------------
// settings: autoCaptureClipboard + dismissal bus
// ---------------------------------------------------------------------------

test('autoCaptureClipboard defaults to off and needs an explicit boolean true', () => {
  assert.equal(DEFAULT_SETTINGS.autoCaptureClipboard, false);

  assert.equal(sanitizeSettings({}).autoCaptureClipboard, false);
  assert.equal(sanitizeSettings({ autoCaptureClipboard: 'true' }).autoCaptureClipboard, false);
  assert.equal(sanitizeSettings({ autoCaptureClipboard: 1 }).autoCaptureClipboard, false);
  assert.equal(sanitizeSettings({ autoCaptureClipboard: 'yes' }).autoCaptureClipboard, false);
  assert.equal(sanitizeSettings({ autoCaptureClipboard: true }).autoCaptureClipboard, true);
  // Unrelated fields keep their existing defaults / values.
  assert.equal(sanitizeSettings({ autoCaptureClipboard: true }).autoSync, true);
});

test('subscribeDismissedClipboardUrl notifies synchronously and unsubscribes', async () => {
  const seen = [];
  const unsubscribe = subscribeDismissedClipboardUrl((url) => seen.push(url));

  const pending = saveDismissedClipboardUrl('https://example.com/dismissed');
  // Notification must be synchronous even though the storage write is async.
  assert.deepEqual(seen, ['https://example.com/dismissed']);
  await pending;

  unsubscribe();
  await saveDismissedClipboardUrl('https://example.com/after-unsubscribe');
  assert.deepEqual(seen, ['https://example.com/dismissed']);

  unsubscribe(); // idempotent
  assert.doesNotThrow(() => unsubscribe());
});

test('a throwing dismissal listener cannot block the others or the save', async () => {
  const seen = [];
  const offBroken = subscribeDismissedClipboardUrl(() => {
    throw new Error('broken listener');
  });
  const offHealthy = subscribeDismissedClipboardUrl((url) => seen.push(url));

  await assert.doesNotReject(saveDismissedClipboardUrl('https://example.com/x'));
  assert.deepEqual(seen, ['https://example.com/x']);

  offBroken();
  offHealthy();
});
