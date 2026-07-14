# Proposal: Demo instance (no-login, small persona pool, hourly reset)

> **Status — Implemented 2026-07-14 on branch `demo-mode`; machinery shipped, content pass pending.**
> The machinery in this proposal is built and tested (entry route, auth guard, `/p/config` flag,
> `sendMail` skip, `seed-demo.ts` + reset/snapshot/restore scripts, systemd units). The "Tuimel
> Festival" content is a minimal first pass; a content-deepening pass is the remaining work.
> **The as-built design is documented in [DEMO_MODE.md](DEMO_MODE.md) — that is the authoritative
> reference.** This file is kept for the design rationale and rejected alternatives.
> Supersedes an earlier internal design round (2026-06-10, approved then parked) that was built
> around an *elastic* pool of per-visitor pre-seeded accounts. This version keeps that round's
> structural decisions but replaces both the elastic pool and the interim single-shared-account idea
> with a **small fixed pool of ~20 persona colleagues** in one org; a visitor is signed into a random
> one on entry. Also part of the grant story: a public demo instance is a named deliverable.

> **Implementation deltas** (where the shipped code diverged from this proposal; see DEMO_MODE.md):
> - **Org guard reduced.** The proposal's demo guard blocked `/auth/organization/{create,leave}`. It
>   doesn't need to: the org privilege-escalation bug was fixed at the product level (`requireAdmin`
>   scoped to `config.orgId` + `allowUserToCreateOrganization: false`, commit `32fe269d`,
>   `org-privesc.test.ts`). The shipped denylist is api-key writes, 2FA enable, and revoke-(other-)sessions.
> - **Converter seam is `convertToDocument`.** Docs/sheets seed through `convertToDocument`
>   (`lib/import/import-document.ts`), not the `writeEigendocToYjs` / `writeSheetsToYjs` seams named here.
> - **Mail needs raw RFC822.** Persona threads are delivered via hand-built RFC822 with explicit `Date`
>   headers into `Home.mail.mailboxDeliver`, not `composeRfc822()` — dates must land in the wire headers.
> - **Teams are explicit.** The crew shares a `createTeam` + `addTeamMember` team with its own mounted
>   shared drive, not just the default org.
> - **Comment cards must be anchored in the doc text.** Seeding a comment writes both the `comment` mark
>   over the anchor phrase (`injectCommentMark`) and the card into the doc's `comments` Y.Map.
> - **`__Secure-` cookie gotcha.** Under an https `API_URL` / `NODE_ENV=production`, better-auth prefixes
>   its session cookie name; the seeder must reuse the full `name=value` pair or `addTeamMember` 401s.
>
> **Changes from the 2026-07-11 draft** (from the 2026-07-14 deep review — each finding verified
> against source, file:line in § Why this shape):
> 1. **Pool, not one account.** ~20 colleague personas sharing one workspace. Whichever one you
>    land as, you see a lived-in company: team drives, shared docs, mail from colleagues, calendar
>    invites. Concurrent visitors are distinct colleagues editing side by side (a *better* collab
>    demo than one shared login).
> 2. **No fixed persona ids.** The data model references everything by **file/folder name** and
>    **email** (ACLs, comments, comment-assignment, calendar attendees, stickies `creator`,
>    file-history actors, notifications are all email-keyed; container internals reference children
>    by name). The only user id embedded in *bytes* is chat `messages.authorId`, and it degrades
>    gracefully (display name resolves from `authorEmail`). So personas need a **stable email**, not
>    a stable id — random ids each rebuild are fine, and the fixed-id bookkeeping is deleted.
> 3. **Demo hardening.** The shared-workspace account surface has three real abuse vectors the old
>    draft called "naturally tamper-proof" — it isn't. A small `isDemo()`-gated auth guard blocks
>    api-key creation, 2FA enrollment, and org creation. See § Demo hardening.
> 4. **Wipe scope reconsidered.** Full data-root wipe stays the recommendation; § Reset explains why
>    (a partial `data/home`+`data/team` wipe reopens identity-tamper accumulation and needs an
>    out-of-band schema rebuild).

