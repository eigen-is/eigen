FROM oven/bun:1-slim

WORKDIR /app

# Runtime deps + build tools for native modules (sharp, etc.)
RUN apt-get update && apt-get install -y \
    libvips \
    libimage-exiftool-perl \
    weasyprint \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0

COPY . .

RUN bun install --ignore-scripts

RUN mkdir -p /app/data/home /app/data/server

WORKDIR /app/apps/api

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:8000/health || exit 1

CMD ["bun", "run", "--env-file=../../.env.production", "src/index.ts"]
