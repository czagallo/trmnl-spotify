require('dotenv').config();
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3004;

// Load environment variables
const CLIENT_ID = process.env.TRMNL_CLIENT_ID;
const CLIENT_SECRET = process.env.TRMNL_CLIENT_SECRET;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// In-memory storage for plugin connections
// In production, use a database (PostgreSQL, MongoDB, etc.)
const pluginConnections = new Map();

// Cache for Spotify API responses (avoid hitting rate limits)
const spotifyCache = new Map();
const CACHE_DURATION = 60 * 1000; // 60 seconds

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// SPOTIFY API FUNCTIONS
// ============================================================================

// Make an HTTPS request and return parsed JSON
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (error) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (error) => { reject(error); });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Exchange Spotify authorization code for tokens
async function exchangeSpotifyCode(code) {
  const postData = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: `${BASE_URL}/spotify/callback`
  }).toString();

  const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const response = await httpsRequest({
    hostname: 'accounts.spotify.com',
    port: 443,
    path: '/api/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (response.body.access_token) {
    return {
      access_token: response.body.access_token,
      refresh_token: response.body.refresh_token,
      expires_in: response.body.expires_in,
      expires_at: Date.now() + (response.body.expires_in * 1000)
    };
  }

  throw new Error(`Spotify token exchange failed: ${JSON.stringify(response.body)}`);
}

