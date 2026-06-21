# Etteum Pool (Private)

**AI Proxy Pool for Multiple Providers** — Load balancing, auto-warmup, and credit tracking for Kiro, CodeBuddy, Codex, Canva, Qoder, **GitLab Duo**, and **YouMind** accounts.

> 🔒 **This is the PRIVATE repository.** It includes extra providers (GitLab Duo, YouMind) and debug tooling that are not in the public release at [`etteum-pool`](https://github.com/priyo000/etteum-pool). All install instructions below assume you have SSH access configured for `git@github.com:priyo000/etteum.git`.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun)](https://bun.sh)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://python.org)

---

## ⚡ Quick Start — One Command

### Linux / macOS / WSL

```bash
# Clone first (one-shot pipe-to-bash doesn't work for private repos)
git clone git@github.com:priyo000/etteum.git ~/etteum-pool
cd ~/etteum-pool
bash install.sh
```

### Windows (PowerShell)

```powershell
git clone git@github.com:priyo000/etteum.git $HOME\etteum-pool
cd $HOME\etteum-pool
powershell -ExecutionPolicy Bypass -File install.ps1
```

### Then start the server

```bash
etteum start
```

Open the dashboard at **http://localhost:1931** and you're done.

> **Tip:** the installer is fully idempotent — re-run it any time to pull updates and rebuild.

---

## What the installer does

The installer takes you from a clean machine to a running proxy in one shot:

1. ✅ Installs **Git, Bun, Python 3.10+** (via your distro's package manager)
2. ✅ Clones the repo to `~/etteum-pool` (or `$ETTEUM_HOME`)
3. ✅ Generates a random `ENCRYPTION_KEY` and a fresh `API_KEY` in `.env`
4. ✅ Installs JS deps (root + dashboard) via Bun
5. ✅ Creates a Python venv at `scripts/auth/.venv` and installs requirements
6. ✅ Downloads **Playwright Chromium** + **Camoufox** browsers
7. ✅ Builds the dashboard for production
8. ✅ Runs database migrations
9. ✅ Symlinks the `etteum` CLI into `~/.local/bin`
10. ✅ Runs a **preflight check** — every step is verified before exiting

If anything fails, the installer prints exactly what to do next.

### Supported OS / distros

| OS                 | Package manager used        | Status     |
|--------------------|-----------------------------|------------|
| Ubuntu / Debian    | `apt-get`                   | ✅ Tested  |
| Fedora / RHEL      | `dnf` (fallback `yum`)      | ✅ Tested  |
| Arch / Manjaro     | `pacman`                    | ✅ Tested  |
| openSUSE           | `zypper`                    | ✅ Tested  |
| Alpine             | `apk`                       | ✅ Tested  |
| WSL (any distro)   | inherits Linux              | ✅ Works   |
| macOS              | `brew` (or Xcode CLT)       | ✅ Tested  |
| Windows 10/11      | `winget` → `scoop` → `choco`| ✅ Tested  |

### Installer environment variables

All optional. Set before running for unattended installs.

| Variable                  | Default                       | Purpose                              |
|---------------------------|-------------------------------|--------------------------------------|
| `ETTEUM_HOME`             | `~/etteum-pool`               | Install directory                    |
| `ETTEUM_REPO`             | github.com/priyo000/etteum-pool | Git URL                            |
| `ETTEUM_BRANCH`           | `main`                        | Branch to clone                      |
| `ETTEUM_YES`              | unset                         | `=1` skips the confirmation prompt   |
| `ETTEUM_NO_CLI`           | unset                         | `=1` skips the `~/.local/bin/etteum` symlink |
| `ETTEUM_SKIP_BROWSERS`    | unset                         | `=1` skips Playwright/Camoufox download (use only if you don't need the auth bot) |

```bash
# Example: unattended install into custom path
ETTEUM_HOME=/srv/etteum ETTEUM_YES=1 \
  curl -fsSL https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.sh | bash
```

---

## Manual install

If you prefer doing it by hand:

```bash
# Linux/macOS
git clone https://github.com/priyo000/etteum-pool.git
cd etteum-pool
bash install.sh        # the installer is also the canonical "manual" path

# Windows
git clone https://github.com/priyo000/etteum-pool.git
cd etteum-pool
powershell -ExecutionPolicy Bypass -File install.ps1
```

---

## CLI Commands

After installation, the `etteum` command is on your PATH:

```bash
# Server
etteum start              # Start backend + dashboard in background
etteum stop               # Stop this instance (process-group scoped, safe)
etteum restart            # Stop + start
etteum status             # PID, ports, listening state
etteum dev                # Foreground with HMR (Ctrl-C to quit)

# Logs & maintenance
etteum logs               # Tail logs (follow)
etteum logs 100           # Print last 100 lines
etteum build              # Rebuild dashboard and restart
etteum migrate            # Run DB migrations
etteum doctor             # 🩺 Diagnose installation health
etteum doctor --json      # Same, machine-readable
etteum preflight          # Quick smoke test of installed components

# Configuration
etteum port 8080 8081     # Change ports (rewrites .env, restarts if running)
etteum update             # git pull → install → build → migrate → restart

# Help
etteum help               # Full command reference
```

> **Windows users:** if `etteum` isn't recognised, use `.\etteum.ps1 <cmd>` from the install dir, or add `~\.local\bin` to your PATH.

---

## Usage

### Adding accounts

1. Open the dashboard at **http://localhost:1931**
2. Go to **Accounts** → click **Add Account** for your provider
3. Pick your method:
   - **Bulk Import** — paste `email|password` lines (recommended)
   - **Instant Login** — refresh tokens (Kiro Pro, Codex)
   - **PAT Token** — Personal Access Token (Qoder)
   - **API Key** — for `byok` and `codebuddy-china` providers

### Auto-warmup

1. Go to **Accounts** → toggle **Auto WarmUp** for each provider
2. Set interval in **Settings** (default: 15 minutes)

### Proxy pool (geo-restricted providers)

1. **Proxy Pool** page → add proxies as `protocol://user:pass@host:port`
2. **Settings** → enable proxies

---

## Configuration

The installer creates `.env` for you with sensible defaults. To customise:

```bash
# Server ports
PORT=1930                    # API port
DASHBOARD_PORT=1931          # Dashboard port

# Security (auto-generated by installer — keep safe)
API_KEY=...                  # Random 48-char hex; clients send as Bearer
ENCRYPTION_KEY=...           # Random 32-char hex; encrypts stored tokens

# Database
DATABASE_PATH=./data/poolprox3.db

# Auth bot (Python + Playwright/Camoufox)
PYTHON_PATH=                 # Empty = auto-detect venv path per OS
BROWSER_ENGINE=camoufox      # or chromium
HEADLESS=true

# Optional
PROXY_URL=                   # Global outbound proxy
KIRO_PRO_UPGRADE=false       # Enable Kiro Pro features
```

| Variable          | Default                       | Description                              |
|-------------------|-------------------------------|------------------------------------------|
| `PORT`            | `1930`                        | Backend API port                         |
| `DASHBOARD_PORT`  | `1931`                        | Dashboard web UI port                    |
| `API_KEY`         | random (installer-generated)  | API auth — clients send `Bearer <key>`   |
| `ENCRYPTION_KEY`  | random (installer-generated)  | 32-char hex; encrypts saved tokens       |
| `DATABASE_PATH`   | `./data/poolprox3.db`         | SQLite database location                 |
| `PYTHON_PATH`     | empty (auto-detect)           | Override venv Python — leave empty       |
| `BROWSER_ENGINE`  | `camoufox`                    | `camoufox` (anti-detect) or `chromium`   |
| `PROXY_URL`       | empty                         | Outbound proxy for the auth bot          |
| `KIRO_PRO_UPGRADE`| `false`                       | Auto-upgrade Kiro accounts to Pro        |

---

## API

OpenAI-compatible. The installer prints your `API_KEY` after install — store it.

```bash
# List models
curl http://localhost:1930/v1/models \
  -H "Authorization: Bearer $API_KEY"

# Chat completions
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Stats
curl http://localhost:1930/api/stats \
  -H "Authorization: Bearer $API_KEY"
```

---

## 🩺 Troubleshooting

**First step, always:** run `etteum doctor`. It checks every component and prints a fix-it hint for each problem.

```bash
etteum doctor
```

Sample output:
```
🩺 Etteum Pool — Doctor Report

  ✓  Bun runtime — 1.1.30 at /home/user/.bun/bin/bun
  ✓  Python venv — Python 3.11.5 at scripts/auth/.venv/bin/python
  ✗  Camoufox browser — Browser not fetched
     → Run: scripts/auth/.venv/bin/python -m camoufox fetch
  ✓  .env: ENCRYPTION_KEY — custom key set
  ✓  Database — ./data/poolprox3.db (2.34 MB)

  4 ok   0 warn   1 fail
```

### Common fixes

<details>
<summary><b>Playwright / Camoufox not installed</b></summary>

```bash
# Linux/macOS
scripts/auth/.venv/bin/python -m playwright install chromium
scripts/auth/.venv/bin/python -m camoufox fetch

# Windows
scripts\auth\.venv\Scripts\python.exe -m playwright install chromium
scripts\auth\.venv\Scripts\python.exe -m camoufox fetch
```
</details>

<details>
<summary><b>Port already in use</b></summary>

```bash
# Check who owns it
ss -tlnp | grep 1930          # Linux
lsof -i :1930                 # macOS
netstat -ano | findstr :1930  # Windows

# Or just change the port
etteum port 8080 8081
```
</details>

<details>
<summary><b>Database migration failed</b></summary>

```bash
# Wipe and re-create (loses data)
rm -rf data/poolprox3.db
etteum migrate
```
</details>

<details>
<summary><b>"bun: command not found" after install</b></summary>

The installer adds Bun to your shell rc — you may need a new terminal, or:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

Add that line to `~/.bashrc` / `~/.zshrc` to make it permanent.
</details>

<details>
<summary><b>Windows: <code>python</code> opens Microsoft Store</b></summary>

That's a stub, not a real Python. The installer detects and skips it. If `etteum doctor` still complains, install Python 3.11 explicitly:

```powershell
winget install Python.Python.3.11
# Then re-run the installer
```
</details>

<details>
<summary><b>"python3-venv is not available" on Debian/Ubuntu</b></summary>

```bash
sudo apt install python3-venv python3-pip
# Then re-run install.sh
```
</details>

<details>
<summary><b>Behind a corporate proxy</b></summary>

```bash
# Linux/macOS
export HTTPS_PROXY=http://user:pass@proxy:port
export HTTP_PROXY=$HTTPS_PROXY
bash install.sh

# Windows (PowerShell)
$env:HTTPS_PROXY = "http://user:pass@proxy:port"
$env:HTTP_PROXY = $env:HTTPS_PROXY
.\install.ps1
```
</details>

<details>
<summary><b>Accounts show "Exhausted"</b></summary>

- Wait for auto-warmup to refresh credits, **or**
- Click **Warmup** in the dashboard, **or**
- Check the provider's quota limits — some reset daily, some weekly
</details>

If `etteum doctor` shows everything ✓ but it still doesn't work, open an issue with `etteum logs 200` attached.

---

## Updating

Re-run the installer (it pulls latest, rebuilds, migrates):

```bash
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.sh | bash

# Windows
irm https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.ps1 | iex
```

Or use the CLI:
```bash
etteum update
```

---

## Architecture

### Providers

| Provider          | Auth Method      | Notes                                |
|-------------------|------------------|--------------------------------------|
| **Kiro**          | Email/Password   | Claude Sonnet, free tier             |
| **Kiro Pro**      | Refresh Token    | Claude Opus, higher limits           |
| **CodeBuddy**     | Email/Password   | Multiple models, Tencent Cloud       |
| **CodeBuddy CN**  | API Key          | China region, vision support         |
| **Codex**         | OAuth/Token      | OpenAI / GPT-4o                      |
| **Canva**         | Email/Password   | Image generation (Flux Pro)          |
| **Qoder**         | PAT Token        | Claude models, 1M context, free tier |
| **BYOK**          | API Key          | Bring your own keys (any compatible) |

### Request flow

```
client → /v1/chat/completions → load balancer → provider adapter → provider
                                       ↓
                           dashboard (WebSocket updates)
                                       ↓
                           auto-warmup (periodic health checks)
```

---

## Development

```bash
# Backend with hot reload
bun run dev

# Dashboard with HMR (separate terminal)
cd dashboard && bun run dev
```

### Project structure

```
etteum-pool/
├── src/
│   ├── api/              # API routes (Hono)
│   ├── auth/             # Login automation & warmup
│   ├── db/               # Schema & migrations
│   ├── proxy/            # Provider implementations
│   └── ws/               # WebSocket server
├── dashboard/            # React + Vite + Tailwind
├── scripts/
│   ├── auth/             # Python automation (Playwright + Camoufox)
│   ├── doctor.ts         # Health diagnostic
│   ├── preflight.ts      # Post-install verification
│   └── production.ts     # Production server
├── etteum               # Linux/macOS CLI
├── etteum.ps1           # Windows CLI
├── install.sh           # Linux/macOS installer
└── install.ps1          # Windows installer
```

---

## License

MIT License — see [LICENSE](LICENSE).

---

## Support

- **Issues:** [GitHub Issues](https://github.com/priyo000/etteum-pool/issues)
- **Discussions:** [GitHub Discussions](https://github.com/priyo000/etteum-pool/discussions)

**Made with ❤️ for the AI community**
