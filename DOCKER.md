# Docker Deployment Guide

This guide explains how to build and deploy the Eigen project using Docker.

## Architecture

The Docker setup uses a **local build approach** for optimal efficiency:

**Build Strategy:**
- Applications are built **locally** on your machine using Bun
- Docker images only copy the pre-built artifacts
- Results in smaller images (~250MB total vs ~800MB+)
- Faster Docker builds (seconds vs minutes)
- Leverages local caching and resources

**Services:**
1. **nginx** (~50MB) - Serves pre-built static frontend apps and proxies API/WebSocket
2. **api** (~200MB) - Runs the pre-built Bun backend with production dependencies only

## Prerequisites

- **Bun** (latest version) - [Install from bun.sh](https://bun.sh)
- **Docker** (version 20.10 or higher)
- **Docker Compose** (version 2.0 or higher)

## Environment Configuration

Update `.env.production` with your production URLs:

```env
PRODUCTION=1
API_URL=https://api.eigen.is
VITE_API_HOST=https://api.eigen.is
VITE_APP_SPACE_URL=https://eigen.is/space
VITE_APP_MAIL_URL=https://eigen.is/mail
VITE_APP_CALENDAR_URL=https://eigen.is/calendar
VITE_APP_CONTACTS_URL=https://eigen.is/contacts
VITE_APP_DRIVE_URL=https://eigen.is/drive
VITE_APP_DOCS_URL=https://eigen.is/docs
VITE_APP_STICKIES_URL=https://eigen.is/stickies
```

**Important:** Update these URLs before building!

## Quick Start (Recommended)

Use the automated deployment script:

```bash
chmod +x deploy.sh
./deploy.sh
```

This will:
1. Build all applications locally
2. Create Docker images
3. Start all containers

## Manual Build Process

### Step 1: Build Applications Locally

```bash
chmod +x build-for-docker.sh
./build-for-docker.sh
```

This builds:
- All frontend apps → `./dist/`
- API server → `./apps/api-server/build/`

### Step 2: Build Docker Images

```bash
docker-compose build
```

This is fast since it only copies pre-built files.

### Step 3: Start Containers

```bash
docker-compose up -d
```

## Managing Services

**Start:**
```bash
docker-compose up -d
```

**Stop:**
```bash
docker-compose down
```

**Restart:**
```bash
docker-compose restart
```

**View logs:**
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f api
docker-compose logs -f nginx
```

**Check status:**
```bash
docker-compose ps
```

## Ports

- **Port 80**: nginx (HTTP) - serves frontend apps and proxies API
- **Port 443**: nginx (HTTPS) - for SSL/TLS (requires SSL configuration)
- **Port 8000**: API server (internal only, not exposed to host)

## Volumes

Two volumes are created for data persistence:

- `eigen-data`: Database files
- `eigen-uploads`: User uploaded files

## Application Routes

Once running, access the applications at:

- `http://localhost/` - Index/Home page
- `http://localhost/admin` - Admin setup and dashboard
- `http://localhost/mail` - Mail application
- `http://localhost/contacts` - Contacts application
- `http://localhost/calendar` - Calendar application
- `http://localhost/drive` - Drive application
- `http://localhost/docs` - Docs application
- `http://localhost/stickies` - Stickies application
- `http://localhost/space` - Space application

API is available at `http://localhost/api/*`

## SSL/TLS Configuration

For production with HTTPS, you need to:

1. Update `nginx.conf` to include SSL certificate configuration
2. Mount SSL certificates into the nginx container
3. Update `docker-compose.yml` to mount certificate volumes

Example SSL configuration for `nginx.conf`:

```nginx
server {
    listen 443 ssl http2;
    server_name eigen.is;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    
    # ... rest of configuration
}
```

## Troubleshooting

### Check service health

```bash
docker-compose ps
```

All services should show "healthy" status.

### API server not responding

Check API logs:

```bash
docker-compose logs api
```

Verify the API container is running:

```bash
docker exec eigen-api bun run -e "fetch('http://localhost:8000/health')"
```

### Frontend apps not loading

Check nginx logs:

```bash
docker-compose logs nginx
```

Verify static files were built:

```bash
docker exec eigen-nginx ls -la /usr/share/nginx/html
```

### Rebuild from scratch

Remove all containers, volumes, and images:

```bash
docker-compose down -v
docker rmi eigen/api:latest eigen/nginx:latest
docker-compose build --no-cache
docker-compose up -d
```

## Production Deployment

For production deployment:

1. Update `.env.production` with your production URLs
2. Configure SSL certificates
3. Set up proper firewall rules
4. Consider using Docker secrets for sensitive data
5. Set up automated backups for volumes
6. Configure logging to external services
7. Set resource limits in docker-compose.yml

## Updates

To update the application:

```bash
# Pull latest code
git pull

# Option 1: Use deployment script
./deploy.sh

# Option 2: Manual update
./build-for-docker.sh
docker-compose build
docker-compose up -d
```

Docker Compose will only restart services that have changed.

## Why Local Build?

**Advantages:**
- ✅ **Smaller images**: No build tools (Python, make, g++) in final images
- ✅ **Faster Docker builds**: Seconds instead of minutes
- ✅ **Better caching**: Uses local Bun cache and node_modules
- ✅ **Less resources**: Docker only copies files, doesn't compile
- ✅ **Consistent builds**: Same environment as development

**Image Sizes:**
- nginx: ~50MB (Alpine + static files)
- api: ~200MB (Bun slim + compiled code + prod deps)
- **Total: ~250MB** vs ~800MB+ with in-container builds

## Scripts

- `./build-for-docker.sh` - Build all applications locally
- `./deploy.sh` - Complete deployment (build + Docker + start)

Make scripts executable:
```bash
chmod +x build-for-docker.sh deploy.sh
```
