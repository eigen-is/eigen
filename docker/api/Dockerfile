# No default: .bun-version is the one pin (Bun 1.4.2 blows past memory late in the API suite).
ARG BUN_VERSION

# Only the manifests, so the install layer below stays cached until a dependency changes.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp --parents package.json bun.lock .bun-version apps/*/package.json packages/*/package.json /out/

FROM oven/bun:${BUN_VERSION}-slim

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

COPY --from=manifests /out/ ./

RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

# /run/eigen keeps the control socket out of data/ and away from host users.
RUN mkdir -p /app/data/home /app/data/server /app/backups /run/eigen \
    && chown 1000:1000 /run/eigen \
    && chmod 0700 /run/eigen

ENV EIGEN_CONTROL_SOCKET=/run/eigen/control.sock

ARG EIGEN_REGISTRY=ghcr.io/eigen-is
ARG EIGEN_VERSION
ARG EIGEN_COMMIT
ARG EIGEN_BUILT_AT
ENV EIGEN_REGISTRY=${EIGEN_REGISTRY} \
    EIGEN_COMMIT=${EIGEN_COMMIT} \
    EIGEN_BUILT_AT=${EIGEN_BUILT_AT}
LABEL org.opencontainers.image.title="eigen-api" \
      org.opencontainers.image.description="Eigen API server: the backend every Eigen app talks to." \
      org.opencontainers.image.url="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.version="${EIGEN_VERSION}" \
      org.opencontainers.image.revision="${EIGEN_COMMIT}"

WORKDIR /app/apps/api

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:8000/health || exit 1

ENTRYPOINT ["/app/docker/api/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
