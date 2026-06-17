# Etteum Pool — VPS Setup Guide

Deploy Etteum Pool ke VPS Ubuntu dengan aaPanel + Cloudflare Tunnel.

**Domain**: `pool.miraya.my.id`  
**Stack**: Ubuntu + Bun + SQLite + Cloudflare Tunnel

---

## 1. Install Etteum di VPS

SSH ke VPS, lalu jalankan:

```bash
# Install Etteum (otomatis install Bun, Python, dll)
curl -fsSL https://raw.githubusercontent.com/levanza1358/etteum-pool/main/install.sh | bash
```

Atau manual:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Clone repo
cd ~
git clone https://github.com/levanza1358/etteum-pool.git
cd etteum-pool

# Install dependencies
bun install
cd dashboard && bun install && bun run build && cd ..

# Setup Python venv untuk auth bot
python3 -m venv scripts/auth/.venv
source scripts/auth/.venv/bin/activate
pip install -r scripts/auth/requirements.txt
python -m playwright install chromium --with-deps
deactivate

# Setup database
bun src/db/migrate.ts

# Copy dan edit .env
cp .env.example .env
nano .env
```

### Konfigurasi `.env`

```bash
# Ports (internal, tidak perlu expose ke public)
PORT=1930
DASHBOARD_PORT=1931

# GANTI dengan key yang kuat!
API_KEY=ganti-dengan-key-rahasia-anda

# Database
DATABASE_PATH=./data/poolprox3.db

# Encryption key (auto-generated oleh installer, atau buat sendiri 32 hex chars)
ENCRYPTION_KEY=your-32-char-hex-key-here

# Browser
BROWSER_ENGINE=camoufox
HEADLESS=true
```

---

## 2. Setup Systemd Service

Buat service supaya Etteum jalan otomatis saat VPS restart:

```bash
sudo nano /etc/systemd/system/etteum.service
```

Isi dengan:

```ini
[Unit]
Description=Etteum Pool - AI Proxy Pool
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/etteum-pool
ExecStart=/root/.bun/bin/bun scripts/production.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=1930
Environment=DASHBOARD_PORT=1931

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable etteum
sudo systemctl start etteum

# Cek status
sudo systemctl status etteum

# Lihat logs
sudo journalctl -u etteum -f
```

---

## 3. Setup Cloudflare Tunnel

Karena cloudflared sudah terinstall dan login, tinggal buat tunnel:

### Buat Tunnel

```bash
# Buat tunnel baru
cloudflared tunnel create etteum

# Catat Tunnel ID yang muncul (misal: abc123-def456-...)
```

### Konfigurasi Tunnel

```bash
nano ~/.cloudflared/config.yml
```

Isi dengan:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  # Dashboard (port 1931) — serve di root
  - hostname: pool.miraya.my.id
    service: http://localhost:1931
    originRequest:
      noTLSVerify: true

  # API (port 1930) — proxy /v1/* dan /api/* ke backend
  # Karena dashboard sudah proxy ke backend via Vite config,
  # kita perlu route API calls juga
  
  # Catch-all
  - service: http_status:404
```

> **Catatan**: Karena pakai 1 domain, dashboard di port 1931 sudah otomatis proxy API calls ke port 1930 (via konfigurasi internal Etteum). Jadi cukup expose port 1931 saja.

**Tapi**, kalau client (Cursor/VS Code) langsung hit API di `/v1/chat/completions`, perlu route ke port 1930. Update config:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  # API endpoints langsung ke backend
  - hostname: pool.miraya.my.id
    path: /v1/*
    service: http://localhost:1930

  - hostname: pool.miraya.my.id
    path: /api/*
    service: http://localhost:1930

  - hostname: pool.miraya.my.id
    path: /ws
    service: http://localhost:1930

  # Semua lainnya ke dashboard
  - hostname: pool.miraya.my.id
    service: http://localhost:1931

  - service: http_status:404
```

### Daftarkan DNS

```bash
cloudflared tunnel route dns etteum pool.miraya.my.id
```

### Jalankan Tunnel sebagai Service

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Cek status
sudo systemctl status cloudflared
```

---

## 4. Verifikasi

```bash
# Test API
curl https://pool.miraya.my.id/api/health

# Test chat completions
curl https://pool.miraya.my.id/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kr-claude-sonnet-4.6","messages":[{"role":"user","content":"Hello"}]}'

# Buka dashboard di browser
# https://pool.miraya.my.id
```

---

## 5. Konfigurasi Client (Cursor/VS Code)

Di Cursor atau VS Code, set:

- **Base URL**: `https://pool.miraya.my.id/v1`
- **API Key**: (API_KEY yang di-set di `.env`)

---

## 6. Update Etteum di VPS

```bash
cd ~/etteum-pool
git pull
bun install
cd dashboard && bun install && bun run build && cd ..
sudo systemctl restart etteum
```

---

## 7. Troubleshooting

### Etteum tidak start
```bash
sudo journalctl -u etteum -n 50 --no-pager
```

### Cloudflare Tunnel error
```bash
sudo journalctl -u cloudflared -n 50 --no-pager
cloudflared tunnel info etteum
```

### Port sudah dipakai
```bash
sudo lsof -i :1930
sudo lsof -i :1931
```

### Reset database
```bash
sudo systemctl stop etteum
rm -f data/poolprox3.db
bun src/db/migrate.ts
sudo systemctl start etteum
```

---

## Catatan Keamanan

1. **Ganti API_KEY** — jangan pakai default `pool-proxy-secret-key`
2. **Jangan expose port 1930/1931** langsung — selalu lewat Cloudflare Tunnel
3. **Firewall** — pastikan port 1930/1931 hanya bisa diakses dari localhost:
   ```bash
   sudo ufw deny 1930
   sudo ufw deny 1931
   sudo ufw allow 22
   sudo ufw enable
   ```
4. **Backup rutin** — gunakan fitur Export di Settings dashboard
