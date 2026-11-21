// Pure markup builders for every TRMNL layout.
//
// Rules (TRMNL marketplace review):
// - The platform picks the screen and adds screen--sm/md/lg, screen--portrait and bit-depth classes; we never branch
//   on device in JS. Text uses framework classes with lg:/portrait: prefixes, graphics are SVG with a viewBox.
// - Black and white only (currentColor / white in SVG), no hex colours or opacity greys: they dither badly on 1-bit.
// - TRMNL parses every markup string as Liquid, so nothing may contain "{{" or "{%". esc() also escapes braces,
//   because track, artist, album and genre names come from Spotify.
// - Long names are clipped by CSS (ellipsis / line clamp), never truncated in JS.

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"'{}]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[c],
  );
}

// Type ramps. Base = TRMNL OG (800x480), lg: = TRMNL X, lg:portrait: = TRMNL X held upright, which gets the biggest
// type. The quadrant is the same size on X in either orientation, so it skips the portrait step.
const T = {
  full: {
    status: 'label lg:label--large lg:portrait:label--xlarge',
    track: 'title title--large lg:title--xlarge lg:portrait:title--xxlarge',
    artist: 'label label--large lg:label--xlarge lg:portrait:label--xxlarge',
    album: 'label lg:label--large lg:portrait:label--xlarge',
    time: 'label label--small lg:label--base lg:portrait:label--large',
    name: 'title lg:title--large lg:portrait:title--xlarge',
    sub: 'label lg:label--large lg:portrait:label--xlarge',
    rank: 'value value--xsmall lg:value--small lg:portrait:value--base',
    msgTitle: 'title lg:title--large lg:portrait:title--xlarge',
    msgText: 'description lg:description--large lg:portrait:description--xlarge',
  },
  half: {
    status: 'label label--small lg:label--base lg:portrait:label--large',
    track: 'title lg:title--large lg:portrait:title--xlarge',
    artist: 'label lg:label--large lg:portrait:label--xlarge',
    album: 'label label--small lg:label--base lg:portrait:label--large',
    time: 'label label--small lg:label--base lg:portrait:label--large',
    name: 'title title--small lg:title--base lg:portrait:title--large',
    sub: 'label label--small lg:label--base lg:portrait:label--large',
    rank: 'value value--xxsmall lg:value--xsmall lg:portrait:value--small',
    msgTitle: 'title title--small lg:title--base lg:portrait:title--large',
    msgText: 'description lg:description--base lg:portrait:description--large',
  },
  quadrant: {
    status: 'label label--small lg:label--base',
    track: 'title title--small lg:title--large',
    artist: 'label lg:label--large',
    album: 'label label--small lg:label--base',
    time: 'label label--small lg:label--base',
    name: 'title title--small lg:title--base',
    sub: 'label label--small lg:label--base',
    rank: 'value value--xxsmall lg:value--xsmall',
    msgTitle: 'title title--small lg:title--base',
    msgText: 'description lg:description--base',
  },
};

// How many list rows each layout shows: md (OG), mdP (OG upright), lg (X), lgP (X upright).
const ROWS = {
  full: { md: 6, mdP: 9, lg: 7, lgP: 10 },
  half_horizontal: { md: 6, mdP: 5, lg: 8, lgP: 6 },
  half_vertical: { md: 6, mdP: 8, lg: 8, lgP: 8 },
  quadrant: { md: 3, mdP: 4, lg: 5, lgP: 5 },
};

// Framework visibility classes for list row i. lg:portrait:* is the most specific rule, so it settles X upright.
// The framework CSS sits in cascade layers, so our own (unlayered) rules would beat it: elements that carry these
// classes never get a display value from our CSS (rows are wrapped in a bare .sp-slot for that reason).
function rowVisibility(i, r) {
  const shown = (n) => i < n;
  const cls = [];
  if (!shown(r.md)) cls.push('hidden');
  if (shown(r.mdP) !== shown(r.md)) cls.push(shown(r.mdP) ? 'portrait:flex' : 'portrait:hidden');
  if (shown(r.lg) !== shown(r.md)) cls.push(shown(r.lg) ? 'lg:flex' : 'lg:hidden');
  if (shown(r.lgP) !== shown(r.md) || shown(r.mdP) !== shown(r.md) || shown(r.lg) !== shown(r.md)) {
    cls.push(shown(r.lgP) ? 'lg:portrait:flex' : 'lg:portrait:hidden');
  }
  return cls.join(' ');
}

