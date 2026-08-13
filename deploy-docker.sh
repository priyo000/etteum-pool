#!/bin/bash

# Etteum Pool Docker Deployment Script
# Usage: ./deploy-docker.sh

set -e

echo "🚀 Deploying Etteum Pool with Docker..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p data logs

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from template..."
    cat > .env << 'EOF'
# Core ports
PORT=1930
DASHBOARD_PORT=1931

# API key
API_KEY=pool-proxy-secret-key

# Database
DATABASE_PATH=./data/poolprox3.db

# Encryption key (generate with: openssl rand -hex 16)
ENCRYPTION_KEY=

# Auth bot
AUTH_SCRIPT_PATH=./scripts/auth/login.py
PYTHON_PATH=python3
AUTH_SCRIPT_CWD=./scripts/auth

# Browser
BROWSER_ENGINE=camoufox
HEADLESS=true

# Proxy (optional)
PROXY_URL=

# VCC
KIRO_PRO_UPGRADE=false
EOF
    echo "✅ .env file created. Please edit it with your settings."
    echo ""
fi

# Build and start
echo "🔨 Building Docker image..."
docker-compose build

echo "🏃 Starting containers..."
docker-compose up -d

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Access points:"
echo "   Backend API: http://localhost:1930"
echo "   Dashboard:   http://localhost:1931"
echo ""
echo "📝 Useful commands:"
echo "   View logs:      docker-compose logs -f"
echo "   Stop:           docker-compose down"
echo "   Restart:        docker-compose restart"
echo "   Rebuild:        docker-compose up -d --build"
echo ""
