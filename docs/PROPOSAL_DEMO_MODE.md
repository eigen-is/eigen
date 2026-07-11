# Proposal: Demo instance (no-login, hourly reset)

> **Status — Proposal, written 2026-07-11, grounded in code research the same day, not started.**
> The ROADMAP row "Demo mode" (on hold, decision needed). Supersedes an earlier internal design
> round (2026-06-10, approved then parked) that was built around an elastic pool of per-visitor
> pre-seeded accounts; this proposal drops the pool and keeps that round's structural decisions.
> Also part of the grant story: a public demo instance is a named deliverable.

> **TLDR**: Demo mode is a **deployment shape, not a code mode**. A dedicated instance
> (`demo.eigen.is`, own VPS, no `mail` compose profile, no MX, local mounts only) runs with
> `EIGEN_DEMO=1`. Visitors enter through one public route, `GET /p/demo/enter`, which signs them
> into a **single shared demo account** using the exact session-minting mechanism the guest-OTP
> flow already uses in production (`auth.api.signInEmail({ asResponse: true })` + a deterministic
> HMAC password nobody ever sees) — no login UI, no auth bypass, no middleware. The world is
> built by an offline `seed-demo.ts` script that drives the real domain APIs (docs and sheets are
> seeded from `.docx`/`.xlsx` fixtures through the *shipped* converters, dogfooding import), and a
> ~10-line **host-level** script resets the box every hour: stop container → wipe the data root →
> re-run the seeder → start. Wipe-and-reseed makes every timestamp less than an hour old, so
> nothing date-rots and no cleanup job ever eats seeded content. Total conditional surface in
> shared code: **one line in `sendMail()`** (extending its existing dev-skip) and one login-page
> conditional. No pool, no new tables, no scheduler jobs, no settings-schema churn, no admin UI.
> The reset script doubles as the safe offline backup/restore that
> [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md) flags as missing, and the seeder is the
> skeleton of the future import features ([PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md),
> mail `.eml` ingest, vCard).

## Problem

People evaluating Eigen should be able to try the real product — mail, drive, docs, sheets,
slides, stickies, chat, calendar, live collab, activity panels — without creating an account,
and without us trusting strangers with a persistent instance. That means three things: entry
without any sign-in flow, a pre-seeded workspace that looks lived-in, and a blast radius bounded
by an automatic reset.

The design tension is that "demo-ness" must not leak into the codebase as scattered
`if (demo)` checks that every self-hosted instance executes.

## Goals

1. Zero-friction entry: click "Try the demo" → you are inside the product. No email, no OTP,
   no password.
2. A seeded workspace that exercises every app, with resolvable authorship (fictional persona
   colleagues), realistic dates, and populated Activity panels / file history / notifications.
3. Full state reset on a fixed cadence (hourly), surviving any vandalism a visitor can produce.
4. Near-zero conditional surface in shared code; demo behaviour must be structurally impossible
   to trigger on a real instance.
5. The machinery pays rent elsewhere: the reset tooling is a general offline backup/restore, the
   seeder is a general fixture-ingestion path.

## Non-goals

- **Per-visitor isolated accounts** (the earlier pool design). One shared account is the v1
  model — see § The shared-account trade. The pool remains the documented upgrade path.
- **Demo content authoring** ("Studio Noord" fixtures). v1 ships the machinery plus a minimal
  placeholder set; the content pass is a separate work package.
- **The project front-door / marketing landing on eigen.is.** Independent scope; the demo box
  itself only needs a `/` redirect (Caddy) or a one-line button.
- **Protocol surfaces** (IMAP/CalDAV/WebDAV) in the demo. They keep working with the demo
  credentials nobody has; deliberately left alone.
- **Captcha / abuse hardening beyond rate limits.** The hourly reset is the abuse story for v1.

## Why this shape (two findings)

