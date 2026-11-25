/**
 * Runtime configuration for v2 Frontend.
 * Defaults to the live Cloudflare Worker API for both local static server
 * testing and GitHub Pages. Pass ?localApi=1 in URL to test against local wrangler dev.
 */
const USE_LOCAL_API = new URLSearchParams(window.location.search).has('localApi');

window.APP_CONFIG = {
  API_BASE_URL: USE_LOCAL_API
    ? 'http://127.0.0.1:8787'
    : 'https://easter-scavenger-hunt-api.friendlyfeud.workers.dev',

  // Leave empty when assets/ is served alongside index.html (local symlink or GitHub Pages root).
  ASSET_BASE_URL: ''
};

