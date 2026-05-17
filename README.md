# PoolProx2

A self-hosted proxy that pools accounts from **Kiro, Kiro Pro, CodeBuddy, Canva, Z.ai, Windsurf, Moclaw, and Codex** behind a single OpenAI-compatible endpoint, with a real-time dashboard for managing accounts, quotas, and traffic.

> One API key in. Many provider accounts out. Round-robin or sequential, with quota tracking, auto-warmup, error recovery, and an Anthropic-compatible streaming endpoint.

## Highlights

- **One OpenAI/Anthropic-compatible endpoint** — point any client (Cline, OpenWebUI, custom apps) at `http://localhost:1630/v1/chat/completions` or `/v1/messages`.
- **Multi-provider account pool** — Kiro, Kiro Pro, CodeBuddy, Canva, Z.ai, Windsurf, Moclaw, Codex.
- **Live dashboard** — accounts, quotas, requests, usage charts, image studio.
- **Auto WarmUp** — global interval, per-provider toggle, live countdown.
- **Auto-login bot** — Camoufox/Chromium based, batch import via `email|password` lines or instant-login via refresh token.
- **Load balancing** — round-robin or sequential, global default with per-provider override.
- **Production runtime** — single Bun process for backend + static dashboard, optional systemd unit included.

## Quick install (one command)

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.ps1 | iex
```

The installer will:

1. Install missing prerequisites (git, Bun, Python 3.10+).
2. Clone the repo to `~/poolprox2` (override with `POOLPROX_HOME=/path/to/install`).
3. Create the Python venv at `scripts/auth/.venv` and install Playwright + Camoufox.
4. Install JS deps and build the dashboard.
5. Generate `.env` with a random `ENCRYPTION_KEY`.
6. Run database migrations (skipped with a warning if PostgreSQL is unreachable).

After it finishes, edit `.env` if needed and start the server:

```bash
cd ~/poolprox2
./poolprox start              # Linux / macOS
.\poolprox.ps1 start          # Windows
```

Dashboard: http://localhost:1631 — Backend: http://localhost:1630

## Manual install

If you prefer to run each step yourself:

```bash
# 1. Prereqs
#    Bun:           https://bun.sh
#    Python 3.10+:  https://python.org
#    PostgreSQL:    https://postgresql.org

# 2. Clone
git clone https://github.com/priyo000/etteum-pool.git poolprox2
cd poolprox2

# 3. JS deps
bun install
(cd dashboard && bun install)

# 4. Python auth bot
python3 -m venv scripts/auth/.venv
scripts/auth/.venv/bin/pip install -r scripts/auth/requirements.txt
scripts/auth/.venv/bin/python -m playwright install chromium
scripts/auth/.venv/bin/python -m camoufox fetch

# 5. Config
cp .env.example .env
# Edit .env — set DATABASE_URL, ENCRYPTION_KEY (32 hex chars), etc.

# 6. DB
createdb pool_proxy
bun run migrate

