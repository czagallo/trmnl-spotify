// Turns a user's stored connection into screen data, with token refresh and caching.
//
// getScreen(uuid) resolves (never rejects) to one of:
//   { status: 'ok', mode, data, fetchedAt, stale }      data fresh from Spotify, or stale cache while Spotify is down
//   { status: 'not_connected', reason: 'none'|'reauth' } no Spotify account linked, or its access was revoked
//   { status: 'unavailable', reason: 'rate_limited'|'unavailable' }  Spotify unreachable and nothing cached
// Empty lists are a successful 'ok' result: the account genuinely has no data.

const { SpotifyError } = require('./spotify');
const { normalizeSettings } = require('./settings');

const REFRESH_MARGIN = 5 * 60 * 1000;

function createService({
  store,
  spotify,
  now = Date.now,
  ttlMs = 60 * 1000,
  staleMs = 24 * 60 * 60 * 1000,
  maxEntries = 2000,
  log = console,
}) {
  const cache = new Map(); // key -> { data, at }, oldest first
  const refreshing = new Map(); // uuid -> Promise<access token>
  const fetching = new Map(); // cache key -> Promise<data>

  function remember(key, data) {
    cache.delete(key);
    cache.set(key, { data, at: now() });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  function forget(uuid) {
    for (const key of cache.keys()) if (key.startsWith(`${uuid}|`)) cache.delete(key);
  }

  // One refresh per user at a time; concurrent callers share it.
  function refreshToken(uuid) {
    if (refreshing.has(uuid)) return refreshing.get(uuid);
    const p = (async () => {
      const conn = store.get(uuid);
      const sp = conn && conn.spotify;
      if (!sp || !sp.refresh_token) throw new SpotifyError('auth', 'no refresh token');
      const t = await spotify.refresh(sp.refresh_token);
      // The user may have disconnected while the refresh ran: do not bring the tokens back.
      const latest = store.get(uuid);
      if (!latest || !latest.spotify) throw new SpotifyError('auth', 'disconnected during refresh');
      store.update(uuid, {
        spotify: { ...latest.spotify, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at },
      });
      return t.access_token;
    })().finally(() => refreshing.delete(uuid));
    refreshing.set(uuid, p);
    return p;
  }

  async function accessToken(uuid) {
    const sp = store.get(uuid)?.spotify;
    if (sp && sp.access_token && Number.isFinite(sp.expires_at) && sp.expires_at - REFRESH_MARGIN > now()) return sp.access_token;
    return refreshToken(uuid);
  }

  // Run fn(token); on a 401 refresh once and retry.
  async function withToken(uuid, fn) {
    const token = await accessToken(uuid);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof SpotifyError) || err.kind !== 'auth') throw err;
      return fn(await refreshToken(uuid));
    }
  }

  async function fetchMode(uuid, mode, timeRange) {
    switch (mode) {
      case 'top_tracks':
        return { mode, tracks: await withToken(uuid, (t) => spotify.topTracks(t, timeRange)) };
      case 'top_artists':
        return { mode, artists: await withToken(uuid, (t) => spotify.topArtists(t, timeRange)) };
      case 'recently_played':
        return { mode, tracks: await withToken(uuid, (t) => spotify.recentlyPlayed(t)) };
      default: {
        const current = await withToken(uuid, (t) => spotify.currentlyPlaying(t));
        if (current) return { mode: 'now_playing', current };
        // Nothing playing: show what was played last.
        return { mode: 'now_playing', current: null, tracks: await withToken(uuid, (t) => spotify.recentlyPlayed(t)) };
      }
    }
  }

  async function getScreen(uuid) {
    const conn = store.get(uuid);
    if (!conn || !conn.spotify || !(conn.spotify.refresh_token || conn.spotify.access_token)) {
      return { status: 'not_connected', reason: 'none' };
    }
    const { displayMode, timeRange } = normalizeSettings(conn.settings);
    const key = `${uuid}|${displayMode}|${timeRange}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) return { status: 'ok', mode: displayMode, data: cached.data, fetchedAt: cached.at, stale: false };

    try {
      let p = fetching.get(key);
      if (!p) {
        p = fetchMode(uuid, displayMode, timeRange).finally(() => fetching.delete(key));
        fetching.set(key, p);
      }
      const data = await p;
      remember(key, data);
      return { status: 'ok', mode: displayMode, data, fetchedAt: now(), stale: false };
    } catch (err) {
      const kind = err instanceof SpotifyError ? err.kind : 'unavailable';
      log.error(`Spotify ${displayMode} failed: ${err.message}`);
      if (kind === 'auth') return { status: 'not_connected', reason: 'reauth' };
      if (cached && now() - cached.at < staleMs) return { status: 'ok', mode: displayMode, data: cached.data, fetchedAt: cached.at, stale: true };
      return { status: 'unavailable', reason: kind === 'rate_limited' ? 'rate_limited' : 'unavailable' };
    }
  }

  // Whatever is cached for the user's current settings, without touching Spotify (used when /markup runs out of
  // time). null when there is nothing usable.
  function cachedScreen(uuid) {
    const conn = store.get(uuid);
    if (!conn || !conn.spotify) return null;
    const { displayMode, timeRange } = normalizeSettings(conn.settings);
    const c = cache.get(`${uuid}|${displayMode}|${timeRange}`);
    if (!c || now() - c.at >= staleMs) return null;
    return { status: 'ok', mode: displayMode, data: c.data, fetchedAt: c.at, stale: now() - c.at >= ttlMs };
  }

  return { getScreen, cachedScreen, forget, cacheSize: () => cache.size };
}

module.exports = { createService };