// Refresh Spotify access token
async function refreshSpotifyToken(refreshToken) {
  const postData = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const response = await httpsRequest({
    hostname: 'accounts.spotify.com',
    port: 443,
    path: '/api/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (response.body.access_token) {
    return {
      access_token: response.body.access_token,
      refresh_token: response.body.refresh_token || refreshToken,
      expires_in: response.body.expires_in,
      expires_at: Date.now() + (response.body.expires_in * 1000)
    };
  }

  throw new Error(`Spotify token refresh failed: ${JSON.stringify(response.body)}`);
}

// Get a valid Spotify access token for a user (auto-refresh if expired)
async function getValidSpotifyToken(uuid) {
  const connection = pluginConnections.get(uuid);
  if (!connection || !connection.spotify) {
    return null;
  }

  const spotify = connection.spotify;

  // Refresh if token expires within the next 5 minutes
  if (spotify.expires_at && (Date.now() + 300000) > spotify.expires_at) {
    try {
      console.log(`Refreshing Spotify token for user ${uuid}`);
      const tokens = await refreshSpotifyToken(spotify.refresh_token);
      connection.spotify = {
        ...connection.spotify,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at
      };
      pluginConnections.set(uuid, connection);
    } catch (error) {
      console.error(`Failed to refresh Spotify token for ${uuid}:`, error.message);
      return null;
    }
  }

  return connection.spotify.access_token;
}

// Call a Spotify API endpoint
async function spotifyApiCall(accessToken, path) {
  const response = await httpsRequest({
    hostname: 'api.spotify.com',
    port: 443,
    path: path,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  return response;
}

// Get the user's currently playing track
async function getCurrentlyPlaying(accessToken) {
  const response = await spotifyApiCall(accessToken, '/v1/me/player/currently-playing');

  // 204 = nothing playing, 200 = something playing
  if (response.statusCode === 204 || !response.body || !response.body.item) {
    return null;
  }

  const item = response.body.item;
  return {
    is_playing: response.body.is_playing,
    track: item.name,
    artist: item.artists.map(a => a.name).join(', '),
    album: item.album ? item.album.name : '',
    duration_ms: item.duration_ms,
    progress_ms: response.body.progress_ms || 0,
    album_art_url: item.album && item.album.images && item.album.images[0]
      ? item.album.images[0].url
      : null
  };
}

// Get the user's recently played tracks
async function getRecentlyPlayed(accessToken, limit) {
  const response = await spotifyApiCall(accessToken, `/v1/me/player/recently-played?limit=${limit}`);

  if (response.statusCode !== 200 || !response.body.items) {
    return [];
  }

  return response.body.items.map(item => ({
    track: item.track.name,
    artist: item.track.artists.map(a => a.name).join(', '),
    album: item.track.album ? item.track.album.name : '',
    played_at: item.played_at
  }));
}

// Get the user's top tracks
async function getTopTracks(accessToken, timeRange, limit) {
  const response = await spotifyApiCall(
    accessToken,
    `/v1/me/top/tracks?time_range=${timeRange}&limit=${limit}`
  );

  if (response.statusCode !== 200 || !response.body.items) {
    return [];
  }

  return response.body.items.map((item, index) => ({
    rank: index + 1,
    track: item.name,
    artist: item.artists.map(a => a.name).join(', '),
    album: item.album ? item.album.name : ''
  }));
}

// Get the user's top artists
async function getTopArtists(accessToken, timeRange, limit) {
  const response = await spotifyApiCall(
    accessToken,
    `/v1/me/top/artists?time_range=${timeRange}&limit=${limit}`
  );

  if (response.statusCode !== 200 || !response.body.items) {
    return [];
  }

  return response.body.items.map((item, index) => ({
    rank: index + 1,
    name: item.name,
    genres: item.genres ? item.genres.slice(0, 2).join(', ') : ''
  }));
}

// Get Spotify data for a user with caching
async function getSpotifyData(uuid, displayMode) {
  const now = Date.now();
  const cacheKey = `${uuid}_${displayMode}`;

  // Return cached data if still valid
  const cached = spotifyCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.data;
  }

  const accessToken = await getValidSpotifyToken(uuid);
  if (!accessToken) {
    return { error: 'not_connected' };
  }

  const connection = pluginConnections.get(uuid);
  const timeRange = connection?.settings?.timeRange || 'short_term';

  try {
    let data;

    switch (displayMode) {
      case 'top_tracks':
        data = {
          mode: 'top_tracks',
          tracks: await getTopTracks(accessToken, timeRange, 5)
        };
        break;

      case 'top_artists':
        data = {
          mode: 'top_artists',
          artists: await getTopArtists(accessToken, timeRange, 5)
        };
        break;

      case 'recently_played':
        data = {
          mode: 'recently_played',
          tracks: await getRecentlyPlayed(accessToken, 5)
        };
        break;

      case 'now_playing':
      default: {
        const current = await getCurrentlyPlaying(accessToken);
        if (current) {
          data = { mode: 'now_playing', ...current };
        } else {
          // Fall back to recently played when nothing is active
          const recent = await getRecentlyPlayed(accessToken, 5);
          data = { mode: 'recently_played', tracks: recent, fallback: true };
        }
        break;
      }
    }

    spotifyCache.set(cacheKey, { data, timestamp: now });
    return data;

  } catch (error) {
    console.error(`Spotify API error for ${uuid}:`, error.message);
    // Return stale cache if available
    if (cached) {
      return cached.data;
    }
    return { error: 'api_error' };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Truncate a string with ellipsis
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 1) + '...' : str;
}

// Format milliseconds as m:ss
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Format a relative time string (e.g. "3 min ago")
function timeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Get human label for Spotify time range
function timeRangeLabel(timeRange) {
  switch (timeRange) {
    case 'short_term': return 'Last 4 Weeks';
    case 'medium_term': return 'Last 6 Months';
    case 'long_term': return 'All Time';
    default: return 'Last 4 Weeks';
  }
}

// Generate a simple music note SVG icon
function musicNoteSvg(size) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="18" cy="52" rx="10" ry="8" fill="black"/>
      <rect x="26" y="10" width="4" height="44" fill="black"/>
      <path d="M30 10 L58 4 L58 18 L30 24 Z" fill="black"/>
    </svg>
  `.trim();
}

// Generate a small play/pause indicator
function playStatusSvg(isPlaying, size) {
  if (isPlaying) {
    // Equalizer bars
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="8" width="4" height="16" rx="1" fill="black"/>
        <rect x="10" y="4" width="4" height="20" rx="1" fill="black"/>
        <rect x="18" y="10" width="4" height="14" rx="1" fill="black"/>
      </svg>
    `.trim();
  }

  // Paused icon
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="6" height="16" rx="1" fill="black"/>
      <rect x="14" y="4" width="6" height="16" rx="1" fill="black"/>
    </svg>
  `.trim();
}

// ============================================================================
// TRMNL INSTALLATION FLOW
// ============================================================================

// Step 1: Installation URL - TRMNL sends code and callback URL
app.get('/install', async (req, res) => {
  console.log('Install request received');

  const { code, installation_callback_url } = req.query;

  if (!code || !installation_callback_url) {
    return res.status(400).json({ error: 'Missing code or installation_callback_url' });
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'Plugin credentials not configured' });
  }

  try {
    console.log('Exchanging authorization code for access token...');
    await exchangeTrmnlCode(code);
    console.log('Redirecting to TRMNL...');
    res.redirect(302, installation_callback_url);
  } catch (error) {
    console.error('Installation error:', error.message);
    res.status(500).json({ error: 'Installation failed', details: error.message });
  }
});

// Exchange TRMNL authorization code for access_token
function exchangeTrmnlCode(code) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code'
    });

    const req = https.request({
      hostname: 'trmnl.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          console.log('TRMNL OAuth response status:', res.statusCode);
          console.log('TRMNL OAuth response body:', data);
          const response = JSON.parse(data);
          if (response.access_token) {
            resolve(response.access_token);
          } else {
            reject(new Error(`No access_token in response: ${data}`));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Installation success webhook
app.post('/webhooks/install-success', (req, res) => {
  console.log('Install success webhook received');

  const user = req.body.user;
  if (!user) {
    return res.status(400).json({ error: 'No user data' });
  }

  const user_uuid = user.uuid;
  const plugin_setting_id = user.plugin_setting_id;
  const access_token = req.headers.authorization?.replace('Bearer ', '');

  console.log('Installation successful for user:', user_uuid);

  pluginConnections.set(user_uuid, {
    plugin_setting_id,
    access_token,
    installed_at: new Date().toISOString(),
    user_data: user,
    spotify: null,
    settings: {
      displayMode: 'now_playing',
      timeRange: 'short_term'
    }
  });

  res.status(200).json({ success: true });
});

// Uninstallation webhook
app.post('/webhooks/uninstall', (req, res) => {
  const user_uuid = req.body.user?.uuid || req.body.uuid;
  console.log('Uninstalling plugin for user:', user_uuid);

  if (user_uuid) {
    pluginConnections.delete(user_uuid);
    // Also clear any cached data
    for (const key of spotifyCache.keys()) {
      if (key.startsWith(user_uuid)) {
        spotifyCache.delete(key);
      }
    }
  }

  res.status(200).json({ success: true });
});

// ============================================================================
// SPOTIFY OAUTH2 FLOW
// ============================================================================

// Redirect user to Spotify authorization
app.get('/spotify/authorize', (req, res) => {
  const { uuid } = req.query;

  if (!uuid) {
    return res.status(400).send('Missing uuid parameter');
  }

  if (!SPOTIFY_CLIENT_ID) {
    return res.status(500).send('Spotify credentials not configured');
  }

  // Generate state parameter to prevent CSRF
  const state = `${uuid}:${crypto.randomBytes(16).toString('hex')}`;

  // Store state temporarily so we can validate on callback
  const connection = pluginConnections.get(uuid);
  if (connection) {
    connection.oauth_state = state;
    pluginConnections.set(uuid, connection);
  }

  const scopes = 'user-read-currently-playing user-read-recently-played user-top-read';
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${BASE_URL}/spotify/callback`,
    scope: scopes,
    state: state,
    show_dialog: 'true'
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Spotify OAuth2 callback
app.get('/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Spotify auth error:', error);
    return res.send(renderErrorPage('Spotify authorization was denied or failed.'));
  }

  if (!code || !state) {
    return res.status(400).send(renderErrorPage('Missing authorization code or state.'));
  }

  // Extract UUID from state
  const uuid = state.split(':')[0];
  const connection = pluginConnections.get(uuid);

  if (!connection) {
    return res.status(400).send(renderErrorPage('Plugin connection not found. Please reinstall the plugin.'));
  }

  // Validate state matches
  if (connection.oauth_state !== state) {
    return res.status(400).send(renderErrorPage('Invalid state parameter. Please try again.'));
  }

  // Clear the state
  delete connection.oauth_state;

  try {
    console.log('Exchanging Spotify code for tokens...');
    const tokens = await exchangeSpotifyCode(code);

    connection.spotify = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      connected_at: new Date().toISOString()
    };

    pluginConnections.set(uuid, connection);
    console.log('Spotify connected successfully for user:', uuid);

    // Redirect back to manage page with success
    res.redirect(`/manage?uuid=${uuid}&spotify=connected`);
  } catch (error) {
    console.error('Spotify token exchange error:', error.message);
    res.send(renderErrorPage('Failed to connect Spotify. Please try again.'));
  }
});

