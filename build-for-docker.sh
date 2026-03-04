#!/usr/bin/env bash
set -e

echo "🔨 Building Eigen for Docker deployment"
echo "========================================"

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "❌ Error: Bun is not installed"
    echo "Install it from: https://bun.sh"
    exit 1
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
bun install

# Build all frontend apps
echo ""
echo "🏗️  Building frontend applications..."
echo "📝 Using environment file: .env"
bun --filter './apps/index' build
bun --filter './apps/mail' build
bun --filter './apps/contacts' build
bun --filter './apps/calendar' build
bun --filter './apps/drive' build
bun --filter './apps/docs' build
bun --filter './apps/stickies' build
bun --filter './apps/space' build
bun --filter './apps/chat' build
bun --filter './apps/slides' build
bun --filter './apps/sheets' build
bun --filter './apps/people' build

# Build API server
echo ""
echo "⚙️  Building API server..."
bun --filter './apps/api' buildfordocker

echo ""
echo "✅ Build completed successfully!"
echo ""
echo "📊 Build artifacts:"
echo "   - Frontend apps: ./dist/"
echo "   - API server: ./apps/api/build/"
echo ""
echo "🐳 Next steps:"
echo "   1. Build Docker images: docker-compose build"
echo "   2. Start containers: docker-compose up -d"
echo "   3. View logs: docker-compose logs -f"
