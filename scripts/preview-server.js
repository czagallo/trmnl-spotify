#!/usr/bin/env node
// Local preview of every screen from fixture data, for trmnl-plugin-preview or curl. Never part of production:
// it is a separate entry point (npm start / the systemd unit run server.js), it listens on 127.0.0.1 only, keeps its
// users in memory, and answers Spotify calls from test/fixtures without any network access or real credentials.
//
//   node scripts/preview-server.js [port]        (default 4103)
//   curl -s -X POST localhost:4103/markup -d user_uuid=preview-top-tracks
//
// The user_uuid picks the scenario:
//   preview-now-playing  preview-paused  preview-nothing-playing  preview-recently-played  preview-top-tracks
//   preview-top-artists  preview-empty  preview-connect  preview-reauth  preview-error  preview-stale
const { createApp } = require('../server');
const { createStore } = require('../src/store');
const { createSpotify } = require('../src/spotify');
const { createService } = require('../src/service');
const { fakeSpotifyRequest } = require('../test/fixtures/fake-spotify');

const PORT = Number(process.argv[2]) || 4103;
const BASE = `http://127.0.0.1:${PORT}`;
const linked = () => ({ access_token: 'preview', refresh_token: 'preview', expires_at: Date.now() + 365 * 864e5 });

const SCENARIOS = {
  'now-playing': { mode: 'now_playing', fake: { current: 'playing' } },
  paused: { mode: 'now_playing', fake: { current: 'paused' } },
  'nothing-playing': { mode: 'now_playing', fake: { current: 'none' } },
  'recently-played': { mode: 'recently_played', fake: {} },
  'top-tracks': { mode: 'top_tracks', range: 'medium_term', fake: {} },
  'top-artists': { mode: 'top_artists', range: 'long_term', fake: {} },
  empty: { mode: 'top_tracks', fake: { empty: true } },
  connect: { mode: 'top_tracks', spotify: null, fake: {} },
  reauth: { mode: 'top_tracks', fake: { apiStatus: 401, tokenStatus: 400, tokenError: 'invalid_grant' } },
  error: { mode: 'top_tracks', fake: { apiStatus: 503 } },
  stale: { mode: 'recently_played', fake: {}, staleAfterFirst: true },
};

// One store + service per scenario, so each can have its own fake Spotify behaviour.
const apps = {};
for (const [name, s] of Object.entries(SCENARIOS)) {
  const uuid = `preview-${name}`;
  const store = createStore(null, {
    seed: {
      [uuid]: {
        plugin_setting_id: 1,
        installed_at: new Date().toISOString(),
        spotify: s.spotify === null ? null : linked(),
        settings: { displayMode: s.mode, timeRange: s.range || 'short_term' },
      },
    },
  });
  const fakeOpts = { ...s.fake, shiftTo: Date.now() };
  if (s.staleAfterFirst) fakeOpts.apiStatus = (calls) => (calls.length > 1 ? 503 : 200);
  const spotify = createSpotify({ clientId: 'preview', clientSecret: 'preview', redirectUri: `${BASE}/spotify/callback`, request: fakeSpotifyRequest(fakeOpts) });
  // The stale scenario's clock starts 20 minutes back for its one successful fetch.
  const clock = { skew: s.staleAfterFirst ? -20 * 60000 : 0 };
  const service = createService({ store, spotify, now: () => Date.now() + clock.skew, log: { error() {} } });
  apps[uuid] = { clock, app: createApp({ store, spotify, service, baseUrl: BASE, spotifyClientId: 'preview', log: { log() {}, error() {} } }), service, s };
}

// Route each request to its scenario's app; anything else gets the connect screen from a default one.
const express = require('express');
const front = express();
front.use(express.urlencoded({ extended: true, limit: '100kb' }));
front.use(express.json({ limit: '100kb' }));
front.use(async (req, res, next) => {
  const uuid = (req.body && req.body.user_uuid) || '';
  const entry = apps[uuid] || apps['preview-connect'];
  // The stale scenario needs one successful fetch first, made 20 minutes "ago".
  if (entry.s.staleAfterFirst && !entry.primed) {
    entry.primed = true;
    await entry.service.getScreen(uuid);
    entry.clock.skew = 0;
  }
  entry.app(req, res, next);
});

front.listen(PORT, '127.0.0.1', () => console.log(`Spotify fixture preview on ${BASE} (scenarios: ${Object.keys(SCENARIOS).join(', ')})`));