// ---------------------------------------------------------------------------
// Graphics
// ---------------------------------------------------------------------------

const SVG = 'xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"';
// Message icons sit at the bottom of their box, right above the title, whatever shape the box ends up.

function vinylSvg() {
  return `<svg viewBox="0 0 100 100" ${SVG} style="display:block;width:100%;height:100%">
<circle cx="50" cy="50" r="48" fill="currentColor"/>
<circle cx="50" cy="50" r="42" fill="none" stroke="white" stroke-width="0.7"/>
<circle cx="50" cy="50" r="36.5" fill="none" stroke="white" stroke-width="0.7"/>
<circle cx="50" cy="50" r="31" fill="none" stroke="white" stroke-width="0.7"/>
<circle cx="50" cy="50" r="25.5" fill="none" stroke="white" stroke-width="0.7"/>
<path d="M18 30 A38 38 0 0 1 30 18" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round"/>
<circle cx="50" cy="50" r="17" fill="white"/>
<circle cx="50" cy="50" r="13" fill="none" stroke="currentColor" stroke-width="1.2"/>
<circle cx="50" cy="50" r="2.6" fill="currentColor"/>
</svg>`;
}

function noteSvg() {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMax meet" style="display:block;width:100%;height:100%">
<path d="M24 12 L56 6 L56 46" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/>
<line x1="24" y1="12" x2="24" y2="52" stroke="currentColor" stroke-width="4.5"/>
<line x1="24" y1="20" x2="56" y2="14" stroke="currentColor" stroke-width="4.5"/>
<ellipse cx="16" cy="52" rx="9" ry="7" fill="currentColor"/>
<ellipse cx="48" cy="46" rx="9" ry="7" fill="currentColor"/>
</svg>`;
}

function alertSvg() {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMax meet" style="display:block;width:100%;height:100%">
<circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="4.5"/>
<line x1="32" y1="17" x2="32" y2="37" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
<circle cx="32" cy="46.5" r="3.5" fill="currentColor"/>
</svg>`;
}

