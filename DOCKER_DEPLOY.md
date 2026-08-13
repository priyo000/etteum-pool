# Etteum Pool Docker Deployment Guide

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/Chimera-pkg/etteum-pool.git
cd etteum-pool

# 2. Make deploy script executable
chmod +x deploy-docker.sh

# 3. Run deployment
./deploy-docker.sh

# 4. Edit .env with your settings
nano .env

# 5. Restart with new config
docker-compose restart
```

## Access Points

- **Backend API**: http://your-server-ip:1930
- **Dashboard**: http://your-server-ip:1931

## Configuration

Edit `.env` file:

```env
# API Key (change this!)
API_KEY=your-secure-api-key-here

# Encryption Key (generate: openssl rand -hex 16)
ENCRYPTION_KEY=your-encryption-key

# Browser Engine
BROWSER_ENGINE=camoufox  # or chromium
HEADLESS=true
```

## Useful Commands

```bash
# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Restart services
docker-compose restart

# Rebuild after code changes
docker-compose up -d --build

# Check status
docker-compose ps

# Enter container
docker-compose exec etteum-pool bash
```

## Data Persistence

- **Database**: `./data/poolprox3.db`
- **Logs**: `./logs/`

Data is persisted in Docker volumes, so it survives container restarts.

## Resource Limits

Edit `docker-compose.yml` to adjust:

```yaml
deploy:
  resources:
    limits:
      memory: 2G  # Increase if needed
    reservations:
      memory: 512M
```

## Troubleshooting

### Port already in use
```bash
# Check what's using the port
sudo lsof -i :1930
sudo lsof -i :1931

# Change ports in .env and docker-compose.yml
```

### Container won't start
```bash
# Check logs
docker-compose logs etteum-pool

# Remove and recreate
docker-compose down
docker-compose up -d
```

### Database locked
```bash
# Stop container
docker-compose down

# Remove database (WARNING: loses data)
rm data/poolprox3.db

# Restart
docker-compose up -d
```

## Production Tips

1. **Change API_KEY** to something secure
2. **Generate ENCRYPTION_KEY**: `openssl rand -hex 16`
3. **Use reverse proxy** (nginx/caddy) with SSL
4. **Monitor logs**: `docker-compose logs -f`
5. **Backup database**: Copy `data/poolprox3.db` regularly

## Nginx Reverse Proxy (Optional)

```nginx
server {
    listen 80;
    server_name pool.yourdomain.com;

    location / {
        proxy_pass http://localhost:1931;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://localhost:1930;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then add SSL with Let's Encrypt:
```bash
sudo certbot --nginx -d pool.yourdomain.com
```
