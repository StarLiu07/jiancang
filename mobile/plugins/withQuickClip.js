const fs = require('node:fs');
const path = require('node:path');

const {
  withAndroidManifest,
  withAndroidStyles,
  withDangerousMod,
  withStringsXml,
} = require('expo/config-plugins');

/**
 * Android quick-clip native channel.
 *
 * Adds a transparent hand-off activity, a QS tile service, a static launcher
 * shortcut and a `jiancang-clip://` deeplink handler. Every entry point ends in
 * the same Maildir-ish inbox: `<filesDir>/quick_clip_inbox/<epochMs>-<uuid>.json`
 * written atomically via a `.json.tmp` sibling, so JS can drain it later without
 * ever booting React Native from the cold-start path.
 */

const ACTIVITY_NAME = '.quickclip.QuickClipActivity';
const SERVICE_NAME = '.quickclip.QuickClipTileService';
const STYLE_NAME = 'Theme.Jiancang.QuickClip';
const STYLE_PARENT = 'android:Theme.Translucent.NoTitleBar';
const SHORTCUTS_META = 'android.app.shortcuts';
const TOGGLEABLE_META = 'android.service.quicksettings.TOGGLEABLE_TILE';
const QS_TILE_ACTION = 'android.service.quicksettings.action.QS_TILE';

const QUICK_CLIP_STRINGS = {
  quick_clip_tile_label: '剪藏',
  quick_clip_tile_subtitle: '收剪贴板',
  quick_clip_shortcut_short: '收剪贴板',
  quick_clip_shortcut_long: '一键收进书房',
};

const QUICK_CLIP_STYLE_ITEMS = {
  'android:windowIsTranslucent': 'true',
  'android:windowBackground': '@android:color/transparent',
  'android:backgroundDimEnabled': 'false',
  'android:windowAnimationStyle': '@null',
  'android:windowNoTitle': 'true',
  'android:windowContentOverlay': '@null',
};

const TILE_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M17,3H7c-1.1,0 -1.99,0.9 -1.99,2L5,21l7,-3 7,3V5c0,-1.1 -0.9,-2 -2,-2z" />
</vector>
`;

const SHORTCUT_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#D44E30"
        android:pathData="M17,3H7c-1.1,0 -1.99,0.9 -1.99,2L5,21l7,-3 7,3V5c0,-1.1 -0.9,-2 -2,-2z" />
</vector>
`;

const SHORTCUTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut
        android:enabled="true"
        android:icon="@drawable/ic_quick_clip_shortcut"
        android:shortcutId="quick_clip_clipboard"
        android:shortcutLongLabel="@string/quick_clip_shortcut_long"
        android:shortcutShortLabel="@string/quick_clip_shortcut_short">
        <intent
            android:action="__APP_ID__.action.QUICK_CLIP_CLIPBOARD"
            android:targetClass="__APP_ID__.quickclip.QuickClipActivity"
            android:targetPackage="__APP_ID__">
            <extra
                android:name="__APP_ID__.extra.QUICK_CLIP_SOURCE"
                android:value="shortcut" />
        </intent>
    </shortcut>
</shortcuts>
`;

const KOTLIN_INBOX = String.raw`package __PACKAGE__

import android.content.Intent
import android.net.Uri
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import org.json.JSONObject

enum class QuickClipEnqueueStatus { QUEUED, DUPLICATE, NO_LINK, FAILED }

data class QuickClipEnqueueResult(
    val status: QuickClipEnqueueStatus,
    val id: String? = null,
    val url: String? = null,
)

/** Mirrors mobile/src/utils/url.ts so native and JS agree on what counts as a clip. */
object QuickClipUrls {
    private val URL_PATTERN =
        Regex("https?://[^\\s<>\"'\u0060，。；：！？、（）【】《》]+", RegexOption.IGNORE_CASE)
    private val BARE_DOMAIN_PATTERN = Regex(
        "(?:^|\\s)((?:[a-z0-9-]+\\.)+[a-z]{2,}(?:/[^\\s，。；：！？、（）【】《》]*)?)",
        RegexOption.IGNORE_CASE,
    )

