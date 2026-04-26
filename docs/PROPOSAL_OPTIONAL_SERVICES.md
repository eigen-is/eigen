# Proposal: Optional Caddy + Mail Stack for Existing-Server Deployments

> **TLDR**: Make the Docker stack composable so users with an existing webserver and/or mail server on the
> host can opt out of Eigen's `caddy`, `postfix`, and `dovecot` containers. Two axes: **edge** (Caddy) and
> **mail** (postfix + dovecot + Unbound + the Mail app). Implemented via three small mechanisms that work
> together: Docker Compose `profiles` for the container layer, an `EIGEN_API_BIND` env var that exposes
> `eigen-api` to a host-level reverse proxy, and a single `MAIL_APP_ENABLED` feature flag that gates
> `mailRouter` registration in `app.ts`, the Mail tile in the launcher list (`packages/lib/src/core/apps.ts`),
> the `import app mail` line in `Caddyfile`, and the IMAP autoconfig route. Outbound notification mail is
> unaffected — `SMTP_HOST` already routes wherever the deployer wants.

## Goals

1. A user with an existing reverse proxy (nginx, Caddy, Apache, Traefik) on the host can run Eigen without
   the bundled `caddy` container, by binding `eigen-api` to a host port and reverse-proxying to it.
2. A user with an existing mail server on the host (own postfix, or a third-party provider) can run Eigen
   without `postfix` / `dovecot` / `unbound`, with the in-app Mail experience cleanly **disabled** rather
   than half-broken.
3. Eigen still emits its own outbound notifications (welcome, password reset, share invites, calendar
   imip) regardless of which scenario, by relaying through whichever SMTP server `SMTP_HOST` points at.
4. No regressions for the default "all-in-one VPS" deployment path documented in
   [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md).

## Non-goals

- Multi-host / multi-machine deployments. The modularity is about *which services run on this host*, not
  about distributing the stack across machines.
- Plug-in architecture for arbitrary apps. Only the **Mail** app is gated, because it's the only app whose
  backend depends on services (postfix/dovecot) that the host is likely to already provide. Calendar /
  Drive / Docs / etc. are pure-API and have no host-side competitor.
- Replacing `SMTP_HOST` / `SMTP_RELAY_*`. The existing outbound-relay knobs already work; this proposal
  adds toggles for *containers* and the *Mail app*, not the SMTP path.
- Splitting the API binary into separate Docker images per app. The API stays one image; only routes and
  UI visibility are gated.
- Giving Eigen's `postfix` a separate IP so two postfixes can coexist on the same host. That's a real
  scenario but requires host-level network surgery and is documented as the "Flavor 2" follow-up.

## The deployment matrix

Today there is one supported shape: Caddy + API + Postfix + Dovecot + Unbound, all in containers. After
this proposal there are four:

| Scenario | Caddy | Postfix + Dovecot + Unbound | Mail app | `SMTP_HOST` |
|---|---|---|---|---|
| **A. Default** (current) | container | containers | enabled | `postfix` |
| **B. Host webserver** | host (nginx / Caddy / Apache) | containers | enabled | `postfix` |
| **C. Host mail server** | container | host postfix | disabled | `host.docker.internal` |
| **D. Host both** | host webserver | host mail server | disabled | `host.docker.internal` |

Scenarios B and D need the API reachable from the host; C and D need the in-app Mail experience hidden so
users do not see a tile that 5xx's on every click.

## Design

Three small mechanisms working together.

### 1. Docker Compose profiles for optional services

Wrap the optional services in profiles:

```yaml
# docker-compose.yml — relevant excerpts
services:
  caddy:
    profiles: ["edge"]
    # ... existing config

  postfix:
    profiles: ["mail"]
    # ... existing config

  dovecot:
    profiles: ["mail"]
    # ... existing config

  unbound:
    profiles: ["mail"]   # only postfix consumed it; lives in the mail profile
    # ... existing config

  eigen-api:
    # always on — no profile
    ports:
      - "${EIGEN_API_BIND:-127.0.0.1:8000}:8000"
```

Default behaviour is preserved by setting both profiles in `.env.example`:

```bash
COMPOSE_PROFILES=edge,mail
```

| Scenario | `COMPOSE_PROFILES` |
|---|---|
| A. Default | `edge,mail` |
| B. Host webserver | `mail` |
| C. Host mail server | `edge` |
| D. Host both | *(empty)* |

This is the exact pattern Compose was built for; no plugins or third-party tools.

### 2. `EIGEN_API_BIND` for host-proxied deployments