> **TLDR**: Demo mode is a **deployment shape, not a code mode**. A dedicated instance
> (`demo.eigen.is`, own VPS, no `mail` compose profile, no MX, local mounts only) runs with
> `EIGEN_DEMO=1`. Visitors enter through one public route, `GET /p/demo/enter`, which picks a
> **random persona from a fixed ~20-user pool** and signs them in using the exact session-minting
> mechanism the guest-OTP flow already uses in production (`auth.api.signInEmail({asResponse:true})`
> + a deterministic HMAC password nobody ever sees) — no login UI, no auth bypass, no middleware.
> The world is built by an offline `seed-demo.ts` script that drives the real domain APIs as the
> personas (docs and sheets seeded from `.docx`/`.xlsx` fixtures through the *shipped* converters,
> dogfooding import), and a short **host-level** script resets the box every hour: stop container →
> wipe the data root → re-run the seeder → start. Wipe-and-reseed makes every timestamp less than an
> hour old, so nothing date-rots and no cleanup job ever eats seeded content — and it wipes the
> auth DB, so every visitor tamper (rogue org, minted key, enrolled 2FA) is healed by construction.
> Conditional surface in shared code: **one line in `sendMail()`** (extending its existing dev-skip),
> one login-page conditional, and one small `isDemo()`-gated auth guard. No new tables, no scheduler
> jobs, no settings-schema churn, no admin UI. The reset script doubles as the safe offline
> backup/restore that [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md) flags as missing, and
> the seeder is the skeleton of the future import features
> ([PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md), mail `.eml` ingest, vCard).

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
3. Full state reset on a fixed cadence (hourly), surviving any vandalism a visitor can produce —
   including anything that persists into the auth database.
4. Near-zero conditional surface in shared code; demo behaviour must be structurally impossible
   to trigger on a real instance.
5. The machinery pays rent elsewhere: the reset tooling is a general offline backup/restore, the
   seeder is a general fixture-ingestion path.

## Non-goals