// Disconnect Spotify
app.post('/spotify/disconnect', (req, res) => {
  const { uuid } = req.body;

  if (!uuid) {
    return res.status(400).json({ error: 'Missing uuid' });
  }

  const connection = pluginConnections.get(uuid);
  if (connection) {
    connection.spotify = null;
    pluginConnections.set(uuid, connection);

    // Clear cached data
    for (const key of spotifyCache.keys()) {
      if (key.startsWith(uuid)) {
        spotifyCache.delete(key);
      }
    }
  }

  res.redirect(`/manage?uuid=${uuid}&spotify=disconnected`);
});

// ============================================================================
// MANAGE PAGE
// ============================================================================

function renderErrorPage(message) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Spotify Plugin - Error</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 600px; margin: 50px auto; padding: 20px; background: #f5f5f5;
        }
        .card { background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
        .error { background: #FEE2E2; color: #991B1B; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Spotify Plugin</h1>
        <div class="error">${message}</div>
        <p>Please return to TRMNL and try again.</p>
      </div>
    </body>
    </html>
  `;
}

// TRMNL sends users to /webhooks/manage with uuid and jwt params
app.get('/webhooks/manage', (req, res) => {
  res.redirect(`/manage?${new URLSearchParams(req.query).toString()}`);
});

app.get('/manage', (req, res) => {
  const { uuid } = req.query;

  if (!uuid) {
    return res.status(400).send('Missing uuid parameter');
  }

  const connection = pluginConnections.get(uuid);
  const isSpotifyConnected = !!(connection?.spotify?.access_token);
  const currentMode = connection?.settings?.displayMode || 'now_playing';
  const currentTimeRange = connection?.settings?.timeRange || 'short_term';
  const spotifyStatus = req.query.spotify;
  const saved = req.query.saved === 'true';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Spotify Plugin Settings</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 600px; margin: 50px auto; padding: 20px; background: #f5f5f5;
        }
        .card { background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-top: 0; }
        h2 { color: #333; margin-top: 30px; font-size: 20px; }
        p { color: #666; line-height: 1.6; }
        label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
        select {
          width: 100%; padding: 10px; border: 1px solid #ddd;
          border-radius: 4px; font-size: 16px; margin-bottom: 15px;
        }
        .btn {
          display: inline-block; padding: 12px 24px; color: white;
          text-decoration: none; border-radius: 6px; border: none;
          cursor: pointer; font-size: 16px; margin-right: 10px;
        }
        .btn-spotify { background: #1DB954; }
        .btn-spotify:hover { background: #1AA34A; }
        .btn-save { background: #1DB954; }
        .btn-save:hover { background: #1AA34A; }
        .btn-secondary { background: #6B7280; }
        .btn-secondary:hover { background: #4B5563; }
        .btn-danger { background: #DC2626; font-size: 14px; padding: 8px 16px; }
        .btn-danger:hover { background: #B91C1C; }
        .success { background: #D1FAE5; color: #065F46; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
        .warning { background: #FEF3C7; color: #92400E; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
        .info { background: #EFF6FF; color: #1E40AF; padding: 12px; border-radius: 6px; margin-bottom: 20px; }
        .status { display: flex; align-items: center; gap: 8px; margin: 15px 0; }
        .status-dot { width: 10px; height: 10px; border-radius: 50%; }
        .status-dot.connected { background: #1DB954; }
        .status-dot.disconnected { background: #DC2626; }
        .desc { font-size: 14px; color: #666; margin-top: 4px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Spotify Now Playing</h1>

        ${saved ? '<div class="success">Settings saved successfully.</div>' : ''}
        ${spotifyStatus === 'connected' ? '<div class="success">Spotify connected successfully.</div>' : ''}
        ${spotifyStatus === 'disconnected' ? '<div class="warning">Spotify has been disconnected.</div>' : ''}

        <h2>Spotify Account</h2>

        <div class="status">
          <span class="status-dot ${isSpotifyConnected ? 'connected' : 'disconnected'}"></span>
          <span style="font-weight: 500;">${isSpotifyConnected ? 'Connected' : 'Not connected'}</span>
        </div>

        ${isSpotifyConnected ? `
          <p>Your Spotify account is linked. The plugin will display your listening data.</p>
          <form method="POST" action="/spotify/disconnect" style="margin-top: 10px;">
            <input type="hidden" name="uuid" value="${uuid}">
            <button type="submit" class="btn btn-danger">Disconnect Spotify</button>
          </form>
        ` : `
          <p>Connect your Spotify account to display your listening activity on TRMNL.</p>
          <a href="/spotify/authorize?uuid=${uuid}" class="btn btn-spotify">Connect Spotify</a>
        `}

        ${isSpotifyConnected ? `
          <h2>Display Settings</h2>
          <form method="POST" action="/manage/save">
            <input type="hidden" name="uuid" value="${uuid}">

            <label for="displayMode">Display Mode:</label>
            <select name="displayMode" id="displayMode">
              <option value="now_playing" ${currentMode === 'now_playing' ? 'selected' : ''}>Now Playing</option>
              <option value="recently_played" ${currentMode === 'recently_played' ? 'selected' : ''}>Recently Played</option>
              <option value="top_tracks" ${currentMode === 'top_tracks' ? 'selected' : ''}>Top Tracks</option>
              <option value="top_artists" ${currentMode === 'top_artists' ? 'selected' : ''}>Top Artists</option>
            </select>
            <div class="desc">
              <strong>Now Playing</strong> shows your current track (falls back to recently played).<br>
              <strong>Recently Played</strong> shows your last 5 tracks.<br>
              <strong>Top Tracks / Artists</strong> shows your most listened content.
            </div>

            <label for="timeRange">Top Content Time Range:</label>
            <select name="timeRange" id="timeRange">
              <option value="short_term" ${currentTimeRange === 'short_term' ? 'selected' : ''}>Last 4 Weeks</option>
              <option value="medium_term" ${currentTimeRange === 'medium_term' ? 'selected' : ''}>Last 6 Months</option>
              <option value="long_term" ${currentTimeRange === 'long_term' ? 'selected' : ''}>All Time</option>
            </select>
            <div class="desc">Applies to Top Tracks and Top Artists modes.</div>

            <div style="margin-top: 25px;">
              <button type="submit" class="btn btn-save">Save Settings</button>
              ${connection && connection.plugin_setting_id ?
                `<a href="https://trmnl.com/plugin_settings/${connection.plugin_setting_id}/edit?force_refresh=true" class="btn btn-secondary">Back to TRMNL</a>` :
                `<a href="https://trmnl.com" class="btn btn-secondary">Back to TRMNL</a>`
              }
            </div>
          </form>
        ` : `
          <div style="margin-top: 25px;">
            ${connection && connection.plugin_setting_id ?
              `<a href="https://trmnl.com/plugin_settings/${connection.plugin_setting_id}/edit?force_refresh=true" class="btn btn-secondary">Back to TRMNL</a>` :
              `<a href="https://trmnl.com" class="btn btn-secondary">Back to TRMNL</a>`
            }
          </div>
        `}
      </div>
    </body>
    </html>
  `);
});

