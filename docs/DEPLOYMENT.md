# Eigen Deployment

Docker-based deployment for Eigen. Four containers: Caddy (reverse proxy + HTTPS), Eigen API (Bun),
Postfix (email), Dovecot (IMAP).

**Guides:**
- [VPS Setup Guide](../docker/SETUP-GUIDE.md) — step-by-step server deployment
- [Local Testing Guide](../docker/LOCAL-TESTING.md) — run the full stack on your machine

## Architecture

```
                    Internet
                       |
          +------------+--------------------+
          | Port 80/443|    Port 25   Port 993
          v            |       v         v
     +---------+  +----+----+ +-------+ +---------+
     |  Caddy  |  |  Caddy  | |Postfix| | Dovecot |
     | static  |  | proxy   | |  MTA  | |  IMAP   |
     |  files  |  | /eigen/*| |       | |         |
     +----+----+  +----+----+ +---+---+ +----+----+
          |            |          |           |
          |       +----v----+    |           |
          |       |  Eigen  |<---+           |
          |       |   API   |                |
          |       |  :8000  |                |
          |       +----+----+                |
          |            |                     |
          +------------+---------------------+
                       |
                +------v------+
                |  ./data/    |  (bind mount)
                |  server/    |  auth DB, config
                |  home/      |  user data + Maildirs
                |  team/      |  team data
                |  certs/     |  TLS certs
                |  dkim/      |  DKIM keys
                +-------------+
```

## Current State (Phase 1-3 complete)

### What's implemented and working

| Component | Status | Details |
|-----------|--------|---------|
| **Caddy reverse proxy** | Done | Auto-HTTPS, HTTP/2, gzip/zstd, SPA routing for all apps |
| **Eigen API in Docker** | Done | Bun container with healthcheck, bind-mount data |
| **`TRUSTED_NETWORKS`** | Done | `requireLocalhost` accepts Docker bridge IPs via env var |
| **SMTP transport** | Done | `mailer.ts` uses SMTP when `SMTP_HOST` is set, sendmail fallback |
| **Postfix container** | Done | Receives mail (port 25), sends via relay, DKIM signing |
| **Dovecot container** | Done | IMAP on port 993, checkpassword auth via API |
| **Internal auth endpoint** | Done | `POST /internal/auth/verify` — returns userId for email lookup |
| **Cert export** | Done | Background script copies Caddy certs to shared volume |
| **Dev mode** | Done | `docker-compose.dev.yml` with mailpit + self-signed certs |
| **Env generator** | Done | `scripts/generate-env.sh` derives all vars from DOMAIN |
| **Operational scripts** | Done | `scripts/update.sh`, `scripts/backup.sh` |

### Code changes (backward-compatible)

| File | Change |
|------|--------|
| `apps/api/src/lib/core/access.ts` | Added `isIpTrusted()` + `TRUSTED_NETWORKS` env var |
| `apps/api/src/lib/core/mailer.ts` | Added SMTP transport when `SMTP_HOST` is set |
| `apps/api/src/lib/auth/auth.ts` | Added `https://localhost` to `trustedOrigins` |
| `apps/api/src/routes/internal.ts` | New: `/internal/auth/verify` endpoint |
| `apps/api/src/app.ts` | Registered `internalRouter` |

All changes are backward-compatible: without the new env vars, behavior is identical to before.

## File Structure

```
/                                    # Repo root
+-- Caddyfile                        # Reverse proxy config
+-- docker-compose.yml               # Production: Caddy + API + Postfix + Dovecot
+-- docker-compose.dev.yml           # Dev overrides: localhost + mailpit
+-- .env.example                     # Template for .env.production
+-- docker/
|   +-- api/Dockerfile               # Eigen API container
|   +-- caddy/export-certs.sh        # Cert export for Dovecot/Postfix
|   +-- postfix/
|   |   +-- Dockerfile               # Postfix + OpenDKIM
|   |   +-- main.cf.template         # Postfix config (envsubst)
|   |   +-- master.cf.template       # Postfix transport definitions
|   |   +-- eigen-deliver            # Delivery script (curl to API)
|   |   +-- entrypoint.sh            # DKIM keygen, relay config
|   +-- dovecot/
|   |   +-- Dockerfile               # Dovecot IMAP
|   |   +-- dovecot.conf             # IMAP config with checkpassword
|   |   +-- eigen-checkpassword      # Auth script (curl to API)
|   |   +-- entrypoint.sh            # Self-signed cert gen, wait for API
|   +-- SETUP-GUIDE.md               # VPS deployment guide
|   +-- LOCAL-TESTING.md             # Local Docker testing guide
+-- scripts/
|   +-- generate-env.sh              # Generate .env.production from DOMAIN
|   +-- update.sh                    # Pull + build + restart
|   +-- backup.sh                    # Backup data directory
```

