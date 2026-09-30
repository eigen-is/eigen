# Demo mode

> **TLDR:** Demo mode is a deployment shape, not a code mode. A release install with `EIGEN_DEMO=1` lets visitors in through one public route, `GET /p/demo/enter`, as a random persona from a pool of 20. `scripts/demo-reset.sh` wipes the data root every hour and reruns `apps/api/src/scripts/seed-demo.ts`, which builds the "Tuimel Festival" world through the real product surfaces. What surprises: the reset is the security model, so the app only guards what a visitor could do within the hour; the reset shares the launcher's lock; and on a real install every demo branch is dead code.

## One env var turns the whole instance into a demo

`isDemo()` (`apps/api/src/lib/config/env.ts`) reads `EIGEN_DEMO === '1'`. It is an env var, not a server setting: the whole instance is the mode, so no admin UI can toggle it and it cannot drift onto a real box. `docker-compose.yml` passes it through with a default of `0`, and `./eigen update` keeps every key of `.env.production` it does not own.

The branches are few, and each is inert when the var is unset:

- `sendMail` (`apps/api/src/lib/core/mailer.ts`) skips delivery. A demo box runs no MTA, so a real send would fail on every share, invite and iMIP.
- `messageSend` (`apps/api/src/lib/mail/mail-domain.ts`) throws a 403 that says outgoing email is off, and the message stays in Drafts. The guard is not in `sendMail`, because `sendMail` serves every fire-and-forget notification, where a throw only becomes a logged error. Compose is the one send a person waits on.
- `isMailAppEnabled()` keeps the Mail app on without hosted mail, so the seeded mailboxes show.
- `/p/config` carries `demoMode`, the one flag the frontend reads. The login card and the landing page swap sign-in for an **Enter demo** button, and `DemoBanner` says the workspace is shared and resets every hour.
- The auth guard and the entry route below.

## The entry route signs a visitor in as a persona

`GET /p/demo/enter` (`apps/api/src/routes/demo.ts`) is public and 404s unless `isDemo()`. It allows 10 hits a minute per IP (`checkDemoRateLimit`), because it is unauthenticated and runs two scrypt hashes per hit.

`getDemoPersonaPool` reads the pool from org membership, so it cannot drift from the seeder. It takes role `member`, which leaves out the setup admin (the org `owner`), and skips members with 2FA on, whom `signInEmail` would divert into a challenge.

`signInWithScopedPassword('demo', …)` (`apps/api/src/lib/auth/guest-auth.ts`) is the guest-OTP mechanism. It overwrites the persona's password with `HMAC-SHA256('demo:' + email, auth secret)`, which nobody sees, then signs in for a real session. Overwriting on every entry heals tampering: a visitor who changes a persona's password cannot lock the next one out.

Two visitors can land on the same persona, about 1 in 20 per pair, and share its private drive. Per-visitor accounts would isolate them, but the team drive, chats and calendar are the point of the demo, and a shared pool shows them lived in.

## The auth guard closes the window before the reset

The hourly wipe heals every auth tamper. Three kinds still hurt within the hour, so `routes/auth.ts` 403s them in demo mode (`DEMO_BLOCKED_AUTH_PATHS`):

- Api key create, update and delete. A key is a working IMAP, CalDAV and WebDAV credential.
- Enabling 2FA, which would lock the persona out of the pool.
- Revoking sessions, which griefs other visitors.

Creating or leaving an organization needs no demo guard. `allowUserToCreateOrganization` is off, and `getOrgRole` reads the role in the default org only, so the owner of a second org never passes `requireAdmin` (`apps/api/src/test/home/org-privesc.test.ts`).

**The guard must be chained before `.mount(auth.handler)`.** Elysia snapshots an instance's lifecycle hooks at route registration, so a hook added after the mount never runs for the mounted handler.

## The hourly reset runs outside the app

Swapping database files under open handles is the `SQLITE_IOERR_VNODE` hazard, so the reset stops the API instead of running on an in-app scheduler. `scripts/demo-reset.sh` refuses unless `.env.production` holds the line `EIGEN_DEMO=1`, so it cannot wipe a real box. Then it:

1. Takes the launcher's lock, `.eigen/lock`. While an `./eigen` command such as an update or a restore holds it, the reset refuses and the next hourly run retries.
2. Stops `eigen-api`.
3. Removes `data/server`, `data/home`, `data/team`, `data/org` and `data/guest`, an explicit list and never a wildcard, so `data/certs` and `data/dkim` survive.
4. Runs the seeder in a throwaway container off the current image.
5. Starts `eigen-api` only if the seeder wrote its last file, `data/server/.demo-seeded`. A failed seed leaves the API stopped rather than showing strangers a server that is not set up.

Wiping the full root instead of restoring a golden tarball keeps every timestamp under an hour old, rebuilds the auth database from current code, and erases rogue keys, orgs and 2FA enrollments. Only local mounts work: an `s3` mount keeps its bytes outside the data root, where the wipe cannot reach.

## A demo box is a release install with the reset turned on

