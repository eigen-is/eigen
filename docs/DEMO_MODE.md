# Demo mode

> **TLDR:** Demo mode is a deployment shape, not a code mode. A release install with `EIGEN_DEMO=1` lets visitors in through one public route, `GET /p/demo/enter`, as a random persona from a pool of 20. `scripts/demo-reset.sh` wipes the data root every hour and reruns `apps/api/src/scripts/seed-demo.ts`, which builds the "Tuimel Festival" world through the real product surfaces. What surprises: the reset is the security model, so the app only guards what a visitor could do within the hour; the reset shares the launcher's lock; and on a real install every demo branch is dead code.

A demo box is a public Eigen that anyone can try without an account. A visitor clicks **Enter demo** and lands in a shared workspace as a persona: one of the made-up staff of the festival, an ordinary member account the seeder creates, with a team drive, chats, mail, calendars and documents already in it. The sign-in is real, through the same scoped-password mechanism guests use ([GUEST-ACCESS.md](GUEST-ACCESS.md)). Everything else is the normal product on a normal release install ([SELF-HOSTING.md](SELF-HOSTING.md)), with a handful of guards and the hourly reset added.

## One env var turns the whole instance into a demo

`isDemo()` (`apps/api/src/lib/config/env.ts`) reads `EIGEN_DEMO === '1'`. It is an env var, not a server setting: the whole instance is the mode, so no admin UI can toggle it and it cannot drift onto a real box. `docker-compose.yml` passes it through with a default of `0`, and `./eigen update` keeps every key of `.env.production` it does not own.

The branches are few, and each is inert when the var is unset:

- `sendMail` (`apps/api/src/lib/mailer/mailer.ts`) skips delivery. A demo box runs no MTA, so a real send would fail on every share, invite and iMIP.
- `messageSend` (`apps/api/src/lib/mail/mail-domain.ts`) throws a 403 that says outgoing email is off, and the message stays in Drafts. The guard is not in `sendMail`, because `sendMail` serves every fire-and-forget notification, where a throw only becomes a logged error. Compose is the one send a person waits on.
- `isMailAppEnabled()` keeps the Mail app on without hosted mail, so the seeded mailboxes show.
- `arePublicLinksEnabled()` (`apps/api/src/lib/config/server-settings.ts`) answers false whatever the setting says, so nothing anyone uploads to the demo can be opened by a public link ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#public-links-are-never-on-a-demo-server)).
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
2. Warns every open tab with `restart-notice --in 300 --reason demo-reset`, the way the launcher's `api_cli` reaches it (`docker compose exec` into the container), and waits five minutes with the lock held. The banner reads "This demo resets in 4:59. Everything made here will be wiped." If the API is not running or refuses the notice, nobody is there to warn and the wait is skipped. A failure or signal before the stop takes the notice back with `restart-notice --clear`.
3. Stops `eigen-api`.
4. Removes `data/server`, `data/home`, `data/team`, `data/org` and `data/guest`, an explicit list and never a wildcard, so `data/certs` and `data/dkim` survive.
5. Runs the seeder in a throwaway container off the current image.
6. Starts `eigen-api` only if the seeder wrote its last file, `data/server/.demo-seeded`. A failed seed leaves the API stopped rather than showing strangers a server that is not set up.

Wiping the full root instead of restoring a golden tarball dates the whole world from the hour of the reset, so the festival is always three weeks out. It also rebuilds the auth database from current code and erases rogue keys, orgs and 2FA enrollments. Only local mounts work: an `s3` mount keeps its bytes outside the data root, where the wipe cannot reach.

## A demo box is a release install with the reset turned on

The release bundle ships `scripts/demo-reset.sh` and `scripts/systemd/` to every install (`apps/api/src/cli/bootstrap.ts`). Install Eigen as [SELF-HOSTING.md](SELF-HOSTING.md) describes and answer No to hosting mail. Add `EIGEN_DEMO=1` to `.env.production`, and optionally `EIGEN_DEMO_ADMIN_PASSWORD` (unset, the seeder prints a random one), then run `./eigen setup` again. Build the world with `./scripts/demo-reset.sh` rather than the setup link, since the seeder refuses a completed setup. Then install the hourly timer:

```bash
cp scripts/systemd/eigen-demo-reset.service scripts/systemd/eigen-demo-reset.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eigen-demo-reset.timer
```

