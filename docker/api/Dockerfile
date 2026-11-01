# No default: .bun-version is the one pin, read by the launcher, CI and the host alike.
ARG BUN_VERSION

# Only the manifests and patches/, so the install layer below stays cached until a dependency changes. Without the
# release version too, which the lockfile does not hold and every release bumps.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp -r --parents package.json bun.lock .bun-version patches apps/*/package.json packages/*/package.json /out/ \
    && sed -i '/^  "version": /d' /out/package.json

FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app

# Runtime deps. No compiler, since the install runs no scripts. No libvips or ImageMagick: sharp ships its own binary
# with its own libvips, and nothing else calls them. No recommended packages: they bring fonts, and production would
# then draw some text in another font than dev and CI. Ghostscript's Droid Sans Fallback once printed its Chinese.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libimage-exiftool-perl \
    python3-venv \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz-subset0 \
    ffmpeg \
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

# librsvg draws an SVG's text in the system's fonts. The image's only other font is DejaVu, which fontconfig needs, and
# it is wider than Eigen's and has no Chinese or Korean. An SVG's thumbnail and its PNG fallback in an Office file, such
# as a canvas selection pasted into a doc, draw Eigen-font text. So the image carries each Eigen font's regular and its
# bold, the 600 a bold label takes.
COPY packages/ui/src/assets/fonts/inter/Inter-Regular.ttf \
    packages/ui/src/assets/fonts/inter/Inter-Bold-renamed.ttf \
    packages/ui/src/assets/fonts/source-serif/SourceSerif4-Regular.ttf \
    packages/ui/src/assets/fonts/source-serif/SourceSerif4-Bold.ttf \
    packages/ui/src/assets/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf \
    packages/ui/src/assets/fonts/jetbrains-mono/JetBrainsMono-Bold-renamed.ttf \
    packages/ui/src/assets/fonts/excalifont/Excalifont-Regular.ttf \
    /usr/share/fonts/truetype/eigen/
# Chinese and Korean draw in Noto's slices. sharp's own libvips has no brotli, so its FreeType can't read a WOFF2 and
# would draw boxes. So the venv's fontTools writes each slice as TrueType, and a bind mount keeps the WOFF2s out of
# this layer.
RUN --mount=type=bind,source=packages/ui/src/assets/fonts,target=/tmp/fonts \
    /opt/weasyprint/bin/python3 -I -c 'import pathlib, sys; from fontTools.ttLib.woff2 import decompress; \
        [decompress(f, f"/usr/share/fonts/truetype/eigen/{pathlib.Path(f).stem}.ttf") for f in sys.argv[1:]]' \
        /tmp/fonts/noto-sans-sc/*.woff2 /tmp/fonts/noto-sans-kr/*.woff2 \
    && fc-cache /usr/share/fonts/truetype/eigen

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
