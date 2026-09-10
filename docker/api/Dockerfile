# Pinned, same version as .bun-version (CI) and the host: Bun 1.4.2 blows past memory late in the API suite.
FROM oven/bun:1.3.14-slim

WORKDIR /app

# Runtime deps + build tools for native modules (sharp, etc.)
RUN apt-get update && apt-get install -y \
    libvips \
    libimage-exiftool-perl \
    weasyprint \
    ffmpeg \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0

COPY . .

RUN bun install --frozen-lockfile --ignore-scripts

RUN mkdir -p /app/data/home /app/data/server /app/backups

WORKDIR /app/apps/api

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:8000/health || exit 1

CMD ["bun", "run", "--env-file=../../.env.production", "src/index.ts"]