// Save settings
app.post('/manage/save', (req, res) => {
  const { uuid, displayMode, timeRange } = req.body;

  if (!uuid) {
    return res.status(400).send('Missing uuid parameter');
  }

  const connection = pluginConnections.get(uuid);
  if (connection) {
    connection.settings = {
      ...connection.settings,
      displayMode: displayMode || 'now_playing',
      timeRange: timeRange || 'short_term'
    };
    pluginConnections.set(uuid, connection);
  }

  res.redirect(`/manage?uuid=${uuid}&saved=true`);
});

// ============================================================================
// MARKUP GENERATION
// ============================================================================

app.post('/markup', async (req, res) => {
  const { user_uuid } = req.body;

  try {
    const connection = pluginConnections.get(user_uuid);
    const displayMode = connection?.settings?.displayMode || 'now_playing';
    const data = await getSpotifyData(user_uuid, displayMode);

    const response = {
      markup: generateFullMarkup(data, connection),
      markup_half_vertical: generateHalfVerticalMarkup(data, connection),
      markup_half_horizontal: generateHalfHorizontalMarkup(data, connection),
      markup_quadrant: generateQuadrantMarkup(data, connection),
      shared: ""
    };

    res.json(response);
  } catch (error) {
    console.error('Error generating markup:', error);
    res.status(500).json({ error: 'Failed to generate markup' });
  }
});

