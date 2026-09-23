# No default: .bun-version is the one pin.
ARG BUN_VERSION

# Only the manifests, so the install layer below stays cached until a dependency changes.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp --parents package.json bun.lock .bun-version apps/*/package.json packages/*/package.json /out/

FROM oven/bun:${BUN_VERSION}-slim AS builder

WORKDIR /app

COPY --from=manifests /out/ ./

RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

# Relative on purpose: the bundle resolves them against window.location.origin, so one build
# serves the public domain, a LAN IP or a tunnel alike.
ARG VITE_API_HOST=/eigen
ARG VITE_APP_SPACE_URL=/space
ARG VITE_APP_MAIL_URL=/mail
ARG VITE_APP_CALENDAR_URL=/calendar
ARG VITE_APP_CONTACTS_URL=/contacts
ARG VITE_APP_DRIVE_URL=/drive
ARG VITE_APP_DOCS_URL=/docs
ARG VITE_APP_STICKIES_URL=/stickies
ARG VITE_APP_CHAT_URL=/chat
ARG VITE_APP_ADMIN_URL=/admin
ARG VITE_APP_SLIDES_URL=/slides
ARG VITE_APP_SHEETS_URL=/sheets
ARG VITE_APP_VECTOR_URL=/vector
ARG VITE_APP_INDEX_URL=/
# The index prerender writes canonical URLs and sitemap.xml only when DOMAIN is set.
ARG DOMAIN=

RUN bun run --sequential --filter './apps/*' build

FROM caddy:2-alpine

COPY --from=builder /app/dist/ /www/

# Caddyfile serves the edge mode, Caddyfile.static the static mode; autoconfig.xml is templated with
# $MAIL_DOMAIN at request time.
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker/static/Caddyfile /etc/caddy/Caddyfile.static
COPY docker/caddy/autoconfig.xml /etc/caddy/autoconfig.xml
COPY docker/caddy/export-certs.sh /usr/local/bin/export-certs.sh

ARG EIGEN_VERSION
ARG EIGEN_COMMIT
LABEL org.opencontainers.image.title="eigen-frontend" \
      org.opencontainers.image.description="Eigen web apps served by Caddy, with the API reverse proxy and mail autoconfig." \
      org.opencontainers.image.url="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/eigen-is/eigen" \
      org.opencontainers.image.version="${EIGEN_VERSION}" \
      org.opencontainers.image.revision="${EIGEN_COMMIT}"

EXPOSE 8080
