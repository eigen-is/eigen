FROM caddy:2-alpine

# The frontend bundles. Built by `bun run --filter './apps/*' build` before `docker compose
# build`; the Vite output lives in /repo/dist with one subdir per app.
COPY dist/ /www/

# Caddy config + autoconfig template (templated with $MAIL_DOMAIN at request time).
COPY docker/static/Caddyfile /etc/caddy/Caddyfile
COPY docker/caddy/autoconfig.xml /etc/caddy/autoconfig.xml

EXPOSE 8080
