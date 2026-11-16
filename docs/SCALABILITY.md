# Scalability

> **TLDR:** Eigen runs as one API process, and no sharding exists. What exists is the shape sharding needs: every user's and team's data lives in one isolated Home, every authenticated route carries the Home's `ownerId` as its second path segment, so a router can pin a Home to one process, and every call from one Home into another goes through `apps/api/src/lib/home/home-relay.ts`, the one file sharding has to change. A user working on another owner's drive with their own permission stays outside it, and a copy between two owners' drives is the known blocker. Not obvious from the code: the server-wide state, such as the auth database and the share registry, is what a second process cannot share yet, a push is delivered once and never retried, and a read across many homes opens at most four at once and leaves out a home that takes over four seconds. The first concrete step is [PROPOSAL_SINGLE_MACHINE_CLUSTER.md](proposals/PROPOSAL_SINGLE_MACHINE_CLUSTER.md).

Read this doc before you write a route or any code that reaches another owner's data, even with one process. Code that skips the `:ownerId` segment or the relay works on one process and breaks once Homes live in different ones, so `bun run check` gates both rules ([§ The ownerId is the routing key](#the-ownerid-is-the-routing-key), [§ lib/ may not import getHome](#lib-may-not-import-gethome)).

## A Home holds all of one owner's data

Every user and every team has a Home with its own SQLite databases, file storage and event stream. No database mixes users' content. The only server-level databases are the three in `SERVER_DATABASES` (`apps/api/src/lib/config/paths.ts`): `users3.db` for auth, `eigen.db` for the share registry and `waitlist.db`. So a Home can live on any server without a schema change, and moving one is moving its folder.

## The ownerId is the routing key

Every authenticated route has `:ownerId` as its second path segment (`/drive/:ownerId/…`, `/calendar/:ownerId/…`), which `scripts/check-standards.ts` enforces. A router can read it without parsing a body and send every request for one Home to the process that owns it. A collab socket carries the document owner's id, not the editor's, so an edit of someone else's document already routes to the right Home.

Server-wide surfaces that act on no Home carry none, and `OWNER_ID_EXEMPT` lists them: setup, the settings, the waitlist, the public pages, and the per-home and whole-server backup routes. In a cluster they need a process of their own or a shared answer.

## Every cross-home call goes through the relay

When one user's action touches another Home, it goes through one of the three functions of `home-relay.ts`, each keyed by owner ids:

- **`pushToHomes(ownerIds, message)`** hands a `HomeMessage` to each owner: an ACL change, a Recent open, a calendar share, invitation, invitation removal or RSVP, or a notification. It returns nothing and never rejects: a failed delivery is logged with its kind and target, and the caller carries on. Most callers don't wait. One that awaits, such as share reconciliation (`reconcileShares`), waits for the deliveries themselves.
- **`getFromHomes(ownerIds, kind, ask)`** asks every owner the same question and answers a `Map` of the answers it got, keyed by owner id. A question is one of ten kinds, such as `'drive:watches'`, `'calendar:calendars'` and `'team:quota-overrides'`, each declared as plain data with the handler that answers it in its domain's `home-calls.ts` (`lib/drive/`, `lib/calendar/`, `lib/team/`) ([§ Reads across many homes go through getFromHomes](#reads-across-many-homes-go-through-getfromhomes)). A caller of a calendar kind first drops every owner without a home folder (`homeFolderExists`), so asking never creates a home ([CALENDAR.md](CALENDAR.md#asking-about-another-owners-calendar-never-opens-a-home-it-would-create)).
- **`broadcastToHomes(ownerIds, event)`** tells the open tabs of the homes that are loaded. A closed home has no tab to tell, so it opens none and stores nothing. Drive's `broadcastToOwnerAndMembers` (`apps/api/src/lib/drive/sse-events.ts`) picks who may read a path and calls it ([SSE.md](SSE.md)).

