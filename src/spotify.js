// Spotify Web API: token endpoints, data endpoints and pure parsers for their responses.

const { httpsRequest } = require('./http');
const { TIME_RANGES } = require('./settings');

const LIST_LIMIT = 10;

// kind: 'auth' (token revoked/invalid: the user must reconnect), 'rate_limited', 'unavailable' (network, 5xx, odd
// responses). Messages hold only a status and Spotify's short error code, never a body.
class SpotifyError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const str = (v) => (typeof v === 'string' ? v : '');
const artistNames = (artists) => (Array.isArray(artists) ? artists.map((a) => str(a && a.name)).filter(Boolean).join(', ') : '');
const shortCode = (body) => (body && typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? ` ${body.error}` : '');

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

function parseTrack(t) {
  if (!t || typeof t !== 'object') return null;
  return { track: str(t.name), artist: artistNames(t.artists), album: str(t.album && t.album.name) };
}

// null when nothing is playing (204, no item, or an ad/podcast without track data).
function parseCurrentlyPlaying(body) {
  if (!body || typeof body !== 'object' || !body.item || typeof body.item !== 'object') return null;
  const item = body.item;
  // Podcast episodes carry the show instead of artists.
  const artist = artistNames(item.artists) || str(item.show && item.show.name);
  const duration = Number.isFinite(item.duration_ms) ? item.duration_ms : 0;
  const progress = Number.isFinite(body.progress_ms) ? Math.max(0, Math.min(body.progress_ms, duration || body.progress_ms)) : 0;
  return {
    is_playing: body.is_playing === true,
    track: str(item.name),
    artist,
    album: str(item.album && item.album.name),
    duration_ms: duration,
    progress_ms: progress,
  };
}

function parseRecentlyPlayed(body) {
  const items = body && Array.isArray(body.items) ? body.items : [];
  return items
    .map((it) => {
      const t = parseTrack(it && it.track);
      return t && t.track ? { ...t, played_at: str(it.played_at) } : null;
    })
    .filter(Boolean);
}

function parseTopTracks(body) {
  const items = body && Array.isArray(body.items) ? body.items : [];
  return items.map(parseTrack).filter((t) => t && t.track).map((t, i) => ({ rank: i + 1, ...t }));
}

function parseTopArtists(body) {
  const items = body && Array.isArray(body.items) ? body.items : [];
  return items
    .filter((a) => a && typeof a === 'object' && str(a.name))
    .map((a, i) => ({
      rank: i + 1,
      name: str(a.name),
      genres: Array.isArray(a.genres) ? a.genres.filter((g) => typeof g === 'string').slice(0, 2).join(', ') : '',
    }));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// request: (options, postData) => Promise<{ statusCode, body }>; injectable for tests.
function createSpotify({ clientId, clientSecret, redirectUri, request = httpsRequest } = {}) {
  async function tokenRequest(params) {
    const postData = new URLSearchParams(params).toString();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    let res;
    try {
      res = await request({
        hostname: 'accounts.spotify.com',
        port: 443,
        path: '/api/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
          'Content-Length': Buffer.byteLength(postData),
        },
      }, postData);
    } catch (err) {
      throw new SpotifyError('unavailable', `token request failed: ${err.message}`);
    }
    const body = res.body && typeof res.body === 'object' ? res.body : {};
    if (res.statusCode === 200 && typeof body.access_token === 'string') {
      const expiresIn = Number.isFinite(body.expires_in) ? body.expires_in : 3600;
      return {
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : null,
        expires_at: Date.now() + expiresIn * 1000,
      };
    }
    const msg = `token request failed (HTTP ${res.statusCode}${shortCode(body)})`;
    // invalid_grant: the refresh token was revoked or expired. Anything else is on Spotify's or our side.
    if (res.statusCode === 400 && body.error === 'invalid_grant') throw new SpotifyError('auth', msg, res.statusCode);
    if (res.statusCode === 429) throw new SpotifyError('rate_limited', msg, res.statusCode);
    throw new SpotifyError('unavailable', msg, res.statusCode);
  }

  function exchangeCode(code) {
    return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  async function refresh(refreshToken) {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { ...t, refresh_token: t.refresh_token || refreshToken };
  }

  // Returns the parsed body (null for 204). Throws SpotifyError; kind 'auth' for 401.
  async function get(accessToken, path) {
    let res;
    try {
      res = await request({
        hostname: 'api.spotify.com',
        port: 443,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
    } catch (err) {
      throw new SpotifyError('unavailable', `api request failed: ${err.message}`);
    }
    const s = res.statusCode;
    if (s === 204) return null;
    if (s === 200) {
      if (res.body && typeof res.body === 'object') return res.body;
      // currently-playing occasionally answers 200 with an empty body
      if (res.body === null || res.body === '') return null;
      throw new SpotifyError('unavailable', 'api returned a non-JSON body', s);
    }
    if (s === 401) throw new SpotifyError('auth', 'api rejected the access token (HTTP 401)', s);
    if (s === 429) throw new SpotifyError('rate_limited', 'api rate limited (HTTP 429)', s);
    throw new SpotifyError('unavailable', `api request failed (HTTP ${s})`, s);
  }

  const range = (r) => (TIME_RANGES.includes(r) ? r : 'short_term');

  return {
    exchangeCode,
    refresh,
    currentlyPlaying: async (t) => parseCurrentlyPlaying(await get(t, '/v1/me/player/currently-playing')),
    recentlyPlayed: async (t) => parseRecentlyPlayed(await get(t, `/v1/me/player/recently-played?limit=${LIST_LIMIT}`)),
    topTracks: async (t, r) => parseTopTracks(await get(t, `/v1/me/top/tracks?time_range=${range(r)}&limit=${LIST_LIMIT}`)),
    topArtists: async (t, r) => parseTopArtists(await get(t, `/v1/me/top/artists?time_range=${range(r)}&limit=${LIST_LIMIT}`)),
  };
}

module.exports = {
  SpotifyError,
  createSpotify,
  parseCurrentlyPlaying,
  parseRecentlyPlayed,
  parseTopTracks,
  parseTopArtists,
  LIST_LIMIT,
};