# 7. Build + run
bun run build
bun start
```

## Configuration

All settings live in `.env`. The defaults match what `install.sh` writes for an in-tree setup.

| Key | Default | Description |
|---|---|---|
| `PORT` | `1630` | Backend / proxy port |
| `DASHBOARD_PORT` | `1631` | Dashboard port |
| `API_KEY` | `pool-proxy-secret-key` | Bearer token clients send to `/v1/*` and `/api/*` |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/pool_proxy` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | random | 32 hex chars, used to encrypt account passwords/tokens at rest |
| `AUTH_SCRIPT_PATH` | `./scripts/auth/login.py` | Auth bot entrypoint |
| `PYTHON_PATH` | `./scripts/auth/.venv/bin/python` | Python interpreter from the venv |
| `BROWSER_ENGINE` | `camoufox` | `camoufox` (anti-detect) or `chromium` |
| `HEADLESS` | `true` | Run the auth browser headless |
| `PROXY_URL` | empty | Outbound proxy for the auth bot |
| `KIRO_PRO_UPGRADE` | `false` | Auto-upgrade kiro-pro after login using VCC pool |

Most runtime settings (load-balancing method, auto-warmup interval, per-provider toggles, billing address) are stored in the `settings` table and edited from the dashboard at **Settings**.

## Daily commands

The repo ships with a small management CLI. After install it's at `./poolprox` (Bash) and `./poolprox.ps1` (PowerShell).

```bash
./poolprox start          # start backend + dashboard in background
./poolprox stop           # stop everything
./poolprox restart        # restart
./poolprox status         # show pids and ports
./poolprox logs           # tail .poolprox.log
./poolprox logs 200       # last 200 lines
./poolprox update         # git pull + bun install + rebuild + restart
./poolprox build          # rebuild dashboard + restart
./poolprox port 1630 1631 # change ports and restart
```

Or use Bun directly:

```bash
bun start            # production (build dashboard if missing, then run)
bun run start:fast   # production (skip dashboard build, use existing dist)
bun run dev          # dev mode with Vite HMR for the dashboard
bun run build        # rebuild dashboard only
bun run migrate      # run drizzle migrations
```

## Using the proxy

PoolProx2 exposes both OpenAI and Anthropic-shaped endpoints. Send the `API_KEY` from `.env` as a bearer token.

### OpenAI-compatible

```bash
curl http://localhost:1630/v1/chat/completions \
  -H "Authorization: Bearer pool-proxy-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kp-auto",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Anthropic-compatible

```bash
curl http://localhost:1630/v1/messages \
  -H "x-api-key: pool-proxy-secret-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kp-auto",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

### Model routing

The model id you pass selects which pool answers the request:

| Prefix / id | Provider |
|---|---|
| `kp-*` (e.g. `kp-auto`, `kp-opus-4.7`) | Kiro Pro |
| `codebuddy-*`, `cb-auto` | CodeBuddy |
| `canva-*` | Canva |
| `glm-*`, `zai-*` | Z.ai |
| `windsurf-*` | Windsurf |
| `moclaw-*`, `mo-auto` | Moclaw |
| `codex-*`, `gpt-5-codex` | Codex (OpenAI) |
| anything else | Kiro |

`/v1/models` returns the full model list aggregated from every provider.

## Adding accounts

Open the dashboard at http://localhost:1631 → **Accounts** → pick a provider card → **Add**.

Three modes:

- **Single** — email + password, runs the login bot once.
- **Bulk** — paste `email|password` per line for batch login.
- **Instant Login** — paste refresh tokens (one per line) for `kiro-pro` and `codex`. No browser needed.

Every provider card has an **Auto WarmUp** toggle. The interval is set in **Settings → Auto WarmUp** (global, in minutes). When enabled, the scheduler calls each provider's health-check on every tick to refresh quotas and recover errored accounts (skips `pending` ones).

## Production deployment

### systemd (Linux user service)

The repo includes [poolprox2.service](poolprox2.service). After install:

```bash
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$HOME/poolprox2|" poolprox2.service
sed -i "s|/home/[^/]*/.bun/bin/bun|$HOME/.bun/bin/bun|"            poolprox2.service

mkdir -p ~/.config/systemd/user
cp poolprox2.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now poolprox2

loginctl enable-linger $USER          # survive logout
journalctl --user -u poolprox2 -f
```

### Updating later

```bash
./poolprox update
```

That runs `git pull`, `bun install`, rebuilds the dashboard, and restarts.

## Troubleshooting

**`bun: command not found` after install.**
Open a new shell or `source ~/.bashrc` (Linux) / `source ~/.zshrc` (macOS). On Windows open a new PowerShell window.

**Migrations fail with `connection refused`.**
PostgreSQL isn't running or `DATABASE_URL` is wrong. Start Postgres, then:

```bash
createdb pool_proxy
bun run migrate
```

**Dashboard shows "Failed to fetch".**
Backend isn't running on `PORT`. Check `./poolprox status` and `./poolprox logs`.

**Auth bot fails with `Camoufox not found`.**
Re-run the browser fetch:

```bash
scripts/auth/.venv/bin/python -m camoufox fetch
```

**Port already in use.**
`./poolprox stop` then `./poolprox start`. Or change ports: `./poolprox port 1630 1631`.

## Repo layout

```
.
├── src/                  Backend (Bun + Hono)
│   ├── api/              REST endpoints (accounts, settings, stats, vcc)
│   ├── auth/             Login + warmup queues, scheduler, runner
│   ├── proxy/            OpenAI/Anthropic adapters, account pool, providers
│   ├── db/               Drizzle schema + migrations
│   └── ws/               WebSocket broadcast
├── dashboard/            React + Vite + Tailwind
├── scripts/              Bun helpers + Python auth bot
│   └── auth/             Playwright/Camoufox login flows per provider
├── services/             Embedded sub-services (windsurf-api)
├── drizzle/              SQL migration files
├── install.sh            One-command installer (Linux/macOS)
├── install.ps1           One-command installer (Windows)
├── poolprox              Bash management CLI
├── poolprox.ps1          PowerShell management CLI
└── poolprox2.service     systemd user unit
```

## License

This project is provided as-is for personal use. Don't use it to abuse third-party services or violate their TOS — that's on you.
