#!/usr/bin/env bash
set -e

# Check for --local flag
LOCAL=false
if [[ "$1" == "--local" ]]; then
    LOCAL=true
    echo "🏠 Local Docker Testing Mode"
    echo "============================="
    
    # Backup current .env and use .env.docker.local
    cp .env .env.backup 2>/dev/null || true
    cp .env.docker.local .env
else
    echo "🚀 Eigen Docker Deployment (Production)"
    echo "========================================"
fi

# Build locally
echo ""
echo "Step 1: Building applications locally..."
./build-for-docker.sh

# Build Docker images
echo ""
echo "Step 2: Building Docker images..."
docker-compose build

# Start containers
echo ""
echo "Step 3: Starting containers..."
docker-compose up -d

# Wait for services to be healthy
echo ""
echo "⏳ Waiting for services to start..."
sleep 5

# Show status
echo ""
echo "📊 Container status:"
docker-compose ps

echo ""
echo "✅ Deployment complete!"
echo ""
echo "🌐 Access your applications at:"
echo "   - Home: http://localhost/"
echo "   - Admin: http://localhost/admin"
echo "   - Mail: http://localhost/mail"
echo "   - Contacts: http://localhost/contacts"
echo "   - Calendar: http://localhost/calendar"
echo "   - Drive: http://localhost/drive"
echo "   - Docs: http://localhost/docs"
echo "   - Stickies: http://localhost/stickies"
echo "   - Space: http://localhost/space"
echo ""
echo "📝 View logs: docker-compose logs -f"
echo "🛑 Stop: docker-compose down"

# Restore .env if local mode
if [[ "$LOCAL" == true ]]; then
    echo ""
    echo "🔄 Restoring original .env..."
    mv .env.backup .env 2>/dev/null || true
fi
