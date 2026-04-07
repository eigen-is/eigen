#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Pulling latest changes..."
git pull

echo "Loading environment..."
set -a && source .env.production && set +a

echo "Installing dependencies..."
bun install

echo "Building frontend (sequential)..."
bun run --sequential --filter './apps/*' build

echo "Building API bundle..."
bun --filter '@apps/api' buildfordocker

echo "Setting data directory permissions..."
mkdir -p data
chown -R 1000:1000 data

echo "Rebuilding containers..."
docker compose --env-file .env.production up -d --build

echo "Done. Status:"
docker compose --env-file .env.production ps