- **The elastic warm pool** (the earlier design's per-visitor, seed-on-demand pool). This
  proposal's pool is a small *fixed* set of ~20 pre-seeded personas, not an elastic one that grows
  per visitor. The elastic pool remains the documented upgrade path for high traffic.
- **Demo content authoring** ("Studio Noord" fixtures). v1 ships the machinery plus a minimal
  placeholder set; the content pass is a separate work package.
- **The project front-door / marketing landing on eigen.is.** Independent scope; the demo box
  itself only needs a `/` redirect (Caddy) or a one-line button.
- **Protocol surfaces** (IMAP/CalDAV/WebDAV) in the demo. They keep working with the demo
  credentials nobody has; deliberately left alone. (The app-password vector that *would* hand a
  visitor those credentials is closed in § Demo hardening.)
- **Captcha / abuse hardening beyond rate limits + the demo guard.** The hourly reset is the abuse
  story for v1.

## Why this shape (findings, all verified against source 2026-07-14)

**1. Whole-instance rebuild sidesteps the embedded-ownerId problem.** The earlier design round
correctly banned seeding by copying a template home: `paths.ownerId`, `shared_paths.ownerId`, and
chat `authorId` are embedded inside the per-home DBs, so cloning a home for a *new* user id
produces a broken workspace. But that objection does not apply to resetting the **entire data
root**: `users3.db` and every home are replaced together, so all embedded ids stay consistent by
construction. (Corollary: whole eigen-doc *containers* also byte-copy legally — they reference
children by name, not pathId; `apps/api/src/lib/drive/copy-across.ts:14-17` — which gives
slides/stickies fixture content without new machinery.)

**2. Restart-the-process is the only safe reset, so the reset must live outside the app.**
`shutdownAllHomes()` (`apps/api/src/lib/home/get-home.ts:134`) closes Homes but never closes the
server-level DBs — `users3.db` (opened at `auth.ts:50`, and again as a second module-level handle
in `getAuthDrizzleDb()` at `auth.ts:174`) and `eigen.db` (share-registry singleton, `share/db.ts`).
Swapping files under open handles is the documented `SQLITE_IOERR_VNODE` hazard, and any in-flight
request repopulates the Home map between evict and swap. A host-level stop → replace → start is
both simpler and the only correct option. This single fact deletes the elastic pool, the TTL
cleanup jobs, and their race conditions from the design.

**3. The data model is name/email-keyed, so personas need a stable email, not a stable id.** The
2026-07-14 audit confirmed the project owner's suspicion in full:

- ACL entries match on email (`acl.ts:56-62`, `entry.id.toLowerCase() === user.email`); the share
  registry stores `targetIdentifier` = email.
- Comments and comment-assignment are email-keyed (`createdBy`/`resolvedBy`/`assignee`/
  `lastAuthorEmail`; the comment-card Yjs `creator` is the user email).
- Stickies cards embed `creator: email` only; slides embed no user identity at all.
- Calendar attendees are email (`share-propagation.ts` resolves via `getUserByEmail`); file-history
  rows carry `actorEmail`; notifications carry `actorEmail`.
- Container internals reference children **by name** (proven in `copy-across.ts`).

The **only** user id embedded in fixture bytes is chat `messages.authorId` inside a byte-copied
chat/comment container — and even that is non-load-bearing: the chat UI resolves the display name
from `authorEmail` and uses `authorId` only to style *your own* bubbles
(`chat-message-list.tsx:453-455`, self-check at `:223`). A stranger's `authorId` just loses the
"mine" highlight. **Consequence:** personas are anchored by a fixed **email** list; their ids can
be random each rebuild. The seeder builds personas and their content in one run, so ids are
internally consistent by construction. All the "fixed hardcoded persona ids" bookkeeping the
earlier draft required is deleted. (Whether `messages.authorId` can be dropped for email entirely
is a separate cleanup — tracked in ROADMAP.)

**4. The shared-workspace account surface is not tamper-proof; three vectors need closing.** The
old draft claimed the account was "naturally tamper-proof." Verified false:

- **Org-creation privilege escalation.** `requireAdmin` (`core/access.ts:87-90`) calls
  `getOrgRole(userId)`, which is **not org-scoped** — `select role from member where userId = ?
  .get()` with no org filter and no `ORDER BY` (`user/user.ts:64-66`). The organization plugin is
  enabled without `allowUserToCreateOrganization:false` (`auth.ts:122-131`), so any member can
  create an org and become its `owner`, then (`organization.leave` the default org) leave only the
  `owner` membership behind — now `getOrgRole` returns `owner` and `requireAdmin` passes, unlocking
  the admin settings router (server settings, delete-any-user). This is a latent product authz bug
  independent of the demo — tracked in ROADMAP — and it must also be blocked in demo mode.
- **API keys = live protocol credentials, no password required.** The `apiKey()` plugin is enabled
  with rate-limiting off and no per-account cap (`auth.ts:132-134`); `/auth/api-key/create` needs
  only a session, and `protocol-auth.ts:45-49` accepts any such key as an IMAP/CalDAV/WebDAV
  credential. A visitor could mint working protocol credentials for their persona — contradicting
  "credentials nobody has."
- **Open session revocation + 2FA enrollment.** better-auth's `/auth/revoke-sessions` needs no
  password (a visitor can kick others; bounded, they re-enter), and `/auth/two-factor/enable` would
  turn a persona's next sign-in into a 2FA challenge — locking that persona out of the pool until
  the hourly reset.

The hourly full-root wipe already *heals* all of these within the hour (fresh `users3.db` each
reset → no rogue orgs, no minted keys, no 2FA). The demo guard in § Demo hardening closes the
*within-the-hour* window cheaply.

## Design

### 1. Entry: `GET /p/demo/enter`

A public route (in `routes/public.ts` or a sibling `routes/demo.ts`), gated at the top of the
handler by `isDemo()` (Elysia mounts routes at startup, so the gate is a runtime check; on real
instances the route 404s and is inert):

- **Pick a random persona.** Query the demo org's members (role `member`, excluding the admin)
  from `getAuthDrizzleDb()` and choose one at random. Pool size is whatever the seeder created
  (~20). No hardcoded email list in the route — the pool is discovered from the org membership, so
  it can't drift from the seeder.
- **Mint the session** exactly as `guest-auth.ts` does: upsert the persona's `credential` account
  with the deterministic password `HMAC-SHA256('demo:' + email, auth.options.secret)`, then
  `return auth.api.signInEmail({ body, asResponse: true })` and relay the `Set-Cookie` on a 302 to
  `/space`. Real better-auth session, real signed cookie, zero new auth surface. Re-deriving and
  re-setting the password on every entry (as the guest flow does at `guest-auth.ts:126-146`) means
  a visitor who changes the persona's password can't lock the next visitor out — the next entry
  overwrites it.
- `isDemo()` = `process.env.EIGEN_DEMO === '1'`, added next to `isProduction()` in
  `apps/api/src/lib/config/env.ts`. An env var, not a server setting: the whole instance is the
  mode, it must not be togglable from an admin UI, and it cannot drift onto a real instance.
  (Additive optional env var — safe for `update.sh` per the add-var-if-missing convention.)
- Personas have 2FA off (2FA would divert `signInEmail` into the two-factor flow — verified at
  `protocol-auth.ts:60-63`, better-auth resolves `{twoFactorRedirect:true}` with no cookie) and
  `role: 'user'` / org `member` (not guest — `requireNonGuest` (`core/access.ts:68-72`) gates
  guests out of nearly every product route; not admin — keeps the admin app out of reach, subject
  to the org-create block in § Demo hardening).

**Random-assignment residual:** two concurrent visitors can land on the *same* persona (≈ 1/20 per
pair) and edit that persona's private drive together, the way the single-account model did — but
1/20 as often, and shared/team content is the common case anyway. Acceptable; no LRU hand-out
state in v1.

**Post-reset re-entry:** a reset wipes the auth DB, so every session is invalid; the visitor's next
request 401s and the FE redirects to `/login`. One FE conditional: when `publicConfig.demoMode` is
true (new boolean on the existing `GET /p/config`, `routes/public.ts:74-78`), the shared
`login-page.tsx` renders an "Enter demo" button linking to `/p/demo/enter` instead of the
credentials form. Mounted by every app via `createLoginRouteOptions`, so the one conditional
covers all login screens.

Rate limiting comes free: the global IP limiter (`app.ts:81-92`, 1000 / 60s, keyed by
`clientIpKey`) already covers the route, and the OTP-limiter pattern (`otp-rate-limit.ts`) is
available if targeted abuse shows up. The direct `auth.api.signInEmail` call does not pass through
better-auth's `/sign-in/email` HTTP rate rule, so entry bursts don't trip it.

### 2. Seeding: `apps/api/src/scripts/seed-demo.ts`

An **offline, in-process script** — invoked standalone like `seed-test-mail.ts`, built on the
mechanics `apps/api/src/test/setup.ts` already proves (boot the Elysia app in-process, drive it
with real requests and library calls). It runs against an empty `EIGEN_DATA_ROOT` and builds the
world through product surfaces, **authored as the personas** (no fixed ids — personas are keyed by
a fixed email list):

| Domain | Mechanism (all existing) |
|---|---|
| Org + admin | `POST /setup/complete` in-process, as the test harness does |
| ~20 personas | `auth.api.createUser` (ids generated by better-auth; the `user.create` hook auto-joins them to the default org as `member`). Keyed by a fixed **email** list so email-anchored content (ACLs, comments, stickies `creator`) resolves across rebuilds |
| Drive folders/files | `Drive.create` / `uploadFiles`, binary fixtures from `fixtures/`, authored as personas |
| Docs + Sheets | `.docx`/`.xlsx` fixtures through the shipped convert path (`lib/import/import-document.ts` → the exported `writeEigendocToYjs` / `writeSheetsToYjs` seams, no HTTP dependency) — no new Y.Doc builders; the demo dogfoods import on every reset |
| Slides + Stickies | Fixture **containers** (hand-made `.eigenslides`/`.eigenstickies` dirs) copied in — legal per the container-copy design; slides embed no identity, stickies embed only `creator: <persona email>` (use pool emails so names resolve). Writing `writeSlidesToYjs`/`writeStickiesToYjs` (readers exist, writers don't) is the clean long-term path; do it with the content pass |
| Mail | `composeRfc822()` + Maildir `store.append()` — the welcome-mail mechanism (`lib/mail/welcome.ts`), persona threads with arbitrary From/To/Date headers, dates relative to now. Open the mailbox (or omit `skipSync`) so the reconcile indexes the appended files before the run ends |
| Calendar | `createEventAt` (`home-relay.ts:180`), events placed relative to seed time; persona organizer/attendees live in the `data: EventData` payload (`attendees`/`organizer`) |
| Contacts / Chat / comments / shares | Existing domain APIs (`POST /contacts/...`, `ChatRoom.postMessage`, ACL PUT), authored as personas |

**Thread persona actors through every mutation.** Drive records file history only when an actor
is threaded ("no actor, no row" — `history.ts:47-77`), and `postMessage` records `commented` and
fans out to watcher notifications. Seeding through the same seams the product uses means Activity
panels, file history, watchers, and the notification bell look alive with zero extra code. Because
the pool are colleagues in one org with cross-shares, whichever persona a visitor lands as, the
panels are populated.

**No byte-copied chat/comment fixtures.** Chat and comment content is seeded through
`ChatRoom.postMessage` as personas, never as pre-baked container bytes — this keeps the one
id-in-bytes case (`messages.authorId`) out of the fixtures entirely, so random per-rebuild ids stay
consistent. Byte-copied fixtures are limited to slides (identity-free) and stickies (email-only).

### 3. Reset: `scripts/demo-reset.sh` + systemd timer

**Recommended — full data-root wipe:**

```
docker compose stop eigen-api        # graceful: SIGTERM → gracefulShutdown() checkpoints + closes homes within the 30s stop_grace_period
rm -rf data/server data/home data/team data/org data/guest   # never data/certs, data/dkim
bun run apps/api/src/scripts/seed-demo.ts   # runs /setup/complete + creates the pool + reseeds every home
docker compose start eigen-api
```

Hourly, on the hour. No in-app scheduler involvement. Downtime is seconds and predictable.
(`index.ts:38-39` registers SIGTERM/SIGINT → `gracefulShutdown()`; `docker-compose.yml` sets
`stop_grace_period: 30s`; the seeder must `export EIGEN_DATA_ROOT=<repo>/data` first — `paths.ts`
throws in production if it's unset.)

Wipe-and-reseed (rather than restoring a golden tarball) buys three properties:

- **Rot immunity.** Every timestamp — calendar, mail, activity, `updatedAt` — is < 1h old. "Today"
  is never empty; the age-based reapers never see anything old enough to eat. (Verified: the only
  timer-based job is `guest-cleanup` (daily, 7-day idle); every other cleanup runs at mount-init
  and none deletes < 1h *committed* content — `jobs.ts`, `mount.ts:193-213`.)
- **Schema-drift immunity.** `users3.db` has **no** migrate-on-open (its schema comes from
  `completeSetup`'s `CREATE TABLE`s — `setup.ts:20-228` — unlike every `ManagedDatabase`, which
  self-migrates). Rebuilding it from current code hourly makes drift structurally impossible.
- **Tamper immunity.** Wiping `users3.db` heals *every* auth-DB tamper by construction — rogue orgs,
  minted api-keys, enrolled 2FA, changed passwords all vanish. This is the property a partial wipe
  gives up (below).

**Reconsidered — can we wipe only `data/home` + `data/team`?** Tempting (skip re-running setup,
keep persona ids and sessions stable across resets), but it reopens work the full wipe closes for
free:

- **Identity-tamper accumulates.** Keeping `users3.db` keeps every rogue org, minted api-key, and
  enrolled 2FA a visitor created — the exact vectors § Demo hardening exists to bound. The reset
  would have to *heal* each one (delete rogue orgs, revoke keys, clear 2FA) instead of the wipe
  doing it for nothing.
- **Share registry accumulates.** `eigen.db` (server-level, under `data/server`) holds the seeded
  shares; if it survives while homes are reseeded, each hour's seeding piles duplicate share rows on
  top of the last. So `data/server/eigen.db*` would have to be wiped anyway — a partial wipe of
  `data/server`, not a clean "keep it."
- **Schema rebuild goes out-of-band.** Keeping `config.json` (setupCompleted=true) while wiping
  `users3.db` means the app won't re-run `completeSetup` on boot, so the seeder must recreate the
  auth schema itself (call `resetAuthDatabase()` + org + admin directly) instead of the proven
  `POST /setup/complete` path.

The only real win of the partial wipe is that **sessions survive** (a visitor mid-demo isn't
logged out on the hour). That is a UX nicety, not a requirement — re-entry is one click and hands
out a fresh random persona. Re-running setup is sub-second (a handful of `CREATE TABLE`s + inserts),
so "avoid re-running setup" is not a real cost. **Recommendation: full wipe.** If surviving sessions
later prove worth it, the partial variant is a documented option with the three obligations above.

**Optional later optimization** — only if the content pass makes seeding measurably slow: run the
seeder nightly, tar the *stopped* data root (including `-wal`/`-shm`; the two server DBs are never
checkpointed on exit, their WALs are load-bearing), and have the hourly reset untar. The snapshot
is a cache of the seeder, never the source of truth. Don't build it up front.

### 4. Demo hardening: one `isDemo()`-gated auth guard

Three abuse vectors (§ Why this shape, finding 4) are open to any signed-in persona. The hourly
wipe heals them, but a single small guard closes the within-the-hour window. `routes/auth.ts`
mounts better-auth via `.mount(auth.handler)` on the `betterAuth` Elysia instance; add an
`onBeforeHandle` on that instance that, **only when `isDemo()`**, rejects a short denylist of
mutation paths with 403:

- `/auth/api-key/create` (and other `/auth/api-key/*` writes) — closes the protocol-credential
  vector; also means the FE app-passwords section is inert in demo (gate it off `publicConfig.demoMode`
  if it errors on an empty list).
- `/auth/two-factor/enable` — a persona can't be locked out of the pool by a 2FA challenge.
- `/auth/organization/create` (and `/auth/organization/leave`) — closes the privilege-escalation
  path belt-and-suspenders, on top of the product-level `allowUserToCreateOrganization:false` fix
  (ROADMAP). Optionally `/auth/revoke-sessions` to stop cross-visitor session griefing.

One new seam, `isDemo()`-inert on real instances (the guard is a pass-through when the env var is
unset). This is the honest cost of the shared-workspace model — small, but not the "zero auth
changes" the earlier draft claimed.

### 5. Deployment shape (settings + compose, no code)

- Own smallest-class VPS, own domain (added to auth trusted origins via setup's `domain`),
  `EIGEN_DEMO=1` in `.env.production`.
- **Local mounts only** — an `s3` mount stores bytes outside the data root and would desync from
  the reset. Server settings enforce the rest without any code: signups disabled, guests off,
  tiny quotas (50 MB mount, 5 MB upload). These are `updateServerSettings` (admin) values the seeder
  sets each run — `guests.openSignup`, `quotas.defaultMountMaxSizeMB`, `quotas.maxUploadSizeMB`,
  `defaults.mount.storageType` (`server-settings.ts`).
- No `mail` compose profile, no MX records: outbound and inbound mail are physically absent. (The
  `mail` profile is `unbound` + `postfix` + `dovecot`; leaving it off removes both the MTA and the
  inbound `/mail/deliver` path.)
- **The one shared-code mail change:** `sendMail()` (`lib/core/mailer.ts:93-102`) already skips when
  `!isProduction() && !SMTP_HOST`; extend that early-return to `isDemo()`. It is load-bearing, not
  cosmetic — on a production box with no `SMTP_HOST` and no sendmail binary, `sendMail` would
  otherwise throw on every share/ACL-add, access-request, and iMIP invite. One seam covers every
  caller **including the mail app's own send route** (`mail-domain.ts:547`), which routes through
  `sendMail()`. Inert without the env var. (Cross-persona *inbound* threads are seeded by Maildir
  append, not by the send route, which only moves a draft to Sent.)

## The pool trade

Visitors are one of ~20 personas, assigned at random, all sharing one org's workspace. Deliberate,
and load-bearing for the simplicity:

- **Real multi-user collab out of the box.** Two visitors usually land as *different* colleagues and
  can both open the same shared/team doc — live cursors, presence, comments, activity panels
  updating in real time, each under a distinct name. No staged second account, and a better demo of
  presence than one shared login gave.
- **Bounded blast radius.** A visitor can damage only the persona they hold plus shared resources,
  and only until the hourly reset. "Nuke the box" is automated.
- **Tamper-resistant by construction + guard.** Password change is overwritten on the next entry;
  api-key / 2FA / org-create are blocked in demo (§ Demo hardening); the wipe heals whatever slips
  through. Email change is disabled server-wide already (no `changeEmail` config in `auth.ts`).

Accepted residuals, stated plainly: offensive content can be visible to other visitors for up to an
hour; two visitors on the same persona see each other's edits to that persona's private drive (rare
at 1/20, and the point for shared content — the demo banner should say so); a visitor can trash the
workspace mid-hour (the reset heals it); session-revocation griefing kicks others until they
re-enter (bounded; optionally guarded). If traffic ever demands per-visitor isolation, the elastic
warm pool (per-visitor pre-seeded accounts) or better-auth's shipped-but-unwired `anonymous()`
plugin layers on top later — the entry route, seeder, and reset script all survive that upgrade.

## Code-footprint inventory

| Where | What |
|---|---|
| New `routes` handler `/p/demo/enter` | ~35 lines, `isDemo()`-gated, guest-auth mechanics + random pool pick |
| New auth guard on `betterAuth` instance | `onBeforeHandle`, `isDemo()`-gated denylist (api-key / 2FA / org-create) |
| New `apps/api/src/scripts/seed-demo.ts` + `fixtures/` | Offline seeder; never runs on real instances |
| New `scripts/demo-reset.sh` + timer unit | Host-level; not part of the app |
| `lib/config/env.ts` | `isDemo()` |
| `lib/core/mailer.ts` | One condition on the existing dev-skip |
| `routes/public.ts` `/p/config` | `demoMode: boolean` |
| `packages/ui` `login-page.tsx` | One conditional: enter-demo button |
| AppShell demo banner (small) | Keyed off `publicConfig.demoMode` |

Mainline conditional surface on real instances: one line in `sendMail`, one FE conditional, and a
pass-through auth guard (inert without `EIGEN_DEMO`). No new tables, no settings-schema changes, no
scheduler jobs, no changes to Drive, ACL, or Home code. Estimated effort: **3–5 focused days** for
the machinery; the fixture-content pass is separate and unchanged.

## What this pays for elsewhere

1. **Safe offline backup/restore.** `scripts/backup.sh` today tars the live tree (torn WALs — the
   P0 in [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md)), and no restore script exists.
   The reset's stop → copy-stopped-root-with-WALs → start sequence *is* the correct offline backup
   and restore. Ship it as `scripts/snapshot.sh` / `scripts/restore.sh` with `demo-reset.sh` as a
   thin composition, and production gains its offline backup story from the same work.
2. **The import skeleton.** The seeder's shape — fixture files ingested through domain APIs into a
   Home — is the future import feature set. Docs/sheets seeding already rides the shipped
   docx/xlsx converters; the mail path is an `.eml`-ingest function one refactor away from a
   user-facing mail import; when [PROPOSAL_CALENDAR_IMPORT.md](PROPOSAL_CALENDAR_IMPORT.md) lands,
   the seeder swaps its event loop for the `.ics` importer and dogfoods it hourly. Every gap the
   seeder fills is a product feature, not demo-only code.

## Rejected alternatives

- **Single shared account (the 2026-07-11 interim design)** — replaced by the pool. One login gave a
  weaker collab demo (no distinct colleagues), the same tamper surface concentrated on one account,
  and no upside over ~20 personas once the seeder exists.
- **Fixed hardcoded persona ids** — unnecessary given the name/email-keyed data model (finding 3);
  `auth.api.createUser` generates ids anyway, and honoring fixed ids would force direct `userTable`
  inserts + hand-rolled credential rows.
- **Auto-login middleware on sessionless requests** — touches the session hot path on every
  instance; the explicit enter-route gets identical UX with zero mainline surface.
- **Per-visitor accounts via `anonymous()` plugin (v1)** — each anonymous user gets an empty home;
  per-visitor seeding drags elastic-pool machinery back in. Kept as the upgrade path.
- **Per-visitor template-home byte-copy** — broken by embedded ownerIds (unchanged finding).
- **In-process hourly reset via `scheduleInterval`** — unsafe; see § Why this shape, finding 2.
- **Partial `data/home`+`data/team` wipe** — deferred, not rejected: reopens identity-tamper +
  share-registry accumulation and needs an out-of-band schema rebuild (§ Reset). Documented option
  if surviving sessions ever justify it.
- **The elastic warm pool as v1** — deferred: it solves instant-entry against *slow* seeding of
  rich per-visitor content, which is not v1's problem. Revisit with traffic data.

## Open decisions

1. **Pool size / persona set** — ~20 proposed. Enough for varied authorship and low same-persona
   collision without a heavy seed.
2. **Reset cadence** — hourly proposed; 30 min tightens the abuse window, 2–4 h is calmer for
   engaged visitors.
3. **Slides/stickies v1 content** — fixture-container copy (proposed) vs writing the Yjs builders
   now vs near-empty placeholders.
4. **Mail-send UX** — with the mailer skip, a demo "send" silently succeeds-then-vanishes. If that
   confuses testers, add a 403 + toast on the send route later (one more gated check, consciously
   deferred).
5. **Session-revocation guard** — block `/auth/revoke-sessions` in demo (stops cross-visitor
   griefing) or leave it (bounded by re-entry). Proposed: block it with the same guard.
