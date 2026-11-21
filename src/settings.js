// Per-user display settings: the only values the settings form may store.

const DISPLAY_MODES = ['top_tracks', 'top_artists', 'recently_played', 'now_playing'];
const TIME_RANGES = ['short_term', 'medium_term', 'long_term'];
const DEFAULT_SETTINGS = { displayMode: 'top_tracks', timeRange: 'short_term' };

const MODE_LABELS = {
  top_tracks: 'Top tracks',
  top_artists: 'Top artists',
  recently_played: 'Recently played',
  now_playing: 'Now playing',
};

const RANGE_LABELS = {
  short_term: 'Last 4 weeks',
  medium_term: 'Last 6 months',
  long_term: 'Last 12 months',
};

// Stored settings may predate validation: anything unknown falls back to the default.
function normalizeSettings(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    displayMode: DISPLAY_MODES.includes(s.displayMode) ? s.displayMode : DEFAULT_SETTINGS.displayMode,
    timeRange: TIME_RANGES.includes(s.timeRange) ? s.timeRange : DEFAULT_SETTINGS.timeRange,
  };
}

// Form input: every value must be one of the known options.
function validateSettings(body) {
  const displayMode = typeof body?.displayMode === 'string' ? body.displayMode : '';
  const timeRange = typeof body?.timeRange === 'string' ? body.timeRange : '';
  if (!DISPLAY_MODES.includes(displayMode)) return { ok: false, error: 'Unknown display mode.' };
  if (!TIME_RANGES.includes(timeRange)) return { ok: false, error: 'Unknown time range.' };
  return { ok: true, settings: { displayMode, timeRange } };
}

module.exports = { DISPLAY_MODES, TIME_RANGES, DEFAULT_SETTINGS, MODE_LABELS, RANGE_LABELS, normalizeSettings, validateSettings };
