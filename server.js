require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createStore } = require('./src/store');
const { createSpotify } = require('./src/spotify');
const { createService } = require('./src/service');
const { httpsRequest } = require('./src/http');
const { buildView, message } = require('./src/view');
const { renderAll } = require('./src/markup');
const { managePage, errorPage } = require('./src/pages');
const { DEFAULT_SETTINGS, validateSettings } = require('./src/settings');

const PORT = Number(process.env.PORT) || 3004;
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CLIENT_ID = process.env.TRMNL_CLIENT_ID;
const CLIENT_SECRET = process.env.TRMNL_CLIENT_SECRET;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Current TRMNL docs (docs.trmnl.com, plugin installation flow) use this host for the token exchange.
const TRMNL_OAUTH_HOST = 'trmnl.com';
const MARKUP_BUDGET_MS = 7000; // TRMNL gives /markup about 10 s
const OAUTH_STATE_MAX_AGE = 30 * 60 * 1000;
const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const STATE_RE = /^([A-Za-z0-9-]{1,64}):([0-9a-f]{32})$/;

const uuidOf = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
const strOf = (v) => (typeof v === 'string' ? v : '');

// Express 4 does not catch rejected promises: route them to the error handler so no request hangs.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

// TRMNL metadata arrives either as nested form keys (trmnl[user][...]) or as one JSON string in the "trmnl" field.
function trmnlMeta(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.length < 50000) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not JSON: ignore */
    }
  }
  return {};
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// deps: { store, spotify, service, trmnlRequest, baseUrl, spotifyClientId, log }
function createApp({
  store,
  spotify,
  service,
  trmnlRequest = httpsRequest,
  baseUrl = BASE_URL,
  spotifyClientId = SPOTIFY_CLIENT_ID,
  log = console,
}) {
  const app = express();
  app.disable('x-powered-by');
  // TRMNL posts form-encoded bodies (nested trmnl[...] keys or a JSON string); JSON is accepted for local testing.
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.get(/^\/icon(-mono)?\.svg$/, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, `icon${req.params[0] || ''}.svg`));
  });

  // -------------------------------------------------------------------------
  // TRMNL installation
  // -------------------------------------------------------------------------

  async function exchangeTrmnlCode(code) {
    const postData = JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code' });
    const res = await trmnlRequest({
      hostname: TRMNL_OAUTH_HOST,
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, postData);
    if (res.statusCode !== 200 || !res.body || typeof res.body.access_token !== 'string') {
      throw new Error(`token exchange failed (HTTP ${res.statusCode})`);
    }
  }

  app.get('/install', ah(async (req, res) => {
    const code = strOf(req.query.code);
    const callback = strOf(req.query.installation_callback_url);
    if (!code || !callback) return res.status(400).json({ error: 'Missing code or installation_callback_url' });
    let url;
    try {
      url = new URL(callback);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:') return res.status(400).json({ error: 'Invalid installation_callback_url' });
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).json({ error: 'Plugin credentials not configured' });
    try {
      await exchangeTrmnlCode(code);
      log.log('Install: token exchange ok');
      res.redirect(302, url.toString());
    } catch (err) {
      log.error(`Install failed: ${err.message}`);
      res.status(500).json({ error: 'Installation failed' });
    }
  }));

  app.post('/webhooks/install-success', (req, res) => {
    const user = req.body && req.body.user;
    const uuid = uuidOf(user && user.uuid);
    if (!uuid) return res.status(400).json({ error: 'No user data' });
    const existing = store.get(uuid);
    const id = user.plugin_setting_id;
    // A repeated install keeps the Spotify link and settings.
    store.update(uuid, {
      plugin_setting_id: typeof id === 'number' || typeof id === 'string' ? id : existing?.plugin_setting_id ?? null,
      installed_at: existing?.installed_at || new Date().toISOString(),
      spotify: existing?.spotify || null,
      settings: existing?.settings || { ...DEFAULT_SETTINGS },
    });
    log.log(existing ? 'Install success (existing user)' : 'Install success');
    res.json({ success: true });
  });

  app.post('/webhooks/uninstall', (req, res) => {
    // TRMNL has sent {user: {uuid}}, {user_uuid} and {uuid} payloads
    const b = req.body || {};
    const uuid = uuidOf(b.user && b.user.uuid) || uuidOf(b.user_uuid) || uuidOf(b.uuid);
    if (uuid) {
      store.delete(uuid);
      service.forget(uuid);
    }
    log.log('Uninstall');
    res.json({ success: true });
  });

  // -------------------------------------------------------------------------
  // Spotify OAuth
  // -------------------------------------------------------------------------

  app.get('/spotify/authorize', (req, res) => {
    const uuid = uuidOf(req.query.uuid);
    if (!uuid) return res.status(400).type('html').send(errorPage('Missing or invalid uuid.'));
    if (!spotifyClientId) return res.status(500).type('html').send(errorPage('Spotify credentials not configured.'));
    if (!store.get(uuid)) return res.status(404).type('html').send(errorPage('Plugin connection not found. Please reinstall the plugin.'));

    const state = `${uuid}:${crypto.randomBytes(16).toString('hex')}`;
    store.update(uuid, { oauth_state: state, oauth_state_at: Date.now() });
    const params = new URLSearchParams({
      client_id: spotifyClientId,
      response_type: 'code',
      redirect_uri: `${baseUrl}/spotify/callback`,
      scope: 'user-read-currently-playing user-read-recently-played user-top-read',
      state,
      show_dialog: 'true',
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
  });

  app.get('/spotify/callback', ah(async (req, res) => {
    if (req.query.error) {
      log.log('Spotify authorization denied');
      return res.type('html').send(errorPage('Spotify authorization was denied or failed.'));
    }
    const code = strOf(req.query.code);
    const m = STATE_RE.exec(strOf(req.query.state));
    if (!code || !m) return res.status(400).type('html').send(errorPage('Missing or invalid authorization code or state.'));

    const uuid = m[1];
    const conn = store.get(uuid);
    if (!conn) return res.status(400).type('html').send(errorPage('Plugin connection not found. Please reinstall the plugin.'));
    const fresh = !Number.isFinite(conn.oauth_state_at) || Date.now() - conn.oauth_state_at < OAUTH_STATE_MAX_AGE;
    if (!conn.oauth_state || !safeEqual(conn.oauth_state, m[0]) || !fresh) {
      return res.status(400).type('html').send(errorPage('Invalid or expired state. Please try again.'));
    }
    store.update(uuid, { oauth_state: undefined, oauth_state_at: undefined });

    try {
      const t = await spotify.exchangeCode(code);
      store.update(uuid, {
        spotify: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, connected_at: new Date().toISOString() },
      });
      service.forget(uuid);
      log.log('Spotify connected');
      res.redirect(`/manage?uuid=${encodeURIComponent(uuid)}&spotify=connected`);
    } catch (err) {
      log.error(`Spotify code exchange failed: ${err.message}`);
      res.status(502).type('html').send(errorPage('Failed to connect Spotify. Please try again.'));
    }
  }));

  app.post('/spotify/disconnect', (req, res) => {
    const uuid = uuidOf(req.body && req.body.uuid);
    if (!uuid) return res.status(400).type('html').send(errorPage('Missing or invalid uuid.'));
    if (store.get(uuid)) {
      store.update(uuid, { spotify: null, oauth_state: undefined, oauth_state_at: undefined });
      service.forget(uuid);
    }
    res.redirect(`/manage?uuid=${encodeURIComponent(uuid)}&spotify=disconnected`);
  });

  // -------------------------------------------------------------------------
  // Settings page
  // -------------------------------------------------------------------------

  // TRMNL sends users to /webhooks/manage with uuid and jwt params
  app.get('/webhooks/manage', (req, res) => {
    const uuid = uuidOf(req.query.uuid);
    if (!uuid) return res.status(400).type('html').send(errorPage('Missing or invalid uuid.'));
    res.redirect(`/manage?uuid=${encodeURIComponent(uuid)}`);
  });

  app.get('/manage', (req, res) => {
    const uuid = uuidOf(req.query.uuid);
    if (!uuid) return res.status(400).type('html').send(errorPage('Missing or invalid uuid.'));
    const sp = strOf(req.query.spotify);
    const notice = req.query.saved === 'true' ? 'saved' : sp === 'connected' || sp === 'disconnected' ? sp : null;
    res.type('html').send(managePage(uuid, store.get(uuid), notice));
  });

  app.post('/manage/save', (req, res) => {
    const uuid = uuidOf(req.body && req.body.uuid);
    if (!uuid) return res.status(400).type('html').send(errorPage('Missing or invalid uuid.'));
    const conn = store.get(uuid);
    if (!conn) return res.status(404).type('html').send(errorPage('Plugin connection not found. Please reinstall the plugin.'));
    const r = validateSettings(req.body);
    if (!r.ok) return res.status(400).type('html').send(managePage(uuid, conn, { type: 'error', text: r.error }));
    store.update(uuid, { settings: { ...(conn.settings || {}), ...r.settings } });
    res.redirect(`/manage?uuid=${encodeURIComponent(uuid)}&saved=true`);
  });

  // -------------------------------------------------------------------------
  // Screen generation: always answers 200 with all four layouts.
  // -------------------------------------------------------------------------

  app.post('/markup', ah(async (req, res) => {
    const ctx = { baseUrl };
    let out;
    try {
      const trmnl = trmnlMeta(req.body && req.body.trmnl);
      const uuid = uuidOf(req.body && req.body.user_uuid) || uuidOf(trmnl.user && trmnl.user.uuid);
      const conn = uuid ? store.get(uuid) : null;
      let result;
      if (!conn) result = { status: 'not_connected', reason: 'none' };
      else {
        result = await withTimeout(service.getScreen(uuid), MARKUP_BUDGET_MS).catch((err) => {
          log.error(`Markup data: ${err.message}`);
          return service.cachedScreen(uuid) || { status: 'unavailable', reason: 'unavailable' };
        });
      }
      out = renderAll(buildView(result, conn && conn.settings), ctx);
    } catch (err) {
      log.error(`Markup failed: ${err.message}`);
      out = renderAll(message('error'), ctx);
    }
    res.json(out);
  }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), connections: store.size() });
  });

  // Last resort: generic answer, no details (bodies may hold tokens).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) log.error(`Unhandled error on ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return res.end();
    if (req.path === '/markup') return res.json(renderAll(message('error'), { baseUrl }));
    res.status(status).json({ error: status >= 500 ? 'Internal error' : 'Bad request' });
  });

  return app;
}

if (require.main === module) {
  const store = createStore();
  const spotify = createSpotify({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: `${BASE_URL}/spotify/callback`,
  });
  const service = createService({ store, spotify });
  createApp({ store, spotify, service }).listen(PORT, HOST, () => {
    console.log(`TRMNL Spotify plugin on http://${HOST}:${PORT}, public URL ${BASE_URL}`);
  });
}

module.exports = { createApp, trmnlMeta, UUID_RE };