Today `eigen-api` exposes no host port — only the `caddy` container reaches it via the `eigen` Docker
network. For scenarios B and D the host's reverse proxy needs to reach it too. Default the bind to
localhost so it is never internet-exposed by accident:

```yaml
# eigen-api service
ports:
  - "${EIGEN_API_BIND:-127.0.0.1:8000}:8000"
```

```bash
# .env.example
# Bind eigen-api to a host address. Default is localhost-only.
# - With Caddy in the stack (edge profile on): leave as-is. Caddy reaches the API over the docker network.
# - With your own webserver on the host: leave as 127.0.0.1:8000 and reverse-proxy to it.
EIGEN_API_BIND=127.0.0.1:8000
```

The bind is harmless when the `edge` profile is on — Caddy continues to reach the API by its docker
network alias `eigen-api:8000` and ignores the host-side mapping.

#### Reverse-proxy snippets in the setup guide

Add a section to [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md) with copy-pasteable nginx and Caddy
configs for the host. Critical bits for SSE (`/eigen/.../events` endpoints — see
[`SSE.md`](SSE.md) and `apps/api/src/routes/sse.ts`):

```nginx
# /etc/nginx/sites-available/eigen
location /eigen/ {
    proxy_pass http://127.0.0.1:8000/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;            # SSE: stream chunks immediately
    proxy_read_timeout 24h;          # SSE: long-lived connection
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /dav/ {
    proxy_pass http://127.0.0.1:8000/dav/;
    proxy_http_version 1.1;
    proxy_read_timeout 5m;
    proxy_set_header X-Real-IP $remote_addr;
}
```

```caddy
# Host Caddyfile
yourdomain.com {
    encode gzip zstd
    handle /eigen/* {
        reverse_proxy 127.0.0.1:8000 {
            flush_interval -1                  # SSE
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }
    handle /dav/* { reverse_proxy 127.0.0.1:8000 }
    # ... user's own static / app routes ...
}
```

Apache prefork is documented as **not recommended** because of one-process-per-SSE-client; suggest the
event MPM if the user is on Apache.

### 3. `MAIL_APP_ENABLED` feature flag

Disabling the mail containers is half the job. The Mail app frontend, API routes, and IMAP autoconfig also
need to disappear, otherwise scenarios C and D give users:

- A broken Mail tile in the app launcher
- 5xx errors on `/api/mail/*` endpoints
- IMAP autoconfig pointing at a dovecot that isn't running
- A Caddy SPA route serving an app that has no working backend

Introduce a single env var, read at API startup and exposed to the frontend via a small features endpoint:

```bash
# .env.example
MAIL_APP_ENABLED=true
```

| Layer | Where | Behaviour when `false` |
|---|---|---|
| API router | `apps/api/src/app.ts:81` | Skip `.use(mailRouter)`. `/api/mail/*` returns 404. |
| Setup wizard | `apps/api/src/routes/setup.ts` + UI | Skip mail-account creation step for the first admin. |
| Features endpoint | `apps/api/src/routes/setup.ts` (or new `routes/features.ts`) | Returns `{ mail: false }`. |
| App registry | `packages/lib/src/core/apps.ts` (the canonical app list) | Mail entry filtered out — every consumer (launcher, deep-link guards) reads from this list. |
| Notification deep-links | `packages/lib/src/core/notification/resolve-link.ts:124` | Falls back to a non-mail link or hides the notification. |
| `mailto:` shortcuts | `packages/lib/src/core/api.ts:95` (`getMailAppUrl(box/...)`) | Caller checks `features.mail` first; falls back to `mailto:` system handler. |
| Caddy SPA route | `Caddyfile:66` (`import app mail`) | Wrapped in `{$MAIL_APP_ENABLED}` template — or simply omitted, since Caddy is itself optional now. |
| IMAP autodiscovery | `Caddyfile:46` + `docker/caddy/autoconfig.xml` | Skip the `/.well-known/autoconfig/mail/...` route. |
| Background watchers | `apps/api/src/lib/mail/sse-events.ts` and any maildir consumer | Don't initialise. |

The flag does **not** affect outbound notifications. `mailer.ts`
(`apps/api/src/lib/core/mailer.ts:38`) keeps using `SMTP_HOST` regardless — Eigen still sends welcome,
password-reset, share-invite, and iMIP emails through whatever SMTP the deployer points at (host's postfix
in scenarios C/D, the bundled postfix in A/B, a third-party relay if `SMTP_RELAY_HOST` is set).

#### Features endpoint

