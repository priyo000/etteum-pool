# Etteum Pool

**AI Proxy Pool for Multiple Providers** — Load balancing, auto-warmup, credit tracking, and token compression for Kiro, CodeBuddy, Codex, Canva, Qoder, and BYOK providers.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun)](https://bun.sh)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://python.org)

---

## Features

- **Multi-Provider Support** — Kiro, Kiro Pro, CodeBuddy, Codex, Canva, Qoder
- **BYOK (Bring Your Own Key)** — Use your own API keys (OpenRouter, Together, Groq, etc.) alongside pool accounts
- **Automatic Load Balancing** — Round-robin and least-connections strategies across healthy accounts
- **Credit Tracking** — Real-time quota monitoring and exhaustion detection
- **Auto-Warmup** — Periodic health checks to keep accounts ready
- **Token Compression** — RTK / DCP / Caveman / TSC / Cache Markers / Image Dedupe pipeline ([docs](docs/compression.md))
- **Model Mapping** — Rewrite CLI model IDs at the proxy edge (e.g. "haiku" routes to "qwen-3.7")
- **Relay Tunnel System** — Expose pool to the internet via Cloudflare Quick Tunnels, no Cloudflare account needed
- **Relay Edge** — Deploy relay workers to Cloudflare Workers, Deno, or Vercel Edge for global distribution
- **Image Studio** — AI image generation chat interface with multi-model support
- **VCC Management** — Virtual credit card management for Kiro Pro upgrades
- **Cross-Platform** — Full Windows, macOS, and Linux support with native launchers
- **Dashboard** — Beautiful web UI for monitoring and management
- **Proxy Pool** — Optional residential proxy support for geo-restricted providers
- **WebSocket Updates** — Real-time status updates in the dashboard
- **Filter Rules** — Custom routing rules for different users/models
- **Usage Analytics** — Track requests, tokens, and costs

---

## Quick Start

### One-Command Install

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.ps1 | iex
```

The installer will:
- Install dependencies (Bun, Python, Playwright, Camoufox)
- Clone the repository
- Configure `.env` with secure encryption key
- Install Node.js and Python packages
- Build the dashboard
- Run database migrations
- Set up CLI commands

### Start the Server

```bash
etteum start
```

### Access the Dashboard

Open your browser to **http://localhost:1931**

---

## Installation

### Prerequisites

- **Bun 1.x** — JavaScript runtime (auto-installed)
- **Python 3.10+** — For browser automation (auto-installed)
- **Git** — For cloning the repo (auto-installed)
- **500MB disk space** — For browsers and dependencies

### Manual Installation

If you prefer manual installation:

```bash
# Clone the repository
git clone https://github.com/priyo000/etteum-pool.git
cd etteum-pool

# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
cd dashboard && bun install && cd ..

# Set up Python environment
python3 -m venv scripts/auth/.venv
source scripts/auth/.venv/bin/activate  # On Windows: scripts\auth\.venv\Scripts\activate
pip install -r scripts/auth/requirements.txt

# Install browsers
python -m playwright install chromium
python -m camoufox fetch

# Configure environment
cp .env.example .env
# Edit .env with your preferred editor

# Build dashboard
cd dashboard && bun run build && cd ..

# Run migrations
bun src/db/migrate.ts

# Start the server
etteum start
```

---

## Usage

### CLI Commands

```bash
etteum start          # Start server in background
etteum stop           # Stop server
etteum restart        # Restart server
etteum status         # Check server status
etteum logs           # View server logs
etteum build          # Rebuild dashboard and restart
etteum dev            # Run in development mode (with hot reload)
etteum migrate        # Run database migrations
```

### Adding Accounts

1. Open the dashboard at **http://localhost:1931**
2. Navigate to **Accounts** page
3. Click **Add Account** for your provider
4. Choose your method:
   - **Bulk Import** — Paste `email|password` lines (recommended)
   - **Instant Login** — Use refresh tokens (Kiro Pro, Codex)
   - **PAT Token** — Personal Access Token (Qoder)
   - **Single Account** — Manual email/password entry

### Using BYOK (Bring Your Own Key)

Add your own API keys for OpenRouter, Together, Groq, or any OpenAI-compatible provider:

1. Go to **Accounts** page, select **BYOK** provider
2. Enter a label (e.g. "openrouter"), your API key, and base URL
3. Specify the models you want available
4. Models appear as `{label}-{model}` (e.g. "openrouter-gpt-4o")

BYOK accounts are routed through the same load balancer and compression pipeline as pool accounts.

### Configuring Auto-Warmup

1. Go to **Accounts** page
2. Toggle **Auto WarmUp** for each provider
3. Set interval in **Settings** (default: 15 minutes)

### Using the Proxy Pool (Optional)

For providers with geo-restrictions (Canva):

1. Go to **Proxy Pool** page
2. Add proxies in format: `protocol://user:pass@host:port`
3. Enable proxies in **Settings**

---

## Model Mapping

Model mapping lets you rewrite incoming model IDs at the proxy edge. This is useful when CLIs hardcode their own model names (e.g. Claude Code sends "claude-3-5-haiku-20241022") but you want to route to different models in your pool.

**How it works:**

1. CLI sends a request with a model ID (e.g. "haiku")
2. The mapping engine checks enabled rules (priority order)
3. Matched rules rewrite the model ID to the configured target (e.g. "qwen-3.7")
4. The rewritten request is routed to the appropriate provider

**Match types:**
- `contains` — model ID contains the source pattern (default)
- `exact` — model ID matches exactly
- `regex` — model ID matches a regular expression

Configure mappings from the dashboard under **Settings > Model Mapping**. Default rules are seeded for Claude Code's haiku/sonnet/opus classes (disabled by default).

---

## Relay & Edge

The relay system exposes your local pool to the internet so remote clients can connect. It has two layers: a Cloudflare tunnel for internet access, and optional edge workers for global distribution.

### Cloudflare Tunnel

The tunnel auto-downloads the `cloudflared` binary and spawns a quick tunnel. No Cloudflare account required.

**Enable via dashboard:** API > Relay > Enable Tunnel

**Enable via API:**
```bash
curl -X POST http://localhost:1930/api/relay/tunnel/enable \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This returns a `*.trycloudflare.com` URL that proxies to your local pool.

**Tunnel features:**
- Auto-download of cloudflared binary (cross-platform)
- Quick tunnel mode (no account, free, ephemeral URL)
- Health checks every 30 seconds
- Watchdog with auto-reconnect on unexpected exit
- Status updates via WebSocket to dashboard

### Relay Modes

The relay has two components that can run independently or together:

| Mode | Description |
|------|-------------|
| `disabled` | Relay off (default) |
| `client` | Connects this pool to a remote relay server |
| `server` | Accepts connections from relay clients |
| `both` | Runs both client and server |

Configure via dashboard or `.env`:
```bash
RELAY_MODE=disabled       # disabled | client | server | both
RELAY_SECRET=your-secret  # shared auth secret
RELAY_SERVER_URL=         # ws://server-host:port/relay/tunnel (client mode)
RELAY_PEER_NAME=          # human-readable name
RELAY_PUBLIC_BASE_URL=    # public URL for server mode
RELAY_MAX_TUNNELS=50      # max connected clients (server mode)
RELAY_AUTO_START=false    # auto-start on server boot
```

### Relay Edge Workers

Deploy a free edge relay to get a stable URL that never changes, even if your cloudflared tunnel URL rotates. The edge relay is a reverse proxy that forwards requests to your pool.

```
Client (Cursor/CLI) --> Edge Relay (Vercel/Deno/CF) --> etteum-pool (local + cloudflared)
```

Available templates in `relay-edge/`:

| Platform | Free Tier | Deploy |
|----------|-----------|--------|
| **Vercel** | 100GB bandwidth/mo | `vercel deploy` |
| **Deno Deploy** | 100K req/day | `deployctl deploy` |
| **Cloudflare Workers** | 100K req/day | `wrangler deploy` |

**Quick setup (Vercel example):**
```bash
cd relay-edge/vercel
npm install
vercel env add POOL_URL  # paste your cloudflared tunnel URL
vercel deploy --prod
```

Then point your AI tool to the edge relay URL:
```
Base URL: https://your-project.vercel.app/v1
API Key: your-pool-api-key
```

See [`relay-edge/README.md`](relay-edge/README.md) for full deployment instructions.

---

## Token Compression

The compression pipeline reduces token usage before sending requests to providers. Techniques run in a specific order for maximum effectiveness:

| Technique | Type | Description |
|-----------|------|-------------|
| **TSC** | Lossless | Tool-schema compaction, strips redundant schema fields |
| **DCP** | Lossless | Dynamic Context Pruning, stubs inactive tool-result blocks |
| **RTK** | Lossy | Real Token Killer, truncates large tool results |
| **Caveman** | Lossy | System-prompt compaction (off by default) |
| **Image Dedupe** | Lossless | Removes duplicate images from conversation history |
| **Cache Markers** | Structural | Tags prefix shape for provider-side prompt caching |

Full documentation: [`docs/compression.md`](docs/compression.md)

---

## Cross-Platform

Etteum Pool runs natively on Windows, macOS, and Linux with dedicated launchers for each platform.

### Platform Launchers

| Platform | Launcher | Install Script |
|----------|----------|----------------|
| **Windows** | `etteum.ps1` (PowerShell), `etteum.cmd` (batch) | `install.ps1` |
| **macOS/Linux** | `etteum` (bash) | `install.sh` |

### Platform Notes

- **SQLite database** — File-based, works everywhere without external database server
- **Python venv** — Auto-detected per platform (`Scripts/python.exe` on Windows, `bin/python` on Unix)
- **Cloudflared binary** — Auto-downloaded for your OS/arch (Windows `.exe`, macOS `.tgz`, Linux binary)
- **Browser automation** — Playwright and Camoufox work cross-platform for login flows

---

## Configuration

Edit `.env` to customize:

```bash
# Server ports
PORT=1930                    # API port
DASHBOARD_PORT=1931          # Dashboard port

# Security
API_KEY=your-secret-key      # API authentication
ENCRYPTION_KEY=...           # Auto-generated, don't change

# Database
DATABASE_PATH=./data/poolprox3.db

# Browser automation
BROWSER_ENGINE=camoufox      # or chromium

# Proxy (optional)
PROXY_URL=                   # Global proxy for outbound requests

# Kiro Pro (optional)
KIRO_PRO_UPGRADE=true        # Enable Kiro Pro features

# Relay (optional)
RELAY_MODE=disabled          # disabled | client | server | both
RELAY_SECRET=                # Shared auth secret
RELAY_SERVER_URL=            # ws://host:port/relay/tunnel
RELAY_AUTO_START=false       # Auto-start on boot
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `1930` | Backend API port |
| `DASHBOARD_PORT` | `1931` | Dashboard web UI port |
| `API_KEY` | `pool-proxy-secret-key` | API authentication key |
| `ENCRYPTION_KEY` | auto-generated | 32-char hex key for encrypting tokens |
| `DATABASE_PATH` | `./data/poolprox3.db` | SQLite database location |
| `BROWSER_ENGINE` | `camoufox` | Browser for login automation |
| `PROXY_URL` | empty | Global proxy for all outbound requests |
| `KIRO_PRO_UPGRADE` | `true` | Enable Kiro Pro features |
| `RELAY_MODE` | `disabled` | Relay mode: disabled, client, server, both |
| `RELAY_SECRET` | empty | Shared secret for relay authentication |
| `RELAY_SERVER_URL` | empty | WebSocket URL for relay client mode |
| `RELAY_PEER_NAME` | empty | Human-readable name for this pool instance |
| `RELAY_PUBLIC_BASE_URL` | empty | Public URL for relay server mode |
| `RELAY_MAX_TUNNELS` | `50` | Max connected relay clients |
| `RELAY_AUTO_START` | `false` | Auto-start relay on server boot |

---

## Architecture

### Providers

| Provider | Auth Method | Features |
|----------|-------------|----------|
| **Kiro** | Email/Password | Claude Sonnet, free tier |
| **Kiro Pro** | Refresh Token | Claude Opus, higher limits |
| **CodeBuddy** | Email/Password | Multiple models, Tencent Cloud |
| **Codex** | OAuth/Token | OpenAI models, GPT-4o |
| **Canva** | Email/Password | Image generation (Flux Pro) |
| **Qoder** | PAT Token | Claude models, job-based auth |
| **BYOK** | API Key | OpenRouter, Together, Groq, any OpenAI-compatible |

### Request Flow

```
User/CLI --> Etteum API (Hono + Bun)
                |
                +-- Load Balancer (round-robin / least-connections)
                |       +-- Account Pool (SQLite-backed)
                |               +-- Provider Adapters (Kiro, CodeBuddy, Codex, Canva, Qoder, BYOK)
                |
                +-- Relay Tunnel (cloudflared quick tunnel)
                |       +-- Relay Edge Workers (Cloudflare/Deno/Vercel)
                |
                +-- WebSocket Server (real-time dashboard updates)
                |
                +-- Model Mapping Engine
                |
                +-- Token Compression Pipeline (RTK / DCP / Caveman / TSC / Cache Markers)
                |
                +-- Filter Rules (RTK shape filters)
                |
                +-- Dashboard (React SPA)
```

**Request lifecycle:**

1. **Ingress** — OpenAI-compatible API receives the request
2. **Model Mapping** — Incoming model ID is rewritten if a mapping rule matches
3. **Account Selection** — Load balancer picks a healthy account with credits
4. **Compression** — Request passes through the compression pipeline (TSC, DCP, RTK, Caveman, Image Dedupe, Cache Markers)
5. **Provider Translation** — Request is transformed to the target provider's format
6. **Streaming** — Response streams back in OpenAI-compatible format
7. **Tracking** — Credit usage and request stats are recorded

### Relay System

```
Remote Client --> Relay Edge (stable URL)
                        |
                        +--> cloudflared tunnel --> Local Pool
```

The relay system has two layers:

- **Tunnel layer** — cloudflared spawns a quick tunnel, exposing the local server at a `*.trycloudflare.com` URL. No account needed.
- **Edge layer** — Optional edge workers (Vercel, Deno, CF Workers) sit in front of the tunnel, providing a stable URL and global edge routing.

---

## API Endpoints

### Chat Completions (OpenAI-compatible)

```bash
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### List Models

```bash
curl http://localhost:1930/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Dashboard Stats

```bash
curl http://localhost:1930/api/stats \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Relay Management

```bash
# Get relay status
curl http://localhost:1930/api/relay \
  -H "Authorization: Bearer YOUR_API_KEY"

# Enable tunnel
curl -X POST http://localhost:1930/api/relay/tunnel/enable \
  -H "Authorization: Bearer YOUR_API_KEY"

# Disable tunnel
curl -X POST http://localhost:1930/api/relay/tunnel/disable \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## Development

### Project Structure

```
etteum-pool/
├── src/
│   ├── api/              # API routes (Hono)
│   │   ├── accounts.ts   # Account management
│   │   ├── image-studio.ts # Image generation chat
│   │   ├── vcc.ts        # Virtual credit card management
│   │   ├── keys.ts       # API key management
│   │   ├── filters.ts    # Filter rule management
│   │   └── relay.ts      # Relay API endpoints (via relay/)
│   ├── auth/             # Login automation & warmup
│   ├── db/               # Database schema & migrations
│   ├── proxy/            # Provider implementations
│   │   ├── providers/    # Provider adapters (kiro, codebuddy, codex, canva, qoder, byok)
│   │   ├── compression/  # Token compression pipeline
│   │   ├── model-mapping.ts # Model ID rewriting
│   │   └── router.ts     # Request routing & load balancing
│   ├── relay/            # Relay client/server/tunnel
│   │   ├── client.ts     # Relay client (connects to remote server)
│   │   ├── server.ts     # Relay server (accepts client connections)
│   │   ├── tunnel/       # Cloudflared integration
│   │   │   ├── cloudflared.ts # Binary download & process management
│   │   │   └── manager.ts     # Tunnel lifecycle & health checks
│   │   └── index.ts      # Relay API router & auto-start
│   ├── ws/               # WebSocket server
│   └── config.ts         # Configuration (env vars)
├── relay-edge/           # Edge deployment templates
│   ├── cloudflare-worker/
│   ├── deno/
│   └── vercel/
├── dashboard/            # React dashboard
│   ├── src/
│   │   ├── components/   # UI components
│   │   ├── pages/        # Page components (Accounts, Relay, ImageStudio, VccPool, etc.)
│   │   └── hooks/        # Custom hooks
│   └── public/           # Static assets
├── scripts/
│   ├── auth/             # Python browser automation
│   └── production.ts     # Production server
├── etteum                # CLI script (bash, Linux/macOS)
├── etteum.ps1            # CLI launcher (PowerShell, Windows)
├── etteum.cmd            # CLI launcher (batch, Windows)
└── install.sh            # Installer (Linux/macOS)
```

### Running in Development Mode

```bash
# Terminal 1: Backend with hot reload
bun run dev

# Terminal 2: Dashboard with HMR
cd dashboard
bun run dev
```

### Building for Production

```bash
cd dashboard
bun run build
cd ..
./etteum start
```

---

## Troubleshooting

### Playwright/Camoufox Not Found

```bash
# Reinstall browsers
source scripts/auth/.venv/bin/activate
python -m playwright install chromium
python -m camoufox fetch
```

### Database Migration Failed

```bash
# Delete database and start fresh
rm -rf data/poolprox3.db

# Run migrations again
bun src/db/migrate.ts
```

### Port Already in Use

```bash
# Check what's using the port
lsof -i :1930  # macOS/Linux
netstat -ano | findstr :1930  # Windows

# Change ports in .env
echo "PORT=1940" >> .env
echo "DASHBOARD_PORT=1941" >> .env
```

### Accounts Show "Exhausted"

- Wait for auto-warmup to refresh credits
- Click **Warmup** button manually
- Check provider's quota limits

### Cloudflared Tunnel Won't Connect

- Check if port 1930 is accessible locally
- Try restarting the tunnel from the dashboard (Relay page)
- Check logs for download errors: `etteum logs`

---

## Updating

Re-run the installer to pull latest changes:

```bash
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.sh | bash

# Windows
irm https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.ps1 | iex
```

Or manually:

```bash
cd ~/etteum-pool
git pull
bun install
cd dashboard && bun install && bun run build && cd ..
etteum restart
```

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Support

- **Issues**: [GitHub Issues](https://github.com/priyo000/etteum-pool/issues)
- **Discussions**: [GitHub Discussions](https://github.com/priyo000/etteum-pool/discussions)
