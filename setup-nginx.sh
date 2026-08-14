#!/bin/bash

# Setup Nginx Reverse Proxy for Etteum Pool
# This script configures nginx to avoid port conflicts

set -e

echo "🔧 Setting up Nginx for Etteum Pool..."

# Check if port 80 is in use
if sudo lsof -i :80 > /dev/null 2>&1; then
    echo "⚠️  Port 80 is already in use!"
    echo ""
    echo "Options:"
    echo "1. Stop the service using port 80"
    echo "2. Use alternative port (8080)"
    echo ""
    read -p "Which option? (1/2): " choice

    if [ "$choice" = "2" ]; then
        echo "📝 Updating docker-compose.yml to use port 8080..."
        sed -i 's/"80:80"/"8080:80"/' docker-compose.yml
        echo "✅ Nginx will now listen on port 8080"
    else
        echo "❌ Please stop the service on port 80 first"
        exit 1
    fi
fi

# Create nginx directory if not exists
mkdir -p nginx

# Check if nginx.conf exists
if [ ! -f nginx/nginx.conf ]; then
    echo "❌ nginx/nginx.conf not found!"
    exit 1
fi

echo "✅ Nginx configuration ready"
echo ""
echo "📊 Access points:"
echo "   Dashboard: http://your-server-ip:80"
echo "   Backend:   http://your-server-ip:80/api"
echo "   Proxy:     http://your-server-ip:80/v1"
echo ""
echo "If port 80 was changed to 8080, use that port instead."
echo ""
echo "🚀 Starting services..."
docker-compose up -d

echo ""
echo "✅ Setup complete!"
echo ""
echo "📝 Useful commands:"
echo "   View logs:      docker-compose logs -f nginx"
echo "   Restart nginx:  docker-compose restart nginx"
echo "   Test config:    docker-compose exec nginx nginx -t"
