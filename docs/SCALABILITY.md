# Scalability

> **TLDR:** Eigen runs as one API process, and no sharding exists. What exists is the shape sharding needs: every user's and team's data lives in one isolated Home, every authenticated route carries the Home's `ownerId` as its second path segment, so a router can pin a Home to one process, and every call from one Home into another goes through `apps/api/src/lib/home/home-relay.ts`, the one file sharding has to change, apart from a copy between two owners' drives ([ROADMAP.md](ROADMAP.md)). Not obvious from the code: the server-wide state (the auth database, the share registry, the backup job map, the data epochs) is what a second process cannot share yet, a relay message in flight is lost on a crash, and a read across many homes opens at most four at once and leaves out a home that takes over four seconds. The first concrete step is [PROPOSAL_SINGLE_MACHINE_CLUSTER.md](proposals/PROPOSAL_SINGLE_MACHINE_CLUSTER.md).

Read this doc before you write a route or any code that reaches another owner's data, even with one process. Code that skips the `:ownerId` segment or the relay works fine on one process and breaks only once Homes live in different ones, which is why `bun run check` gates both rules ([§ The ownerId is the routing key](#the-ownerid-is-the-routing-key), [§ lib/ may not import getHome](#lib-may-not-import-gethome)).

## A Home holds all of one owner's data

Every user and every team has a Home with its own SQLite databases, file storage and event stream. No database mixes users' content. The only server-level databases are the three in `SERVER_DATABASES` (`apps/api/src/lib/config/paths.ts`): `users3.db` for auth, `eigen.db` for the share registry and `waitlist.db`. So a Home can live on any server without a schema change, and moving one is moving its folder.

## The ownerId is the routing key

Every authenticated route has `:ownerId` as its second path segment (`/drive/:ownerId/…`, `/calendar/:ownerId/…`), which `scripts/check-standards.ts` enforces. A router can read it without parsing a body and send every request for one Home to the process that owns it. A collab socket carries the document owner's id, not the editor's, so an edit of someone else's document already routes to the right Home.

Server-wide surfaces that act on no Home carry none, and `OWNER_ID_EXEMPT` lists them: setup, the settings, the waitlist, the public pages, and the per-home and whole-server backup routes. In a cluster they need a process of their own or a shared answer.

## Every cross-home call goes through the relay

When one user's action touches another Home, it goes through `home-relay.ts`, in one of two shapes, both keyed by the target's `ownerId`:

- **Pushes**: `sendToHome(targetUserId, message)` and `sendToUserHomes(userIds, message)` with a typed `HomeMessage` (ACL changes, Recent opens, calendar shares and invitations, RSVPs, SSE broadcasts, notifications). Most callers don't wait: an ACL fan-out, a chat notification or an event write's invitations are delivered after the request answered. A few callers await theirs, such as a calendar's share change (`propagateCalendarShare`), an assignment from a chat (`propagateAssignment`) and the pushes of share reconciliation at sign-in (`reconcileShares`).
- **Gets**: `getFromHomes(ownerIds, kind, ask)` asks every owner the same question and answers a `Map` of the answers it got, keyed by owner id. A question is one of ten kinds, such as `'drive:watches'`, `'calendar:calendars'` and `'team:quota-overrides'`, each declared as plain data with the handler that answers it in its domain's `home-calls.ts` (`lib/drive/`, `lib/calendar/`, `lib/team/`) ([§ Reads across many homes go through getFromHomes](#reads-across-many-homes-go-through-getfromhomes)). A caller of a calendar kind first drops every owner without a home folder (`homeFolderExists`), so asking never creates a home ([CALENDAR.md](CALENDAR.md#asking-about-another-owners-calendar-never-opens-a-home-it-would-create)).

A route whose URL names the owner opens that owner's Home itself and is no relay call: a Drive route through `getSharedDrive`, a calendar route through `checkCalendarAccess`, which answers the owner's `Calendar` with the caller's permission on it, or `routedCalendar`, and the access-request route through `getHome`.

Calls that no Home makes stay out of the relay. The server jobs in `lib/home/home-jobs.ts` work on one home's folder: `sizeUserHome` reads it without booting the home, and `snapshotHomeHeld` captures it for a backup. The server backup's room check sizes each home's folder with `captureBytes`. `writeUserProfile` and `writeTeamAvatar` in `lib/user/profile.ts` write server-wide data, a user's name and the avatar files.