A single endpoint surfaces the deployment shape to the frontend. The launcher reads it once on app load:

```typescript
// apps/api/src/routes/setup.ts (extend) — or new apps/api/src/routes/features.ts
.get('/setup/features', () => ({
    mail: process.env.MAIL_APP_ENABLED !== 'false',
    // future: every app gets an entry; defaults to true.
}))
```

```typescript
// packages/lib/src/core/features.ts (new)
type EigenFeatures = { mail: boolean };
let cached: Promise<EigenFeatures> | null = null;
export function getFeatures(): Promise<EigenFeatures> {
    cached ??= fetch(getApiUrl('/setup/features')).then(r => r.json());
    return cached;
}
```

```typescript
// packages/lib/src/core/apps.ts — at the bottom, replace the bare export
export async function getEnabledApps() {
    const features = await getFeatures();
    return apps.filter(app => app.name !== 'Mail' || features.mail);
}
```

Existing code that imports `apps` directly is migrated to `getEnabledApps()`. There are only a handful of
consumers (launcher, command palette, switcher) so this is a small sweep.

### Outbound mail in scenarios C and D

When postfix and dovecot are off, `SMTP_HOST=postfix` no longer resolves. Documentation shows three
realistic targets:

| Setup | `SMTP_HOST` | Notes |
|---|---|---|
| Host postfix (Linux) | `host.docker.internal` (or `172.17.0.1`) | Add `extra_hosts: ["host.docker.internal:host-gateway"]` to `eigen-api` for portability. Host postfix needs to allow relay from the docker bridge subnet, or use SMTP submission with auth on 587. |
| Third-party SMTP (Brevo, SendGrid, Postmark) | the relay host | Same as `SMTP_RELAY_HOST` use today, but consumed directly by `mailer.ts`. Auth via `SMTP_RELAY_USER` + `SMTP_RELAY_PASSWORD` (already wired in compose). |
| No outbound at all | unset | `mailer.ts` falls back to `sendmail(1)`, which doesn't exist in the API container — emails fail silently in dev, log error in prod. Document that `SMTP_HOST` is effectively required when `MAIL_APP_ENABLED=false`. |

### TLS certs in scenarios B and D

When Caddy is off, `docker/caddy/export-certs.sh` doesn't run, so `./data/certs/` stays empty and postfix /
dovecot can't read certs for IMAPS / SMTPS. Two paths:

1. **Reuse host's certs.** Document a `docker-compose.host-certs.yml` overlay that mounts the host's
   Let's Encrypt directory into the cert volume:

   ```yaml
   # docker-compose.host-certs.yml
   services:
     postfix:
       volumes:
         - /etc/letsencrypt/live/${DOMAIN}:/certs:ro
     dovecot:
       volumes:
         - /etc/letsencrypt/live/${DOMAIN}:/certs:ro
   ```

   The user runs `docker compose -f docker-compose.yml -f docker-compose.host-certs.yml up -d`.

2. **`certbot` sidecar.** A tiny container that runs `certbot certonly --webroot` against the host
   webserver's webroot, writing to the shared `./data/certs/` volume. Out of scope for v1; mention as
   future work.

In scenario D (mail off, edge off) the cert problem disappears — there's nothing TLS-terminating inside
Docker.

## Setup wizard impact

The current setup wizard (`apps/api/src/routes/setup.ts:21` + corresponding UI) creates the first admin's
mail account. With `MAIL_APP_ENABLED=false` that step should be skipped. The simplest cut:

- Wizard reads `getFeatures()` on load and conditionally renders / runs the mail-account step.
- The first-admin user row is still created; only **mailbox provisioning** is gated.

