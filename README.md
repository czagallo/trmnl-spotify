# TRMNL Spotify Plugin

A [TRMNL](https://usetrmnl.com) marketplace plugin that displays your Spotify listening stats on your e-ink display.

## Features

- **Top Tracks** - Shows your most listened tracks (configurable time range: 4 weeks, 6 months, all time).
- **Top Artists** - Shows your most listened artists with genres.
- **Recently Played** - Shows your last 5 tracks with relative timestamps.
- **Now Playing** - Shows your currently playing track with progress bar (may be outdated between 15-min refreshes).
- All 4 TRMNL layout sizes supported (full, half vertical, half horizontal, quadrant).

## Screenshots

_Coming soon after marketplace approval._

## Setup

### Prerequisites

- A [TRMNL](https://usetrmnl.com) account with a registered plugin
- A [Spotify Developer](https://developer.spotify.com/dashboard) application
- Node.js 18+

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
# Health check
curl http://localhost:3004/health

# Test markup generation
curl -X POST http://localhost:3004/markup \
  -H "Content-Type: application/json" \
  -d '{"user_uuid": "test"}'
```

## How It Works

1. User installs the plugin from the TRMNL marketplace (OAuth2 flow with TRMNL)
2. In the plugin settings, user clicks "Connect Spotify" (OAuth2 flow with Spotify)
3. Plugin stores Spotify tokens and auto-refreshes when expired
4. When TRMNL requests screen content (`POST /markup`), the plugin fetches data from the Spotify API and generates HTML for all 4 layout sizes

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

See the `deployment/` directory for systemd service files, nginx config, and auto-deployment scripts.

## License

MIT - see [LICENSE](LICENSE).