    private fun stripTrailingJunk(value: String): String = value.trimEnd(
        '.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\'', '\u201D', '\u2019',
    )

    fun isValidHttpUrl(value: String): Boolean {
        if (value.isBlank()) return false
        return try {
            val uri = Uri.parse(value)
            val scheme = uri.scheme?.lowercase(Locale.US)
            (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()
        } catch (error: Exception) {
            false
        }
    }

    fun extractFirstUrl(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val direct = URL_PATTERN.find(text)
        if (direct != null) {
            val cleaned = stripTrailingJunk(direct.value)
            if (isValidHttpUrl(cleaned)) return cleaned
        }
        val bare = BARE_DOMAIN_PATTERN.find(text)
        if (bare != null) {
            val cleaned = stripTrailingJunk(bare.groupValues[1])
            val candidate = "https://" + cleaned
            if (isValidHttpUrl(candidate)) return candidate
        }
        return null
    }

    /** Clipboard gate: drop localhost links, exactly like detectClipboardLink() in JS. */
    fun extractClipUrl(text: String?): String? {
        val url = extractFirstUrl(text) ?: return null
        val host = runCatching { Uri.parse(url).host?.lowercase(Locale.US) }.getOrNull()
        if (host.isNullOrBlank() || host == "localhost") return null
        return url
    }
}

/** Maildir-ish inbox: "<epochMs>-<uuid>.json.tmp" -> atomic rename to ".json". */
class QuickClipInbox(filesDir: File) {
    private val inboxDir = File(filesDir, INBOX_DIR_NAME)

    fun enqueue(rawInput: String, source: String): QuickClipEnqueueResult {
        val url = QuickClipUrls.extractClipUrl(rawInput)
            ?: return QuickClipEnqueueResult(QuickClipEnqueueStatus.NO_LINK)
        val id = UUID.randomUUID().toString()

        return try {
            if (!inboxDir.exists() && !inboxDir.mkdirs()) {
                return QuickClipEnqueueResult(QuickClipEnqueueStatus.FAILED, id, url)
            }
            if (hasQueuedUrl(url)) {
                return QuickClipEnqueueResult(QuickClipEnqueueStatus.DUPLICATE, id, url)
            }

            val payload = JSONObject().apply {
                put("id", id)
                put("rawInput", rawInput)
                put("url", url)
                put("source", source)
                put("createdAt", isoNow())
            }.toString()

            val baseName = System.currentTimeMillis().toString() + "-" + id
            val tmpFile = File(inboxDir, baseName + ".json.tmp")
            val finalFile = File(inboxDir, baseName + ".json")
            tmpFile.writeText(payload, Charsets.UTF_8)
            if (tmpFile.renameTo(finalFile)) {
                QuickClipEnqueueResult(QuickClipEnqueueStatus.QUEUED, id, url)
            } else {
                tmpFile.delete()
                QuickClipEnqueueResult(QuickClipEnqueueStatus.FAILED, id, url)
            }
        } catch (error: Exception) {
            QuickClipEnqueueResult(QuickClipEnqueueStatus.FAILED, id, url)
        }
    }

    private fun hasQueuedUrl(url: String): Boolean {
        val files = inboxDir.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?: return false
        return files.any { file ->
            val queued = runCatching {
                JSONObject(file.readText(Charsets.UTF_8)).optString("url")
            }.getOrNull()
            queued == url
        }
    }