// --- Full layout (800x480) ---
function generateFullMarkup(data, connection) {
  if (data.error === 'not_connected') {
    return renderConnectPrompt('full');
  }

  if (data.error === 'api_error') {
    return renderError('full', 'Unable to reach Spotify. Please try again later.');
  }

  if (data.mode === 'now_playing') {
    return renderNowPlayingFull(data);
  }

  if (data.mode === 'recently_played') {
    return renderRecentlyPlayedFull(data);
  }

  if (data.mode === 'top_tracks') {
    return renderTopTracksFull(data, connection);
  }

  if (data.mode === 'top_artists') {
    return renderTopArtistsFull(data, connection);
  }

  return renderConnectPrompt('full');
}

function renderNowPlayingFull(data) {
  const progressPct = data.duration_ms > 0
    ? Math.round((data.progress_ms / data.duration_ms) * 100)
    : 0;
  const progressTime = formatDuration(data.progress_ms);
  const totalTime = formatDuration(data.duration_ms);

  return `
    <div class="view view--full">
      <div class="layout">
        <div class="markdown" style="display: flex; flex-direction: row; align-items: center; height: 100%; padding: 20px 30px;">
          <div style="flex: 0 0 180px; display: flex; align-items: center; justify-content: center;">
            ${musicNoteSvg(140)}
          </div>
          <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; padding-left: 30px; max-width: 70%;">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
              ${playStatusSvg(data.is_playing, 24)}
              <span style="font-size: 16px; font-weight: 400; opacity: 0.6;">${data.is_playing ? 'Now Playing' : 'Paused'}</span>
            </div>
            <div style="font-size: 42px; font-weight: 700; line-height: 1.1; margin-bottom: 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">
              ${truncate(data.track, 30)}
            </div>
            <div style="font-size: 26px; font-weight: 400; opacity: 0.7; margin-bottom: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">
              ${truncate(data.artist, 40)}
            </div>
            <div style="font-size: 18px; font-weight: 300; opacity: 0.5; margin-bottom: 20px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">
              ${truncate(data.album, 45)}
            </div>
            <div style="width: 100%; background: #E5E5E5; height: 6px; border-radius: 3px; overflow: hidden;">
              <div style="width: ${progressPct}%; background: black; height: 100%; border-radius: 3px;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 14px; opacity: 0.5; margin-top: 6px;">
              <span>${progressTime}</span>
              <span>${totalTime}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="title_bar">
        <span class="title">Spotify</span>
      </div>
    </div>
  `.trim();
}

