# Demo mode

> **TLDR**: Demo mode is a **deployment shape, not a code mode**. A dedicated box runs with
> `EIGEN_DEMO=1`; visitors enter through one public route, `GET /p/demo/enter`, which signs them
> into a random seeded persona from a ~20-user pool using the same session-minting mechanism the
> guest-OTP flow uses in production. An offline `seed-demo.ts` script builds a lived-in workspace
> through the real product surfaces, and a host-level script wipes and reseeds the box every hour.
> Mainline conditional surface on a real instance is near zero: one line in `sendMail`, a
> compose-send guard, one `/p/config` flag, two login-surface conditionals, a demo banner, a
> pass-through auth guard, and the inert entry route — all keyed off `isDemo()`
> (`EIGEN_DEMO === '1'`) and dead without the env var.

## What demo mode is

`isDemo()` (`apps/api/src/lib/config/env.ts`) reads `process.env.EIGEN_DEMO === '1'`. It is an env
var, not a server setting — the whole instance is the mode, so it can't be toggled from an admin UI
and can't drift onto a real box. Everything else is a runtime check against it. The exact touchpoints
that exist in mainline code (all inert when `EIGEN_DEMO` is unset):

- **`sendMail` skip** (`lib/core/mailer.ts`) — the existing dev-skip early-return also fires on
  `isDemo()`. Load-bearing: a demo box has no MTA, so a real send would throw on every share/invite/iMIP.
- **compose-send guard** (`lib/mail/mail-domain.ts` `messageSend`) — the one interactive send path
  throws a friendly `ApiError` in demo (the mail mutation toasts it), so a visitor gets "outgoing
  email is turned off" instead of a silent fake send. Deliberately NOT in `sendMail`: that would turn
  the ~10 fire-and-forget notification sends (share/invite/iMIP/access-request) into logged errors and
  regress the shared dev/test skip that guest-OTP and 2FA rely on. The message stays in Drafts.
- **`/p/config` `demoMode`** (`routes/public.ts`) — `getPublicConfig()` gains `demoMode: isDemo()`,
  the single flag the frontend keys off.
- **login-page conditional** (`packages/ui/.../pages/login-page.tsx`) — when `demoMode` is true the
  card is just an **Enter demo** button (linking to `/p/demo/enter`); there is no password sign-in and
  no Guest tab (guest signup is off in demo). The hourly wipe/reseed rebuilds the admin account each
  hour, so a demo box deliberately exposes no web credentials form to visitors.
- **index-landing conditional** (`apps/index/.../routes/index.tsx`) — when `demoMode` is true the
  landing page's primary button reads **Enter demo** and points at `/p/demo/enter` instead of the
  normal **Login** button that goes to `/space`.
- **`DemoBanner`** (`packages/ui/.../app/demo-banner.tsx`, mounted once in `AppShell`) — a
  warning-toned strip (`bg-warning`, `border-t`) pinned to the BOTTOM edge of the app shell:
  "Shared demo workspace. You are exploring as \<first name\>. Everything resets every hour."
  (the name-less fallback drops the middle sentence).
- **pass-through auth guard** (`routes/auth.ts`) — an `onBeforeHandle` that returns immediately when
  `!isDemo()`.
- **inert `/p/demo/enter`** (`routes/demo.ts`) — the route is always registered but 404s when
  `!isDemo()`.

No new tables, no scheduler jobs, no settings-schema churn, no changes to Drive/ACL/Home code.

## Entry: `GET /p/demo/enter`

Public route (no `auth: true`), gated at the top by `isDemo()` (else 404), then a tight per-IP rate
limit (`checkDemoRateLimit`, `lib/auth/demo-rate-limit.ts`, 10/60s — the route is unauthenticated and
runs two scrypt ops per hit, so the global 1000/60s limiter isn't enough; Caddy's `X-Real-IP` keys it).
It reads the demo org id from server config, then discovers the pool via `getDemoPersonaPool`
(`lib/auth/demo-persona-pool.ts`) — org members with role `member` (the setup admin is org `owner`, so
it's excluded) and 2FA off (a 2FA member would divert `signInEmail` into the two-factor flow), so the
pool can never drift from the seeder — and picks one at random. It signs that persona in via
`signInWithScopedPassword('demo', id, email)`
(`lib/auth/guest-auth.ts`), relays the response's `Set-Cookie` headers with `getSetCookie()` (which
keeps multiple cookies distinct where `get()` would comma-join them), and 302s to `/space`.

