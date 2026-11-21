// A stand-in for the HTTPS transport that answers Spotify requests from the JSON fixtures in this folder.
// Used by the tests and by scripts/preview-server.js; it never touches the network.

const fs = require('fs');
const path = require('path');

const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, `${name}.json`), 'utf8'));
const FIXTURE_NOW = load('fixture-now').now;

// opts:
//   current: 'playing' | 'paused' | 'none' | 'ad'   what currently-playing returns
//   empty: true                                      list endpoints return no items
//   apiStatus / tokenStatus: number                  force an HTTP status (e.g. 429, 503, 401, 400)
//   tokenError: string                               error code in a failed token response (e.g. 'invalid_grant')
//   network: true                                    every request rejects like a network failure
//   shiftTo: ms                                      move played_at times so the fixture "now" becomes this instant
//   delayMs: number                                  answer after a delay
function fakeSpotifyRequest(opts = {}) {
  const calls = [];
  const shift = opts.shiftTo ? opts.shiftTo - FIXTURE_NOW : 0;

  async function request(options) {
    calls.push({ host: options.hostname, path: options.path });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.network) throw new Error('getaddrinfo ENOTFOUND');

    if (options.hostname === 'accounts.spotify.com') {
      const status = typeof opts.tokenStatus === 'function' ? opts.tokenStatus(calls) : opts.tokenStatus;
      if (status && status !== 200) return { statusCode: status, body: { error: opts.tokenError || 'server_error', error_description: 'secret-ish detail' } };
      const n = calls.filter((c) => c.host === 'accounts.spotify.com').length;
      return { statusCode: 200, body: { access_token: `fresh-token-${n}`, token_type: 'Bearer', expires_in: 3600, scope: 'user-top-read' } };
    }

    const status = typeof opts.apiStatus === 'function' ? opts.apiStatus(calls, options) : opts.apiStatus;
    if (status && status !== 200) return { statusCode: status, body: { error: { status, message: 'nope' } } };

    const p = options.path;
    if (p.startsWith('/v1/me/player/currently-playing')) {
      const c = opts.current || 'playing';
      if (c === 'none') return { statusCode: 204, body: null };
      if (c === 'ad') return { statusCode: 200, body: load('currently-playing-ad') };
      return { statusCode: 200, body: load(c === 'paused' ? 'currently-playing-escape' : 'currently-playing') };
    }
    if (opts.empty) return { statusCode: 200, body: load('empty-list') };
    if (p.startsWith('/v1/me/player/recently-played')) {
      const body = load('recently-played');
      if (shift) for (const it of body.items) it.played_at = new Date(Date.parse(it.played_at) + shift).toISOString();
      return { statusCode: 200, body };
    }
    if (p.startsWith('/v1/me/top/tracks')) return { statusCode: 200, body: load('top-tracks') };
    if (p.startsWith('/v1/me/top/artists')) return { statusCode: 200, body: load('top-artists') };
    return { statusCode: 404, body: { error: { status: 404 } } };
  }

  request.calls = calls;
  return request;
}

module.exports = { fakeSpotifyRequest, load, FIXTURE_NOW };
