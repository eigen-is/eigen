# No default: .bun-version is the one pin, read by the launcher, CI and the host alike.
ARG BUN_VERSION

# Only the manifests, so the install layer below stays cached until a dependency changes. Without the release version
# too, which the lockfile does not hold and every release bumps.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp --parents package.json bun.lock .bun-version apps/*/package.json packages/*/package.json /out/ \
    && sed -i '/^  "version": /d' /out/package.json

FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app

# Runtime deps + build tools for native modules (sharp, etc.)
RUN apt-get update && apt-get install -y \
    libvips \
    libimage-exiftool-perl \
    python3-venv \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz-subset0 \
    ffmpeg \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# WeasyPrint from PyPI, pinned with every dependency by hash, so the image renders a PDF with the engine development
# does. Debian's 62 has no URLFetcher for weasyprint-render.py and draws a centred figure left-aligned. Wheels only, so
# no compiler.
COPY docker/api/weasyprint-requirements.txt /tmp/
RUN python3 -m venv /opt/weasyprint \
    && /opt/weasyprint/bin/pip install --no-cache-dir --require-hashes --only-binary :all: \
        -r /tmp/weasyprint-requirements.txt \
    && /opt/weasyprint/bin/pip uninstall --yes pip \
    && ln -s /opt/weasyprint/bin/weasyprint /usr/local/bin/weasyprint \
    && rm /tmp/weasyprint-requirements.txt

ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0

COPY --from=manifests /out/ ./

RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

# A system library WeasyPrint needs and the image lacks fails the build here, not a PDF export.
RUN printf '<p>x</p>' | /opt/weasyprint/bin/python3 -I apps/api/src/lib/export/weasyprint-render.py > /tmp/smoke.pdf \
    && head -c 5 /tmp/smoke.pdf | grep -qx '%PDF-' \
    && rm /tmp/smoke.pdf

# /run/eigen keeps the control socket out of data/ and away from host users.
RUN mkdir -p /app/data/home /app/data/server /app/backups /run/eigen \
    && chown 1000:1000 /run/eigen \
    && chmod 0700 /run/eigen

ENV EIGEN_CONTROL_SOCKET=/run/eigen/control.sock

ARG EIGEN_REGISTRY=ghcr.io/eigen-is/eigen
ARG EIGEN_VERSION
ARG EIGEN_COMMIT
ARG EIGEN_BUILT_AT
# main on a build of main, empty on a release: bootstrap pins it, status names it.
ARG EIGEN_CHANNEL
ENV EIGEN_REGISTRY=${EIGEN_REGISTRY} \
    EIGEN_COMMIT=${EIGEN_COMMIT} \
    EIGEN_CHANNEL=${EIGEN_CHANNEL} \
    EIGEN_BUILT_AT=${EIGEN_BUILT_AT}
LABEL org.opencontainers.image.title="Eigen API" \
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