    private fun isoNow(): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date())
    }

    companion object {
        const val INBOX_DIR_NAME = "quick_clip_inbox"
        const val EVENT_NAME = "jiancang:quick-clip-inbox"
        const val ACTION_QUICK_CLIP_CLIPBOARD = "__APP_ID__.action.QUICK_CLIP_CLIPBOARD"
        const val EXTRA_SOURCE = "__APP_ID__.extra.QUICK_CLIP_SOURCE"

        /**
         * Keeps EXTRA_SUBJECT / EXTRA_TITLE plus the full EXTRA_TEXT caption,
         * mirroring buildSharePayload() in mobile/src/utils/url.ts.
         */
        fun buildSharePayload(intent: Intent): String {
            val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()?.trim().orEmpty()
            val title = intent.getCharSequenceExtra(Intent.EXTRA_TITLE)?.toString()?.trim().orEmpty()
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
            if (text.isNotEmpty() && QuickClipUrls.extractFirstUrl(text) != null) return text

            val heading = when {
                subject.isEmpty() -> title
                title.isEmpty() || title == subject -> subject
                else -> subject + "\n" + title
            }
            return when {
                text.isEmpty() -> heading
                heading.isEmpty() -> text
                else -> heading + "\n" + text
            }
        }
    }
}
`;

const KOTLIN_ACTIVITY = String.raw`package __PACKAGE__

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Invisible hand-off activity: share sheet / QS tile / launcher shortcut /
 * deeplink all land here, get written into the native inbox, then the activity
 * disappears without any window animation.
 */