`./eigen update` rewrites the copies in `scripts/` but never installs them, so after an update that changed a unit, copy it to `/etc/systemd/system/` again and run `systemctl daemon-reload`; the script itself runs from `scripts/` and is live at once. The units assume `/opt/eigen`. The timer fires at minute 55 (`OnCalendar=*:55`, `AccuracySec=1s`), so the five-minute warning ends and the wipe lands on the hour. From :55 until the reset is done the reset holds `.eigen/lock`, so an `./eigen` command run then is refused and is run again after. It is `Persistent=true`, so starting it after a pause runs one catch-up reset at once. That run warns only when the API is already up, which right after a reboot it often is not, and then stops `eigen-api` for about a minute: wait until `systemctl show -p ActiveState eigen-demo-reset.service` says `inactive` before you check the site.

A server backup runs inside the API and holds no `.eigen/lock` ([BACKUP.md](BACKUP.md#the-whole-server-backup-runs-inside-the-api)), so a reset that starts while one runs stops the API under it, and the archive's record says it failed. A demo box has nothing worth backing up: the next reset wipes it anyway.

## Every seeded word belongs to the Tuimel crew

The demo is one story: the crew of the Tuimel Festival (the `PERSONAS` in `apps/api/src/scripts/demo/content.ts`, from the festival director to the stage and tech lead) building their festival. Every text added to the seed, such as a mail, a chat line, a document or a card, is something one of them would write about that work, in the voice their existing chats and mails already have. Nothing is product-demo filler or a feature written for its own sake: a feature shows because the crew uses it for the festival. Read the neighbouring content before adding to it, and ask the owner before a new persona, a new storyline or a change in tone.

## The seeder drives the product, not the databases

The seeder imports the app in-process, completes setup through `POST /setup/complete`, then acts as the personas through the same domain calls a route makes. Activity panels, file history, watchers and the bell fill in for free, and every reset dogfoods the importers. Where a route does part of the work itself, the seeder mirrors it, such as the bell notification of a comment assignment.

It applies the demo's settings before any home exists, because a home fixes its mount type on first open: `local-id` storage, no guest signup, small quotas, and no welcome mail, which would land as every persona's first message. Only the crew's team drive is raised, to 100 MB for its photos. Persona ids are random on each rebuild. Personas are keyed by email, and everything the data model keys on (ACLs, comment cards, attendees, a board's `creator`) resolves by email.

The Admin app's lists fill the way an admin fills them. A second team, `stage & tech`, is made and filled through better-auth's `createTeam` and `addTeamMember`, and Saar shares her site access notes with it. Hein, the fencing supplier, is the one guest: `createGuestUser` makes his account as the guest sign-in does, and `reconcileShares` reads in the site plan Saar shared with him ([§ Mail threads because the seeder owns its headers](#mail-threads-because-the-seeder-owns-its-headers)). Each lead signs in once through `signInEmail`, so the user list shows when they were last active.

In production better-auth prefixes cookie names with `__Secure-`, so the seeder keeps the whole `name=value` pair from `Set-Cookie` for its admin session. Rebuilding the name aborts the seed on a real box.

`apps/api/src/scripts/demo/content.ts` holds the personas and every text as data. Docs are HTML that `htmlToDocJson` parses with the editor's schema into the doc's JSON, written as one update. They skip docx, which has no slot for an equation's LaTeX. So the HTML is what the schema parses: a table, a footnote as `span[data-type="footnote"]`, a figure as `span.figure` around an `img[data-media-name]`, and an equation as the `<math display="block">` that `writeMathml(readLatex(tex), tex)` writes, so its panel opens on the LaTeX. A figure's photo is uploaded into the doc's `media/` from the doc's `media` list. Each persona's own drive gets `my notes` and `trying eigen`, the same for all. Comment threads are real chats in the container's `chat/` folder, and each card's anchor is a `comment` mark, as the editor writes them. Every seeded card gets `DEFAULT_CARD_COLOR`, the card dialog's fallback, so seeded and hand-made cards match. A file in a thread, such as Timo's storm photo in the production channel or a vCard in a card chat, is seeded as an upload into the chat's own `media/`, the way a user's upload lands, because a drive-reference chip to a plain file breaks. A seeded `attach` names a document, and only one the seeder made earlier.

Every thread, a channel or the chat under a comment or a card, is posted through `ChatRoom.postMessage`, which stamps the seed minute. Then `messages.createdAt` is set in the room's own `data.db`, each line at the thread's `start` plus its `gap` or at its own `at` (`threadTimes`), so a thread reads as grown over days. No line is dated before the one it follows, because the room pages its messages by time and then by row. A comment card's `createdAt` is its thread's first time.

## The stickies board is a byte-copied fixture

The seeder copies the board's `data.db` and `comments.db` from `demo/fixtures/` into a new container. That is legal because a container names its internals by name, never by path id.

The board is generated by `demo/author-fixtures.ts` from `KANBAN`. The seeder rewrites each `creator` key to a runtime email and sets `createdAt` relative to the seed, because the fixture bakes the day it was authored, weeks before the chat replies under its cards. A card's thread starts at that `createdAt`.

The rest of a card goes through the calls the card's own menu and dialog make. Its cover is an upload into the board's `media/`, listed in its `attachments`, because a card's first image attachment is its cover. The board's author hands a card out with `assignComment`, which rings the assignee's bell, and a crew member closes one with `setCommentStatus`.

A card chat reply can `attach` seeded team documents as drive references, or `attachVCards` uploaded into the chat's `media/` folder like a user's upload. Don't `attach` a plain file: a drive-reference chip to a file opens Drive in a new tab.

## The budget, the site plan and the deck are built from typed specs

The budget (`demo/sheet-build.ts`), the site plan (`demo/vector-build.ts`) and the sponsor deck (`demo/deck-build.ts`) are written straight into fresh Y.Docs, because frozen bytes cannot survive a change to the stored shape and a spec can.

A `SheetSpec` is one tab: its columns, its rows of text, numbers and formulas, and its data bars, red-below-zero rules, dropdowns and charts by A1 range. `buildWorkbook` writes them in the shapes the editor stores, each chart's refs naming its tab by id, and runs `recalcSheets` once, as the xlsx importer does. So the snapshot is stored as computed and opens with its values. The budget's costs column chart sits beside the table on its Budget tab, level with its top and smaller than Insert's default, so a 1000-pixel-wide page shows both whole and an edited cost moves its bar in the same view; the Charts tab holds the income pie. The same builder makes the quote a seeded mail attaches, through the shipped `writeXlsx`.

The site plan is one typed spec. Every element carries the full field set the editor writes. Ids, indices and roughjs seeds are deterministic, so every reseed renders the same jitter. Text is sized with `measureLabel` (`@workspace/lib/vector`), since the seeder has no DOM. Arrows settle through the lib's `followBindings`, as in the editor.

To check a site plan change without a browser, build a Y.Doc with `buildVectorDoc`, render it with `readVectorFromDoc` and `sceneToSvg`, and open the SVG.

A deck's chart is the parts Insert → Chart writes, with the slide's inline data in place of the sample's, no legend, and the deck's style table for its fill and color. Each of the deck's element ids is `el-<slide key>-<kind>-<n>`, the name a canvas comment points at.

A canvas comment, such as Timo's on the site plan's wind cover or Bram's on the sponsors chart, is written in the editor's order: the thread's chat in the container's `chat/`, the card in the `comments` map, then the card's id in the element's `commentCardIds`. The threads are posted first, and the collab doc opens only for the one write after them, because a document no socket joins closes a minute after its open and a write after that close is lost.

## Mail threads because the seeder owns its headers

`buildRfc822` composes each message, dated relative to the seed, and `mailboxDeliver` indexes it. A persona's own replies move to Sent, so only inbound mail sits in the inbox. An all-hands mail reaches every persona with one `Message-ID` for every copy, like a list mail: a later reply threads only if it references that one id. A reply quotes the message before it with `formatReplyQuote`, the composer's "On <date> <name> wrote:" line over a blockquote, and its text part is that HTML's text, as a reply sent from Eigen has. So the last reply holds the whole thread. Last of all, `messageSetRead` marks every inbox message but the newest read, the store's own path that sets the Maildir seen flag, so each persona opens on one unread mail.

An attachment is fixture bytes, a vCard from the shipped writer, or a `workbook` the shipped xlsx exporter writes. A drive-reference pill links through the `VITE_APP_*_URL` vars, which the seeder points at the demo host, so no pill bakes in a localhost URL.

A persona's own message to someone outside can `attachDocs`: the seeder grants that person read access through `grantAccessForReferences`, the grant the composer's send makes, and adds the documents' pills to the body. That is how Saar's site plan reaches Hein.

An external message can carry an `invite`, which `serializeEventForImip`, the shipped iMIP writer, turns into the `text/calendar` part an outside calendar sends. Such a message also carries the `Authentication-Results` line our own MTA writes for an aligned DKIM pass, so `mailboxDeliver` runs the real `processInboundImip` and the culture fund's walk-through lands in Bram's calendar as a pending invitation. All other seeded mail carries no verdict, so its delivery leaves every calendar alone. The calendars get the rest of their events directly: the team's from `EVENTS`, and each persona's own calendar its two `SHIFTS` plus the whole `PERSONAL_EVENTS` pool, such as a dentist visit, a weekly run or packing the van.

Every day in the calendar seed counts from the festival Saturday, the first Saturday at least 20 days after the seed runs, so a visitor always lands about three weeks out, 20 to 26 days. The seed places every line in Europe/Amsterdam time (`DEMO_TIME_ZONE`) and stores that zone on each timed event, so the demo reads the same on a UTC server and a weekly line keeps its weekday and hour across a DST switch. Chat messages and mails are dated on the same clock through `demoTime`. The personal pool is densest there, from about four weeks out to two, and thinner through the build week, the festival and the days after; its weekday office hours stay light and the build and festival days keep to early mornings and late evenings, when the crew is not on site. Every persona gets the same pool, so no entry names a persona. Hours may be fractional (`startHour: 9.5` is half past nine), an all-day entry lasts `days` days, one when unset, and an `rrule` is written in the order the calendar store writes it back, such as `FREQ=WEEKLY;COUNT=8;BYDAY=TU,TH`.

## Running the seeder

Locally: `cd apps/api && EIGEN_DATA_ROOT=/abs/data MAIL_DOMAIN=tuimel.example bun run src/scripts/seed-demo.ts`. `EIGEN_DEMO_ADMIN_PASSWORD` and `EIGEN_DEMO_PERSONA_PASSWORD` fix the admin's and every persona's password, for a tool that signs in as them, such as the About pages' capture tool ([HELP-CENTER.md § Filming the demo](HELP-CENTER.md#filming-the-demo)); unset, each is random. On a box the reset runs it by absolute path, because the image's working directory is `/app/apps/api`. `seed-demo.test.ts` spawns the whole seeder in about 30 s, so it runs on CI, and locally with `EIGEN_SLOW_TESTS=1` after you touch `scripts/demo/` or a reader it decodes with ([TESTING.md](TESTING.md)).

## The About films show only what the demo holds

The About pages film the demo world ([HELP-CENTER.md § Filming the demo](HELP-CENTER.md#filming-the-demo)), so a feature the seed never uses can't be filmed. The filming found these gaps, each checked against `apps/api/src/scripts/demo/content.ts` and `seed-demo.ts`. None is approved: each waits for the owner, the first two under [§ Every seeded word belongs to the Tuimel crew](#every-seeded-word-belongs-to-the-tuimel-crew). Sizes are S and M as in [ROADMAP.md](ROADMAP.md).

| App | What the demo lacks | Who would write it, and why it fits the festival | Size |
|---|---|---|---|
| Drive | No file has an edit history, so Version history is empty: each document is written once | Saar's production plan, edited over days | M |
| Admin | One admin, the setup account | Anouk as the second admin. The visitor pool takes plain members only (`getDemoPersonaPool`), so she leaves the pool of 20 | S |
| Admin | No backup in any list. Backups sit beside the data root (`backupsDirPath`), outside the hourly wipe, so a seeded backup needs the reset to clear them too | The office account's nightly backup | M |

An S3 team drive is not on the list: an `s3` mount keeps its bytes outside the data root, where the hourly wipe cannot reach ([§ The hourly reset runs outside the app](#the-hourly-reset-runs-outside-the-app)).

## Accepted residuals

- A visitor's offensive content stays visible until the next reset.
- An idle visitor is not signed out on the hour. The wipe drops their session, so their next request finds none.
- The Activity panel's events, the bell's notifications and the comment index's `lastActivityAt` carry the seed minute, which the product stamps when the seeder acts, as it does for every other seeded event. So a thread reads days old while its folder's activity says just now.

## See also

- [GUEST-ACCESS.md](GUEST-ACCESS.md): the guest OTP flow that shares the session mint
- [COMMENTS.md](COMMENTS.md) and [CANVAS.md](CANVAS.md): what the seeder writes
- Tests: `apps/api/src/test/server/demo-mode.test.ts`, `apps/api/src/test/server/seed-demo.test.ts`