A message, a question and an answer are plain data, never a `Home`, a `Mount`, a function or a Promise, and the owner id is the only address, so that a call can later travel to another process. A time that matters travels in the message, as a cancelled occurrence's `dtstamp` does. The relay knows no team rule: a sender that means a team's members resolves them itself, as `propagateAccessRequest` does ([NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md#every-user-and-guest-home-has-its-own-notification-database)).

A route whose URL names the owner opens that owner's Home itself and is no relay call: a Drive route through `getSharedDrive`, a calendar route through `checkCalendarAccess` or `routedCalendar`, the access-request route through `getHome`.

Calls that no Home makes stay out of the relay: the server jobs on one home's folder in `lib/home/home-jobs.ts`, such as `sizeUserHome` and the backup's `snapshotHomeHeld`, the server backup's room check (`captureBytes`), and `writeUserProfile` and `writeTeamAvatar` (`lib/user/profile.ts`), which write server-wide data.

Today each is a direct `getHome()` in the same process. Sharded, the delivery of a push, the open behind a get and a broadcast ask whether the Home is here and otherwise send the same message to its process, and nothing outside the file changes.

## A user acting on another owner's drive stays outside the relay

The relay is one Home acting on another with no user check. A signed-in user working on another owner's drive with their own permission is `SharedDrive`'s job ([ARCHITECTURE.md § Drive Architecture](ARCHITECTURE.md#drive-architecture)), so these open it through `getSharedDrive`: an import from it (`readImportSourceBytes`), attaching a file from it to a mail and saving a mail attachment to it (`apps/api/src/lib/mail/mail.ts`), sharing a file on send (`grantAccessForReferences`), the routed WebDAV files and a copy to it. Inbound mail stays outside too: Postfix hands each message to `mailboxDeliver`, which opens the recipient's Home, and Postfix is the queue that retries a message the API refuses.

A copy between two owners is neither a message nor a query but a stream with one writer and a cleanup: `Drive.copyPath` hands the source Home's `Mount` to the target's `receiveCopy`. That works in one process and is the known blocker for sharding ([ROADMAP.md](ROADMAP.md)).

## Reads across many homes go through getFromHomes

A list that spans homes, such as Watched, All docs, file search, the teams list (`apps/api/src/lib/team/my-teams.ts`), Shared with me and Recent files, asks each owner through `getFromHomes`, and so do the team quota overrides of every metered write ([QUOTA.md](QUOTA.md)), the team calendar sync ([CALENDAR.md](CALENDAR.md)) and share reconciliation. An owner whose Home answers 404 on opening is gone or being deleted, and is skipped with no log, because `shared_paths` and Recent rows can outlive their owner and would otherwise log an error on every load. The relay asks the auth database nothing itself, so a loaded Home costs no query: only opening a closed one looks its owner up. A 404 from the answer itself, such as a path that is gone, is logged like any other failure. A read that fails, or a home that does not open in time, is logged and leaves that owner out, so one broken, restoring or slow home never empties the list and never fails silently. Recent and Shared with me ask each owner once for all of its rows ([STORAGE.md § A load asks each owner whether the user may still see the path](STORAGE.md#a-load-asks-each-owner-whether-the-user-may-still-see-the-path)).

**At most four homes open at once** (`HOME_OPENS_AT_ONCE` in `home-relay.ts`), across every get in the process. Opening a home is mostly synchronous database work on the one thread, so opening many together saves no time and stalls every other request for the whole batch. A slot belongs to an open, not to a caller: everyone asking for an owner that is opening waits on the same open, so a home that hangs takes one slot however many ask. A home already loaded skips the queue, so a read of it never waits behind homes that are opening. The slot covers the open only, and the answer runs after it is handed back. Route opens and deliveries are outside the cap, since nothing retries a push that gave up at the deadline. Changing the cap, or bringing deliveries under it, first needs a measurement of a 50- and a 500-target fan-out with a list load running.

**A get waits at most four seconds for one home** (`HOME_OPEN_DEADLINE_MS`), the wait for a slot and the open together. The deadline only ends the caller's wait. An open cannot be cancelled, since `getHome` shares one open with every caller, so its slot stays held until it settles: a slot handed back at the deadline would let opens pile up past the cap. That is the cost in a bucket outage. An open of a home that is closing waits for the close, which was measured at 9.5 s with the bucket hung and about 130 s with an upload on the wire. Until those closes end, lists over closed homes come back partial, homes on local disk included, while loaded homes keep answering. The owner chose both numbers and this behaviour on 15 November 2026.

Both numbers rest on one get over 500 closed user homes in the API image, in Docker on a developer Mac, three runs per cap:

| Homes opening at once | Total, median | Longest event-loop gap |
|---|---|---|
| 1 | 1.5 s | 53 ms |
| 4 | 1.6 s | 58 ms |
| 8 | 1.9 s | 146 ms |
| 16 | 1.5 s | 209 ms |
| No cap | 1.6 s | 2,347 ms |

The cap decides how long the server stalls, not how long the list takes. Four stays near the floor of about 50 ms that one open alone shows there, and in an outage it takes four hung homes, not one, to hold every slot. The deadline is twice the 500-home list at that cap, rounded up to whole seconds. A cold open of an `s3` mount does not contact the bucket, so a slow bucket does not slow a healthy open. What the measurement cannot show: production disk and CPU, likely slower, so every gap in the table is optimistic; real bucket latency; a cold page cache; and first opens after an upgrade, which run migrations synchronously.

A load asks far fewer homes than 500: Recent only the owners in the user's list, Watched every team and everyone who shared with the user. The real cost is homes held open: each read keeps its home open for its idle time, so a large load raises the file descriptors in use until those homes close ([PROPOSAL_FD_BUDGET.md](proposals/PROPOSAL_FD_BUDGET.md)).

## A receive method finishes the job on the target

The Calendar and Drive `receive*` methods write the database, broadcast the SSE event and persist the notification themselves. One message therefore does a whole operation on the target Home, and a sharded relay never has to coordinate steps across processes.

## lib/ may not import getHome

`scripts/check-home-imports.ts`, part of `bun run check`, fails on a function that hands out a Home, such as `getHome`, anywhere in `apps/api/src/lib/` outside `lib/home/`. The per-domain `get-*.ts` resolvers are allowed by design, and a few older files are allowlisted pending a refactor. A route opens the Home its URL names; one Home reaching another goes through the relay. Passing the `Home` down from the route would empty the allowlist and make a wrong lookup impossible to write ([ROADMAP.md](ROADMAP.md)).

The same check holds a domain's `home-calls.ts` to type imports only. The relay spreads each table while it loads, so a table that loaded a module leading back to the relay would make the relay run first and read the table before it exists. A handler needs no module of its own: it calls methods on the `Home` it is given.

It also fences the calls outside the relay. In `lib/`, only the files on `SHARED_DRIVE_FILES` may name `getSharedDrive`. In `routes/` and the CalDAV router, every `getHome`, `getTeamHome`, `getUserHome` and `getSharedDrive` takes `params.ownerId` or `user.id`, or is on `OTHER_OWNER_CALLS` with a reason, such as a copy's target drive. The check reads text, so a wrapper that takes an owner id is listed once and its callers go unchecked.

## Server-wide state is what a second process cannot share yet

| Component | Today | Sharded |
|---|---|---|
| Auth | `data/server/users3.db` | One shared database |
| Share registry | `data/server/eigen.db` | A shared database or a distributed registry |
| Waitlist | `data/server/waitlist.db` | One row set, written from any process |
| Yjs documents | In memory in the process that opened them | Editors connect to the owner's process |
| SSE streams | In the process that serves the user | A user connects to their Home's process ([SSE.md](SSE.md)) |
| Backup jobs and the restore mark | The in-memory job map and `markHomeRestoring` ([BACKUP.md § A restore deletes nothing and writes identity last](BACKUP.md#a-restore-deletes-nothing-and-writes-identity-last)), per process | Home jobs run where the Home lives. The whole-server job captures every Home through `snapshotHomeHeld`, a server job that assumes the Home's folder is on this disk, and its slot and schedule tick need one owner ([BACKUP.md](BACKUP.md)) |
| The deletion mark | `markHomeDeleting` (`apps/api/src/lib/home/get-home.ts`), per process, from the teardown of a home until better-auth has deleted the owner's row | Set where the delete runs, and it must be seen by the process that serves the Home. A deletion that fails after the folder is gone keeps it until a restart, and until then reads across homes skip that owner without a log ([ROADMAP.md](ROADMAP.md)) |
| Data epochs | Read once per process (`apps/api/src/lib/home/data-epoch.ts`), so no other process sees a rotation | The Home's process owns its epoch, and a stream or collab open elsewhere reads it through a get ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home)) |

Also per process and not solved: the server settings held in memory (`getServerSettings`), the rate limits (`WindowLimiter`), the scheduled jobs, and the calls outside the relay.

## The first step is several processes on one machine

[PROPOSAL_SINGLE_MACHINE_CLUSTER.md](proposals/PROPOSAL_SINGLE_MACHINE_CLUSTER.md) runs several API processes on one box over one filesystem, with Caddy routing by `ownerId`, so the application never hashes an id itself. Its row in [ROADMAP-POST-1.md](ROADMAP-POST-1.md) says what exists and what triggers it. The instance lock keeps a second API off a data folder today ([DATABASE.md](DATABASE.md#one-api-process-owns-a-data-folder)), so the cluster replaces it with a per-home lock first.

## A relay message in flight is lost on a crash

A push is delivered directly: the relay opens the target Home and runs the message there. Nothing stores or retries it, so a delivery that fails is logged and gone, and so is one in flight when the process dies or one to a home under restore, which answers 503. The owner chose this over a durable queue on 15 November 2026: a queue is a server-level database and a second copy of the truth, for a crash that rarely comes.

A lost revoke hides itself, because Shared with me asks the owner whether the user may still see each path ([ACL.md](ACL.md#shared-with-me-reads-each-path-from-its-owner)), and a guest gets a lost share back at the next sign-in, when reconciliation runs. Five losses nothing repairs: a share added for an existing full account, a calendar one user shares with another, an invitation removal, an RSVP, and every notification.

The access changes of one path reach each target in the order they were made, since an add and a revoke out of order would bring a removed share back, and a fan-out opens one Home at a time, because an open blocks the event loop ([ACL.md § Share Propagation](ACL.md#share-propagation)). A graceful shutdown waits for every push still delivering (`drainDeliveriesWithin`) before it closes the homes, because a delivery opens its recipient's home again. The wait gives up after 10 s, and a delivery still running then is lost as in a crash. A caller's loop of pushes, such as an invitation to several guests, is not waited for as a whole: a push it has not started yet meets the shutdown's 503.

## Multi-server questions without an answer yet

- **Moving a Home between servers** means copying its folder and updating the shard map. A push to it meanwhile fails as one to a home under restore does.
- **Co-locating an organization**: members on one server keep shared calendars and team drives off the network.

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md): the pitfall that every route carries `:ownerId` and every cross-home call uses the relay
- [PROPOSAL_FD_BUDGET.md](proposals/PROPOSAL_FD_BUDGET.md): what sets how many Homes one process can hold