**1. Whole-instance rebuild sidesteps the embedded-ownerId problem.** The earlier design round
correctly banned seeding by copying a template home: `paths.ownerId`, `shared_paths.ownerId`, and
chat `authorId` are embedded inside the per-home DBs, so cloning a home for a *new* user id
produces a broken workspace. But that objection does not apply to resetting the **entire data
root**: `users3.db` and every home are replaced together, so all embedded ids stay consistent by
construction. (Corollary: whole eigen-doc *containers* also byte-copy legally — they reference
children by name, not pathId; see [AGENTS.md](../AGENTS.md) § Copy / move — which gives
slides/stickies fixture content without new machinery.)

**2. Restart-the-process is the only safe reset, so the reset must live outside the app.**
`shutdownAllHomes()` (`apps/api/src/lib/home/get-home.ts`) closes Homes but never closes the two
module-level server DBs — `users3.db` (plain drizzle connection, `auth.ts:50`) and `eigen.db`
(share-registry singleton, `share/db.ts`). Swapping files under open handles is the documented
`SQLITE_IOERR_VNODE` hazard (`managed-database.ts`, `versioning/snapshot.ts`), and any in-flight
request repopulates the Home map between evict and swap. An in-process hourly reset job would be
fighting the process it runs in; a host-level stop → replace → start is both simpler and the only
correct option. This single fact deletes the pool, the TTL cleanup jobs, and their race
conditions from the design.

## Design

### 1. Entry: `GET /p/demo/enter`

A public route (in `routes/public.ts` or a sibling `routes/demo.ts`), gated at the top of the
handler by `isDemo()` (Elysia mounts routes at startup, so the gate is a runtime check; on real
instances the route 404s and is inert):

- Sign the visitor into the fixed demo user via `auth.api.signInEmail({ body, asResponse: true })`
  with the deterministic password `HMAC-SHA256('demo:' + email, serverConfig.secret)` — the exact
  mechanism `guest-auth.ts` uses today (`verifyOtpAndSignIn`, minus the OTP). Real better-auth
  session, real signed cookie (`better-auth.session_token`), zero new auth surface.
- Copy the `Set-Cookie` header onto a 302 redirect to `/space`.
- `isDemo()` = `process.env.EIGEN_DEMO === '1'`, next to `isProduction()` in
  `apps/api/src/lib/config/env.ts`. An env var, not a server setting: the whole instance is the
  mode, it must not be togglable from an admin UI, and it cannot drift onto a real instance.
  (Additive optional env var — safe for `update.sh` per the add-var-if-missing convention.)
- The demo user has 2FA off (2FA would divert `signInEmail` into the two-factor flow) and
  `role: 'user'` (not guest — `requireNonGuest` gates guests out of nearly every product route;
  not admin — keeps the admin app out of reach).

**Post-reset re-entry:** a reset invalidates all sessions; the visitor's next request 401s and
the FE redirects to `/login`. One FE conditional: when `publicConfig.demoMode` is true (new
boolean on the existing `GET /p/config`), the shared `login-page.tsx` renders an "Enter demo"
button linking to `/p/demo/enter` instead of the credentials form.

Rate limiting comes free: the global IP limiter already covers the route, and the OTP-limiter
pattern (`otp-rate-limit.ts`) is available if targeted abuse shows up. Note the direct
`auth.api.signInEmail` call does not pass through better-auth's `/sign-in/email` HTTP rate rule,
so entry bursts don't trip it.

### 2. Seeding: `apps/api/src/scripts/seed-demo.ts`

An **offline, in-process script** — invoked standalone like `seed-test-mail.ts`, built on the
mechanics `apps/api/src/test/setup.ts` already proves (boot the Elysia app in-process, drive it
with real requests and library calls). It runs against an empty `EIGEN_DATA_ROOT` and builds the
world through product surfaces:

