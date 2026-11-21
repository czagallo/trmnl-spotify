// Plugin connections keyed by TRMNL user UUID, persisted to a JSON file readable by the owner only.
//
// On-disk format (unchanged from the single-file version, so existing users keep working):
//   { "<uuid>": { plugin_setting_id, installed_at, oauth_state?, oauth_state_at?,
//                 spotify: { access_token, refresh_token, expires_at, connected_at } | null,
//                 settings: { displayMode, timeRange } } }
// Older files also hold the TRMNL access token and the whole TRMNL user object; nothing uses them, so they are
// dropped when the file is loaded and the file is rewritten without them.

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'connections.json');
const LEGACY_FIELDS = ['access_token', 'user_data'];

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    let stripped = false;
    const map = new Map();
    for (const [uuid, conn] of Object.entries(parsed)) {
      if (!conn || typeof conn !== 'object') continue;
      const clean = { ...conn };
      for (const f of LEGACY_FIELDS) {
        if (f in clean) {
          delete clean[f];
          stripped = true;
        }
      }
      map.set(uuid, clean);
    }
    return { map, stripped };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read connections file: ${err.message}`);
    return { map: new Map(), stripped: false };
  }
}

function save(map, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`Could not write connections file: ${err.message}`);
  }
}

// file: path, or null for a purely in-memory store (tests, local preview).
function createStore(file = DATA_FILE, { seed } = {}) {
  let map;
  if (file) {
    const loaded = load(file);
    map = loaded.map;
    if (loaded.stripped) save(map, file);
    console.log(`Loaded ${map.size} connection(s)`);
  } else {
    map = new Map(Object.entries(seed || {}));
  }
  const persist = () => file && save(map, file);
  return {
    get: (uuid) => map.get(uuid) || null,
    has: (uuid) => map.has(uuid),
    // Shallow merge; returns the new record.
    update(uuid, patch) {
      const next = { ...(map.get(uuid) || {}), ...patch };
      map.set(uuid, next);
      persist();
      return next;
    },
    delete(uuid) {
      if (map.delete(uuid)) persist();
    },
    size: () => map.size,
  };
}

module.exports = { createStore };