`signInWithScopedPassword` is shared with the guest-OTP flow (scope `'guest' | 'demo'`). It upserts
the account's credential with a deterministic password `HMAC-SHA256('<scope>:' + email, auth.secret)`
that nobody ever sees, then calls `auth.api.signInEmail({ asResponse: true })` for a real signed
better-auth session. Re-deriving and overwriting the password **on every entry** is the
password-tamper heal: a visitor who changes a persona's password can't lock the next visitor out.

**Random-assignment residual:** two concurrent visitors can land on the same persona (~1/20 per
pair) and co-edit its private drive; shared/team content is the common case and the point of the pool.

## Auth guard

Three auth mutations are open to any signed-in persona; the hourly wipe heals them but a small guard
closes the within-the-hour window. `routes/auth.ts` adds an `onBeforeHandle` on the `betterAuth`
instance that, **only when `isDemo()`**, 403s a short denylist (`DEMO_BLOCKED_AUTH_PATHS`):

- `/auth/api-key/{create,update,delete}` — api keys are live IMAP/CalDAV/WebDAV credentials
  (`protocol-auth.ts` accepts any key), so a visitor could mint working protocol credentials.
- `/auth/two-factor/enable` — a 2FA enrollment would turn the persona's next sign-in into a challenge,
  locking it out of the pool until the reset.
- `/auth/revoke-sessions`, `/auth/revoke-other-sessions` — kicking other visitors is griefing.

**Org create/leave are deliberately NOT blocked here.** The privilege-escalation path they used to
open (create an org → leave the default org as `owner` → `requireAdmin` passes) was fixed at the
product level: `requireAdmin`/`getOrgRole` are scoped to `config.orgId` and the org plugin sets
`allowUserToCreateOrganization: false` (commit `32fe269d`, regression-pinned by `org-privesc.test.ts`).
No demo-specific guard is needed.

**Ordering constraint.** The guard MUST be chained before `.mount(auth.handler)`. Elysia's AOT
compilation freezes each instance's lifecycle pipeline in registration order, so a hook added after
`.mount()` never runs for the mounted better-auth handler.

## Seeder: `apps/api/src/scripts/seed-demo.ts`

An offline, in-process seeder — it imports `../app`, POSTs `/setup/complete`, and drives the real
domain surfaces as the personas, so Activity panels, file history, watchers, and the notification
bell populate for free. It runs against an **empty** `EIGEN_DATA_ROOT` and refuses a completed setup
(`server/config.json` exists — the reset script wipes first). Storage is `local-id`; it enforces the
demo settings (`guests.openSignup: false`, `defaultMountMaxSizeMB: 50`, `maxUploadSizeMB: 5`, and
`onboarding.welcomeMail.enabled: false` so no "Welcome to …" system mail lands as inbox message #1).

- **Email-keyed personas, no fixed ids.** `content.ts` `PERSONAS` are keyed by a stable email
  local-part; the runtime email is `<key>@MAIL_DOMAIN`. Everything the data model keys on (ACLs,
  comments, calendar attendees, stickies `creator`) resolves by email, so ids may be random each
  rebuild. `auth.api.createUser` generates them; the `user.create` hook auto-joins each to the org.
- **Content split from mechanics.** `apps/api/src/scripts/demo/content.ts` is **data only** — the
  "Tuimel Festival" personas, folder names, and document/mail/event/chat/contact text. `seed-demo.ts`
  turns it into a live workspace. A later content-deepening pass swaps `content.ts` without touching
  mechanics.
- **Content conventions.** All seeded directory and file names are lowercase; chat channels live in a
  `chats/` directory on the team drive (a few messages, and some doc/stickies comment replies, are
  `/cheer`-style slash-command emotes the chat app renders). A chat line's `attach` names seeded team documents (`'site plan'`, `'crew roster'`, …) the seeder posts as drive-reference attachments, so the message links the real container. A `festival crew` team is created
  (`createTeam` + `addTeamMember` per persona) with an explicit shared mount.
- **Docs through the shipped importer.** Docs are HTML → `.docx` (`@turbodocx/html-to-docx`) →
  `convertToDocument(..., 'eigendoc')`. The demo dogfoods import on every reset; no bespoke Y.Doc builder.
- **Slides, sheets, and stickies from fixture containers.** `demo/fixtures/{sponsor-pitch.eigenslides,
  festival-budget.eigensheets, festival-kanban.eigenstickies}` (`data.db` + `comments.db`, plus a
  `media/` folder for any embedded images) are byte-copied in via `placeFixture` — legal because
  eigen-doc containers reference their internals (including media) by name, not pathId.
  - The **slides deck and budget sheet are hand-maintained**: edit them in a live demo, then copy the
    container's `data.db`/`comments.db`/`media/*` back into `fixtures/` (the content lives in `data.db`,
    not in `content.ts`). `author-fixtures.ts` must NOT regenerate them.
  - The **stickies board is content-driven**: `author-fixtures.ts` regenerates it from `KANBAN` when the
    board's title/description/column/creator content changes (the exact Y.Doc shapes the editors read
    live in `demo/fixtures-build.ts` `buildStickiesDoc`, which `author-fixtures.ts` calls). Its `creator`
    keys are rewritten to runtime emails after copy, and each `CardSpec`'s `chat` slug +
    `chatText`/`chatReplies` become a live chat
    (real personas, same as doc comments) with `color`/`chatName` patched onto the placed board's `tasks`
    Y.Map — so that part needs no fixture regen.
