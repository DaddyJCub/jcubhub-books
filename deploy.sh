#!/bin/bash
# deploy.sh - Deployment script for JcubHub Books v2.0

set -e

echo "🚀 Starting JcubHub Books Deployment..."

# Check if Docker and Docker Compose are installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Determine docker compose command
COMPOSE_CMD="docker compose"
if ! command -v docker compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
fi

# Create necessary directories
echo "📁 Creating project structure..."
mkdir -p backend/data
mkdir -p backend/public/css
mkdir -p backend/public/img

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from template..."
    
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "📝 Created .env from .env.example"
    else
        cat > .env << 'EOF'
# JcubHub Books Configuration
PORT=3003
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
JWT_SECRET=$(openssl rand -base64 32)
ADMIN_EMAIL=admin@jcubhub.com
ZOHO_EMAIL=
ZOHO_PASSWORD=
TURNSTILE_SECRET_KEY=
READARR_URL=
READARR_API_KEY=
CWA_URL=https://cwa.jcubhub.com
CWA_USERNAME=
CWA_PASSWORD=
EOF
    fi
    
    echo ""
    echo "⚠️  Please edit .env file with your actual credentials before continuing."
    read -p "Press Enter to continue after editing .env file..."
fi

# Stop existing containers
echo "🛑 Stopping existing containers..."
$COMPOSE_CMD down 2>/dev/null || true

# Build containers
echo "🐳 Building Docker containers..."
$COMPOSE_CMD build --no-cache

# Start services
echo "🚀 Starting services..."
$COMPOSE_CMD up -d

# Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 5

# Health check
echo "🏥 Running health check..."
for i in {1..10}; do
    if curl -sf http://localhost:3003/api/health > /dev/null 2>&1; then
        echo "✅ Health check passed!"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "⚠️  Health check taking longer than expected..."
    fi
    sleep 2
done

# Check if services are running
if $COMPOSE_CMD ps | grep -q "running\|Up"; then
    echo ""
    echo "✅ Deployment successful!"
    echo ""
    echo "📊 Service Status:"
    $COMPOSE_CMD ps
    echo ""
    echo "🌐 Your application is now available at:"
    echo "   Main Site:      http://localhost:3003"
    echo "   Admin Panel:    http://localhost:3003/admin"
    echo "   API Health:     http://localhost:3003/api/health"
    echo ""
    echo "📝 Useful commands:"
    echo "   View logs:      $COMPOSE_CMD logs -f"
    echo "   Stop services:  $COMPOSE_CMD down"
    echo "   Restart:        $COMPOSE_CMD restart"
    echo ""
else
    echo "❌ Some services failed to start."
    echo "Check logs with: $COMPOSE_CMD logs"
    exit 1
fi

echo "✨ JcubHub Books v2.0 is ready!"
