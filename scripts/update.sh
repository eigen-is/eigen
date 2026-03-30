#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Pulling latest changes..."
git pull

echo "Loading environment..."
set -a && source .env.production && set +a

echo "Installing dependencies..."
bun install

echo "Building frontend..."
bun run build:prod

echo "Rebuilding containers..."
docker compose up -d --build

echo "Done. Status:"
docker compose ps
