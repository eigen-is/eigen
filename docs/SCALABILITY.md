# Scalability

> **TLDR:** Eigen runs as one API process, and no sharding exists. What exists is the shape sharding needs: every user's and team's data lives in one isolated Home, every authenticated route carries the Home's `ownerId` as its second path segment, so a router can pin a Home to one process, and every cross-home call goes through `apps/api/src/lib/home/home-relay.ts`, the one file sharding has to change. Not obvious from the code: the server-wide state (the auth database, the share registry, the backup job map, the data epochs) is what a second process cannot share yet, and a relay message in flight is lost on a crash. The first concrete step is [PROPOSAL_SINGLE_MACHINE_CLUSTER.md](proposals/PROPOSAL_SINGLE_MACHINE_CLUSTER.md).

## A Home holds all of one owner's data

Every user and every team has a Home with its own SQLite databases, file storage and event stream. No database mixes users' content. The only server-level databases are the three in `SERVER_DATABASES` (`apps/api/src/lib/config/paths.ts`): `users3.db` for auth, `eigen.db` for the share registry and `waitlist.db`. So a Home can live on any server without a schema change, and moving one is moving its folder.

## The ownerId is the routing key

Every authenticated route has `:ownerId` as its second path segment (`/drive/:ownerId/…`, `/calendar/:ownerId/…`), which `scripts/check-standards.ts` enforces. A router can read it without parsing a body and send every request for one Home to the process that owns it. A collab socket carries the document owner's id, not the editor's, so an edit of someone else's document already routes to the right Home.

Server-wide surfaces that act on no Home carry none, and `OWNER_ID_EXEMPT` lists them: setup, the settings, the waitlist, the public pages, and the per-home and whole-server backup routes. In a cluster they need a process of their own or a shared answer.

## Every cross-home call goes through the relay

When one user's action touches another Home, it goes through `home-relay.ts`, in one of three shapes, all keyed by the target's `ownerId`:

- **Pushes**: `sendToHome(targetUserId, message)` with a typed `HomeMessage` (ACL changes, calendar shares and invitations, RSVPs, SSE broadcasts, notifications), plus `push*` helpers for profile and team avatars. Fire and forget.
- **Pulls**: one typed function per cross-home read, such as `pullSharedPaths`, `pullCalendars` and `pullDriveSearch`. `pullHomeSize` and `pullHomeBackupBytes` read a home's folder without booting it, and `pullHomeSnapshot` captures a home for a backup.
- **Event writes**: `createEventAt`, `updateEventAt`, `deleteEventAt` and `moveEventAt`, which return a value and so are not pushes.

Today each is a direct `getHome()` in the same process. Sharded, `sendToHome` routes or enqueues a message and a pull becomes a request to the owning process, and nothing outside the file changes. A `HomeMessage` is plain data for that reason.

## A receive method finishes the job on the target

The Calendar and Drive `receive*` methods write the database, broadcast the SSE event and persist the notification themselves. One message therefore does a whole operation on the target Home, and a sharded relay never has to coordinate steps across processes.

## lib/ may not import getHome

`scripts/check-home-imports.ts`, part of `bun run check`, fails on `getHome` anywhere in `apps/api/src/lib/` outside `lib/home/`. The per-domain `get-*.ts` resolvers are allowed by design, and a few older files are allowlisted pending a refactor. A route may resolve its own request's Home. Any other Home goes through the relay. Passing the `Home` down from the route would empty the allowlist and make a wrong lookup impossible to write ([ROADMAP.md](ROADMAP.md)).

## Server-wide state is what a second process cannot share yet

| Component | Today | Sharded |
|---|---|---|
| Auth | `data/server/users3.db` | One shared database |
| Share registry | `data/server/eigen.db` | A shared database or a distributed registry |
| Waitlist | `data/server/waitlist.db` | One row set, written from any process |
| Yjs documents | In memory in the process that opened them | Editors connect to the owner's process |
| SSE streams | In the process that serves the user | A user connects to their Home's process ([SSE.md](SSE.md)) |
| Backup jobs and the restore mark | The in-memory job map and `markHomeRestoring`, per process | Home jobs run where the Home lives. The whole-server job reaches every Home through `pullHomeSnapshot`, which becomes a pull, and its slot and schedule tick need one owner ([BACKUP.md](BACKUP.md)) |
| Data epochs | Read once per process (`apps/api/src/lib/home/data-epoch.ts`), so no other process sees a rotation | The Home's process owns its epoch, and a stream or collab open elsewhere reads it through a pull ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home)) |

## The first step is several processes on one machine

[PROPOSAL_SINGLE_MACHINE_CLUSTER.md](proposals/PROPOSAL_SINGLE_MACHINE_CLUSTER.md) runs several API processes on one box over one filesystem, with Caddy routing by `ownerId`, so the application never hashes an id itself. Its row in [ROADMAP-POST-1.md](ROADMAP-POST-1.md) says what exists and what triggers it. The instance lock keeps a second API off a data folder today ([DATABASE.md](DATABASE.md#one-api-process-owns-a-data-folder)), so the cluster replaces it with a per-home lock first.

## A relay message in flight is lost on a crash

`sendToHome` has no durable queue. The ACL fan-out is bounded and ordered per path (`apps/api/src/lib/drive/acl-propagation.ts`), but a delivery in flight when the process dies is gone. [PROPOSAL_HOME_RELAY_OUTBOX.md](proposals/PROPOSAL_HOME_RELAY_OUTBOX.md) turns each push into a row in a server-level outbox with one drain loop, FIFO per target, retries and replay on boot. In a sharded deployment that drain is the one place that learns about other processes.

## Multi-server questions without an answer yet

- **Moving a Home between servers** means copying its folder and updating the shard map. `sendToHome` could queue messages for it meanwhile.
- **Co-locating an organization**: members on one server keep shared calendars and team drives off the network.

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md): the pitfall that every route carries `:ownerId` and every cross-home call uses the relay
- [PROPOSAL_FD_BUDGET.md](proposals/PROPOSAL_FD_BUDGET.md): what sets how many Homes one process can hold