class QuickClipActivity : Activity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var handled = false
    private var inbox: QuickClipInbox? = null

    private val clipboardTimeout = Runnable {
        if (!handled) {
            handled = true
            finishWithoutAnimation()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        inbox = QuickClipInbox(filesDir)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handled = false
        mainHandler.removeCallbacks(clipboardTimeout)
        handleIntent(intent)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled) return
        if (!isClipboardRequest(intent)) return
        // Android 10+ refuses clipboard reads until the window has input focus.
        window?.decorView?.post { readClipboard() }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(clipboardTimeout)
        super.onDestroy()
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        when (intent.action) {
            Intent.ACTION_SEND -> {
                if (handled) return
                handled = true
                mainHandler.removeCallbacks(clipboardTimeout)
                enqueueAndFinish(QuickClipInbox.buildSharePayload(intent), SOURCE_SHARE)
            }
            QuickClipInbox.ACTION_QUICK_CLIP_CLIPBOARD -> scheduleClipboardRead()
            Intent.ACTION_VIEW -> {
                if (isClipboardRequest(intent)) {
                    scheduleClipboardRead()
                    return
                }
                if (handled) return
                handled = true
                mainHandler.removeCallbacks(clipboardTimeout)
                handleDeeplink(intent)
            }
            else -> finishWithoutAnimation()
        }
    }

    private fun scheduleClipboardRead() {
        mainHandler.removeCallbacks(clipboardTimeout)
        mainHandler.postDelayed(clipboardTimeout, CLIPBOARD_TIMEOUT_MS)
        if (hasWindowFocus()) window?.decorView?.post { readClipboard() }
    }

    private fun readClipboard() {
        if (handled) return
        handled = true
        mainHandler.removeCallbacks(clipboardTimeout)

        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val text = runCatching {
            val clip = clipboard?.primaryClip
            if (clip == null || clip.itemCount == 0) null
            else clip.getItemAt(0).coerceToText(this)?.toString()
        }.getOrNull()

        if (text.isNullOrBlank()) {
            finishWithToast(TOAST_NO_LINK)
            return
        }
        enqueueAndFinish(text, resolveSource(intent))
    }

    private fun handleDeeplink(intent: Intent) {
        val data = intent.data
        val text = data?.getQueryParameter("text")?.trim().orEmpty()
        val url = data?.getQueryParameter("url")?.trim().orEmpty()
        val rawInput = when {
            text.isNotEmpty() && url.isNotEmpty() -> text + "\n" + url
            text.isNotEmpty() -> text
            else -> url
        }
        enqueueAndFinish(rawInput, SOURCE_DEEPLINK)
    }

    private fun enqueueAndFinish(rawInput: String, source: String) {
        val result = runCatching { inbox?.enqueue(rawInput, source) }.getOrNull()
            ?: QuickClipEnqueueResult(QuickClipEnqueueStatus.FAILED)
        when (result.status) {
            QuickClipEnqueueStatus.QUEUED -> {
                notifyReact(result)
                finishWithToast(TOAST_SAVED)
            }
            QuickClipEnqueueStatus.DUPLICATE -> finishWithToast(TOAST_DUPLICATE)
            QuickClipEnqueueStatus.NO_LINK -> finishWithToast(TOAST_NO_LINK)
            QuickClipEnqueueStatus.FAILED -> finishWithToast(TOAST_FAILED)
        }
    }

    /** Never boots React Native: emit only when a live bridge already exists. */
    private fun notifyReact(result: QuickClipEnqueueResult) {
        val application = application
        if (application !is ReactApplication) return

        val reactContext = runCatching { application.reactHost?.currentReactContext }.getOrNull()
            ?: runCatching {
                val host = application.reactNativeHost
                if (host.hasInstance()) host.reactInstanceManager.currentReactContext else null
            }.getOrNull()
            ?: return

        runCatching {
            val payload = Arguments.createMap()
            payload.putString("id", result.id)
            payload.putString("url", result.url)
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(QuickClipInbox.EVENT_NAME, payload)
        }
    }

    private fun resolveSource(intent: Intent?): String {
        if (intent == null) return SOURCE_DEEPLINK
        return when (intent.action) {
            Intent.ACTION_SEND -> SOURCE_SHARE
            QuickClipInbox.ACTION_QUICK_CLIP_CLIPBOARD ->
                intent.getStringExtra(QuickClipInbox.EXTRA_SOURCE) ?: SOURCE_SHORTCUT
            else -> SOURCE_DEEPLINK
        }
    }

    private fun isClipboardRequest(intent: Intent?): Boolean {
        if (intent == null) return false
        if (intent.action == QuickClipInbox.ACTION_QUICK_CLIP_CLIPBOARD) return true
        return intent.action == Intent.ACTION_VIEW &&
            intent.data?.scheme == "jiancang-clip" &&
            intent.data?.host == "clipboard"
    }

    private fun finishWithToast(message: String) {
        mainHandler.removeCallbacks(clipboardTimeout)
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
        finishWithoutAnimation()
    }

    private fun finishWithoutAnimation() {
        finish()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        } else {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    companion object {
        private const val CLIPBOARD_TIMEOUT_MS = 800L
        private const val SOURCE_SHARE = "share"
        private const val SOURCE_SHORTCUT = "shortcut"
        private const val SOURCE_DEEPLINK = "deeplink"
        private const val TOAST_SAVED = "已收进书房"
        private const val TOAST_DUPLICATE = "已在收件队列"
        private const val TOAST_NO_LINK = "剪贴板没有可剪藏的链接"
        private const val TOAST_FAILED = "剪藏写入失败，请重试"
    }
}
`;

const KOTLIN_TILE = String.raw`package __PACKAGE__

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: one tap collects whatever link is on the clipboard. */
class QuickClipTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.let { tile ->
            tile.state = Tile.STATE_INACTIVE
            tile.label = getString(R.string.quick_clip_tile_label)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                tile.subtitle = getString(R.string.quick_clip_tile_subtitle)
            }
            tile.updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) {
            unlockAndRun { launchQuickClip() }
        } else {
            launchQuickClip()
        }
    }

    private fun launchQuickClip() {
        val intent = Intent(this, QuickClipActivity::class.java).apply {
            action = QuickClipInbox.ACTION_QUICK_CLIP_CLIPBOARD
            putExtra(QuickClipInbox.EXTRA_SOURCE, "tile")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pendingIntent = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pendingIntent)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
`;

function renderTemplate(template, appId) {
  return template
    .split('__PACKAGE__')
    .join(`${appId}.quickclip`)
    .split('__APP_ID__')
    .join(appId);
}

/** Renders the three Kotlin sources keyed by file name. */
function renderQuickClipKotlinFiles(appId) {
  if (typeof appId !== 'string' || !appId.trim()) {
    throw new Error('[withQuickClip] a valid android package is required');
  }
  return {
    'QuickClipInbox.kt': renderTemplate(KOTLIN_INBOX, appId),
    'QuickClipActivity.kt': renderTemplate(KOTLIN_ACTIVITY, appId),
    'QuickClipTileService.kt': renderTemplate(KOTLIN_TILE, appId),
  };
}

function writeFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
}

/**
 * Writes drawables, shortcuts.xml and the Kotlin sources under an Android
 * project root (`mobile/android`). Overwrites in place, so re-running prebuild
 * produces byte-identical output.
 */
function writeQuickClipNativeFiles(androidRoot, appId) {
  if (!androidRoot) throw new Error('[withQuickClip] android project root is required');
  const mainRoot = path.join(androidRoot, 'app', 'src', 'main');
  const resRoot = path.join(mainRoot, 'res');

  writeFile(path.join(resRoot, 'drawable', 'ic_quick_clip_tile.xml'), TILE_DRAWABLE);
  writeFile(path.join(resRoot, 'drawable', 'ic_quick_clip_shortcut.xml'), SHORTCUT_DRAWABLE);
  writeFile(
    path.join(resRoot, 'xml', 'shortcuts.xml'),
    SHORTCUTS_XML.split('__APP_ID__').join(appId),
  );

  const kotlinDir = path.join(mainRoot, 'java', ...appId.split('.'), 'quickclip');
  for (const [name, source] of Object.entries(renderQuickClipKotlinFiles(appId))) {
    writeFile(path.join(kotlinDir, name), source);
  }
}

function findByName(entries, name) {
  if (!Array.isArray(entries)) return undefined;
  return entries.find((entry) => {
    const current = entry && entry.$ && entry.$['android:name'];
    if (typeof current !== 'string' || !current) return false;
    return current === name || current.endsWith(name);
  });
}

function intentFilterSignature(filter) {
  const actions = (filter && filter.action ? filter.action : [])
    .map((entry) => entry && entry.$ && entry.$['android:name'])
    .filter(Boolean)
    .sort();
  const data = (filter && filter.data ? filter.data : [])
    .map((entry) => JSON.stringify((entry && entry.$) || {}))
    .sort();
  return `${actions.join('|')}::${data.join('|')}`;
}

function ensureIntentFilter(filters, filter) {
  const signature = intentFilterSignature(filter);
  if (!filters.some((item) => intentFilterSignature(item) === signature)) {
    filters.push(filter);
  }
}

function ensureMetaData(owner, name, attribute, value) {
  if (!Array.isArray(owner['meta-data'])) owner['meta-data'] = [];
  const existing = owner['meta-data'].find((entry) => entry && entry.$ && entry.$['android:name'] === name);
  if (existing) {
    existing.$ = { ...(existing.$ || {}), 'android:name': name, [attribute]: value };
    return existing;
  }
  const created = { $: { 'android:name': name, [attribute]: value } };
  owner['meta-data'].push(created);
  return created;
}

function buildActivityIntentFilters(appId) {
  return [
    {
      action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
      category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      data: [{ $: { 'android:mimeType': 'text/plain' } }],
    },
    {
      action: [{ $: { 'android:name': `${appId}.action.QUICK_CLIP_CLIPBOARD` } }],
      category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    },
    {
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.DEFAULT' } },
        { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
      ],
      data: [{ $: { 'android:scheme': 'jiancang-clip' } }],
    },
  ];
}

/** Mutates a manifest JSON object (expo modResults.manifest) in place. */
function ensureQuickClipManifest(manifest, appId) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  if (!Array.isArray(manifest.application) || !manifest.application[0]) return manifest;

  const application = manifest.application[0];
  if (!Array.isArray(application.activity)) application.activity = [];
  if (!Array.isArray(application.service)) application.service = [];

  const activityAttrs = {
    'android:name': ACTIVITY_NAME,
    'android:exported': 'true',
    'android:excludeFromRecents': 'true',
    'android:noHistory': 'true',
    'android:taskAffinity': '',
    'android:launchMode': 'singleInstance',
    'android:label': '剪藏',
    'android:icon': '@mipmap/ic_launcher',
    'android:theme': `@style/${STYLE_NAME}`,
  };

  let activity = findByName(application.activity, ACTIVITY_NAME);
  if (!activity) {
    activity = { $: { ...activityAttrs }, 'intent-filter': [] };
    application.activity.push(activity);
  } else {
    activity.$ = { ...(activity.$ || {}), ...activityAttrs };
    if (!Array.isArray(activity['intent-filter'])) activity['intent-filter'] = [];
  }
  for (const filter of buildActivityIntentFilters(appId)) {
    ensureIntentFilter(activity['intent-filter'], filter);
  }

  const serviceAttrs = {
    'android:name': SERVICE_NAME,
    'android:exported': 'true',
    'android:label': '@string/quick_clip_tile_label',
    'android:icon': '@drawable/ic_quick_clip_tile',
    'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
  };

  let service = findByName(application.service, SERVICE_NAME);
  if (!service) {
    service = { $: { ...serviceAttrs }, 'intent-filter': [], 'meta-data': [] };
    application.service.push(service);
  } else {
    service.$ = { ...(service.$ || {}), ...serviceAttrs };
    if (!Array.isArray(service['intent-filter'])) service['intent-filter'] = [];
  }
  ensureIntentFilter(service['intent-filter'], {
    action: [{ $: { 'android:name': QS_TILE_ACTION } }],
  });
  ensureMetaData(service, TOGGLEABLE_META, 'android:value', 'false');

  const mainActivity = findByName(application.activity, '.MainActivity');
  if (mainActivity) {
    ensureMetaData(mainActivity, SHORTCUTS_META, 'android:resource', '@xml/shortcuts');
  }

  return manifest;
}

/** Mutates parsed strings.xml JSON (expo modResults). */
function ensureQuickClipStrings(xml) {
  if (!xml || typeof xml !== 'object') return xml;
  if (!xml.resources || typeof xml.resources !== 'object') xml.resources = {};
  if (!Array.isArray(xml.resources.string)) xml.resources.string = [];

  for (const [name, value] of Object.entries(QUICK_CLIP_STRINGS)) {
    const existing = xml.resources.string.find((entry) => entry && entry.$ && entry.$.name === name);
    if (existing) existing._ = value;
    else xml.resources.string.push({ $: { name }, _: value });
  }
  return xml;
}

/** Mutates parsed styles.xml JSON (expo modResults). */
function ensureQuickClipStyles(xml) {
  if (!xml || typeof xml !== 'object') return xml;
  if (!xml.resources || typeof xml.resources !== 'object') xml.resources = {};
  if (!Array.isArray(xml.resources.style)) xml.resources.style = [];

  let style = xml.resources.style.find((entry) => entry && entry.$ && entry.$.name === STYLE_NAME);
  if (!style) {
    style = { $: { name: STYLE_NAME, parent: STYLE_PARENT }, item: [] };
    xml.resources.style.push(style);
  } else {
    style.$ = { ...(style.$ || {}), name: STYLE_NAME };
    if (!style.$.parent) style.$.parent = STYLE_PARENT;
    if (!Array.isArray(style.item)) style.item = [];
  }

  for (const [name, value] of Object.entries(QUICK_CLIP_STYLE_ITEMS)) {
    const existing = style.item.find((entry) => entry && entry.$ && entry.$.name === name);
    if (existing) existing._ = value;
    else style.item.push({ $: { name }, _: value });
  }
  return xml;
}

module.exports = function withQuickClip(config) {
  const appId = config.android && config.android.package;
  if (!appId) throw new Error('[withQuickClip] android.package is required');

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      writeQuickClipNativeFiles(cfg.modRequest.platformProjectRoot, appId);
      return cfg;
    },
  ]);

  config = withStringsXml(config, (cfg) => {
    ensureQuickClipStrings(cfg.modResults);
    return cfg;
  });

  config = withAndroidStyles(config, (cfg) => {
    ensureQuickClipStyles(cfg.modResults);
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    ensureQuickClipManifest(cfg.modResults.manifest, appId);
    return cfg;
  });

  return config;
};

module.exports.ACTIVITY_NAME = ACTIVITY_NAME;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.STYLE_NAME = STYLE_NAME;
module.exports.ensureQuickClipManifest = ensureQuickClipManifest;
module.exports.ensureQuickClipStrings = ensureQuickClipStrings;
module.exports.ensureQuickClipStyles = ensureQuickClipStyles;
module.exports.writeQuickClipNativeFiles = writeQuickClipNativeFiles;
module.exports.renderQuickClipKotlinFiles = renderQuickClipKotlinFiles;