function renderRecentlyPlayedFull(data) {
  const subtitle = data.fallback ? 'Nothing playing right now' : 'Recently Played';
  const trackList = (data.tracks || []).slice(0, 5).map(t => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #E5E5E5;">
      <div style="flex: 1; overflow: hidden;">
        <div style="font-size: 22px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(t.track, 35)}</div>
        <div style="font-size: 16px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(t.artist, 40)}</div>
      </div>
      ${t.played_at ? `<div style="font-size: 14px; opacity: 0.4; white-space: nowrap; padding-left: 10px;">${timeAgo(t.played_at)}</div>` : ''}
    </div>
  `).join('');

  return `
    <div class="view view--full">
      <div class="layout">
        <div class="markdown" style="padding: 20px 30px; height: 100%; display: flex; flex-direction: column;">
          <div style="font-size: 16px; opacity: 0.5; margin-bottom: 12px;">${subtitle}</div>
          <div style="flex: 1; overflow: hidden;">
            ${trackList || '<div style="font-size: 20px; opacity: 0.5;">No recent tracks found.</div>'}
          </div>
        </div>
      </div>
      <div class="title_bar">
        <span class="title">Spotify</span>
      </div>
    </div>
  `.trim();
}

function renderTopTracksFull(data, connection) {
  const range = timeRangeLabel(connection?.settings?.timeRange);
  const trackList = (data.tracks || []).map(t => `
    <div style="display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #E5E5E5; gap: 14px;">
      <div style="font-size: 28px; font-weight: 700; opacity: 0.3; min-width: 36px; text-align: right;">${t.rank}</div>
      <div style="flex: 1; overflow: hidden;">
        <div style="font-size: 22px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(t.track, 35)}</div>
        <div style="font-size: 16px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(t.artist, 40)}</div>
      </div>
    </div>
  `).join('');

  return `
    <div class="view view--full">
      <div class="layout">
        <div class="markdown" style="padding: 20px 30px; height: 100%; display: flex; flex-direction: column;">
          <div style="font-size: 16px; opacity: 0.5; margin-bottom: 12px;">Top Tracks &middot; ${range}</div>
          <div style="flex: 1; overflow: hidden;">
            ${trackList || '<div style="font-size: 20px; opacity: 0.5;">No data yet. Keep listening!</div>'}
          </div>
        </div>
      </div>
      <div class="title_bar">
        <span class="title">Spotify</span>
      </div>
    </div>
  `.trim();
}

function renderTopArtistsFull(data, connection) {
  const range = timeRangeLabel(connection?.settings?.timeRange);
  const artistList = (data.artists || []).map(a => `
    <div style="display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #E5E5E5; gap: 14px;">
      <div style="font-size: 28px; font-weight: 700; opacity: 0.3; min-width: 36px; text-align: right;">${a.rank}</div>
      <div style="flex: 1; overflow: hidden;">
        <div style="font-size: 24px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(a.name, 35)}</div>
        ${a.genres ? `<div style="font-size: 15px; opacity: 0.5;">${a.genres}</div>` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div class="view view--full">
      <div class="layout">
        <div class="markdown" style="padding: 20px 30px; height: 100%; display: flex; flex-direction: column;">
          <div style="font-size: 16px; opacity: 0.5; margin-bottom: 12px;">Top Artists &middot; ${range}</div>
          <div style="flex: 1; overflow: hidden;">
            ${artistList || '<div style="font-size: 20px; opacity: 0.5;">No data yet. Keep listening!</div>'}
          </div>
        </div>
      </div>
      <div class="title_bar">
        <span class="title">Spotify</span>
      </div>
    </div>
  `.trim();
}

// --- Half vertical layout ---
function generateHalfVerticalMarkup(data, connection) {
  if (data.error) {
    return renderConnectPrompt('half_vertical');
  }

  if (data.mode === 'now_playing') {
    return `
      <div class="view view--half_vertical">
        <div class="layout">
          <div class="title_bar"><div class="title">Spotify</div></div>
          <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 0 20px;">
            ${playStatusSvg(data.is_playing, 28)}
            <div style="font-size: 30px; font-weight: 700; margin-top: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 100%;">${truncate(data.track, 22)}</div>
            <div style="font-size: 20px; opacity: 0.6; margin-top: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 100%;">${truncate(data.artist, 28)}</div>
            <div style="width: 80%; background: #E5E5E5; height: 4px; border-radius: 2px; margin-top: 16px; overflow: hidden;">
              <div style="width: ${data.duration_ms > 0 ? Math.round((data.progress_ms / data.duration_ms) * 100) : 0}%; background: black; height: 100%;"></div>
            </div>
          </div>
        </div>
      </div>
    `.trim();
  }

  // For list modes, show first 3 items
  const items = data.tracks || data.artists || [];
  const listHtml = items.slice(0, 3).map((item, i) => {
    const name = item.track || item.name;
    const sub = item.artist || item.genres || '';
    return `<div style="text-align: center; margin: 6px 0;">
      <div style="font-size: 20px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">${truncate(name, 20)}</div>
      <div style="font-size: 14px; opacity: 0.5;">${truncate(sub, 24)}</div>
    </div>`;
  }).join('');

  const modeLabel = data.mode === 'top_tracks' ? 'Top Tracks'
    : data.mode === 'top_artists' ? 'Top Artists'
    : 'Recent';

  return `
    <div class="view view--half_vertical">
      <div class="layout">
        <div class="title_bar"><div class="title">Spotify</div></div>
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 0 15px;">
          <div style="font-size: 14px; opacity: 0.4; margin-bottom: 10px;">${modeLabel}</div>
          ${listHtml}
        </div>
      </div>
    </div>
  `.trim();
}

// --- Half horizontal layout ---
function generateHalfHorizontalMarkup(data, connection) {
  if (data.error) {
    return renderConnectPrompt('half_horizontal');
  }

  if (data.mode === 'now_playing') {
    return `
      <div class="view view--half_horizontal">
        <div class="layout">
          <div class="title_bar"><div class="title">Spotify</div></div>
          <div class="markdown" style="display: flex; align-items: center; justify-content: center; height: 100%; gap: 20px; padding: 0 20px;">
            ${musicNoteSvg(60)}
            <div style="overflow: hidden;">
              <div style="font-size: 28px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(data.track, 25)}</div>
              <div style="font-size: 18px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(data.artist, 30)}</div>
            </div>
          </div>
        </div>
      </div>
    `.trim();
  }

  // For list modes, show first 2 items inline
  const items = data.tracks || data.artists || [];
  const first = items[0];
  const name = first ? (first.track || first.name) : 'No data';
  const sub = first ? (first.artist || first.genres || '') : '';

  return `
    <div class="view view--half_horizontal">
      <div class="layout">
        <div class="title_bar"><div class="title">Spotify</div></div>
        <div class="markdown" style="display: flex; align-items: center; justify-content: center; height: 100%; gap: 20px; padding: 0 20px;">
          ${musicNoteSvg(60)}
          <div style="overflow: hidden;">
            <div style="font-size: 28px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(name, 25)}</div>
            <div style="font-size: 18px; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${truncate(sub, 30)}</div>
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

// --- Quadrant layout ---
function generateQuadrantMarkup(data, connection) {
  if (data.error) {
    return renderConnectPrompt('quadrant');
  }

  if (data.mode === 'now_playing') {
    return `
      <div class="view view--quadrant">
        <div class="layout">
          <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 0 10px;">
            ${playStatusSvg(data.is_playing, 20)}
            <div style="font-size: 16px; font-weight: 700; margin-top: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 100%;">${truncate(data.track, 18)}</div>
            <div style="font-size: 12px; opacity: 0.6; margin-top: 2px;">${truncate(data.artist, 20)}</div>
          </div>
        </div>
      </div>
    `.trim();
  }

  const items = data.tracks || data.artists || [];
  const first = items[0];
  const name = first ? (first.track || first.name) : 'Spotify';

  return `
    <div class="view view--quadrant">
      <div class="layout">
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 0 10px;">
          ${musicNoteSvg(28)}
          <div style="font-size: 14px; font-weight: 600; margin-top: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 100%;">${truncate(name, 16)}</div>
        </div>
      </div>
    </div>
  `.trim();
}

// --- Fallback: connect prompt ---
function renderConnectPrompt(layout) {
  const viewClass = layout === 'full' ? 'view--full'
    : layout === 'half_vertical' ? 'view--half_vertical'
    : layout === 'half_horizontal' ? 'view--half_horizontal'
    : 'view--quadrant';

  if (layout === 'quadrant') {
    return `
      <div class="view ${viewClass}">
        <div class="layout">
          <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center;">
            ${musicNoteSvg(28)}
            <div style="font-size: 12px; opacity: 0.5; margin-top: 6px;">Connect Spotify</div>
          </div>
        </div>
      </div>
    `.trim();
  }

  return `
    <div class="view ${viewClass}">
      <div class="layout">
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 20px;">
          ${musicNoteSvg(layout === 'full' ? 80 : 48)}
          <div style="font-size: ${layout === 'full' ? '28' : '20'}px; font-weight: 600; margin-top: 16px;">Connect Spotify</div>
          <div style="font-size: ${layout === 'full' ? '18' : '14'}px; opacity: 0.5; margin-top: 8px;">Open plugin settings to link your account</div>
        </div>
      </div>
      <div class="title_bar"><span class="title">Spotify</span></div>
    </div>
  `.trim();
}

function renderError(layout, message) {
  const viewClass = layout === 'full' ? 'view--full' : `view--${layout}`;

  return `
    <div class="view ${viewClass}">
      <div class="layout">
        <div class="markdown" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; padding: 20px;">
          ${musicNoteSvg(48)}
          <div style="font-size: 20px; opacity: 0.5; margin-top: 16px;">${message}</div>
        </div>
      </div>
      <div class="title_bar"><span class="title">Spotify</span></div>
    </div>
  `.trim();
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: pluginConnections.size
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`TRMNL Spotify Plugin running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Markup endpoint: POST ${BASE_URL}/markup`);
});
