const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Fake TRMNL credentials so /install reaches the (stubbed) token exchange.
process.env.TRMNL_CLIENT_ID = 'test-client-id';
process.env.TRMNL_CLIENT_SECRET = 'test-client-secret';
const { createApp, trmnlMeta } = require('../server');
const { createStore } = require('../src/store');
const {
  createSpotify,
  parseCurrentlyPlaying,
  parseRecentlyPlayed,
  parseTopTracks,
  parseTopArtists,
} = require('../src/spotify');
const { createService } = require('../src/service');
const { buildView, message, formatDuration, timeAgo } = require('../src/view');
const { renderAll, esc, rowVisibility, ROWS } = require('../src/markup');
const { validateSettings, normalizeSettings } = require('../src/settings');
const { fakeSpotifyRequest, load, FIXTURE_NOW } = require('./fixtures/fake-spotify');

const UUID = 'a1b2c3d4-0000-4000-8000-123456789abc';
const MARKUP_KEYS = ['markup', 'markup_half_horizontal', 'markup_half_vertical', 'markup_quadrant'];
const VIEW_OF = { markup: 'full', markup_half_horizontal: 'half_horizontal', markup_half_vertical: 'half_vertical', markup_quadrant: 'quadrant' };
const CTX = { baseUrl: 'https://example.test' };

function quietLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
}

function linkedConn(extra = {}) {
  return {
    plugin_setting_id: 42,
    installed_at: '2026-01-01T00:00:00.000Z',
    spotify: { access_token: 'old-access', refresh_token: 'refresh-1', expires_at: Date.now() + 3600e3, connected_at: '2026-01-01T00:00:00.000Z' },
    settings: { displayMode: 'top_tracks', timeRange: 'short_term' },
    ...extra,
  };
}