Today each is a direct `getHome()` in the same process. Sharded, `sendToHome` routes or enqueues a message and a get becomes a request to the owning process, and nothing outside the file changes. A `HomeMessage`, a question and its answer are plain data for that reason. [PROPOSAL_HOME_RELAY.md](proposals/PROPOSAL_HOME_RELAY.md), signed off, shrinks the file to `pushToHomes`, `getFromHomes` and `broadcastToHomes`.

## Reads across many homes go through getFromHomes

A list that spans homes, such as Watched, All docs, file search, the teams list (`apps/api/src/lib/team/my-teams.ts`), Shared with me and Recent files, asks each owner through `getFromHomes`, and so do the team quota overrides of every metered write ([QUOTA.md](QUOTA.md)), the team calendar sync ([CALENDAR.md](CALENDAR.md)) and share reconciliation. An owner whose Home answers 404 on opening is gone or being deleted, and is skipped with no log, because `shared_paths` and Recent rows can outlive their owner and would otherwise log an error on every load. The relay asks the auth database nothing itself, so a loaded Home costs no query: only opening a closed one looks its owner up. A 404 from the answer itself, such as a path that is gone, is logged like any other failure. A read that fails, or a home that does not open in time, is logged and leaves that owner out, so one broken, restoring or slow home never empties the list and never fails silently. A caller that must tell silence from an empty answer, such as the calendar sync, reads an owner missing from the map as no answer. Recent and Shared with me read through `readVisiblePaths` (`apps/api/src/lib/drive/shared-with-me.ts`), which asks each owner once for all of its rows, and `Drive.getVisiblePaths` answers which are still visible ([STORAGE.md § A load asks each owner whether the user may still see the path](STORAGE.md#a-load-asks-each-owner-whether-the-user-may-still-see-the-path)).

**At most four homes open at once** (`HOME_OPENS_AT_ONCE` in `home-relay.ts`), across every get in the process. Opening a home is mostly synchronous database work on the one thread, so opening many together saves no time and stalls every other request for the whole batch. A slot belongs to an open, not to a caller: everyone asking for an owner that is opening waits on the same open, so a home that hangs takes one slot however many ask. A home already loaded skips the queue, so a read of it never waits behind homes that are opening. The slot covers the open only, and the answer runs after it is handed back. Route opens and pushes are outside the cap.

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

## The first step is several processes on one machine

[PROPOSAL_SINGLE_MACHINE_CLUSTER.md](proposals/PROPOSAL_SINGLE_MACHINE_CLUSTER.md) runs several API processes on one box over one filesystem, with Caddy routing by `ownerId`, so the application never hashes an id itself. Its row in [ROADMAP-POST-1.md](ROADMAP-POST-1.md) says what exists and what triggers it. The instance lock keeps a second API off a data folder today ([DATABASE.md](DATABASE.md#one-api-process-owns-a-data-folder)), so the cluster replaces it with a per-home lock first.

## A relay message in flight is lost on a crash

`sendToHome` has no durable queue. An ACL fan-out is ordered per path, but a delivery in flight when the process dies is gone. A graceful shutdown is not a crash: it waits for every push still delivering, queued ACL fan-outs and direct sends included (`drainDeliveriesWithin`), before it closes the homes, because a delivery opens its recipient's home again. The wait gives up after 10 s, and a delivery still running then is lost as in a crash. A caller's loop of direct sends, such as an invitation to several guests, is not waited for as a whole: a send it hasn't started yet gets a 503 and is lost. [PROPOSAL_HOME_RELAY.md](proposals/PROPOSAL_HOME_RELAY.md) plans to turn each push into a row in a server-level outbox with one drain loop, in order per target, retries and replay on boot. In a sharded deployment the relay is the one place that learns about other processes.

## Multi-server questions without an answer yet

- **Moving a Home between servers** means copying its folder and updating the shard map. `sendToHome` could queue messages for it meanwhile.
- **Co-locating an organization**: members on one server keep shared calendars and team drives off the network.

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md): the pitfall that every route carries `:ownerId` and every cross-home call uses the relay
- [PROPOSAL_FD_BUDGET.md](proposals/PROPOSAL_FD_BUDGET.md): what sets how many Homes one process can hold
