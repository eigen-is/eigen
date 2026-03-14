# Docker Deployment

> **TLDR**: Local build → Docker copy approach. Frontend built locally with Bun → served by nginx. API runs in Bun
> container. Two services: nginx (~50MB) + api (~200MB). Use `./deploy.sh` for automated deployment.

## Quick Start

```bash
./deploy.sh          # Build + Docker + start
./deploy.sh --local  # Local Docker (localhost)
```

## Architecture

- **nginx**: Serves static frontend, proxies API/WebSocket
- **api**: Bun backend with production dependencies

## Environment

Update `.env` with production URLs before building. For local Docker: `.env.docker.local`.

Key vars: `VITE_API_HOST`, `VITE_APP_*_URL` for each app.

## Manual Build

```bash
./build-for-docker.sh          # Build all apps locally
docker-compose build            # Create images
docker-compose up -d            # Start
```

## Management

```bash
docker-compose logs -f          # View logs
docker-compose down             # Stop
docker-compose restart          # Restart
docker-compose ps               # Status
```

## Ports

- **80**: nginx (HTTP)
- **443**: nginx (HTTPS, requires SSL config)
- **8000**: API (internal only)

## Volumes

- `eigen-data`: Databases
- `eigen-uploads`: User files

## SSL

Add SSL cert config to `nginx.conf`, mount certs into nginx container.