- **Site plan is content-driven, no fixture.** `content.ts` `SITE_PLAN` is a typed spec (shapes, arrows, lines, images, texts); `demo/vector-build.ts` `buildVectorDoc` writes it straight into a freshly created `site plan.eigenvector` container's Y.Doc (authored by Saar in `production/`), the way the stickies board is authored but without any byte-copied fixture to migrate. Text is sized from the `demo/excalifont-metrics.ts` advance table (the seeder has no DOM to `measureText` with); ids and roughjs seeds are deterministic so every reseed renders identical jitter. The two referenced images upload into the container's `media/` subfolder via `createFileFromData`, matching each image element's `mediaName`. Arrows bind to shapes by key (`{ shape, side, along? }`) and settle through the lib's own `followBindings`, so they read back exactly as an editor would store them; shapes take an `angle`, lines a `freedraw` flag. The spec is authored top-left-positive; the builder shifts the finished drawing so its bounding box is centred on the scene origin, where the editor opens. To eyeball a layout change without a browser, build a fresh Y.Doc with `buildVectorDoc`, run it through `readVectorFromDoc` + `sceneToSvg` (the same renderer the app and previews use), and open the SVG.
- **Site photos in `images/`.** `demo/fixtures/images/*.webp` (five of the maintainer's own
  coastal/festival photos, two Unsplash) are uploaded into an `images/` team-drive folder through
  the real `createFileFromData` path, keyed to plausible persona uploaders (`content.ts` `PHOTOS`).
  Attribution + licensing in `demo/fixtures/images/CREDITS.md`.
- **Branding in `branding/`.** `demo/fixtures/branding/*` (the festival logo) uploaded into a
  `branding/` team-drive folder the same way (`content.ts` `BRANDING`).