function setup({ fake = {}, conn = linkedConn(), service: svcOpts = {} } = {}) {
  const store = createStore(null, { seed: conn ? { [UUID]: conn } : {} });
  const request = fakeSpotifyRequest(fake);
  const spotify = createSpotify({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.test/spotify/callback', request });
  const logs = quietLog();
  const service = createService({ store, spotify, log: logs, ...svcOpts });
  return { store, request, spotify, service, logs };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parses currently-playing, including nothing playing and ads', () => {
  const c = parseCurrentlyPlaying(load('currently-playing'));
  assert.equal(c.is_playing, true);
  assert.match(c.track, /^Pneumono/);
  assert.equal(c.artist, 'The Very Long Band Name Orchestra & Friends, Another Featured Artist');
  assert.equal(c.progress_ms, 83000);
  assert.equal(c.duration_ms, 214000);
  assert.equal(parseCurrentlyPlaying(load('currently-playing-ad')), null);
  assert.equal(parseCurrentlyPlaying(null), null);
  assert.equal(parseCurrentlyPlaying('garbage'), null);
});

test('parses recently played and top lists', () => {
  const recent = parseRecentlyPlayed(load('recently-played'));
  assert.equal(recent.length, 10);
  assert.equal(recent[0].track, '<3 & {{x}}');
  assert.ok(recent[0].played_at);

  const tracks = parseTopTracks(load('top-tracks'));
  assert.deepEqual(tracks.map((t) => t.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(tracks[5].artist, 'Sigur Rós, Jónsi');

  const artists = parseTopArtists(load('top-artists'));
  assert.equal(artists[1].genres, 'art rock, alternative rock');
  assert.equal(artists[9].genres, '');
  assert.deepEqual(parseTopArtists({ items: 'nope' }), []);
  assert.deepEqual(parseTopTracks(null), []);
});

test('formats durations and relative times', () => {
  assert.equal(formatDuration(83000), '1:23');
  assert.equal(formatDuration(3723000), '1:02:03');
  assert.equal(timeAgo(new Date(FIXTURE_NOW - 5 * 60000).toISOString(), FIXTURE_NOW), '5m ago');
  assert.equal(timeAgo('not a date', FIXTURE_NOW), '');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings form only accepts known values', () => {
  assert.deepEqual(validateSettings({ displayMode: 'now_playing', timeRange: 'long_term' }), {
    ok: true,
    settings: { displayMode: 'now_playing', timeRange: 'long_term' },
  });
  assert.equal(validateSettings({ displayMode: 'evil', timeRange: 'short_term' }).ok, false);
  assert.equal(validateSettings({ displayMode: 'top_tracks', timeRange: 'short_term&limit=50' }).ok, false);
  assert.equal(validateSettings({ displayMode: ['top_tracks'], timeRange: 'short_term' }).ok, false);
  assert.equal(validateSettings({}).ok, false);
  // Stored values from before validation fall back to the defaults.
  assert.deepEqual(normalizeSettings({ displayMode: 'x', timeRange: '../../me' }), { displayMode: 'top_tracks', timeRange: 'short_term' });
});

test('the time range in the Spotify API path is always whitelisted', async () => {
  const { service, request, store } = setup();
  store.update(UUID, { settings: { displayMode: 'top_artists', timeRange: 'long_term&x=1' } });
  await service.getScreen(UUID);
  const call = request.calls.find((c) => c.host === 'api.spotify.com');
  assert.equal(call.path, '/v1/me/top/artists?time_range=short_term&limit=10');
});

// ---------------------------------------------------------------------------
// Service state machine
// ---------------------------------------------------------------------------

test('not connected: no record, or Spotify unlinked', async () => {
  const a = setup({ conn: null });
  assert.deepEqual(await a.service.getScreen(UUID), { status: 'not_connected', reason: 'none' });
  const b = setup({ conn: linkedConn({ spotify: null }) });
  assert.deepEqual(await b.service.getScreen(UUID), { status: 'not_connected', reason: 'none' });
  assert.equal(b.request.calls.length, 0);
});

test('fresh data is cached for the TTL', async () => {
  const { service, request } = setup();
  const r1 = await service.getScreen(UUID);
  assert.equal(r1.status, 'ok');
  assert.equal(r1.stale, false);
  assert.equal(r1.data.tracks.length, 10);
  await service.getScreen(UUID);
  assert.equal(request.calls.length, 1);
});

test('an expired token is refreshed once, shared by concurrent requests, and persisted', async () => {
  const { service, request, store } = setup({ conn: linkedConn({ spotify: { access_token: 'x', refresh_token: 'r', expires_at: Date.now() - 1000 } }) });
  const p1 = service.getScreen(UUID);
  store.update(UUID, { settings: { displayMode: 'top_artists', timeRange: 'short_term' } });
  const p2 = service.getScreen(UUID);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'ok');
  assert.equal(r2.status, 'ok');
  assert.equal(request.calls.filter((c) => c.host === 'accounts.spotify.com').length, 1);
  assert.equal(store.get(UUID).spotify.access_token, 'fresh-token-1');
  assert.equal(store.get(UUID).spotify.refresh_token, 'r', 'keeps the refresh token when Spotify sends none');
});

test('a 401 from the API refreshes the token and retries once', async () => {
  const { service, request } = setup({ fake: { apiStatus: (calls) => (calls.filter((c) => c.host === 'api.spotify.com').length === 1 ? 401 : 200) } });
  const r = await service.getScreen(UUID);
  assert.equal(r.status, 'ok');
  assert.equal(request.calls.filter((c) => c.host === 'accounts.spotify.com').length, 1);
});

test('a revoked refresh token means reconnect, not an empty list', async () => {
  const { service } = setup({
    conn: linkedConn({ spotify: { access_token: 'x', refresh_token: 'r', expires_at: 0 } }),
    fake: { tokenStatus: 400, tokenError: 'invalid_grant' },
  });
  assert.deepEqual(await service.getScreen(UUID), { status: 'not_connected', reason: 'reauth' });
});

test('a network failure during refresh is "unavailable", not "not connected"', async () => {
  const { service } = setup({ conn: linkedConn({ spotify: { access_token: 'x', refresh_token: 'r', expires_at: 0 } }), fake: { network: true } });
  assert.deepEqual(await service.getScreen(UUID), { status: 'unavailable', reason: 'unavailable' });
});

test('Spotify errors serve stale data when there is some', async () => {
  let fail = false;
  let clock = 1_000_000;
  const { service } = setup({ fake: { apiStatus: () => (fail ? 503 : 200) }, service: { now: () => clock } });
  assert.equal((await service.getScreen(UUID)).stale, false);
  fail = true;
  clock += 5 * 60e3;
  const r = await service.getScreen(UUID);
  assert.equal(r.status, 'ok');
  assert.equal(r.stale, true);
  assert.equal(r.data.tracks.length, 10);
  const v = buildView(r, { timeRange: 'short_term' }, { now: clock });
  assert.equal(v.note, 'Offline, data from 5 min ago');
  // Too old to show: unavailable.
  clock += 48 * 3600e3;
  assert.deepEqual(await service.getScreen(UUID), { status: 'unavailable', reason: 'unavailable' });
});

test('rate limiting without cache is reported as such', async () => {
  const { service, logs } = setup({ fake: { apiStatus: 429 } });
  assert.deepEqual(await service.getScreen(UUID), { status: 'unavailable', reason: 'rate_limited' });
  assert.ok(logs.lines.every((l) => !l.includes(UUID)));
});

test('genuinely empty lists are ok results with an empty-state screen', async () => {
  const { service } = setup({ fake: { empty: true } });
  const r = await service.getScreen(UUID);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data.tracks, []);
  const v = buildView(r, { timeRange: 'short_term' });
  assert.equal(v.kind, 'message');
  assert.equal(v.icon, 'empty');
});

test('now playing falls back to recently played when nothing is playing', async () => {
  const { service } = setup({ conn: linkedConn({ settings: { displayMode: 'now_playing', timeRange: 'short_term' } }), fake: { current: 'none' } });
  const r = await service.getScreen(UUID);
  assert.equal(r.data.current, null);
  assert.equal(r.data.tracks.length, 10);
  assert.equal(buildView(r, {}).kind, 'list');
});

test('the response cache is bounded', async () => {
  const seed = {};
  for (let i = 0; i < 6; i++) seed[`user-${i}`] = linkedConn();
  const store = createStore(null, { seed });
  const spotify = createSpotify({ request: fakeSpotifyRequest() });
  const service = createService({ store, spotify, maxEntries: 3, log: quietLog() });
  for (let i = 0; i < 6; i++) await service.getScreen(`user-${i}`);
  assert.equal(service.cacheSize(), 3);
});

test('disconnecting during a refresh does not bring the tokens back', async () => {
  const { service, store } = setup({ conn: linkedConn({ spotify: { access_token: 'x', refresh_token: 'r', expires_at: 0 } }), fake: { delayMs: 20 } });
  const p = service.getScreen(UUID);
  store.update(UUID, { spotify: null });
  assert.deepEqual(await p, { status: 'not_connected', reason: 'reauth' });
  assert.equal(store.get(UUID).spotify, null);
});

test('token errors never carry response bodies', async () => {
  const spotify = createSpotify({ request: fakeSpotifyRequest({ tokenStatus: 400, tokenError: 'invalid_grant' }) });
  await assert.rejects(spotify.refresh('r'), (err) => {
    assert.equal(err.kind, 'auth');
    assert.doesNotMatch(err.message, /secret-ish|error_description/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function nowResult(current) {
  return { status: 'ok', mode: 'now_playing', data: { mode: 'now_playing', current: parseCurrentlyPlaying(load(current)) }, fetchedAt: FIXTURE_NOW, stale: false };
}
function listResult(mode, key, file, parse) {
  return { status: 'ok', mode, data: { mode, [key]: parse(load(file)) }, fetchedAt: FIXTURE_NOW, stale: false };
}

const SCENARIOS = {
  now_playing: () => buildView(nowResult('currently-playing'), {}, { now: FIXTURE_NOW }),
  paused_escape: () => buildView(nowResult('currently-playing-escape'), {}, { now: FIXTURE_NOW }),
  recently_played: () => buildView(listResult('recently_played', 'tracks', 'recently-played', parseRecentlyPlayed), {}, { now: FIXTURE_NOW }),
  nothing_playing: () => buildView({ ...listResult('now_playing', 'tracks', 'recently-played', parseRecentlyPlayed), data: { mode: 'now_playing', current: null, tracks: parseRecentlyPlayed(load('recently-played')) } }, {}, { now: FIXTURE_NOW }),
  top_tracks: () => buildView(listResult('top_tracks', 'tracks', 'top-tracks', parseTopTracks), { timeRange: 'medium_term' }),
  top_artists: () => buildView(listResult('top_artists', 'artists', 'top-artists', parseTopArtists), { timeRange: 'long_term' }),
  empty: () => buildView({ status: 'ok', mode: 'top_tracks', data: { mode: 'top_tracks', tracks: [] }, fetchedAt: 0, stale: false }, {}),
  stale: () => buildView({ ...listResult('top_tracks', 'tracks', 'top-tracks', parseTopTracks), stale: true, fetchedAt: FIXTURE_NOW - 3 * 3600e3 }, {}, { now: FIXTURE_NOW }),
  connect: () => buildView({ status: 'not_connected', reason: 'none' }, {}),
  reauth: () => buildView({ status: 'not_connected', reason: 'reauth' }, {}),
  unavailable: () => buildView({ status: 'unavailable', reason: 'unavailable' }, {}),
  rate_limited: () => buildView({ status: 'unavailable', reason: 'rate_limited' }, {}),
  error: () => message('error'),
};

for (const [name, make] of Object.entries(SCENARIOS)) {
  test(`markup: ${name} renders all four layouts safely`, () => {
    const out = renderAll(make(), CTX);
    assert.deepEqual(Object.keys(out).sort(), [...MARKUP_KEYS, 'shared'].sort());
    for (const key of MARKUP_KEYS) {
      const html = out[key];
      assert.ok(html.startsWith(`<div class="view view--${VIEW_OF[key]}">`), `${key} wrapper`);
      assert.doesNotMatch(html, /\{\{|\{%/, `${key} has Liquid delimiters`);
      assert.doesNotMatch(html, /(?<!&)#[0-9a-fA-F]{3,8}\b|opacity|rgba?\(/, `${key} uses greys or colours`);
      assert.doesNotMatch(html, /font-size:\s*\d+px/, `${key} uses fixed font sizes`);
      // title_bar is a sibling of .layout inside .view
      assert.match(html, /<div class="layout"[\s\S]*<\/div>\n<div class="title_bar">[\s\S]*<\/div>\n<\/div>$/);
      assert.match(html, /lg:/, `${key} has no TRMNL X classes`);
      if (key !== 'markup_quadrant') assert.match(html, /lg:portrait:/, `${key} has no X portrait type step`);
      for (const svg of html.match(/<svg[^>]*>/g) || []) assert.match(svg, /viewBox=/);
    }
  });
}

test('markup escapes external strings, braces included', () => {
  const out = renderAll(SCENARIOS.paused_escape(), CTX);
  for (const key of MARKUP_KEYS) {
    assert.ok(out[key].includes('&lt;3 &amp; &#123;&#123;x&#125;&#125;'), key);
    assert.ok(!out[key].includes('<b>bold</b>'), key);
  }
  const list = renderAll(SCENARIOS.top_artists(), CTX).markup;
  assert.ok(list.includes('&#123;% liquid %&#125;'));
  assert.equal(esc('<3 & {{x}}'), '&lt;3 &amp; &#123;&#123;x&#125;&#125;');
  assert.equal(esc(`"'`), '&quot;&#39;');
});

test('markup clips long names with CSS, not JS truncation', () => {
  const html = renderAll(SCENARIOS.top_tracks(), CTX).markup;
  assert.ok(html.includes('Pneumonoultramicroscopicsilicovolcanoconiosis and Other Extremely Long Song Titles That Never Seem to End'));
  assert.match(html, /text-overflow:ellipsis/);
});

test('list rows: more on TRMNL X and upright screens, via framework classes', () => {
  // Row 7 of the full view: hidden on OG landscape, shown upright and on X.
  assert.equal(rowVisibility(6, ROWS.full), 'hidden portrait:flex lg:flex lg:portrait:flex');
  assert.equal(rowVisibility(0, ROWS.full), '');
  assert.equal(rowVisibility(9, ROWS.full), 'hidden lg:portrait:flex');
  // The quadrant shows more rows on X.
  assert.ok(ROWS.quadrant.lg > ROWS.quadrant.md);
  const q = renderAll(SCENARIOS.top_tracks(), CTX).markup_quadrant;
  assert.match(q, /sp-slot hidden[^"]*lg:flex/);
});

test('now playing on the quadrant adds album and progress on TRMNL X', () => {
  const q = renderAll(SCENARIOS.now_playing(), CTX).markup_quadrant;
  assert.match(q, /<div class="hidden lg:block"><span[^>]*>An Album Title/);
  assert.match(q, /<div class="hidden lg:block"><div class="sp-bar">/);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function withServer(deps, fn) {
  const app = createApp({ baseUrl: 'https://example.test', spotifyClientId: 'cid', ...deps });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function deps(opts = {}) {
  const s = setup(opts);
  const logs = quietLog();
  return { ...s, log: logs, logs };
}

const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });

test('trmnlMeta accepts nested objects and JSON strings', () => {
  assert.deepEqual(trmnlMeta({ user: { uuid: 'x' } }), { user: { uuid: 'x' } });
  assert.deepEqual(trmnlMeta('{"user":{"uuid":"x"}}'), { user: { uuid: 'x' } });
  assert.deepEqual(trmnlMeta('nope'), {});
  assert.deepEqual(trmnlMeta(undefined), {});
});

test('/markup: user from user_uuid, from a trmnl JSON string, or from nested form keys', async () => {
  const d = deps();
  await withServer(d, async (base) => {
    for (const body of [
      `user_uuid=${UUID}`,
      `trmnl=${encodeURIComponent(JSON.stringify({ user: { uuid: UUID } }))}`,
      `trmnl%5Buser%5D%5Buuid%5D=${UUID}`,
    ]) {
      const r = await fetch(`${base}/markup`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.match(j.markup, /Top tracks · Last 4 weeks/);
    }
  });
  assert.ok(d.logs.lines.every((l) => !l.includes(UUID)));
});

test('/markup: unknown or invalid user gets the connect screen', async () => {
  await withServer(deps(), async (base) => {
    for (const uuid of ['someone-else', '<script>', '']) {
      const r = await fetch(`${base}/markup`, form({ user_uuid: uuid }));
      assert.equal(r.status, 200);
      assert.match((await r.json()).markup_quadrant, /Connect Spotify/);
    }
  });
});

test('/markup: a failing service renders the error screen with HTTP 200', async () => {
  const d = deps();
  d.service = { getScreen: async () => { throw new Error('boom'); }, cachedScreen: () => null, forget() {} };
  await withServer(d, async (base) => {
    const r = await fetch(`${base}/markup`, form({ user_uuid: UUID }));
    assert.equal(r.status, 200);
    const j = await r.json();
    for (const key of MARKUP_KEYS) assert.match(j[key], /Spotify unavailable/);
  });
});

test('/markup: malformed JSON still answers with a screen', async () => {
  await withServer(deps(), async (base) => {
    const r = await fetch(`${base}/markup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).markup);
  });
});

test('/manage validates and escapes the uuid and plugin_setting_id', async () => {
  const d = deps({ conn: linkedConn({ plugin_setting_id: '"><script>alert(1)</script>' }) });
  await withServer(d, async (base) => {
    let r = await fetch(`${base}/manage?uuid=${encodeURIComponent('"><script>alert(1)</script>')}`);
    assert.equal(r.status, 400);
    assert.doesNotMatch(await r.text(), /<script>/);
    r = await fetch(`${base}/manage?uuid=${UUID}&saved=true`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /plugin_settings\/%22%3E%3Cscript%3E/);
    assert.match(html, /Settings saved/);
    r = await fetch(`${base}/manage?uuid[]=x`);
    assert.equal(r.status, 400);
  });
});

test('/manage/save whitelists settings and encodes the redirect', async () => {
  const d = deps();
  await withServer(d, async (base) => {
    let r = await fetch(`${base}/manage/save`, form({ uuid: UUID, displayMode: 'hack', timeRange: 'short_term' }));
    assert.equal(r.status, 400);
    assert.equal(d.store.get(UUID).settings.displayMode, 'top_tracks');
    r = await fetch(`${base}/manage/save`, form({ uuid: UUID, displayMode: 'now_playing', timeRange: 'long_term' }));
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/manage?uuid=${UUID}&saved=true`);
    assert.deepEqual(d.store.get(UUID).settings, { displayMode: 'now_playing', timeRange: 'long_term' });
    r = await fetch(`${base}/manage/save`, form({ uuid: 'x"y', displayMode: 'now_playing', timeRange: 'long_term' }));
    assert.equal(r.status, 400);
  });
});

test('/spotify/callback rejects repeated or malformed state without hanging', async () => {
  await withServer(deps(), async (base) => {
    for (const q of ['code=c&state=a&state=b', 'code=c&state[x]=1', 'code=c', `code=c&state=${UUID}:nothex`, 'code[]=1&state=x']) {
      const r = await fetch(`${base}/spotify/callback?${q}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(r.status, 400, q);
    }
  });
});

test('Spotify connect flow: authorize stores state, callback checks it and links the account', async () => {
  const d = deps({ conn: linkedConn({ spotify: null }) });
  await withServer(d, async (base) => {
    let r = await fetch(`${base}/spotify/authorize?uuid=${UUID}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.host, 'accounts.spotify.com');
    const state = loc.searchParams.get('state');
    assert.equal(state, d.store.get(UUID).oauth_state);

    r = await fetch(`${base}/spotify/callback?code=abc&state=${encodeURIComponent(`${UUID}:${'0'.repeat(32)}`)}`);
    assert.equal(r.status, 400, 'wrong state');

    r = await fetch(`${base}/spotify/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/manage?uuid=${UUID}&spotify=connected`);
    const sp = d.store.get(UUID).spotify;
    assert.equal(sp.access_token, 'fresh-token-1');
    assert.equal(d.store.get(UUID).oauth_state, undefined);

    r = await fetch(`${base}/spotify/authorize?uuid=unknown-user`);
    assert.equal(r.status, 404);
  });
  assert.ok(d.logs.lines.every((l) => !l.includes(UUID) && !l.includes('fresh-token')));
});

test('/spotify/disconnect clears the link and validates the uuid', async () => {
  const d = deps();
  await withServer(d, async (base) => {
    let r = await fetch(`${base}/spotify/disconnect`, form({ uuid: UUID }));
    assert.equal(r.status, 302);
    assert.equal(d.store.get(UUID).spotify, null);
    r = await fetch(`${base}/spotify/disconnect`, form({ uuid: '../x' }));
    assert.equal(r.status, 400);
  });
});

test('install-success stores only what is needed and keeps an existing Spotify link', async () => {
  const d = deps({ conn: null });
  await withServer(d, async (base) => {
    const post = (body) => fetch(`${base}/webhooks/install-success`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer trmnl-secret-token' },
      body: JSON.stringify(body),
    });
    let r = await post({ user: { uuid: UUID, plugin_setting_id: 7, email: 'someone@example.test', name: 'Someone' } });
    assert.equal(r.status, 200);
    let c = d.store.get(UUID);
    assert.equal(c.plugin_setting_id, 7);
    assert.equal(c.spotify, null);
    assert.deepEqual(c.settings, { displayMode: 'top_tracks', timeRange: 'short_term' });
    assert.ok(!('access_token' in c) && !('user_data' in c));
    assert.doesNotMatch(JSON.stringify(c), /someone@|trmnl-secret-token/);

    d.store.update(UUID, { spotify: { access_token: 'a', refresh_token: 'r', expires_at: 1 }, settings: { displayMode: 'now_playing', timeRange: 'long_term' } });
    r = await post({ user: { uuid: UUID, plugin_setting_id: 8 } });
    c = d.store.get(UUID);
    assert.equal(c.spotify.refresh_token, 'r');
    assert.equal(c.settings.displayMode, 'now_playing');
    assert.equal(c.plugin_setting_id, 8);

    r = await post({ user: { uuid: '<bad>' } });
    assert.equal(r.status, 400);
  });
  assert.ok(d.logs.lines.every((l) => !l.includes(UUID) && !l.includes('someone@')));
});

test('uninstall accepts all payload shapes', async () => {
  for (const body of [{ user: { uuid: UUID } }, { user_uuid: UUID }, { uuid: UUID }]) {
    const d = deps();
    await withServer(d, async (base) => {
      const r = await fetch(`${base}/webhooks/uninstall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 200);
    });
    assert.equal(d.store.get(UUID), null);
  }
});

test('/install: never returns or logs the TRMNL token response', async () => {
  const d = deps();
  const calls = [];
  d.trmnlRequest = async (opts) => {
    calls.push(opts.hostname);
    return { statusCode: 401, body: { error: 'nope', access_token_hint: 'leak-me' } };
  };
  await withServer(d, async (base) => {
    let r = await fetch(`${base}/install?code=c&installation_callback_url=javascript:alert(1)`);
    assert.equal(r.status, 400);
    r = await fetch(`${base}/install?code=c&installation_callback_url=${encodeURIComponent('https://trmnl.com/x')}`, { redirect: 'manual' });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Installation failed' });
    assert.deepEqual(calls, ['trmnl.com']);
    d.trmnlRequest = null;
  });
  const ok = deps();
  ok.trmnlRequest = async () => ({ statusCode: 200, body: { access_token: 'leak-me' } });
  await withServer(ok, async (base) => {
    const r = await fetch(`${base}/install?code=c&installation_callback_url=${encodeURIComponent('https://trmnl.com/x?y=1')}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://trmnl.com/x?y=1');
  });
  assert.ok(ok.logs.lines.every((l) => !l.includes('leak-me')));
  assert.ok(d.logs.lines.every((l) => !l.includes('leak-me')));
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test('store reads the legacy file format, drops unused TRMNL fields and keeps Spotify tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trmnl-spotify-'));
  const file = path.join(dir, 'data', 'connections.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({
    [UUID]: {
      plugin_setting_id: 5,
      access_token: 'trmnl-token',
      installed_at: '2025-01-01T00:00:00.000Z',
      user_data: { uuid: UUID, email: 'x@example.test' },
      spotify: { access_token: 'sp-a', refresh_token: 'sp-r', expires_at: 123, connected_at: '2025-01-02T00:00:00.000Z' },
      settings: { displayMode: 'recently_played', timeRange: 'medium_term' },
    },
  }));
  const origLog = console.log;
  console.log = () => {};
  try {
    const store = createStore(file);
    const c = store.get(UUID);
    assert.equal(c.spotify.refresh_token, 'sp-r');
    assert.equal(c.settings.displayMode, 'recently_played');
    assert.ok(!('access_token' in c) && !('user_data' in c));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))[UUID];
    assert.equal(onDisk.spotify.refresh_token, 'sp-r');
    assert.ok(!('user_data' in onDisk) && !('access_token' in onDisk));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const file2 = path.join(dir, 'fresh', 'connections.json');
    createStore(file2).update(UUID, { settings: {} });
    assert.equal(fs.statSync(path.dirname(file2)).mode & 0o777, 0o700);
  } finally {
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
