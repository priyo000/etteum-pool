#!/bin/bash

# Setup SSL with Let's Encrypt for Etteum Pool
# Requires: Domain name pointing to your server

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <domain>"
    echo "Example: $0 pool.example.com"
    exit 1
fi

DOMAIN=$1

echo "🔒 Setting up SSL for $DOMAIN..."

# Check if certbot is installed
if ! command -v certbot &> /dev/null; then
    echo "📦 Installing certbot..."
    sudo apt-get update
    sudo apt-get install -y certbot
fi

# Create SSL directory
mkdir -p nginx/ssl

# Stop nginx temporarily
docker-compose stop nginx

# Get certificate (standalone mode)
echo "📜 Obtaining SSL certificate..."
sudo certbot certonly --standalone -d $DOMAIN --agree-tos --email admin@$DOMAIN

# Copy certificates to nginx directory
sudo cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem nginx/ssl/
sudo cp /etc/letsencrypt/live/$DOMAIN/privkey.pem nginx/ssl/
sudo chown -R $USER:$USER nginx/ssl/

# Update nginx config to enable HTTPS
echo "📝 Updating nginx configuration..."
sed -i 's/# server {/server {/g' nginx/nginx.conf
sed -i 's/#     listen 443/    listen 443/g' nginx/nginx.conf
sed -i 's/#     server_name pool.yourdomain.com/    server_name '$DOMAIN'/g' nginx/nginx.conf
sed -i 's/#     ssl_certificate/    ssl_certificate/g' nginx/nginx.conf
sed -i 's/#     ssl_protocols/    ssl_protocols/g' nginx/nginx.conf
sed -i 's/#     ssl_ciphers/    ssl_ciphers/g' nginx/nginx.conf
sed -i 's/#     ssl_prefer_server_ciphers/    ssl_prefer_server_ciphers/g' nginx/nginx.conf

# Uncomment HTTPS locations
sed -i 's/#     # Backend API/    # Backend API/g' nginx/nginx.conf
sed -i 's/#     location \/api/    location \/api/g' nginx/nginx.conf
sed -i 's/#         proxy_pass/        proxy_pass/g' nginx/nginx.conf
sed -i 's/#         proxy_http_version/        proxy_http_version/g' nginx/nginx.conf
sed -i 's/#         proxy_set_header/        proxy_set_header/g' nginx/nginx.conf
sed -i 's/#         proxy_cache_bypass/        proxy_cache_bypass/g' nginx/nginx.conf
sed -i 's/#     # WebSocket/    # WebSocket/g' nginx/nginx.conf
sed -i 's/#     location \/ws/    location \/ws/g' nginx/nginx.conf
sed -i 's/#         proxy_set_header Connection "Upgrade"/        proxy_set_header Connection "Upgrade"/g' nginx/nginx.conf
sed -i 's/#     # Proxy endpoints/    # Proxy endpoints/g' nginx/nginx.conf
sed -i 's/#     location \/v1/    location \/v1/g' nginx/nginx.conf
sed -i 's/#         proxy_buffering/        proxy_buffering/g' nginx/nginx.conf
sed -i 's/#         proxy_cache off/        proxy_cache off/g' nginx/nginx.conf
sed -i 's/#     # Dashboard/    # Dashboard/g' nginx/nginx.conf
sed -i 's/#     location \//    location \//g' nginx/nginx.conf

# Update docker-compose to expose 443
sed -i 's/# - "443:443"/- "443:443"/g' docker-compose.yml
sed -i 's/# - \.\/nginx\/ssl/- .\/nginx\/ssl/g' docker-compose.yml

# Start nginx with SSL
docker-compose up -d nginx

echo ""
echo "✅ SSL setup complete!"
echo ""
echo "🔒 Your site is now accessible via HTTPS:"
echo "   https://$DOMAIN"
echo ""
echo "📝 Auto-renewal:"
echo "   Certbot will auto-renew certificates."
echo "   To test renewal: sudo certbot renew --dry-run"
