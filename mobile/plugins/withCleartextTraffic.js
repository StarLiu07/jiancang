const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Sets android:usesCleartextTraffic="true" on <application> so the app can talk
 * to plain HTTP backends on the LAN / Tailscale without HTTPS termination.
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return cfg;
  });
};
