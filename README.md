# TRMNL Spotify Plugin

A [TRMNL](https://usetrmnl.com) marketplace plugin that displays your Spotify listening stats on your e-ink display.

## Features

- **Top Tracks** - Shows your most listened tracks (configurable time range: 4 weeks, 6 months, 12 months).
- **Top Artists** - Shows your most listened artists with genres.
- **Recently Played** - Shows your latest tracks with relative timestamps.
- **Now Playing** - Shows your currently playing track with progress bar (may be outdated between refreshes); falls back to recently played when nothing is playing.
- All 4 TRMNL layouts (full, half vertical, half horizontal, quadrant) on TRMNL OG and TRMNL X, landscape and portrait. More rows and bigger type on TRMNL X.
- When Spotify is unreachable the last good data is shown (marked "Offline") instead of an empty screen.

## Screenshots

_Coming soon after marketplace approval._

## Setup

### Prerequisites

- A [TRMNL](https://usetrmnl.com) account with a registered plugin
- A [Spotify Developer](https://developer.spotify.com/dashboard) application
- Node.js 18+ (the preview tool below needs Node 24)

### 1. Register TRMNL Plugin

1. Go to [TRMNL Plugin Registration](https://usetrmnl.com/plugins/my/new)
2. Set your plugin URLs:
   - **Installation URL**: `https://your-domain.com/install`
   - **Manage URL**: `https://your-domain.com/manage`
   - **Markup URL**: `https://your-domain.com/markup`
   - **Webhook URLs**: configure install-success and uninstall webhooks
3. Note your `client_id` and `client_secret`

### 2. Create Spotify App

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create a new application
3. Add `https://your-domain.com/spotify/callback` as a Redirect URI
4. Note your `client_id` and `client_secret`

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```
PORT=3004
# HOST=127.0.0.1   (default; the app only listens on loopback behind the reverse proxy / tunnel)
BASE_URL=https://your-domain.com
TRMNL_CLIENT_ID=your_trmnl_client_id
TRMNL_CLIENT_SECRET=your_trmnl_client_secret
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

### 4. Install and Run

```bash
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

### 5. Test Locally

```bash
# Unit and HTTP tests (no network, Spotify answers come from test/fixtures), then the /health smoke test
npm test
npm run test:unit   # the node --test suite only

# Health check
curl http://localhost:3004/health
```

#### Preview every screen without a Spotify account

`scripts/preview-server.js` serves `/markup` from fixture data. It is a separate entry point (never started by
`npm start` or the systemd unit), listens on 127.0.0.1 only and keeps its demo users in memory.

```bash
npm run preview            # http://127.0.0.1:4103
curl -s -X POST http://127.0.0.1:4103/markup -d user_uuid=preview-top-tracks
```

The `user_uuid` picks the scenario: `preview-now-playing`, `preview-paused`, `preview-nothing-playing`,
`preview-recently-played`, `preview-top-tracks`, `preview-top-artists`, `preview-empty`, `preview-connect`,
`preview-reauth`, `preview-error`, `preview-stale`.

Point [trmnl-plugin-preview](https://github.com/danmunoz/trmnl-plugin-preview) (Node 24) at it to see the real
framework rendering on TRMNL OG and TRMNL X:

```bash
node dist/src/index.js --port 4203 --no-open --target http://127.0.0.1:4103/markup \
  --token preview --user-uuid preview-top-tracks
curl -o top-tracks.png 'http://127.0.0.1:4203/render/quadrant.png?model=v2&orientation=portrait'
```

## How It Works

1. User installs the plugin from the TRMNL marketplace (OAuth2 flow with TRMNL)
2. In the plugin settings, user clicks "Connect Spotify" (OAuth2 flow with Spotify)
3. Plugin stores Spotify tokens (in `data/connections.json`, mode 0600) and refreshes them when they expire; concurrent requests share one refresh
4. When TRMNL requests screen content (`POST /markup`), the plugin fetches data from the Spotify API (cached for 60 s) and generates HTML for all 4 layout sizes. `/markup` always answers 200 with a screen: data, a "connect" prompt, or an error screen

### Code layout

| File | Purpose |
|---|---|
| `server.js` | Express routes (install, webhooks, OAuth, settings page, `/markup`) |
| `src/spotify.js` | Spotify token and API calls, response parsers |
| `src/service.js` | Token refresh, caching, stale fallback; decides connected / unavailable / ok |
| `src/view.js` | View model for the screens |
| `src/markup.js` | Pure markup builders for the four layouts (all external text escaped, braces included) |
| `src/pages.js` | Settings and error pages |
| `src/store.js` | `data/connections.json` persistence |
| `test/` | `node --test` suite and Spotify fixtures |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/install` | GET | TRMNL OAuth2 installation entry |
| `/webhooks/install-success` | POST | TRMNL post-installation webhook |
| `/webhooks/uninstall` | POST | TRMNL cleanup webhook |
| `/manage` | GET | Plugin settings page |
| `/manage/save` | POST | Save user settings |
| `/spotify/authorize` | GET | Start Spotify OAuth2 flow |
| `/spotify/callback` | GET | Spotify OAuth2 callback |
| `/spotify/disconnect` | POST | Disconnect Spotify account |
| `/markup` | POST | Generate screen markup |
| `/health` | GET | Health check |

## Deployment

Pushes to `main` are tested (`npm test` runs the `node --test` suite, then starts the server and checks `/health`) and scanned for vulnerable dependencies and committed secrets (Trivy), then
deployed by GitHub Actions (`.github/workflows/deploy.yml`), which runs `deployment/deploy.sh` on the server. The
server connection comes from repository secrets.

The systemd unit and nginx config are in `deployment/`.

## License

MIT - see [LICENSE](LICENSE).
