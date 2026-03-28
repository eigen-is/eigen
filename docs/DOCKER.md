# Docker Deployment

> **TLDR**: Local build + Docker copy approach. Frontend apps built locally with Bun into `dist/` and served by nginx.
> API runs from source in a Bun container. Two services: nginx + api. Use `./deploy.sh` for automated deployment.

## Quick Start

```bash
./deploy.sh          # Build + Docker + start (production)
./deploy.sh --local  # Local Docker (uses .env.docker.local)
```

## Architecture

- **nginx** (`eigen/nginx`): Serves pre-built static frontend apps from `dist/`, proxies `/eigen/` to the API backend
- **api** (`eigen/api`): Bun backend running from source with production dependencies

All frontend apps are built locally before Docker build. The `Dockerfile` is a multi-stage build with two targets:
`nginx` (nginx:alpine + `dist/`) and `api` (oven/bun:1-slim + full source + `bun install`).

## Environment Files

| File               | Purpose                                    |
|--------------------|--------------------------------------------|
| `.env`             | Development (localhost with per-app ports)  |
| `.env.docker.local`| Local Docker testing (all apps on port 80)  |
| `.env.eigen`       | Production (eigen.is)                       |
| `.env.production`  | Used by API container at runtime (CMD flag) |

Key variables:

- `PRODUCTION` -- `1` for production, `0` for local Docker testing
- `API_URL` -- Backend URL used server-side (e.g., `http://localhost` in Docker, `https://api.eigen.is` in prod)
- `VITE_API_HOST` -- API URL baked into frontend builds (e.g., `http://localhost/eigen` for Docker)
- `VITE_APP_*_URL` -- Per-app URLs baked into frontend builds (e.g., `http://localhost/mail`)
- `COOKIE_DOMAIN` -- Cookie domain for auth (e.g., `localhost`, `.eigen.is`)

Frontend `VITE_*` vars are baked in at build time, so the `.env` file must be correct before running `build-for-docker.sh`.
The API container reads `.env.production` at runtime via the `--env-file` flag in the Dockerfile CMD.

For local Docker testing, `deploy.sh --local` temporarily swaps `.env` with `.env.docker.local` during the build,
then restores it.

## Build Process

### Automated

```bash
./deploy.sh          # Runs build-for-docker.sh + docker compose build + up
```

### Manual

```bash
# 1. Set environment for the target deployment
cp .env.docker.local .env   # for local testing
# OR ensure .env has production URLs

# 2. Build frontend apps + API bundle
./build-for-docker.sh

# 3. Build Docker images and start
docker compose build
docker compose up -d
```

### Build Scripts

**`build-for-docker.sh`** -- Builds each frontend app individually, then the API:

```
bun --filter './apps/index' build     # Each app builds to dist/{appName}/
bun --filter './apps/mail' build
...
bun --filter './apps/api' buildfordocker  # Bundles API to apps/api/build/
```

**`bun run build:prod`** (root package.json) -- Alternative that builds all apps at once:

```
bun --filter './apps/*' build && bun --filter '@apps/api' buildfordocker
```

The `buildfordocker` script in `apps/api/package.json` runs:

```
bun build --minify --sourcemap --target=bun --external 'node_modules/*' --external 'sharp' --external 'jsdom' --external 'css-tree' src/index.ts --outdir=./build
```

Note: The `setup` app is excluded from `build-for-docker.sh` and nginx routing -- it runs standalone during
initial server setup, not inside Docker.

## Build Artifacts

```
dist/
  index/        # Landing page (served at /)
  mail/         # Email client
  drive/        # File storage
  docs/         # Document editor
  contacts/     # Contact management
  calendar/     # Calendar
  chat/         # Chat
  stickies/     # Kanban boards
  slides/       # Presentations
  sheets/       # Spreadsheets
  space/        # User settings
  people/       # Admin panel
apps/api/build/ # Bundled API server
```

## Docker Compose Services

### api

- Image: `oven/bun:1-slim`
- Port: `8000` (exposed to host for debugging, internal to Docker network)
- Volumes: `eigen-user-data` -> `/app/data/home`, `eigen-server-data` -> `/app/data/server`
- Healthcheck: `GET /health` returns `OK`
- Runtime deps installed in container: `libvips`, `exiftool`, `python3`, `make`, `g++` (for native modules)

### nginx

- Image: `nginx:alpine`
- Ports: `80` (HTTP), `443` (HTTPS, requires SSL config)
- Serves static files from `/usr/share/nginx/html` (copied from `dist/`)
- Proxies `/eigen/*` to `http://api:8000/` (strips the `/eigen/` prefix)
- Depends on API being healthy before starting

## Volumes

| Volume              | Mount Point        | Contents                            |
|---------------------|--------------------|-------------------------------------|
| `eigen-user-data`   | `/app/data/home`   | Per-user data (drives, mail, etc.)  |
| `eigen-server-data` | `/app/data/server` | Server config, auth DB, settings    |

## nginx Routing

The `nginx.conf` maps URL paths to app directories:

| Path           | Serves from              | Fallback SPA            |
|----------------|--------------------------|-------------------------|
| `/`            | `index/index.html`       | --                      |
| `/index/*`     | `index/`                 | `index/index.html`      |
| `/mail/*`      | `mail/`                  | `mail/index.html`       |
| `/drive/*`     | `drive/`                 | `drive/index.html`      |
| `/docs/*`      | `docs/`                  | `docs/index.html`       |
| `/contacts/*`  | `contacts/`              | `contacts/index.html`   |
| `/calendar/*`  | `calendar/`              | `calendar/index.html`   |
| `/chat/*`      | `chat/`                  | `chat/index.html`       |
| `/stickies/*`  | `stickies/`              | `stickies/index.html`   |
| `/slides/*`    | `slides/`                | `slides/index.html`     |
| `/sheets/*`    | `sheets/`                | `sheets/index.html`     |
| `/space/*`     | `space/`                 | `space/index.html`      |
| `/people/*`    | `people/`                | `people/index.html`     |
| `/eigen/*`     | Proxy to API `:8000`     | --                      |
| `/health`      | `200 OK` (nginx itself)  | --                      |

Static assets (js, css, images, fonts) get `Cache-Control: public, immutable` with 1-year expiry.

## Management

```bash
docker compose logs -f          # View logs
docker compose down             # Stop and remove containers
docker compose restart          # Restart
docker compose ps               # Status
docker compose up -d --build    # Rebuild and restart
```

## SSL

Add SSL cert config to `nginx.conf` and mount certs into the nginx container. The docker-compose.yml
already exposes port 443.
