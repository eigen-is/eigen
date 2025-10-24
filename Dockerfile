# ============================================
# nginx - Static file server
# ============================================
FROM nginx:alpine AS nginx

COPY nginx.conf /etc/nginx/nginx.conf
# Copy pre-built frontend apps from local dist/
COPY dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

# ============================================
# API Server - Runtime
# ============================================
FROM oven/bun:1-slim AS api
WORKDIR /app

# Install runtime dependencies + build tools for native modules
RUN apt-get update && apt-get install -y \
    libvips \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Tell sharp to use system libvips
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0

# Copy all source code (excluding node_modules via .dockerignore)
COPY . .

# Install dependencies (skip lifecycle scripts to avoid hangs)
RUN bun install --ignore-scripts

# Create data directory
RUN mkdir -p /app/apps/api-server/data

WORKDIR /app/apps/api-server

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun run -e "fetch('http://localhost:8000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "run", "--env-file=../../.env.production", "src/index.ts"]
