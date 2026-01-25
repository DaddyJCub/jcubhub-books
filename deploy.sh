#!/bin/bash
# deploy.sh - Complete deployment script for JcubHub Books

echo "🚀 Starting JcubHub Books Deployment..."

# Check if Docker and Docker Compose are installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Create project structure
echo "📁 Creating project structure..."
mkdir -p books-landing-page/{img,css,js}
mkdir -p backend
mkdir -p ssl

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from template..."
    cat > .env << 'EOF'
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-specific-password
MONGO_USER=admin
MONGO_PASS=secure-password-here
MONGODB_URI=mongodb://admin:secure-password-here@mongodb:27017/jcubhub-books?authSource=admin
NODE_ENV=production
PORT=3001
ADMIN_EMAIL=admin@jcubhub.com
EOF
    echo "📝 Please edit .env file with your actual credentials"
    read -p "Press enter to continue after editing .env file..."
fi

# Build and start containers
echo "🐳 Building Docker containers..."
docker-compose build

echo "🚀 Starting services..."
docker-compose up -d

# Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 10

# Check if services are running
if docker-compose ps | grep -q "Up"; then
    echo "✅ Services are running!"
    echo ""
    echo "📊 Service Status:"
    docker-compose ps
    echo ""
    echo "🌐 Your application is now available at:"
    echo "   Frontend: http://books.jcubhub.com"
    echo "   Backend API: http://books.jcubhub.com/api"
    echo ""
    echo "📝 Logs can be viewed with: docker-compose logs -f"
else
    echo "❌ Some services failed to start. Check logs with: docker-compose logs"
    exit 1
fi

echo "✨ Deployment complete!"