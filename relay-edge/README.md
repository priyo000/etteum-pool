# Etteum Pool — Edge Relay

Deploy a free edge relay to expose your local pool to the internet with a stable URL.
No port forwarding needed — just deploy one of these to a free edge platform.

```
┌──────────┐     HTTPS      ┌──────────────┐     HTTPS      ┌─────────────┐
│  Client  │ ──────────────► │  Edge Relay  │ ──────────────► │ etteum-pool │
│ (Cursor) │ ◄────stream──── │  (Vercel/    │ ◄────stream──── │  (local +   │
└──────────┘                 │  Deno/CF)    │                 │ cloudflared)│
                             └──────────────┘                 └─────────────┘
```

## Quick Comparison

| Platform | Free Tier | Latency | Deploy |
|----------|-----------|---------|--------|
| **Vercel** | 100GB bandwidth/mo | ~50ms | `vercel deploy` |
| **Deno Deploy** | 100K req/day | ~30ms | `deployctl deploy` |
| **CF Workers** | 100K req/day | ~20ms | `wrangler deploy` |

## Setup Flow

1. **Start your pool** with cloudflared tunnel:
   ```bash
   # In etteum-pool dashboard: API → Relay → Enable Tunnel
   # Or via API:
   curl -X POST http://localhost:1930/api/relay/tunnel/enable \
     -H "Authorization: Bearer YOUR_API_KEY"
   # → Returns: https://abc-xyz.trycloudflare.com
   ```

2. **Deploy edge relay** (pick one):

3. **Point your AI tool** to the edge relay URL

---

## Vercel Edge

```bash
cd relay-edge/vercel
npm install

# Set your pool URL (from step 1)
vercel env add POOL_URL  # paste: https://abc-xyz.trycloudflare.com

# Optional: add relay-level auth
vercel env add RELAY_KEY  # any secret string

# Deploy
vercel deploy --prod
```

**Result:** `https://your-project.vercel.app/v1`

### Cursor config:
```
Base URL: https://your-project.vercel.app/v1
API Key: your-pool-api-key
```

---

## Deno Deploy

```bash
cd relay-edge/deno

# Option A: Deploy via CLI
POOL_URL=https://abc-xyz.trycloudflare.com deployctl deploy --project=my-relay relay.ts

# Option B: Connect GitHub repo to dash.deno.com
# Set env vars in the dashboard: POOL_URL, RELAY_KEY (optional)
```

**Result:** `https://my-relay.deno.dev/v1`

---

## Cloudflare Workers

```bash
cd relay-edge/cloudflare-worker
npm install

# Set your pool URL as a secret
npx wrangler secret put POOL_URL
# paste: https://abc-xyz.trycloudflare.com

# Optional auth
npx wrangler secret put RELAY_KEY

# Deploy
npx wrangler deploy
```

**Result:** `https://etteum-relay.YOUR_SUBDOMAIN.workers.dev/v1`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POOL_URL` | Yes | Your pool backend URL (cloudflared tunnel or direct) |
| `RELAY_KEY` | No | Extra auth layer — client must send `x-relay-key` header |

---

## How It Works

The edge relay is a simple reverse proxy:
1. Client sends request to edge relay (e.g., `POST /v1/chat/completions`)
2. Edge relay forwards it to `POOL_URL/v1/chat/completions`
3. Pool processes the request (load balancing, RTK compression, etc.)
4. Response streams back through the relay to the client

**Streaming works perfectly** — SSE responses are streamed through without buffering.

---

## Tips

- **Stable URL**: Edge relay URL never changes, even if your cloudflared tunnel URL rotates
- **Multiple relays**: Deploy to all 3 platforms for redundancy
- **Custom domain**: All platforms support custom domains (free)
- **No cold start issues**: Edge functions are always warm
- **Global**: Requests are served from the nearest edge location

---

## Updating POOL_URL

When your cloudflared tunnel URL changes (e.g., after restart):

```bash
# Vercel
vercel env rm POOL_URL && vercel env add POOL_URL

# Deno Deploy
# Update in dash.deno.com → Settings → Environment Variables

# CF Workers
npx wrangler secret put POOL_URL
```

Or use the etteum-pool API to auto-update (coming soon).