The release bundle ships `scripts/demo-reset.sh` and `scripts/systemd/` to every install (`apps/api/src/cli/bootstrap.ts`). Install Eigen as [SELF-HOSTING.md](SELF-HOSTING.md) describes and answer No to hosting mail. Add `EIGEN_DEMO=1` to `.env.production`, and optionally `EIGEN_DEMO_ADMIN_PASSWORD` (unset, the seeder prints a random one), then run `./eigen setup` again. Build the world with `./scripts/demo-reset.sh` rather than the setup link, since the seeder refuses a completed setup. Then install the hourly timer:

```bash
cp scripts/systemd/eigen-demo-reset.service scripts/systemd/eigen-demo-reset.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eigen-demo-reset.timer
```

`./eigen update` rewrites the copies in `scripts/` but never installs them. The units assume `/opt/eigen`.

A server backup runs inside the API and holds no `.eigen/lock` ([BACKUP.md](BACKUP.md#the-whole-server-backup-runs-inside-the-api)), so a reset that starts while one runs stops the API under it, and the archive's record says it failed. A demo box has nothing worth backing up: the next reset wipes it anyway.

## The seeder drives the product, not the databases

The seeder imports the app in-process, completes setup through `POST /setup/complete`, then acts as the personas through the same domain calls a route makes. Activity panels, file history, watchers and the bell fill in for free, and every reset dogfoods the importers. Where a route does part of the work itself, the seeder mirrors it, such as the bell notification of a comment assignment.

It applies the demo's settings before any home exists, because a home fixes its mount type on first open: `local-id` storage, no guest signup, small quotas, and no welcome mail, which would land as every persona's first message. Persona ids are random on each rebuild. Personas are keyed by email, and everything the data model keys on (ACLs, comment cards, attendees, a board's `creator`) resolves by email.

In production better-auth prefixes cookie names with `__Secure-`, so the seeder keeps the whole `name=value` pair from `Set-Cookie` for its admin session. Rebuilding the name aborts the seed on a real box.

`apps/api/src/scripts/demo/content.ts` holds the personas and every text as data. Docs go HTML → `.docx` → `convertToDocument`, the shipped importer. Comment threads are real chats in the container's `chat/` folder, and each card's anchor is a `comment` mark, as the editor writes them. Every seeded card gets `DEFAULT_CARD_COLOR`, the card dialog's fallback, so seeded and hand-made cards match.

## Two containers are byte-copied fixtures

`placeFixture` copies `data.db` and `comments.db` from `demo/fixtures/` into a new container. That is legal because a container names its internals by name, never by path id.

The budget sheet is hand-maintained. Its content lives only in the fixture: edit it in a live demo and copy the files back. Its bytes are the oldest stored sheet shape Eigen ships, so renaming a persisted field needs a migration, which `seed-demo.test.ts` catches.

The stickies board is generated by `demo/author-fixtures.ts` from `KANBAN`, which must never touch the sheet. The seeder rewrites each `creator` key to a runtime email and sets `createdAt` relative to the seed, because the fixture bakes the day it was authored, weeks before the chat replies under its cards.

A card chat reply can `attach` seeded team documents as drive references, or `attachVCards` uploaded into the chat's `media/` folder like a user's upload. Don't `attach` a plain file: a drive-reference chip to a file opens Drive in a new tab.

## The canvases are built from typed specs

The site plan (`demo/vector-build.ts`) and the sponsor deck (`demo/deck-build.ts`) are written straight into fresh Y.Docs, because frozen bytes cannot survive a change to the stored element shape and a spec can. Every element carries the full field set the editor writes. Ids, indices and roughjs seeds are deterministic, so every reseed renders the same jitter. Text is sized from `demo/excalifont-metrics.ts`, since the seeder has no DOM. Arrows settle through the lib's `followBindings`, as in the editor.

To check a site plan change without a browser, build a Y.Doc with `buildVectorDoc`, render it with `readVectorFromDoc` and `sceneToSvg`, and open the SVG.

## Mail threads because the seeder owns its headers

`buildRfc822` composes each message, dated relative to the seed, and `mailboxDeliver` indexes it. A persona's own replies move to Sent, so only inbound mail sits in the inbox. An all-hands mail reaches every persona with one `Message-ID` for every copy, like a list mail: a later reply threads only if it references that one id.

## Running the seeder

Locally: `cd apps/api && EIGEN_DATA_ROOT=/abs/data MAIL_DOMAIN=tuimel.example bun run src/scripts/seed-demo.ts`. On a box the reset runs it by absolute path, because the image's working directory is `/app/apps/api`. `seed-demo.test.ts` spawns the whole seeder in about 30 s, so it runs on CI, and locally with `EIGEN_SLOW_TESTS=1` after you touch `scripts/demo/` or a reader it decodes with ([TESTING.md](TESTING.md)).

## Accepted residuals

- A visitor's offensive content stays visible until the next reset.
- An idle visitor is not signed out on the hour. The wipe drops their session, so their next request finds none.

## See also

- [GUEST-ACCESS.md](GUEST-ACCESS.md): the guest OTP flow that shares the session mint
- [COMMENTS.md](COMMENTS.md) and [CANVAS.md](CANVAS.md): what the seeder writes
- Tests: `apps/api/src/test/server/demo-mode.test.ts`, `apps/api/src/test/server/seed-demo.test.ts`