function statusIcon(playing) {
  const shape = playing
    ? '<path d="M3 1.5 L13 8 L3 14.5 Z" fill="currentColor"/>'
    : '<rect x="2.5" y="2" width="4" height="12" fill="currentColor"/><rect x="9.5" y="2" width="4" height="12" fill="currentColor"/>';
  return `<svg viewBox="0 0 16 16" ${SVG} style="display:inline-block;width:0.85em;height:0.85em;vertical-align:-0.08em;margin-right:0.35em">${shape}</svg>`;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const CSS = `<style>
.sp{display:flex;width:100%;height:100%;min-width:0;min-height:0}
.sp *{min-width:0}
.sp-clip{display:block;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sp-clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;max-width:100%}
.sp-col{display:flex;flex-direction:column;justify-content:center}
.sp-info>*{width:100%}
.sp-art{width:100%;min-height:0}
.sp-bar{height:10px;border:2px solid currentColor;border-radius:6px;overflow:hidden;margin-top:0.6em}
.sp-bar>div{height:100%;background:currentColor}
.screen--lg .sp-bar{height:16px;border-width:3px;border-radius:9px}
.sp-times{display:flex;justify-content:space-between;margin-top:0.25em}
.sp-list{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}
.sp-slot{flex:1 1 0;min-height:0}
.sp-slot+.sp-slot>.sp-row{border-top:1px solid currentColor}
.screen--lg .sp-slot+.sp-slot>.sp-row{border-top-width:2px}
.sp-row{display:flex;width:100%;height:100%;align-items:center;column-gap:0.7em;padding:0 2px}
.sp-rank{flex:none;min-width:1.6em;text-align:right}
.sp-text{flex:1 1 auto;display:flex;flex-direction:column;justify-content:center}
.sp-meta{flex:none;white-space:nowrap}
.sp-msg{flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:0.4em}
.sp-msg .sp-icon{height:30%;max-width:45%;aspect-ratio:1;flex:none;margin-bottom:0.3em}
.view--quadrant .sp-msg .sp-icon{height:24%}
.sp-msg .title,.sp-msg .description{max-width:92%}
</style>`;

function titleBar(v, ctx) {
  return `<div class="title_bar">
<img class="image" src="${esc(ctx.baseUrl)}/icon-mono.svg" alt="">
<span class="title">Spotify</span>
<span class="instance">${esc(v.note || v.heading || '')}</span>
</div>`;
}

function wrap(view, body, v, ctx, layoutStyle = '') {
  return `<div class="view view--${view}">${CSS}
<div class="layout" style="align-items:stretch;justify-content:stretch${layoutStyle}">
${body}
</div>
${titleBar(v, ctx)}
</div>`;
}

function progress(v, t) {
  if (!v.total) return '';
  return `<div class="sp-bar"><div style="width:${Number(v.progressPct) || 0}%"></div></div>
<div class="sp-times"><span class="${t.time} value--tnums">${esc(v.elapsed)}</span><span class="${t.time} value--tnums">${esc(v.total)}</span></div>`;
}

// The text block of the now-playing views. album / bar: classes that control whether those lines show.
function nowInfo(v, t, { album = '', bar = '', clampTrack = true } = {}) {
  return `<div class="sp-col sp-info" style="flex:1 1 auto">
<span class="${t.status} sp-clip" style="font-weight:700">${statusIcon(v.playing)}${esc(v.status)}</span>
<span class="${t.track} ${clampTrack ? 'sp-clamp' : 'sp-clip'}" style="margin-top:0.15em">${esc(v.track)}</span>
${v.artist ? `<span class="${t.artist} sp-clip" style="margin-top:0.2em">${esc(v.artist)}</span>` : ''}
${v.album ? `<div class="${album}"><span class="${t.album} sp-clip" style="margin-top:0.15em">${esc(v.album)}</span></div>` : ''}
${v.total ? `<div class="${bar}">${progress(v, t)}</div>` : ''}
</div>`;
}

function listRows(v, t, rows) {
  return `<div class="sp-list">${v.rows
    .map((r, i) => `<div class="sp-slot ${rowVisibility(i, rows)}"><div class="sp-row">
${v.ranked ? `<span class="${t.rank} value--tnums sp-rank">${esc(r.rank ?? i + 1)}</span>` : ''}
<div class="sp-text"><span class="${t.name} sp-clip">${esc(r.primary)}</span>${r.secondary ? `<span class="${t.sub} sp-clip">${esc(r.secondary)}</span>` : ''}</div>
${r.meta ? `<span class="${t.sub} sp-meta value--tnums">${esc(r.meta)}</span>` : ''}
</div></div>`)
    .join('')}</div>`;
}

function messageBody(v, t) {
  const icon = v.icon === 'error' ? alertSvg() : noteSvg();
  return `<div class="sp sp-msg">
<div class="sp-icon">${icon}</div>
<span class="${t.msgTitle}">${esc(v.title)}</span>
<span class="${t.msgText}">${esc(v.text)}</span>
</div>`;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

// The record art fills its grid cell; the SVG keeps its aspect ratio inside it.
const NOW_CSS = {
  full: `<style>
.sp-now--full{display:grid;grid-template-columns:minmax(0,38%) minmax(0,1fr);grid-template-rows:minmax(0,1fr);column-gap:36px;align-items:center}
.sp-now--full .sp-art{height:84%}
.screen--lg .sp-now--full{column-gap:56px}
.screen--portrait .sp-now--full{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;row-gap:24px}
.screen--portrait .sp-now--full .sp-art{height:100%}
.screen--portrait .sp-now--full .sp-info{align-items:center;text-align:center}
</style>`,
  half_horizontal: `<style>
.sp-now--hh{display:grid;grid-template-columns:minmax(0,26%) minmax(0,1fr);grid-template-rows:minmax(0,1fr);column-gap:24px;align-items:center}
.sp-now--hh .sp-art{height:88%}
.screen--lg .sp-now--hh{column-gap:36px}
.screen--portrait .sp-now--hh{grid-template-columns:minmax(0,30%) minmax(0,1fr)}
</style>`,
  half_vertical: `<style>
.sp-now--hv{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;row-gap:16px}
.sp-now--hv .sp-art{height:100%}
.sp-now--hv .sp-info{align-items:center;text-align:center}
.screen--portrait .sp-now--hv{grid-template-rows:auto auto;align-content:center;row-gap:24px}
.screen--portrait .sp-now--hv .sp-art{height:auto;aspect-ratio:1;width:86%;justify-self:center}
</style>`,
  quadrant: `<style>
.sp-now--q{display:grid;grid-template-columns:minmax(0,32%) minmax(0,1fr);grid-template-rows:minmax(0,1fr);column-gap:16px;align-items:center}
.sp-now--q .sp-art{height:72%}
.screen--lg .sp-now--q .sp-art{height:86%}
.screen--portrait .sp-now--q{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;row-gap:8px}
.screen--portrait .sp-now--q .sp-art{height:100%}
.screen--portrait .sp-now--q .sp-info{align-items:center;text-align:center}
.screen--lg.screen--portrait .sp-now--q .sp-art{height:100%}
</style>`,
};

const LIST_CSS = {
  full: '',
  half_vertical: '',
  quadrant: '',
  // Two columns of stacked rows (column-major), one column when upright.
  half_horizontal: `<style>
.sp-hh .sp-list{display:grid;grid-auto-flow:column;grid-template-columns:1fr 1fr;grid-template-rows:repeat(3,minmax(0,1fr));column-gap:28px}
.sp-hh .sp-slot+.sp-slot>.sp-row{border-top:none}
.screen--lg .sp-hh .sp-list{grid-template-rows:repeat(4,minmax(0,1fr));column-gap:44px}
.screen--portrait .sp-hh .sp-list{grid-auto-flow:row;grid-template-columns:1fr;grid-template-rows:repeat(5,minmax(0,1fr))}
.screen--lg.screen--portrait .sp-hh .sp-list{grid-template-rows:repeat(6,minmax(0,1fr))}
</style>`,
};

const VIEW_KEY = { full: 'full', half_horizontal: 'half', half_vertical: 'half', quadrant: 'quadrant' };
const SHORT = { full: 'full', half_horizontal: 'hh', half_vertical: 'hv', quadrant: 'q' };

function nowPlaying(view, v, ctx) {
  const t = T[VIEW_KEY[view]];
  // The quadrant shows album and progress only on TRMNL X, which has room for them.
  const extra = view === 'quadrant' ? { album: 'hidden lg:block', bar: 'hidden lg:block', clampTrack: false } : {};
  const body = `${NOW_CSS[view]}<div class="sp sp-now--${SHORT[view]}">
<div class="sp-art">${vinylSvg()}</div>
${nowInfo(v, t, extra)}
</div>`;
  return wrap(view, body, v, ctx);
}

function list(view, v, ctx) {
  const t = T[VIEW_KEY[view]];
  // Narrow layouts drop the "12m ago" column.
  const vv = view === 'quadrant' ? { ...v, rows: v.rows.map((r) => ({ ...r, meta: '' })) } : v;
  const body = `${LIST_CSS[view]}<div class="sp sp-${SHORT[view]}">${listRows(vv, t, ROWS[view])}</div>`;
  return wrap(view, body, v, ctx);
}

function message(view, v, ctx) {
  return wrap(view, messageBody(v, T[VIEW_KEY[view]]), v, ctx);
}

const VIEWS = ['full', 'half_horizontal', 'half_vertical', 'quadrant'];
const KEYS = { full: 'markup', half_horizontal: 'markup_half_horizontal', half_vertical: 'markup_half_vertical', quadrant: 'markup_quadrant' };

// v: from buildView. ctx: { baseUrl }.
function renderAll(v, ctx) {
  const render = v.kind === 'now' ? nowPlaying : v.kind === 'list' ? list : message;
  const out = {};
  for (const view of VIEWS) out[KEYS[view]] = render(view, v, ctx);
  out.shared = '';
  return out;
}

module.exports = { renderAll, esc, rowVisibility, ROWS };
