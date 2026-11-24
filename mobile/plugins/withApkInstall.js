const { withAndroidManifest } = require('expo/config-plugins');

const INSTALL_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';

/**
 * Adds REQUEST_INSTALL_PACKAGES so the app can hand a downloaded APK to the
 * Android system installer. Kept idempotent for prebuild re-runs.
 */
function ensureInstallPermission(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  if (!Array.isArray(manifest['uses-permission'])) {
    manifest['uses-permission'] = [];
  }

  const alreadyDeclared = manifest['uses-permission'].some(
    (entry) => entry && entry.$ && entry.$['android:name'] === INSTALL_PERMISSION,
  );

  if (!alreadyDeclared) {
    manifest['uses-permission'].push({
      $: { 'android:name': INSTALL_PERMISSION },
    });
  }

  return manifest;
}

module.exports = function withApkInstall(config) {
  return withAndroidManifest(config, (cfg) => {
    ensureInstallPermission(cfg.modResults.manifest);
    return cfg;
  });
};

// Exposed for a dependency-free smoke test of the manifest mutation.
module.exports.INSTALL_PERMISSION = INSTALL_PERMISSION;
module.exports.ensureInstallPermission = ensureInstallPermission;
