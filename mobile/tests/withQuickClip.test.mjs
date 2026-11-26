import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import withQuickClip from '../plugins/withQuickClip.js';

const APP_ID = 'com.example.jiancang';

const {
  ensureQuickClipManifest,
  ensureQuickClipStrings,
  ensureQuickClipStyles,
  writeQuickClipNativeFiles,
  renderQuickClipKotlinFiles,
} = withQuickClip;

const ACTIVITY = '.quickclip.QuickClipActivity';
const SERVICE = '.quickclip.QuickClipTileService';
const ACTION_CLIPBOARD = `${APP_ID}.action.QUICK_CLIP_CLIPBOARD`;

function createManifest() {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [
            {
              $: {
                'android:name': '.MainActivity',
                'android:exported': 'true',
                'android:launchMode': 'singleTask',
              },
              'intent-filter': [
                {
                  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function actionsOf(filter) {
  return (filter.action ?? []).map((entry) => entry?.$?.['android:name']).filter(Boolean);
}

function findNamed(entries, name) {
  return (entries ?? []).find((entry) => entry?.$?.['android:name'] === name);
}

// ---------------------------------------------------------------------------
// ensureQuickClipManifest
// ---------------------------------------------------------------------------

test('ensureQuickClipManifest registers the transparent activity, tile service and shortcuts meta-data', () => {
  const { manifest } = createManifest();
  ensureQuickClipManifest(manifest, APP_ID);

  const application = manifest.application[0];
  const activity = findNamed(application.activity, ACTIVITY);
  assert.ok(activity, 'QuickClipActivity must be registered');
  assert.equal(activity.$['android:exported'], 'true');
  assert.equal(activity.$['android:excludeFromRecents'], 'true');
  assert.equal(activity.$['android:noHistory'], 'true');
  assert.equal(activity.$['android:taskAffinity'], '');
  assert.equal(activity.$['android:launchMode'], 'singleInstance');
  assert.equal(activity.$['android:label'], '剪藏');
  assert.equal(activity.$['android:icon'], '@mipmap/ic_launcher');
  assert.equal(activity.$['android:theme'], '@style/Theme.Jiancang.QuickClip');

  const filters = activity['intent-filter'] ?? [];
  assert.equal(filters.length, 3);

  const sendFilter = filters.find((filter) =>
    actionsOf(filter).includes('android.intent.action.SEND'),
  );
  assert.ok(sendFilter, 'ACTION_SEND filter must exist');
  assert.match(JSON.stringify(sendFilter), /text\/plain/);

  const clipboardFilter = filters.find((filter) => actionsOf(filter).includes(ACTION_CLIPBOARD));
  assert.ok(clipboardFilter, 'clipboard action filter must exist');
  assert.ok(
    (clipboardFilter.category ?? []).some(
      (entry) => entry?.$?.['android:name'] === 'android.intent.category.DEFAULT',
    ),
    'clipboard filter must declare DEFAULT category',
  );

  const viewFilter = filters.find((filter) =>
    actionsOf(filter).includes('android.intent.action.VIEW'),
  );
  assert.ok(viewFilter, 'ACTION_VIEW filter must exist');
  assert.match(JSON.stringify(viewFilter), /jiancang-clip/);
  assert.ok(
    (viewFilter.category ?? []).some(
      (entry) => entry?.$?.['android:name'] === 'android.intent.category.BROWSABLE',
    ),
    'deeplink filter must declare BROWSABLE category',
  );

  const service = findNamed(application.service, SERVICE);
  assert.ok(service, 'QuickClipTileService must be registered');
  assert.equal(service.$['android:permission'], 'android.permission.BIND_QUICK_SETTINGS_TILE');
  assert.equal(service.$['android:exported'], 'true');
  const serviceFilter = (service['intent-filter'] ?? [])[0];
  assert.deepEqual(actionsOf(serviceFilter), ['android.service.quicksettings.action.QS_TILE']);
  const toggleMeta = findNamed(
    service['meta-data'],
    'android.service.quicksettings.TOGGLEABLE_TILE',
  );
  assert.ok(toggleMeta, 'TOGGLEABLE_TILE meta-data must exist');
  assert.equal(toggleMeta.$['android:value'], 'false');

  const mainActivity = findNamed(application.activity, '.MainActivity');
  const shortcutMeta = findNamed(mainActivity['meta-data'], 'android.app.shortcuts');
  assert.ok(shortcutMeta, 'MainActivity must expose static shortcuts');
  assert.equal(shortcutMeta.$['android:resource'], '@xml/shortcuts');
});

test('ensureQuickClipManifest is idempotent across prebuild re-runs', () => {
  const { manifest } = createManifest();
  ensureQuickClipManifest(manifest, APP_ID);
  const once = JSON.stringify(manifest);

  ensureQuickClipManifest(manifest, APP_ID);
  ensureQuickClipManifest(manifest, APP_ID);

  assert.equal(JSON.stringify(manifest), once, 'manifest must not accumulate duplicates');
  const application = manifest.application[0];
  assert.equal(
    application.activity.filter((entry) => entry?.$?.['android:name'] === ACTIVITY).length,
    1,
  );
  assert.equal(
    application.service.filter((entry) => entry?.$?.['android:name'] === SERVICE).length,
    1,
  );
});

test('ensureQuickClipManifest tolerates a bare manifest without application', () => {
  const bare = {};
  assert.doesNotThrow(() => ensureQuickClipManifest(bare, APP_ID));
  assert.deepEqual(bare, {});
});

// ---------------------------------------------------------------------------
// ensureQuickClipStrings
// ---------------------------------------------------------------------------

test('ensureQuickClipStrings adds the tile and shortcut labels once', () => {
  const xml = { resources: {} };
  ensureQuickClipStrings(xml);

  const byName = Object.fromEntries(
    (xml.resources.string ?? []).map((entry) => [entry.$.name, entry._]),
  );
  assert.equal(byName.quick_clip_tile_label, '剪藏');
  assert.equal(byName.quick_clip_tile_subtitle, '收剪贴板');
  assert.equal(byName.quick_clip_shortcut_short, '收剪贴板');
  assert.equal(byName.quick_clip_shortcut_long, '一键收进书房');

  const snapshot = JSON.stringify(xml);
  ensureQuickClipStrings(xml);
  ensureQuickClipStrings(xml);
  assert.equal(JSON.stringify(xml), snapshot, 'strings.xml must stay deduplicated');
  assert.equal(xml.resources.string.length, 4);
});

// ---------------------------------------------------------------------------
// ensureQuickClipStyles
// ---------------------------------------------------------------------------

test('ensureQuickClipStyles writes the transparent no-animation theme once', () => {
  const xml = { resources: { style: [] } };
  ensureQuickClipStyles(xml);

  const style = xml.resources.style.find((entry) => entry.$.name === 'Theme.Jiancang.QuickClip');
  assert.ok(style, 'Theme.Jiancang.QuickClip must exist');
  assert.equal(style.$.parent, 'android:Theme.Translucent.NoTitleBar');

  const items = Object.fromEntries((style.item ?? []).map((entry) => [entry.$.name, entry._]));
  assert.equal(items['android:windowIsTranslucent'], 'true');
  assert.equal(items['android:windowBackground'], '@android:color/transparent');
  assert.equal(items['android:backgroundDimEnabled'], 'false');
  assert.equal(items['android:windowAnimationStyle'], '@null');

  const snapshot = JSON.stringify(xml);
  ensureQuickClipStyles(xml);
  ensureQuickClipStyles(xml);
  assert.equal(JSON.stringify(xml), snapshot, 'styles.xml must stay deduplicated');
  assert.equal(
    xml.resources.style.filter((entry) => entry.$.name === 'Theme.Jiancang.QuickClip').length,
    1,
  );
});

// ---------------------------------------------------------------------------
// renderQuickClipKotlinFiles
// ---------------------------------------------------------------------------

test('renderQuickClipKotlinFiles renders the three package-corrected sources', () => {
  const files = renderQuickClipKotlinFiles(APP_ID);
  assert.deepEqual(Object.keys(files).sort(), [
    'QuickClipActivity.kt',
    'QuickClipInbox.kt',
    'QuickClipTileService.kt',
  ]);

  for (const [name, source] of Object.entries(files)) {
    assert.match(source, new RegExp(`^package ${APP_ID.replaceAll('.', '\\.')}\\.quickclip$`, 'm'));
    assert.doesNotMatch(source, /__PACKAGE__|__APP_ID__/, `${name} must have no placeholders`);
  }

  const inbox = files['QuickClipInbox.kt'];
  assert.match(inbox, /buildSharePayload/);
  assert.match(inbox, /EXTRA_SUBJECT/);
  assert.match(inbox, /EXTRA_TITLE/);
  assert.match(inbox, /EXTRA_TEXT/);
  assert.match(inbox, /https\?/);
  assert.match(inbox, /\.json\.tmp/);
  assert.match(inbox, /localhost/);
  assert.match(inbox, /jiancang:quick-clip-inbox/);
  assert.match(inbox, new RegExp(`${ACTION_CLIPBOARD.replaceAll('.', '\\.')}`));

  const activity = files['QuickClipActivity.kt'];
  assert.match(activity, /: Activity\(\)/);
  // API 35 marks Activity.onNewIntent's parameter @NonNull: keep the signature
  // non-null so compileSdk 34 and 35 both accept the override.
  assert.match(activity, /override fun onNewIntent\(intent: Intent\) \{/);
  assert.doesNotMatch(activity, /onNewIntent\(intent: Intent\?\)/);
  // Toast must not leak the finishing Activity window context.
  assert.match(activity, /Toast\.makeText\(applicationContext,/);
  assert.doesNotMatch(activity, /Toast\.makeText\(this,/);
  assert.match(activity, /onWindowFocusChanged/);
  assert.match(activity, /decorView\??\.post/);
  assert.match(activity, /overrideActivityTransition/);
  assert.match(activity, /overridePendingTransition/);
  assert.match(activity, /reactHost\?\.currentReactContext/);
  assert.match(activity, /hasInstance\(\)/);
  assert.match(activity, /DeviceEventManagerModule\.RCTDeviceEventEmitter/);
  assert.match(activity, /QuickClipInbox\.EVENT_NAME/);
  assert.match(activity, /已收进书房/);
  assert.match(activity, /已在收件队列/);
  assert.match(activity, /剪贴板没有可剪藏的链接/);
  assert.match(activity, /剪藏写入失败，请重试/);
  assert.match(activity, /800/);

  const tile = files['QuickClipTileService.kt'];
  assert.match(tile, new RegExp(`^import ${APP_ID.replaceAll('.', '\\.')}\\.R$`, 'm'));
  assert.match(tile, /: TileService\(\)/);
  assert.match(tile, /onStartListening/);
  assert.match(tile, /unlockAndRun/);
  assert.match(tile, /startActivityAndCollapse/);
  assert.match(tile, /FLAG_IMMUTABLE/);
  assert.match(tile, /isLocked/);
  assert.match(tile, /quick_clip_tile_label/);
  assert.match(tile, /quick_clip_tile_subtitle/);
});

// ---------------------------------------------------------------------------
// writeQuickClipNativeFiles
// ---------------------------------------------------------------------------

function readTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[path.relative(root, abs).replaceAll(path.sep, '/')] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

test('writeQuickClipNativeFiles writes resources and Kotlin sources idempotently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'with-quick-clip-'));
  try {
    writeQuickClipNativeFiles(tmp, APP_ID);
    const first = readTree(tmp);

    const expected = [
      'app/src/main/res/drawable/ic_quick_clip_tile.xml',
      'app/src/main/res/drawable/ic_quick_clip_shortcut.xml',
      'app/src/main/res/xml/shortcuts.xml',
      `app/src/main/java/${APP_ID.split('.').join('/')}/quickclip/QuickClipInbox.kt`,
      `app/src/main/java/${APP_ID.split('.').join('/')}/quickclip/QuickClipActivity.kt`,
      `app/src/main/java/${APP_ID.split('.').join('/')}/quickclip/QuickClipTileService.kt`,
    ];
    assert.deepEqual(Object.keys(first).sort(), expected.sort());

    assert.match(first['app/src/main/res/drawable/ic_quick_clip_tile.xml'], /#FFFFFF/);
    assert.match(first['app/src/main/res/drawable/ic_quick_clip_shortcut.xml'], /#D44E30/);

    const shortcuts = first['app/src/main/res/xml/shortcuts.xml'];
    assert.match(shortcuts, /quick_clip_clipboard/);
    assert.match(shortcuts, new RegExp(ACTION_CLIPBOARD.replaceAll('.', '\\.')));
    assert.match(shortcuts, new RegExp(`${ACTIVITY.replaceAll('.', '\\.')}`));
    assert.match(shortcuts, /@string\/quick_clip_shortcut_short/);
    assert.match(shortcuts, /@string\/quick_clip_shortcut_long/);
    assert.match(shortcuts, /@drawable\/ic_quick_clip_shortcut/);

    writeQuickClipNativeFiles(tmp, APP_ID);
    const second = readTree(tmp);
    assert.deepEqual(second, first, 're-running prebuild must produce identical files');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// plugin shape
// ---------------------------------------------------------------------------

test('withQuickClip is an Expo config plugin function', () => {
  assert.equal(typeof withQuickClip, 'function');
  assert.equal(typeof ensureQuickClipManifest, 'function');
  assert.equal(typeof ensureQuickClipStrings, 'function');
  assert.equal(typeof ensureQuickClipStyles, 'function');
  assert.equal(typeof writeQuickClipNativeFiles, 'function');
  assert.equal(typeof renderQuickClipKotlinFiles, 'function');
});