- **Portraits in `avatars/`.** `demo/fixtures/avatars/*.jpg` (one per persona plus the admin, keyed by
  `content.ts` `avatar`, credits in the folder's `CREDITS.md`) go through the real avatar upload +
  self-update path, so `pushUserProfile` writes `server/avatars/<id>.webp` and sets `user.image` exactly
  like a user-uploaded avatar. A missing fixture is logged and skipped, never fatal.
- **Personal notes doc per persona.** Every persona gets a private `my notes.eigendoc` in their OWN
  drive (`content.ts` `NOTES`, same cozy role-agnostic content for all) — one `.docx` built once,
  converted per persona through the shipped importer into their home drive. Not shared.
- **Mail as raw RFC822.** `buildRfc822` (nodemailer `MailComposer`) writes real `Date` headers (dates
  relative to seed time) and `Home.mail.mailboxDeliver` indexes them into `mail.db`. Most personas get
  a dedicated `inbox-thread` with an external party; a persona's OWN replies in that thread are moved
  to their Sent box and marked read (`messageMove`/`messageSetRead`), so only genuinely inbound mail
  stays in the inbox. All-hands mail lands in every persona's inbox. A message may carry `html`
  (rendered as a real `multipart/alternative` list/paragraph body); an all-hands flow may set
  `attachTeamDrive` to append an "Open festival →" drive-reference pill (`renderAttachmentPills`)
  linking the shared team drive, the same pill the mail client bakes into a sent message.
- **Comment cards written AND anchored.** For each seeded comment the seeder wraps the anchor phrase
  in a `comment` mark carrying the card id (`injectCommentMark`, mirroring the editor's `setComment`)
  and writes the card into the doc's `comments` Y.Map (`writeCommentCard`, mirroring the FE's
  `writeCardToDoc`). The comment thread is a real chat under the container's `chat/` folder; assignment
  records the same `assigned` event + bell notification the route would.
- **Every card gets the shared default color.** Doc comment cards and stickies cards both use
  `CommentCard`/`color` — no seeded card is left uncolored. `DEFAULT_CARD_COLOR` in `seed-demo.ts`
  is `EIGEN_STICKIES_COLORS[0][1].value` (yellow-100, `#fef9c2`), the same fallback the shared card
  dialog (`card-dialog.tsx`) uses for an uncolored card, so seeded and manually-created cards match.
- **`__Secure-` cookie name.** With an https `API_URL` (or `NODE_ENV=production`) better-auth prefixes
  its cookie names with `__Secure-`. The seeder needs an admin session for `addTeamMember`, so it
  matches the full `name=value` pair verbatim (`(?:__Secure-|__Host-)?better-auth.session_token=...`)
  rather than rebuilding the name — otherwise the session lookup misses and the seed aborts on a real box.
- **Invocations.** Locally: `cd apps/api && EIGEN_DATA_ROOT=/abs/data MAIL_DOMAIN=tuimel.example bun
  run src/scripts/seed-demo.ts`. On the box (throwaway container, WORKDIR `/app/apps/api`): the reset
  script runs it by **absolute** path, `bun run /app/apps/api/src/scripts/seed-demo.ts`.

## Reset: `scripts/demo-reset.sh`

Hourly, on the hour, host-level (no in-app scheduler — swapping DB files under open handles is the
`SQLITE_IOERR_VNODE` hazard, so the reset must live outside the app). Sequence:

1. `docker compose stop eigen-api` — graceful SIGTERM within the 30 s `stop_grace_period`.
2. `rm -rf data/server data/home data/team data/org data/guest` — an **explicit list, never a
   wildcard**. `data/certs` (Caddy) and `data/dkim` (mail) survive.
3. Reseed in a throwaway container off the current image (`run --rm --no-deps eigen-api ...`).
4. Restart `eigen-api` — via a trap, but **only if `data/server/.demo-seeded` exists** (an empty
   sentinel the seeder writes as its final step, so a crash mid-seed can't satisfy the gate — the
   half-built world stays behind the stopped API). A failed seed leaves the API stopped rather than
   serving the public first-run setup wizard to strangers; the next hourly run (or an operator) retries.

**Hard gate:** the script refuses to run unless `.env.production` contains `EIGEN_DEMO=1`, so it is
physically unable to wipe a real box. The full-root wipe (rather than restoring a golden tarball)
keeps every timestamp < 1 h old (rot immunity), rebuilds `users3.db` from current code each hour
(schema-drift immunity), and heals every auth-DB tamper by construction (rogue orgs, minted keys,
enrolled 2FA all vanish).

Install the hourly run with the shipped systemd units (`scripts/systemd/eigen-demo-reset.{service,
timer}`, `OnCalendar=hourly`, `Persistent=true` to catch a run missed while the box was down), or the
one-line cron alternative in the setup guide.

`scripts/snapshot.sh` / `scripts/restore.sh` are the general offline backup/restore that fall out of
the same stop → copy-quiesced-tree → start sequence: `snapshot.sh` tars the quiesced `data/` (WAL/`-shm`
included, so the never-checkpointed server DBs restore crash-consistent), `restore.sh` moves the current
tree aside before unpacking. Both are production-usable, independent of demo mode.

## Deployment shape

- `COMPOSE_PROFILES=edge` (no `mail`): no postfix/dovecot/unbound, no MX — outbound and inbound mail
  are physically absent, which is why `sendMail` skips.
- Local mounts only — an `s3` mount stores bytes outside the data root and would desync from the wipe.
- `docker-compose.yml` passes `EIGEN_DEMO: ${EIGEN_DEMO:-0}` through to the API; `scripts/update.sh`
  adds it via `add_var_if_missing EIGEN_DEMO 0`, so an update never breaks an existing `.env.production`.
- The seeder sets the server settings (signups off, quotas) each run, so they can't drift.

See the **Demo instance** section of `docker/SETUP-GUIDE.md` for the operator walkthrough.

## Accepted residuals and deferred items

- Two concurrent visitors can land on the same persona (~1/20 per pair) and see each other's private-drive edits.
- Offensive content a visitor creates is visible to others for up to an hour, until the reset.
- The login page holds its form area until `/p/config` resolves, so a demo box costs one uncached paint before the Enter-demo button appears.
- Idle visitors aren't kicked at the top of the hour; their next request 401s and the client redirects to login (a client-side session check, not a server push).
- The elastic per-visitor warm pool (per-visitor pre-seeded accounts) remains the documented scale-up path if traffic ever demands per-visitor isolation; the entry route, seeder, and reset all survive that upgrade.

## Key files

| File | Purpose |
|------|---------|
| `apps/api/src/lib/config/env.ts` | `isDemo()` |
| `apps/api/src/routes/demo.ts` | `GET /p/demo/enter` (rate-limit + pool pick + session mint) |
| `apps/api/src/lib/auth/demo-persona-pool.ts` | `getDemoPersonaPool` (pool query: org members, minus admin + 2FA) |
| `apps/api/src/lib/auth/demo-rate-limit.ts` | `checkDemoRateLimit` (per-IP cap on `/p/demo/enter`) |
| `apps/api/src/lib/auth/guest-auth.ts` | `signInWithScopedPassword` (shared HMAC session mint) |
| `apps/api/src/routes/auth.ts` | `DEMO_BLOCKED_AUTH_PATHS` guard (before `.mount`) |
| `apps/api/src/routes/public.ts` | `/p/config` `demoMode` flag |
| `apps/api/src/lib/core/mailer.ts` | `sendMail` demo skip |
| `apps/api/src/lib/mail/mail-domain.ts` | `messageSend` compose-send guard (403 + toast in demo) |
| `apps/api/src/scripts/seed-demo.ts` | Offline in-process seeder (mechanics) |
| `apps/api/src/scripts/demo/content.ts` | Tuimel Festival content (data only) |
| `apps/api/src/scripts/demo/author-fixtures.ts` | Regenerates the stickies board fixture (slides/sheets are hand-maintained) |
| `apps/api/src/scripts/demo/fixtures-build.ts` | `buildStickiesDoc` — the Y.Doc shapes `author-fixtures.ts` writes |
| `apps/api/src/scripts/demo/vector-build.ts` | `buildVectorDoc` — writes the `SITE_PLAN` spec into the site plan's Y.Doc at seed time |
| `apps/api/src/scripts/demo/excalifont-metrics.ts` | Generated Excalifont advance/kerning table the builder sizes text with |
| `apps/api/src/scripts/demo/fixtures/` | Byte-copied `.eigenslides` / `.eigensheets` / `.eigenstickies` containers + `images/` site photos + `branding/` logo + `avatars/` portraits (`images/` and `avatars/` carry their own `CREDITS.md`) |
| `scripts/demo-reset.sh` | Hourly wipe + reseed (hard `EIGEN_DEMO=1` gate) |
| `scripts/snapshot.sh` / `scripts/restore.sh` | General offline backup/restore |
| `scripts/systemd/eigen-demo-reset.{service,timer}` | Hourly timer units |
| `packages/ui/.../app/demo-banner.tsx` | Workspace banner |
| `packages/ui/.../pages/login-page.tsx` | Enter-demo entry (app login card) |
| `apps/index/src/routes/index.tsx` | Enter-demo entry (landing-page button) |
| `apps/api/src/test/server/demo-mode.test.ts`, `apps/api/src/test/server/seed-demo.test.ts` | Contract tests |
