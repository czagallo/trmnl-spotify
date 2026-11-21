// HTML for the settings page and error pages shown in the browser (not on the device).

const { esc } = require('./markup');
const { DISPLAY_MODES, TIME_RANGES, MODE_LABELS, RANGE_LABELS, normalizeSettings } = require('./settings');

const TRMNL_HOST = 'https://trmnl.com';

const STYLE = `<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:50px auto;padding:20px;background:#f5f5f5}
.card{background:white;border-radius:8px;padding:30px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
h1{color:#333;margin-top:0}
h2{color:#333;margin-top:30px;font-size:20px}
p{color:#555;line-height:1.6}
label{display:block;margin-bottom:8px;font-weight:500;color:#333}
select{width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;font-size:16px;margin-bottom:15px}
.btn{display:inline-block;padding:12px 24px;color:white;text-decoration:none;border-radius:6px;border:none;cursor:pointer;font-size:16px;margin-right:10px}
.btn-spotify{background:#1DB954}.btn-spotify:hover{background:#1AA34A}
.btn-secondary{background:#6B7280}.btn-secondary:hover{background:#4B5563}
.btn-danger{background:#DC2626;font-size:14px;padding:8px 16px}.btn-danger:hover{background:#B91C1C}
.notice{padding:12px;border-radius:6px;margin-bottom:20px}
.success{background:#D1FAE5;color:#065F46}
.warning{background:#FEF3C7;color:#92400E}
.error{background:#FEE2E2;color:#991B1B}
.status{display:flex;align-items:center;gap:8px;margin:15px 0}
.dot{width:10px;height:10px;border-radius:50%}
.dot.on{background:#1DB954}.dot.off{background:#DC2626}
.desc{font-size:14px;color:#555;margin-top:4px;margin-bottom:20px}
</style>`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${STYLE}</head>
<body><div class="card">${body}</div></body></html>`;
}

function errorPage(message) {
  return page('Spotify Plugin - Error', `<h1>Spotify Plugin</h1>
<div class="notice error">${esc(message)}</div>
<p>Please return to TRMNL and try again.</p>`);
}

function backLink(conn) {
  const id = conn && conn.plugin_setting_id != null ? String(conn.plugin_setting_id) : '';
  const href = id ? `${TRMNL_HOST}/plugin_settings/${encodeURIComponent(id)}/edit?force_refresh=true` : TRMNL_HOST;
  return `<a href="${esc(href)}" class="btn btn-secondary">Back to TRMNL</a>`;
}

const NOTICES = {
  saved: ['success', 'Settings saved.'],
  connected: ['success', 'Spotify connected.'],
  disconnected: ['warning', 'Spotify has been disconnected.'],
};

// notice: key of NOTICES, or { type, text }.
function managePage(uuid, conn, notice) {
  const connected = !!(conn && conn.spotify && (conn.spotify.refresh_token || conn.spotify.access_token));
  const { displayMode, timeRange } = normalizeSettings(conn && conn.settings);
  const n = typeof notice === 'string' ? NOTICES[notice] : notice ? [notice.type, notice.text] : null;
  const u = esc(uuid);
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;

  const account = connected
    ? `<p>Your Spotify account is linked. The plugin shows your listening data.</p>
<form method="POST" action="/spotify/disconnect" style="margin-top:10px">
<input type="hidden" name="uuid" value="${u}">
<button type="submit" class="btn btn-danger">Disconnect Spotify</button>
</form>`
    : `<p>Connect your Spotify account to show your listening stats on TRMNL.</p>
<a href="/spotify/authorize?uuid=${encodeURIComponent(uuid)}" class="btn btn-spotify">Connect Spotify</a>`;

  const settings = connected
    ? `<h2>Display Settings</h2>
<form method="POST" action="/manage/save">
<input type="hidden" name="uuid" value="${u}">
<label for="displayMode">Display mode</label>
<select name="displayMode" id="displayMode">${DISPLAY_MODES.map((m) => option(m, MODE_LABELS[m], displayMode)).join('')}</select>
<div class="desc"><strong>Top tracks / artists</strong> show your most played music.<br>
<strong>Recently played</strong> shows your latest tracks.<br>
<strong>Now playing</strong> shows the current track (it can be a few minutes old between refreshes).</div>
<label for="timeRange">Time range for top tracks and artists</label>
<select name="timeRange" id="timeRange">${TIME_RANGES.map((r) => option(r, RANGE_LABELS[r], timeRange)).join('')}</select>
<div style="margin-top:25px"><button type="submit" class="btn btn-spotify">Save Settings</button>${backLink(conn)}</div>
</form>`
    : `<div style="margin-top:25px">${backLink(conn)}</div>`;

  return page('Spotify Plugin Settings', `<h1>Spotify Listening Stats</h1>
${n ? `<div class="notice ${esc(n[0])}">${esc(n[1])}</div>` : ''}
<h2>Spotify Account</h2>
<div class="status"><span class="dot ${connected ? 'on' : 'off'}"></span><span style="font-weight:500">${connected ? 'Connected' : 'Not connected'}</span></div>
${account}
${settings}`);
}

module.exports = { managePage, errorPage };