## Remaining Work

### Phase 4: Authentication (required before production use)

The `/internal/auth/verify` endpoint currently accepts **any password** — it only checks that the
email exists. This must be fixed before deploying to a real server.

**Tasks:**

- [ ] **Implement real password verification** in `/internal/auth/verify`
  - Check app-specific password first (better-auth API key plugin — already in `package.json`)
  - Fall back to primary password verification via better-auth
  - File: `apps/api/src/routes/internal.ts`

- [ ] **App-specific passwords UI** in Space settings
  - Users generate "app passwords" for IMAP/CalDAV clients
  - These are revocable and don't expose the primary password
  - Uses `@better-auth/api-key` plugin (already installed)
  - Files: new component in `apps/space/`, new hooks in `packages/lib/src/core/space/hooks/`

- [ ] **Setup wizard cleanup**
  - The `DOMAIN` env var is already set in `.env.production`, but the setup wizard also asks for
    domain. These should be consistent — either pre-populate from env var or remove the duplicate field
  - File: `apps/setup/` + `apps/api/src/routes/setup.ts`

### Phase 5: CalDAV — Done (personal calendars)

Read-write CalDAV server implemented and tested with Thunderbird. Files in `apps/api/src/lib/caldav/`.

**What works:**
- [x] Discovery (PROPFIND chain from `/dav/` → principals → calendar-home-set)
- [x] Calendar listing (PROPFIND Depth:1), properties (ctag, color, displayname)
- [x] Event CRUD: GET/PUT/DELETE with ETag conflict detection
- [x] REPORT: calendar-query (with time-range), calendar-multiget, sync-collection
- [x] MKCALENDAR, PROPPATCH (create/update calendar properties)
- [x] iCalendar serialization/parsing (ical.js) with RFC 5545 compliance
- [x] Recurring events with RRULE, exceptions (RECURRENCE-ID), EXDATE handling
- [x] Two-way sync tested with Thunderbird (create, edit, delete — including single occurrences)
- [x] HTTP Basic Auth (password validation deferred — same as Dovecot IMAP)

**Remaining CalDAV work:**
- [ ] Shared & team calendar proxying via CalDAV
- [ ] Test with Apple Calendar, DAVx5 (Android)
- [ ] VTIMEZONE generation (most clients don't require it)

### Phase 6: SMTP Submission (port 587) — Future

Allow IMAP clients to send email via SMTP (not just the web UI).

- [ ] Postfix submission config (port 587, authenticated)
- [ ] SASL auth via Dovecot auth socket
- [ ] Test: Thunderbird sends via SMTP submission

### Known Issues / Improvements

- [ ] **Cert export fragility** — the export script depends on Caddy's internal cert path
  (`/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/`). Pin Caddy version or use
  `acme.sh` as an alternative cert source
- [ ] **Dovecot UID** — checkpassword sets `userdb_uid=1000` but Dovecot's `prefetch` driver ignores
  it (falls back to UID 100). Works because `first_valid_uid=1` allows it and Docker Desktop maps
  file ownership transparently. On Linux, this needs testing with real UID matching
- [ ] **Backup WAL safety** — `scripts/backup.sh` does a simple tar. For guaranteed consistency,
  implement `/internal/checkpoint` endpoint that runs `PRAGMA wal_checkpoint(TRUNCATE)` on all open
  databases before backup
- [ ] **`VITE_APP_*_URL` in build** — the update script sources `.env.production` before building,
  but this is easy to forget. Consider a build wrapper that does this automatically

## Alternatives Considered

| Approach | Verdict |
|----------|---------|
| **nginx instead of Caddy** | Rejected — Caddy's auto-HTTPS is worth the switch |
| **Hybrid (Docker + native mail)** | Rejected — consistency: one system to learn |
| **All native (systemd)** | Rejected — works but doesn't scale to self-hosters |
| **Managed email + Docker Eigen** | Valid alternative for users who don't want to run mail |