| Domain | Mechanism (all existing) |
|---|---|
| Org + admin | `POST /setup/complete` in-process, as the test harness does |
| Personas + demo user | `auth.api.createUser` / direct `db.insert(userTable)` (guest-flow precedent) with **fixed hardcoded ids**, so any fixture embedding an authorId is portable across rebuilds |
| Drive folders/files | `Drive.create` / `uploadFiles`, binary fixtures from `fixtures/` |
| Docs + Sheets | `.docx`/`.xlsx` fixtures through the shipped convert path (`lib/import/import-document.ts`) — no new Y.Doc builders; the demo dogfoods import on every reset. The in-process `writeEigendocToYjs`/`writeSheetsToYjs` seam stays available for content the converters can't express |
| Slides + Stickies | Fixture **containers** (hand-made `.eigenslides`/`.eigenstickies` dirs) copied in — legal per the container-copy design. Writing `writeSlidesToYjs`/`writeStickiesToYjs` (readers exist, writers don't) is the clean long-term path; do it with the content pass |
| Mail | `composeRfc822()` + Maildir append — the welcome-mail mechanism (`lib/mail/welcome.ts`), persona threads, dates relative to now |
| Calendar | `createEventAt` via the calendar API, events placed relative to seed time (absolute epoch timestamps otherwise rot into an empty "today") |
| Contacts / Chat / comments / shares | Existing domain APIs (`POST /contacts/...`, `ChatRoom.postMessage`, ACL PUT), authored as personas |

**Thread persona actors through every mutation.** Drive records file history only when an actor
is threaded ("no actor, no row"), and `postMessage` records `commented` — seeding through the
same seams the product uses means Activity panels, file history, watchers, and notifications
look alive with zero extra code. This matters more than it did a month ago: activity panels and
comment assignment have shipped since, and a seeded workspace with empty panels now reads as
*less* finished than the product is.

### 3. Reset: `scripts/demo-reset.sh` + systemd timer

```
docker compose stop eigen-api        # graceful: homes checkpoint + close within the 30s grace
rm -rf data/server data/home data/team data/org data/guest   # never data/certs, data/dkim
bun run apps/api/src/scripts/seed-demo.ts
docker compose start eigen-api
```

Hourly, on the hour. No in-app scheduler involvement. Downtime is seconds and predictable.

Wipe-and-reseed (rather than restoring a golden tarball) buys total rot immunity:

- Every timestamp — calendar, mail, activity, `updatedAt` — is < 1h old. "Today" is never empty;
  the age-based reapers (guest cleanup, 30-day trash purge, version pruning, preview cache) never
  see anything old enough to eat.
- `users3.db` has **no** migrations-on-open (its schema comes from `completeSetup`'s
  `CREATE TABLE`s, unlike every `ManagedDatabase` file, which self-migrates). Rebuilding it from
  current code hourly makes schema drift structurally impossible.
- Nothing is ever copied from a live process, so the torn-WAL hazard that makes today's
  `backup.sh` unsafe never arises.

**Optional later optimization** — only if the content pass makes seeding measurably slow: run the
seeder nightly, tar the *stopped* data root (including `-wal`/`-shm`; the two server DBs are
never checkpointed on exit, their WALs are load-bearing), and have the hourly reset untar. The
snapshot is a cache of the seeder, never the source of truth. Don't build it up front.

### 4. Deployment shape (settings + compose, no code)

- Own smallest-class VPS, own domain (added to auth trusted origins via setup's `domain`),
  `EIGEN_DEMO=1` in `.env.production`.
- **Local mounts only** — an `s3` mount stores bytes outside the data root and would desync from
  the reset. Server settings enforce the rest without any code: signups disabled, guests off,
  tiny quotas (50 MB mount, 5 MB upload).
- No `mail` compose profile, no MX records: outbound and inbound mail are physically absent.
- **The one shared-code change:** `sendMail()` (`lib/core/mailer.ts`) already skips in dev;
  extend that same early-return to `isDemo()`. One seam covers every caller (ACL share mails,
  access requests, iMIP) and prevents error noise from the missing sendmail transport. Inert
  without the env var.

## The shared-account trade

All visitors are **one demo user, concurrently**. Deliberate, and load-bearing for the
simplicity:

- Two strangers editing the same doc **is** the collab demo — live cursors, presence, comments,
  activity panels updating in real time, with no staged second account.
- The account is naturally tamper-proof: password change and 2FA enrollment require the current
  password (a deterministic HMAC never displayed anywhere), email change requires a verification
  mail on a box with no mail. Visitors cannot lock each other out.
- Damage radius: anything a visitor deletes or defaces lives for at most an hour. "Nuke the box"
  is automated.

Accepted residuals, stated plainly: offensive content can be visible to other visitors for up to
an hour; concurrent visitors see each other's edits (the point, but it can confuse — the demo
banner should say so); a visitor can trash the workspace mid-hour (the reset heals it). If
shared-account chaos or real traffic ever demands isolation, the earlier pool design (per-visitor
pre-seeded accounts claimed from a warm pool) or better-auth's shipped-but-unwired `anonymous()`
plugin layers on top later — the entry route, seeder, and reset script all survive that upgrade
unchanged.

## Code-footprint inventory

| Where | What |
|---|---|
| New `routes` handler `/p/demo/enter` | ~30 lines, `isDemo()`-gated, guest-auth mechanics |
| New `apps/api/src/scripts/seed-demo.ts` + `fixtures/` | Offline seeder; never runs on real instances |
| New `scripts/demo-reset.sh` + timer unit | Host-level; not part of the app |
| `lib/config/env.ts` | `isDemo()` |
| `lib/core/mailer.ts` | One condition on the existing dev-skip |
| `routes/public.ts` `/p/config` | `demoMode: boolean` |
| `packages/ui` `login-page.tsx` | One conditional: enter-demo button |
| AppShell demo banner (small) | Keyed off `publicConfig.demoMode` |

Mainline conditional surface on real instances: one line in `sendMail`, one FE conditional. No
new tables, no settings-schema changes, no scheduler jobs, no changes to auth, Drive, ACL, or
Home code. Estimated effort: **3–5 focused days** for the machinery (the earlier pool-based
design round estimated 1.5–2 weeks); the fixture-content pass is separate and unchanged.

## What this pays for elsewhere

1. **Safe offline backup/restore.** `scripts/backup.sh` today tars the live tree (torn WALs —
   the P0 in [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md)), and no restore script
   exists. The reset's stop → copy-stopped-root-with-WALs → start sequence *is* the correct
   offline backup and restore. Ship it as `scripts/snapshot.sh` / `scripts/restore.sh` with
   `demo-reset.sh` as a thin composition, and production gains its offline backup story from the
   same work.
2. **The import skeleton.** The seeder's shape — fixture files ingested through domain APIs into
   a Home — is the future import feature set. Docs/sheets seeding already rides the shipped
   docx/xlsx converters; the mail path is an `.eml`-ingest function one refactor away from a
   user-facing mail import; when [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md)
   lands, the seeder swaps its event loop for the `.ics` importer and dogfoods it hourly. Every
   gap the seeder fills is a product feature, not demo-only code.

## Rejected alternatives

- **Auto-login middleware on sessionless requests** — touches the session hot path on every
  instance; the explicit enter-route gets identical UX with zero mainline surface.
- **Per-visitor accounts via `anonymous()` plugin (v1)** — each anonymous user gets an empty
  home; per-visitor seeding drags pool-like machinery back in. Kept as the upgrade path.
- **Per-visitor template-home byte-copy** — broken by embedded ownerIds (unchanged finding).
- **In-process hourly reset via `scheduleInterval`** — unsafe; see § Why this shape, finding 2.
- **Golden data dir baked into the Docker image + ephemeral volume + hourly restart** — the
  zero-script cousin of the tar variant; dates rot until an image rebuild and it diverges from
  the bind-mount deploy tooling. Possible later ops refinement.
- **The elastic warm pool as v1** — deferred, not rejected: it solves instant-entry against
  *slow* seeding of rich per-visitor content, which is not v1's problem. Revisit with traffic
  data; nothing in this proposal blocks it.

## Open decisions

1. **Shared account vs pool** — the one philosophical change from the earlier approved round.
2. **Reset cadence** — hourly proposed; 30 min tightens the abuse window, 2–4 h is calmer for
   engaged visitors.
3. **Slides/stickies v1 content** — fixture-container copy (proposed) vs writing the Yjs
   builders now vs near-empty placeholders.
4. **Mail-send UX** — with the mailer skip, a demo "send" silently succeeds-then-vanishes. If
   that confuses testers, add a 403 + toast on the send route later (one more gated check,
   consciously deferred).
