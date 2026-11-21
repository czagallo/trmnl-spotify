// Builds the view model the markup renders from a service result. Pure: no I/O, time passed in.
//
// v.kind: 'now' | 'list' | 'message'
//   now:     { status, playing, track, artist, album, progressPct, elapsed, total }
//   list:    { rows: [{ rank?, primary, secondary, meta? }], ranked }
//   message: { icon: 'connect'|'error'|'empty', title, text }
// Every v has heading (title bar instance) and note (stale-data hint or '').

const { MODE_LABELS, RANGE_LABELS, normalizeSettings } = require('./settings');

function formatDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function timeAgo(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.floor((now - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ageText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

const MESSAGES = {
  none: { icon: 'connect', title: 'Connect Spotify', text: 'Open the plugin settings in TRMNL and link your Spotify account.' },
  reauth: { icon: 'connect', title: 'Reconnect Spotify', text: 'Spotify access has expired or was revoked. Reconnect in the plugin settings.' },
  rate_limited: { icon: 'error', title: 'Spotify is busy', text: 'Too many requests right now. The next refresh will try again.' },
  unavailable: { icon: 'error', title: 'Spotify unavailable', text: 'Spotify could not be reached. The next refresh will try again.' },
  error: { icon: 'error', title: 'Something went wrong', text: 'The screen could not be built. The next refresh will try again.' },
};

function message(key, heading = '') {
  return { kind: 'message', heading, note: '', ...MESSAGES[key] };
}

function trackRows(tracks, now, withTime) {
  return tracks.map((t) => ({ primary: t.track, secondary: t.artist, meta: withTime ? timeAgo(t.played_at, now) : '' }));
}

// result: from service.getScreen (or null on failure). settings: stored settings.
function buildView(result, settings, { now = Date.now() } = {}) {
  if (!result) return message('error');
  if (result.status === 'not_connected') return message(result.reason === 'reauth' ? 'reauth' : 'none');
  if (result.status !== 'ok') return message(result.reason === 'rate_limited' ? 'rate_limited' : 'unavailable');

  const { timeRange } = normalizeSettings(settings);
  const d = result.data || {};
  const note = result.stale ? `Offline, data from ${ageText(now - result.fetchedAt)} ago` : '';
  const range = RANGE_LABELS[timeRange];

  if (d.mode === 'now_playing' && d.current) {
    const c = d.current;
    const pct = c.duration_ms > 0 ? Math.round((100 * c.progress_ms) / c.duration_ms) : 0;
    return {
      kind: 'now',
      heading: MODE_LABELS.now_playing,
      note,
      playing: c.is_playing,
      status: c.is_playing ? 'Now playing' : 'Paused',
      track: c.track || 'Unknown track',
      artist: c.artist,
      album: c.album,
      progressPct: Math.max(0, Math.min(100, pct)),
      elapsed: formatDuration(c.progress_ms),
      total: c.duration_ms > 0 ? formatDuration(c.duration_ms) : '',
    };
  }

  let heading;
  let rows;
  let ranked = true;
  let empty;
  switch (d.mode) {
    case 'top_tracks':
      heading = `${MODE_LABELS.top_tracks} · ${range}`;
      rows = (d.tracks || []).map((t) => ({ rank: t.rank, primary: t.track, secondary: t.artist }));
      empty = `No top tracks for the ${range.toLowerCase()} yet. Keep listening.`;
      break;
    case 'top_artists':
      heading = `${MODE_LABELS.top_artists} · ${range}`;
      rows = (d.artists || []).map((a) => ({ rank: a.rank, primary: a.name, secondary: a.genres }));
      empty = `No top artists for the ${range.toLowerCase()} yet. Keep listening.`;
      break;
    case 'now_playing':
      // Nothing playing: the last played tracks stand in.
      heading = 'Nothing playing · Recently played';
      rows = trackRows(d.tracks || [], now, true);
      ranked = false;
      empty = 'Nothing is playing and there is no recent listening history.';
      break;
    default:
      heading = MODE_LABELS.recently_played;
      rows = trackRows(d.tracks || [], now, true);
      ranked = false;
      empty = 'No recently played tracks yet.';
  }

  if (!rows.length) return { kind: 'message', heading, note, icon: 'empty', title: 'Nothing here yet', text: empty };
  return { kind: 'list', heading, note, rows, ranked };
}

module.exports = { buildView, message, formatDuration, timeAgo };
