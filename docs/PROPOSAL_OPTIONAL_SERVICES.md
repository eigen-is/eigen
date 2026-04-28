# Proposal: Optional Caddy + Mail Stack for Existing-Server Deployments

> **TLDR**: Make the Docker stack composable so users with an existing webserver and/or mail server on the
> host can opt out of Eigen's `caddy`, `postfix`, and `dovecot` containers, and decouple the mail domain
> from the web domain so the apps can live at `eigen.example.com` while mail stays at `@example.com`. Two
> service axes (**edge** Caddy, **mail** postfix+dovecot+Unbound) and one domain axis. Implemented via
> four small mechanisms: Docker Compose `profiles` for the container layer, an `EIGEN_API_BIND` env var
> that exposes `eigen-api` to a host-level reverse proxy, a single `MAIL_APP_ENABLED` flag that gates the
> in-app Mail experience and inbound delivery (Maildir, IMAP autoconfig, the launcher tile) but **not**
> outbound SMTP, and a `MAIL_DOMAIN` env var that lets mail addresses live at the apex while the web UI
> lives at a subdomain. Outbound mail (welcome, password reset, share invites, calendar iMIP, Drive
> emailCollaborators) is unaffected by `MAIL_APP_ENABLED` — it keeps working as long as `SMTP_HOST`
> resolves to something.

## Goals

1. A user with an existing reverse proxy (nginx, Caddy, Apache, Traefik) on the host can run Eigen without
   the bundled `caddy` container, by binding `eigen-api` to a host port and reverse-proxying to it.
2. A user with an existing mail server on the host (own postfix, or a third-party provider) can run Eigen
   without `postfix` / `dovecot` / `unbound`, with the in-app Mail experience cleanly **disabled** rather
   than half-broken.
3. Eigen still emits its own outbound notifications (welcome, password reset, share invites, calendar
   iMIP, Drive share-by-email) regardless of which scenario, by relaying through whichever SMTP server
   `SMTP_HOST` points at.
4. No regressions for the default "all-in-one VPS" deployment path documented in
   [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md).
5. A user can deploy with the web UI at a subdomain (`eigen.example.com`) and mail addresses at the apex
   (`@example.com`), without forcing every user's address onto the subdomain.

## Non-goals

- Multi-host / multi-machine deployments. The modularity is about *which services run on this host*, not
  about distributing the stack across machines.
- Plug-in architecture for arbitrary apps. Only the **Mail** app is gated, because it's the only app whose
  backend depends on services (postfix/dovecot) that the host is likely to already provide. Calendar /
  Drive / Docs / etc. are pure-API and have no host-side competitor.
- Replacing `SMTP_HOST` / `SMTP_RELAY_*`. The existing outbound-relay knobs already work; this proposal
  adds toggles for *containers*, the *Mail app*, and *which domain mail lives on*, not the SMTP path.
- Splitting the API binary into separate Docker images per app. The API stays one image; only routes,
  background services, and UI visibility are gated.
- Giving Eigen's `postfix` a separate IP so two postfixes can coexist on the same host. That's a real
  scenario but requires host-level network surgery and is deferred as the "Flavor 2" follow-up.
- **Multi-domain mail** (`alice@example.com` AND `bob@anotherdomain.com` on the same instance). Today's
  data model assumes a single mail domain — no `domains` table, no per-user aliases, postfix
  `virtual_mailbox_domains = $DOMAIN` is a literal single value. Pluralizing requires schema changes,
  per-org domain ownership, postfix runtime regeneration, and per-domain DKIM keys. Tracked as future
  "Flavor 3"; out of scope for this proposal but the `MAIL_DOMAIN` env var is the entry point that later
  becomes `MAIL_DOMAINS` (array).

### Alternative philosophy worth knowing