Existing users on a converted-to-no-mail deployment retain whatever Maildir they had on disk (it just
isn't served). Switching the flag back to `true` re-exposes their old mail without surgery — important for
users who are evaluating both modes.

## Documentation impact

| File | Change |
|---|---|
| [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md) | Add **"Deploying alongside an existing webserver"** + **"Deploying alongside an existing mail server"** sections, each with end-to-end example (env vars, profiles, host config snippet, MX records). |
| [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | Update the architecture diagram and "Current State" table to mark optional services. Add the deployment matrix from this proposal. |
| [`docker/LOCAL-TESTING.md`](../docker/LOCAL-TESTING.md) | Note `COMPOSE_PROFILES` defaults to all-services for local; one-line how to test the host-proxy / no-mail variants. |
| [`.env.example`](../.env.example) | Add `EIGEN_API_BIND`, `MAIL_APP_ENABLED`, `COMPOSE_PROFILES` with comments explaining each scenario. |

## File reference

| File | Path | Status |
|---|---|---|
| Compose profiles | `docker-compose.yml` | edit |
| Compose dev overrides (set profiles, add `extra_hosts`) | `docker-compose.dev.yml` | edit |
| Env example | `.env.example` | edit |
| API host bind | `docker-compose.yml` (`eigen-api.ports`) | edit |
| Mail flag in API | `apps/api/src/app.ts:81` (gate `.use(mailRouter)`) | edit |
| Features endpoint | `apps/api/src/routes/setup.ts` (or new `routes/features.ts`) | edit / new |
| Frontend features helper | `packages/lib/src/core/features.ts` | new |
| App registry filter | `packages/lib/src/core/apps.ts` (add `getEnabledApps`) | edit |
| Launcher / switcher consumers of `apps` | various — sweep | edit |
| Notification deep-link guard | `packages/lib/src/core/notification/resolve-link.ts` | edit |
| Caddy SPA + autoconfig conditional | `Caddyfile` | edit |
| Setup wizard skip step | `apps/api/src/routes/setup.ts` + wizard UI | edit |
| Setup guide — host webserver section | `docker/SETUP-GUIDE.md` | edit (new section) |
| Setup guide — host mail server section | `docker/SETUP-GUIDE.md` | edit (new section) |
| Deployment doc — matrix | `docs/DEPLOYMENT.md` | edit |
| Host-cert overlay | `docker-compose.host-certs.yml` | new (optional) |

## Phased plan

| Phase | Scope | Effort |
|---|---|---|
| 1 | Compose profiles + `EIGEN_API_BIND`. Reverse-proxy snippets in setup guide. No API code change yet — Mail still appears in scenarios B/D and works, since postfix/dovecot still run there. | S |
| 2 | `MAIL_APP_ENABLED` flag. Gate `mailRouter`, add `/setup/features`, `getEnabledApps()` filter, sweep consumers of the `apps` array. Notification deep-link guards. | M |
| 3 | Setup wizard skips mail-account creation when flag is off. End-to-end docs for scenarios C/D. | S |
| 4 (optional) | Host-cert mount overlay (`docker-compose.host-certs.yml`) with worked example. `certbot` sidecar example. | S |
| 5 (future) | Generalize the feature-flag pattern: every app exposes `enabled` so admins can disable Calendar / Sheets / etc. for their deployment. | M |

## Open questions

1. **Persist the flag in `config.json` instead of env?** Today config splits between env (`DOMAIN`,
   secrets, infrastructure) and `data/server/settings.json` (runtime-tunable knobs — see
   [`SERVER-SETTINGS.md`](SERVER-SETTINGS.md)). `MAIL_APP_ENABLED` is a deployment shape, not a runtime
   knob, so env feels right. But landing it in `config.json` would let admins flip it from the Admin app
   without redeploying — worth considering once Phase 5 generalises the pattern.
2. **Inbound to the subdomain via host postfix.** If a user wants `alice@eigen.example.com` mailboxes
   served by Eigen *while* the host runs its own postfix, the host postfix has to forward mail for the
   subdomain into Eigen via LMTP. Cleanly out of scope for this proposal (covered as "Flavor 2" in the
   chat that produced it), but worth a follow-up doc.
3. **Should `MAIL_APP_ENABLED=false` survive a future "Eigen mail on a spare IP" feature?** Current
   proposal says the flag is binary on/off for the whole subsystem. If a spare-IP scenario lands later,
   it wants the flag on plus a new `EIGEN_MAIL_BIND_IP=...` knob — additive, not conflicting.
4. **Default for `EIGEN_API_BIND` in dev compose.** Local tests run via `bun run` outside Docker. The bind
   only matters for the production compose; dev keeps no host port.

## See also

- [DEPLOYMENT.md](DEPLOYMENT.md) — current Docker architecture (gets updated by this proposal)
- [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md) — VPS deployment guide that gains two new sections
- [SSE.md](SSE.md) — why reverse-proxy buffering must be off and timeouts must be long
- [IMAP.md](IMAP.md) — Maildir + Dovecot wiring (the half of Mail that the flag turns off)
- [SERVER-SETTINGS.md](SERVER-SETTINGS.md) — runtime settings store; potential home for `MAIL_APP_ENABLED`
  if open question 1 lands that way
- [TODO-MAIL.md](TODO-MAIL.md) — known mail-stack gaps; this proposal is orthogonal but should land before
  any of the larger mail-feature work