[Mail-in-a-Box](https://github.com/mail-in-a-box/mailinabox) explicitly rejects modularity ("Not make
something customizable by power users"), trading flexibility for tight integration and easy upgrades.
Eigen is choosing the opposite trade because its audience often runs other services on the same host;
this proposal is the cost of that choice.

## The deployment matrix

Today there is one supported shape: Caddy + API + Postfix + Dovecot + Unbound, all in containers, with
mail and web sharing one `DOMAIN`. After this proposal there are four service-shape scenarios crossed
with an orthogonal domain-shape choice:

| Scenario | Caddy | Postfix + Dovecot + Unbound | Mail app | `SMTP_HOST` |
|---|---|---|---|---|
| **A. Default** (current) | container | containers | enabled | `postfix` |
| **B. Host webserver** | host (nginx / Caddy / Apache) | containers | enabled | `postfix` |
| **C. Host mail server** | container | host postfix | disabled | `host.docker.internal` |
| **D. Host both** | host webserver | host mail server | disabled | `host.docker.internal` |

Independent of A–D, `MAIL_DOMAIN` can equal `DOMAIN` (default — single-domain deploy) or differ from it
(apex mail, subdomain web). A user can run scenario A with `DOMAIN=eigen.example.com` and
`MAIL_DOMAIN=example.com`; they can run scenario C with both equal; etc. The two axes don't interact.

Two related deployment shapes that need **no new mechanisms** but deserve a guide entry:

- **Cloudflare Tunnel** (`cloudflared` sidecar): treat as scenario B. Set `EIGEN_API_BIND=127.0.0.1:8000`,
  point cloudflared `service: http://localhost:8000`. No host edge container, no public ports.
- **Tailscale Funnel / Serve**: same shape. Tailscale sidecar replaces the host edge.

## Design

Four small mechanisms working together.

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

Compose semantics relevant to this design (per the
[official spec](https://docs.docker.com/reference/compose-file/profiles/)):

- Services without `profiles` are always started.
- `COMPOSE_PROFILES=` (empty) starts only no-profile services — that's the scenario D shape.
- `COMPOSE_PROFILES` env var and `--profile` CLI flag are **merged** (union), not override.
- **Cross-profile `depends_on` is a hard error** unless you set `required: false` on the dependency.
  Compose v2.20.2+ supports this; pin **Compose ≥ 2.20** in the setup guide. Eigen sidesteps the trap by
  keeping `eigen-api` profile-free with no cross-profile `depends_on`, but any future hook that depends
  on `postfix` from `eigen-api` would need `required: false`.

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
network alias `eigen-api:8000` (Caddyfile lines 30, 40, 62) and ignores the host-side mapping.

#### Reverse-proxy snippets in the setup guide

Add a section to [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md) with copy-pasteable nginx and Caddy
configs for the host. Critical bits for SSE (`/eigen/.../events` endpoints — see
[`SSE.md`](SSE.md) and [`apps/api/src/routes/sse.ts`](../apps/api/src/routes/sse.ts)):

```nginx
# /etc/nginx/sites-available/eigen
location /eigen/ {
    proxy_pass http://127.0.0.1:8000/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;            # SSE: stream chunks immediately
    proxy_cache off;                # SSE: belt-and-braces, suppress all caching paths
    proxy_read_timeout 24h;          # SSE: long-lived connection
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    gzip off;                       # SSE: gzip will buffer
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
[event MPM](https://httpd.apache.org/docs/2.4/mod/event.html) if the user is on Apache.

#### Defensive SSE: server-side `X-Accel-Buffering: no`

To protect against operators who misconfigure their reverse proxy, the API should set
`X-Accel-Buffering: no` on every SSE response. nginx honours this header per-response regardless of the
location-level `proxy_buffering` setting. Add to [`apps/api/src/routes/sse.ts`](../apps/api/src/routes/sse.ts):

```typescript
return new Response(stream, {
    headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',   // defends against unconfigured nginx in front
    },
});
```

### 3. `MAIL_APP_ENABLED` feature flag — gates inbound + UI, **not** outbound

The flag's contract: *Eigen-managed mailboxes are off.* That means no Maildir, no IMAP, no inbound
delivery, no in-app Mail UI, no IMAP autoconfig. **Outbound SMTP keeps working** — `mailer.ts` still
sends through whatever `SMTP_HOST` points at, so password resets, welcome emails, calendar invites, and
share-by-email continue to function.

This split matters because outbound and inbound are orthogonal capabilities. In scenarios C and D the
host already runs postfix; Eigen relays outbound through it (`SMTP_HOST=host.docker.internal`) but
*receiving* would require LMTP forwarding from the host — that's "Flavor 2" and out of scope.

```bash
# .env.example
MAIL_APP_ENABLED=true
```

#### What the flag gates (MUST disable when false)

| Layer | Where | Behaviour when `false` |
|---|---|---|
| API mail router | [`apps/api/src/app.ts:81`](../apps/api/src/app.ts) (`.use(mailRouter)`) | Skip registration. `/api/mail/*` and `/mail/deliver/*` return 404. |
| Maildir lifecycle | [`apps/api/src/lib/home/user-home.ts`](../apps/api/src/lib/home/user-home.ts) (`new Maildir(this)` + `_mail.init()`) | Skip instantiation. No filesystem watchers, no `welcomeMail()`, no MailDB. Existing Maildirs on disk are untouched, just not served. |
| Caddy SPA route | [`Caddyfile:66`](../Caddyfile) (`import app mail`) | Omit when Caddy is on but Mail is off. |
| IMAP autodiscovery | [`Caddyfile:46`](../Caddyfile) + [`docker/caddy/autoconfig.xml`](../docker/caddy/autoconfig.xml) | Skip the `/.well-known/autoconfig/mail/...` route. |
| Features endpoint | new [`apps/api/src/routes/features.ts`](../apps/api/src/routes/features.ts) (or extend [`setup.ts`](../apps/api/src/routes/setup.ts)) | Returns `{ mail: false }`. |
| Frontend features hook | new `packages/lib/src/core/features.ts` | `useFeatures()` React Query hook returns `{ mail: false }`. |
| App registry filter | [`packages/lib/src/core/apps.ts`](../packages/lib/src/core/apps.ts) consumers (`topbar.tsx`, `apps/index/src/routes/index.tsx`, `apps/space/src/routes/_auth.index.tsx`, command palette) | Filter Mail entry out via `useFeatures()`. |
| Notification deep-links | [`packages/lib/src/core/notification/resolve-link.ts:124`](../packages/lib/src/core/notification/resolve-link.ts) | The `'mail'` case in `isClickableNotification()` and the `getMailAppUrl()` call return `null` / hide the notification. |
| Mail SSE handler | [`packages/lib/src/core/sse/hooks/use-sse.ts`](../packages/lib/src/core/sse/hooks/use-sse.ts) (`handleMailSSEvent`) | Skip dispatch. Today the handler no-ops on non-`mail:*` events, so this is dead-branch cleanup. |
| Tests | `apps/api/src/test/mail.test.ts`, `ical-imip.test.ts` (the inbound parts) | Skip via `describe.skipIf(...)` when flag is false. |

#### What the flag does NOT gate

These keep working unchanged because they only depend on outbound SMTP, not on Maildir/IMAP:

| Feature | Why it still works | Caveat |
|---|---|---|
| Welcome emails to new users (when sent to user's external address) | Pure outbound via `mailer.ts` | Today `welcomeMail()` is delivered to the user's own Eigen Maildir — gone in C/D. A separate "outbound welcome to external address" path would be a small follow-up; track as TODO. |
| Password reset, email verification | Pure outbound | none |
| Share-invite emails | Pure outbound | none |
| Calendar iMIP **sending** (`apps/api/src/lib/calendar/invite-propagation.ts`, RSVP path in `calendar.ts`) | Generates iMIP-formatted .eml, sends via SMTP | iMIP **RSVPs from external attendees can't be received** in C/D — there's no Maildir for postfix to deliver into. External attendees stay "no response" until Flavor 2 (host-postfix LMTP forwarding) lands. Document this in SETUP-GUIDE. |
| Drive `emailCollaborators()` (`apps/api/src/lib/drive/drive.ts`) | Pure outbound | none |
| Contacts "Send email" button (`apps/contacts/src/components/contacts/contact-detail.tsx` + `team-member-detail.tsx`) | Falls back to system `mailto:` (browser opens user's default mail client) instead of opening Eigen's composer | Need a small UX change: when `features.mail === false`, swap the click handler to `window.location.href = 'mailto:...'`. The button stays useful. |
| `getMailAppUrl` callers ([`api.ts:68`](../packages/lib/src/core/api.ts) and helpers) | Branch on `features.mail` and fall back to `mailto:` | Sweep callsites once. |

`mailer.ts` falls back to `sendmail(1)` when `SMTP_HOST` is unset (lines 46–50), but `sendmail` doesn't
exist in the API container. So **`SMTP_HOST` is effectively required** in scenarios C/D regardless of
`MAIL_APP_ENABLED`. Document this.

#### Features endpoint and frontend hook

A single endpoint surfaces the deployment shape to the frontend:

```typescript
// apps/api/src/routes/features.ts (new) — or extend setup.ts
.get('/setup/features', () => ({
    mail: process.env.MAIL_APP_ENABLED !== 'false',
    // Phase 5: every app gets an entry; defaults to true.
}))
```

```typescript
// packages/lib/src/core/features.ts (new) — React Query hook to match
// the existing useServerSettings() pattern.
import { useQuery } from '@tanstack/react-query';

export const featuresKeys = { all: ['features'] as const };

export function useFeatures() {
    return useQuery({
        queryKey: featuresKeys.all,
        queryFn: () => fetch(getApiUrl('/setup/features')).then(r => r.json() as Promise<{ mail: boolean }>),
        staleTime: 5 * 60_000,
    });
}
```

Consumers do not get an async `getEnabledApps()` (that would force async into a today-sync export);
they call `useFeatures()` and filter `apps` inline:

```typescript
const { data: features } = useFeatures();
const visibleApps = (isGuest ? apps.filter(...) : apps)
    .filter(app => app.name !== 'Mail' || features?.mail !== false);
```

### 4. `MAIL_DOMAIN` to decouple mail from web

Today every layer keys off a single `DOMAIN` env var:
[`Caddyfile`](../Caddyfile) bind, postfix `mydomain` / `myorigin` / `virtual_mailbox_domains`,
`autoconfig.xml`, DKIM signing in `docker/postfix/entrypoint.sh`, and the backend `getDomain()` helper
that builds `noreply@${DOMAIN}` in [`mailer.ts`](../apps/api/src/lib/core/mailer.ts). Real deployments
often want them split:

- Web UI at `eigen.example.com` (a subdomain that's cheap to spin up without touching apex DNS)
- Mail addresses `@example.com` (the apex they've owned for years and don't want to abandon)

Add a `MAIL_DOMAIN` env var that defaults to `DOMAIN` (zero impact on existing deployments):

```bash
# .env.example
DOMAIN=eigen.example.com           # Web UI hostname
# Mail address suffix. Defaults to DOMAIN. Set to apex if mail is @example.com but web is on a subdomain.
MAIL_DOMAIN=${DOMAIN}
```

#### Touchpoints

| File | Change |
|---|---|
| `docker/postfix/main.cf.template` | `mydomain`, `myorigin`, `virtual_mailbox_domains` reference `$MAIL_DOMAIN` instead of `$DOMAIN` |
| `docker/postfix/entrypoint.sh` | DKIM key generation uses `$MAIL_DOMAIN`. The DKIM `Domain` directive matches the address domain, not the web domain |
| `docker/dovecot/dovecot.conf` | Already domain-agnostic (auth keys on full email passed by `eigen-checkpassword`) — no change |
| `docker/dovecot/eigen-checkpassword` | Already passes the full email; backend lookup keys on `email` column, not on a parsed domain |
| `docker/caddy/autoconfig.xml` | `<domain>` and `<hostname>` template `MAIL_DOMAIN`. **But see autoconfig caveat below.** |
| `apps/api/src/lib/config/server-settings.ts` (or wherever `getDomain()` lives) | Add `getMailDomain()` returning `process.env.MAIL_DOMAIN ?? process.env.DOMAIN` |
| `apps/api/src/lib/core/mailer.ts` | `from` uses `noreply@${getMailDomain()}` |
| Setup wizard | Optional "Mail domain" field that defaults to the web domain. Most users skip it. |
| `scripts/generate-env.sh` | Accept `--mail-domain` flag, default to web domain |

#### Autoconfig caveat

Mail clients look for autoconfig at `https://autoconfig.${MAIL_DOMAIN}/.well-known/autoconfig/mail/config-v1.1.xml`
— that's the standard lookup URL. If `MAIL_DOMAIN=example.com` but the web is at `eigen.example.com`,
clients won't find autoconfig at `eigen.example.com/.well-known/...`. Two paths:

1. **Manual config**: users enter IMAP server (`eigen.example.com`) and SMTP server (`eigen.example.com`)
   by hand. Inelegant but always works.
2. **Caddy serves apex too**: Caddy listens on `autoconfig.${MAIL_DOMAIN}` (or apex itself) in addition
   to `eigen.example.com`, serving the autoconfig XML there. Requires DNS `autoconfig.example.com`
   pointing at the Eigen host. Document the Caddy block:
   ```caddy
   autoconfig.{$MAIL_DOMAIN} {
       handle /.well-known/autoconfig/mail/config-v1.1.xml {
           # ... same template handler as the main Caddyfile
       }
   }
   ```

Document option 1 as the no-friction path and option 2 as the polished path.

#### DNS records sit on `MAIL_DOMAIN`

When the two diverge, document clearly that DNS records for mail (MX, SPF, DMARC, DKIM TXT) sit on
`MAIL_DOMAIN`, not on `DOMAIN`:

```
example.com.            MX   10 eigen.example.com.    ; MX target is the web host
example.com.            TXT  "v=spf1 mx -all"          ; SPF allows the MX host
_dmarc.example.com.     TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
default._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=..."
```

### Outbound mail in scenarios C and D

When postfix and dovecot are off, `SMTP_HOST=postfix` no longer resolves. Documentation shows three
realistic targets:

| Setup | `SMTP_HOST` | Notes |
|---|---|---|
| Host postfix (Linux) | `host.docker.internal` (or the bridge gateway IP, default `172.17.0.1`) | Add `extra_hosts: ["host.docker.internal:host-gateway"]` to `eigen-api` for portability. **Host postfix must bind to `0.0.0.0`** (or the bridge IP), not `127.0.0.1`-only — otherwise the container can't reach it. **Firewall**: `iptables`/`nftables` rules must permit traffic from the docker bridge subnet (default `172.17.0.0/16`). Postfix needs to allow relay from that subnet, or use SMTP submission with auth on 587. |
| Third-party SMTP (Brevo, SendGrid, Postmark) | the relay host | Same as `SMTP_RELAY_HOST` use today, but consumed directly by `mailer.ts`. Auth via `SMTP_RELAY_USER` + `SMTP_RELAY_PASSWORD` (already wired in compose). |
| No outbound at all | unset | `mailer.ts` falls back to `sendmail(1)`, which doesn't exist in the API container — emails fail. Document that `SMTP_HOST` is effectively required when `MAIL_APP_ENABLED=false`. |

### TLS certs in scenarios B and D

When Caddy is off, [`docker/caddy/export-certs.sh`](../docker/caddy/export-certs.sh) doesn't run, so
`./data/certs/` stays empty and postfix / dovecot can't read certs for IMAPS / SMTPS.

> **Existing fragility**: `export-certs.sh` is a 12-hour polling loop, not hooked to Caddy's renewal
> events. After a renewal it can take up to 12 hours for postfix/dovecot to see new certs. This applies
> to scenario A today too; document it, and mention `acme.sh` or a deploy-hook based alternative as
> future work.

Two paths for B/D:

1. **Reuse host's certs.** Document a `docker-compose.host-certs.yml` overlay that mounts the host's
   Let's Encrypt directory into the cert volume:

   ```yaml
   # docker-compose.host-certs.yml
   services:
     postfix:
       volumes:
         - /etc/letsencrypt/live/${MAIL_DOMAIN:-${DOMAIN}}:/certs:ro
     dovecot:
       volumes:
         - /etc/letsencrypt/live/${MAIL_DOMAIN:-${DOMAIN}}:/certs:ro
   ```

   The user runs `docker compose -f docker-compose.yml -f docker-compose.host-certs.yml up -d`. Add a
   host-side certbot `--deploy-hook` that runs `docker compose kill -s HUP postfix dovecot` after each
   renewal so cert reload is prompt (this is Mailcow's documented pattern).

2. **`certbot` sidecar.** A tiny container that runs `certbot certonly --webroot` against the host
   webserver's webroot, writing to the shared `./data/certs/` volume. Out of scope for v1; mention as
   future work.

In scenario D (mail off, edge off) the cert problem disappears — there's nothing TLS-terminating inside
Docker.

## Setup wizard impact

The current setup wizard ([`apps/api/src/routes/setup.ts`](../apps/api/src/routes/setup.ts) +
corresponding UI) **does not currently provision a mailbox** — it creates the admin user, the default
org, and saves config. Mailbox initialisation is implicit, happening on first `Maildir.init()` (which
calls `welcomeMail()` for new accounts). So:

- No wizard-step skip is needed for `MAIL_APP_ENABLED`; the gate lives in `user-home.ts` (skip `Maildir`
  instantiation when the flag is false, which suppresses `welcomeMail()` automatically).
- Add an optional `MAIL_DOMAIN` field to the wizard, defaulting to the web domain. Power users who want
  apex-mail-on-subdomain-web set it during setup; everyone else ignores it.
- If a future wizard adds explicit mail account configuration (DKIM display, MX hint, alias setup),
  *that* step gets wrapped in a `useFeatures()?.mail` guard.

Existing users on a converted-to-no-mail deployment retain whatever Maildir they had on disk (it just
isn't served, watched, or synced). Switching the flag back to `true` re-exposes their old mail without
surgery — with one caveat: `welcomeMail()` may re-deliver if the code uses presence-of-Maildir as the
"new account" signal. Check this when implementing; gate `welcomeMail()` on a stable per-user flag, not
on Maildir presence.

## Documentation impact

| File | Change |
|---|---|
| [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md) | Add **"Deploying alongside an existing webserver"**, **"Deploying alongside an existing mail server"**, **"Cloudflare Tunnel"**, **"Tailscale Funnel"**, and **"Apex mail on subdomain web (`MAIL_DOMAIN`)"** sections. Each with end-to-end example (env vars, profiles, host config, MX/DKIM/SPF/DMARC records where relevant). Pin `docker compose ≥ 2.20`. |
| [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | Update the architecture diagram and "Current State" table to mark optional services. Add the deployment matrix from this proposal. Document the `DOMAIN` vs `MAIL_DOMAIN` distinction. |
| [`docker/LOCAL-TESTING.md`](../docker/LOCAL-TESTING.md) | Note `COMPOSE_PROFILES` defaults to all-services for local; one-line how to test the host-proxy / no-mail / split-domain variants. |
| [`.env.example`](../.env.example) | Add `EIGEN_API_BIND`, `MAIL_APP_ENABLED`, `MAIL_DOMAIN`, `COMPOSE_PROFILES` with comments explaining each scenario. |
| [`docs/SSE.md`](SSE.md) | Document the `X-Accel-Buffering: no` response header and rationale. |
| [`docs/IMAP.md`](IMAP.md) | Note that `MAIL_DOMAIN` controls the address suffix; Maildir layout and Dovecot wiring are domain-agnostic. |

## File reference

| File | Path | Status |
|---|---|---|
| Compose profiles | `docker-compose.yml` | edit |
| Compose dev overrides (set profiles, add `extra_hosts`) | `docker-compose.dev.yml` | edit |
| Env example | `.env.example` | edit |
| API host bind | `docker-compose.yml` (`eigen-api.ports`) | edit |
| Mail flag — API router | `apps/api/src/app.ts:81` (gate `.use(mailRouter)`) | edit |
| Mail flag — Maildir init | `apps/api/src/lib/home/user-home.ts` (gate `new Maildir(this)`) | edit |
| Features endpoint | `apps/api/src/routes/features.ts` (or extend `setup.ts`) | new |
| Frontend features hook | `packages/lib/src/core/features.ts` | new |
| App registry filter | `packages/ui/src/components/layout/app/topbar.tsx` + `apps/index/src/routes/index.tsx` + `apps/space/src/routes/_auth.index.tsx` (consume `useFeatures()`) | edit |
| Notification deep-link guard | `packages/lib/src/core/notification/resolve-link.ts` | edit |
| Contacts mailto fallback | `apps/contacts/src/components/contacts/contact-detail.tsx` + `team-member-detail.tsx` | edit |
| `getMailAppUrl` callers | `packages/lib/src/core/api.ts` (line 68 + helpers) callsites | edit |
| Mail SSE handler dispatch | `packages/lib/src/core/sse/hooks/use-sse.ts` | edit |
| SSE response header | `apps/api/src/routes/sse.ts` (add `X-Accel-Buffering: no`) | edit |
| Caddy SPA + autoconfig conditional | `Caddyfile` | edit |
| Postfix templates use `MAIL_DOMAIN` | `docker/postfix/main.cf.template` + `entrypoint.sh` | edit |
| Autoconfig template uses `MAIL_DOMAIN` | `docker/caddy/autoconfig.xml` | edit |
| `getMailDomain()` helper | `apps/api/src/lib/config/server-settings.ts` (or sibling) | edit |
| Mailer uses `getMailDomain()` for `from` | `apps/api/src/lib/core/mailer.ts` | edit |
| `generate-env.sh` accepts `--mail-domain` | `scripts/generate-env.sh` | edit |
| Setup wizard mail-domain field | `apps/api/src/routes/setup.ts` + admin UI | edit |
| Setup guide — host webserver / mail / Cloudflare / Tailscale / split-domain sections | `docker/SETUP-GUIDE.md` | edit (new sections) |
| Deployment doc — matrix | `docs/DEPLOYMENT.md` | edit |
| Host-cert overlay | `docker-compose.host-certs.yml` | new (optional) |

## Phased plan

| Phase | Scope | Effort |
|---|---|---|
| 1 | Compose profiles + `EIGEN_API_BIND`. `MAIL_DOMAIN` env var with all postfix/autoconfig/mailer/`getMailDomain()` plumbing. Reverse-proxy snippets in setup guide (nginx, Caddy, Cloudflare Tunnel, Tailscale, split-domain). `X-Accel-Buffering: no` server-side. Pin Compose ≥ 2.20. No `MAIL_APP_ENABLED` code yet — Mail still appears in scenarios B/D and works, since postfix/dovecot still run there. | M |
| 2 | `MAIL_APP_ENABLED` flag with the corrected (inbound-only) contract. Gate `mailRouter` and `Maildir` instantiation. Add `/setup/features`, `useFeatures()` hook, sweep `apps` consumers. Notification deep-link guards. Contacts mailto-fallback. Calendar iMIP and Drive emailCollaborators stay UNGATED — they only need `SMTP_HOST`. | M |
| 3 | End-to-end docs for scenarios C/D. Host-cert overlay (`docker-compose.host-certs.yml`) with worked example and certbot deploy-hook pattern. Outbound-welcome path for new users when `MAIL_APP_ENABLED=false` (welcome to user's external email instead of internal Maildir). | S |
| 4 (optional) | `certbot` sidecar example. Switch cert export from polling to renewal hook (or `acme.sh`). | S |
| 5 (future) | Generalize the feature-flag pattern: every app exposes `enabled`. Move from env to `data/server/settings.json` with admin-UI toggles, following the Nextcloud `occ app:enable` shape. | M |
| 6 (future, "Flavor 2") | Inbound to the apex via host-postfix LMTP forwarding, so scenario C/D can receive mail (incl. iMIP RSVPs). | M |
| 7 (future, "Flavor 3") | **Multi-domain mail.** `MAIL_DOMAIN` becomes `MAIL_DOMAINS` (array). New `domain` table, per-org domain ownership, postfix `virtual_mailbox_domains` regenerated at startup, per-domain DKIM keys, per-user aliases. User table grows an `email_aliases` relation. Material data-model work; treat as a separate proposal. | L |

## Open questions

1. **Persist `MAIL_APP_ENABLED` and `MAIL_DOMAIN` in `settings.json` instead of env?** Today config splits
   between env (`DOMAIN`, secrets, infrastructure) and `data/server/settings.json` (runtime-tunable knobs
   — see [`SERVER-SETTINGS.md`](SERVER-SETTINGS.md), with prior art like `waitlist.enabled`). Both new
   knobs are deployment shape (must be set before first boot, not flippable while users are logged in),
   so env is right for v1. **Direct prior art**: Nextcloud All-in-One **deprecated
   `AIO_COMMUNITY_CONTAINERS` in v11.0.0** in favour of admin-UI runtime toggles, on the explicit
   grounds that env-var-per-feature doesn't scale. Phase 5 should plan the migration: env stays the
   bootstrap default, written into `settings.json` on first run, thereafter read from settings, surfaced
   in the Admin app.
2. **Inbound to the apex via host postfix** — covered as "Flavor 2" / Phase 6.
3. **Multi-domain mail** — covered as "Flavor 3" / Phase 7. Worth flagging that `MAIL_DOMAIN` is the
   designed entry point; `MAIL_DOMAINS=apex.com,other.com` is the natural extension when the data model
   catches up. Today's single-domain assumption is in: postfix `virtual_mailbox_domains` (single value),
   user `email` column (single value, no aliases table), DKIM (one key generated per `MAIL_DOMAIN`), and
   the `mailbox_deliver` lookup which keys on the literal email string. All four need rework for
   multi-domain.
4. **Default for `EIGEN_API_BIND` in dev compose.** Local tests run via `bun run` outside Docker. The
   bind only matters for the production compose; dev keeps no host port.
5. **`TRUSTED_PROXIES` allowlist for scenario B.** The API trusts `X-Forwarded-Proto`/`X-Real-IP` from
   `TRUSTED_NETWORKS` today. When the host edge proxies in from a non-default subnet, document the env
   extension. Same shape as Mailcow's `TRUSTED_PROXIES`.
6. **`welcomeMail()` re-fire on flag flip-back.** Today the welcome message is delivered to the user's
   own Eigen Maildir on first `Maildir.init()`. If the flag goes false then true again, does it re-fire?
   Check whether the new-user signal is per-user-state or Maildir-presence; gate it on the former so
   re-enabling Mail doesn't spam existing users.

## See also

- [DEPLOYMENT.md](DEPLOYMENT.md) — current Docker architecture (gets updated by this proposal)
- [`docker/SETUP-GUIDE.md`](../docker/SETUP-GUIDE.md) — VPS deployment guide that gains five new sections
- [SSE.md](SSE.md) — why reverse-proxy buffering must be off and timeouts must be long
- [IMAP.md](IMAP.md) — Maildir + Dovecot wiring (the half of Mail that the flag turns off)
- [SERVER-SETTINGS.md](SERVER-SETTINGS.md) — runtime settings store; potential home for `MAIL_APP_ENABLED`
  and `MAIL_DOMAIN` in Phase 5
- [TODO-MAIL.md](TODO-MAIL.md) — known mail-stack gaps; this proposal is orthogonal but should land
  before any of the larger mail-feature work
- [Docker Compose profiles spec](https://docs.docker.com/reference/compose-file/profiles/)
- [Mailcow reverse-proxy docs](https://docs.mailcow.email/post_installation/reverse-proxy/r_p/) —
  reference for the `EIGEN_API_BIND` pattern and host-cert mount
- [Nextcloud AIO discussion #4962](https://github.com/nextcloud/all-in-one/discussions/4962) — why
  `AIO_COMMUNITY_CONTAINERS` was deprecated; Phase 5 precedent
- [Mail-in-a-Box README](https://github.com/mail-in-a-box/mailinabox) — the alternative philosophy
  Eigen is rejecting
