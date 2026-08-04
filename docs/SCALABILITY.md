# Scalability

> **TLDR**: Every user's data lives in one isolated Home, and every authenticated route carries `:ownerId` as its
> second path segment — so a load balancer can hash on it and pin a Home to a server. Every cross-home interaction
> already funnels through `apps/api/src/lib/home/home-relay.ts`, which is the one file sharding has to change.
> Those three exist today; no sharding does. The concrete first step is
> [PROPOSAL_SINGLE_MACHINE_CLUSTER.md](PROPOSAL_SINGLE_MACHINE_CLUSTER.md).

Multi-server scaling design for Eigen. The architecture is built around per-user data isolation (the Home
singleton) and consistent routing by `ownerId`, which together make user-sharding a natural extension of
the single-server model.

## What's Implemented Today

### Per-User Data Isolation

Every user has an isolated Home with its own SQLite databases, file storage, and SSE broadcast channel.
There is no shared database for user content — the only server-level databases are `users3.db` (auth),
`eigen.db` (share registry) and `waitlist.db` (waitlist entries + invite tokens, opened lazily on first use by
`apps/api/src/lib/waitlist/waitlist.ts`). This isolation is the foundation for sharding: a user's Home can live on
any server without schema changes.

### ownerId Routing Key

Every authenticated route includes `:ownerId` as the second path segment (`/drive/:ownerId/...`,
`/calendar/:ownerId/...`). A load balancer can extract `ownerId` and use consistent hashing to route all
requests for one Home to the same server.

### Home Relay Layer

All cross-home interactions — where one user's action touches another user's Home — flow through a single
relay module (`apps/api/src/lib/home/home-relay.ts`). This is the sharding seam.

The module holds three shapes, all keyed by the target's `ownerId`. Read the file for the current inventory —
enumerating it here rots (it has grown to roughly a dozen pulls and a handful of pushes since this doc was
written).

- **Pushes** — `sendToHome(targetUserId, message)` with a typed `HomeMessage` discriminated union (ACL changes,
  calendar shares and invitations, RSVPs, SSE broadcasts, notifications), plus a couple of `push*` helpers for
  profile and team avatars. Fire-and-forget: no return value
- **Pulls** — one typed function per cross-home read (`pullSharedPaths`, `pullCalendars`, `pullEventsInRange`,
  `pullDriveSearch`, team quota/mount lookups, …)
- **Event mutations** — `createEventAt` / `updateEventAt` / `deleteEventAt`. Writes with return values, so they
  don't fit the fire-and-forget push shape

Today all three are direct in-process calls via `getHome()`. In a sharded deployment only `home-relay.ts`
changes — `sendToHome()` routes to the correct server or enqueues a message, and pull/event functions become
remote API calls.

### Self-Contained Receive Methods

Calendar and Drive `receive*` methods handle DB writes, SSE broadcast, and notification persistence
internally. This means a single `sendToHome()` message triggers a complete operation on the target — no
multi-step coordination needed across servers.

## Future: Multi-Server Architecture

The first step is smaller than this: several API processes on one box, sharing the filesystem, routed by Caddy.
That is worked out in [PROPOSAL_SINGLE_MACHINE_CLUSTER.md](PROPOSAL_SINGLE_MACHINE_CLUSTER.md) (also not
implemented). The picture below is the multi-machine end state.

```
                           +-------------------+
                           |   LOAD BALANCER   |
                           |  (route by        |
                           |   ownerId)        |
                           +--------+----------+
                                    |
              +---------------------+---------------------+
              |                     |                     |
              v                     v                     v
+------------------+   +------------------+   +------------------+
| API SERVER 1     |   | API SERVER 2     |   | API SERVER 3     |
| (homes A, B, C)  |   | (homes D, E)     |   | (homes F, G, H)  |
|                  |   |                  |   |                  |
| WebSocket / Yjs  |   | WebSocket / Yjs  |   | WebSocket / Yjs  |
| SQLite per user  |   | SQLite per user  |   | SQLite per user  |
+------------------+   +------------------+   +------------------+
```

### What changes in `home-relay.ts`

```typescript
export async function sendToHome(targetUserId: string, message: HomeMessage): Promise<void> {
    const shard = lookupShard(targetUserId);
    if (shard.isLocal) {
        // Same as today — direct in-process call
        const home = await getHome(targetUserId);
        // ... dispatch message
    } else {
        // Serialize HomeMessage (it's already plain data) and send
        await shard.post(targetUserId, message);
    }
}
```

Pull functions follow the same pattern — check shard locality, call locally or make an API request.
[PROPOSAL_SINGLE_MACHINE_CLUSTER.md](PROPOSAL_SINGLE_MACHINE_CLUSTER.md) works this through concretely for one
machine, using Caddy as the only router so the application never hashes an ownerId itself.

### Shared State That Needs Addressing

| Component          | Current                        | Sharded approach                             |
|--------------------|--------------------------------|----------------------------------------------|
| Auth DB            | `data/server/users3.db`        | Shared database (PostgreSQL or replicated)   |
| Share registry     | `data/server/eigen.db`         | Shared database or distributed registry      |
| Waitlist           | `data/server/waitlist.db`      | Same treatment as the share registry — one row set for the whole deployment, written from any node |
| Yjs documents      | In-memory per server           | Editors connect to document owner's server   |
| SSE connections    | Per-server                     | Each user connects to their home's server    |
| Team membership    | Auth DB queries                | Shared auth DB handles this                  |

### Home Locality Enforcement

A lint rule (`scripts/check-home-imports.ts`, run by `bun run check`) blocks new `getHome` imports
in `lib/` — only route files and `home-relay.ts` may import it. Existing lib files are allowlisted
pending refactor.

**Future refactor**: Change lib functions to receive `Home` as a parameter instead of calling
`getHome` internally. Routes resolve `home` and pass it down. This eliminates convenience wrappers
like `getDrive(user)`, `resolveCalendar(user, ownerId)` — routes just use `home.drive`,
`home.calendar` directly. Makes wrong code structurally impossible rather than just flagged.

### Delivery Guarantees

Answered and scheduled, not open: [PROPOSAL_HOME_RELAY_OUTBOX.md](PROPOSAL_HOME_RELAY_OUTBOX.md) turns
`sendToHome` into a durable row in a server-level outbox with a single drain loop, per-target FIFO, retry/backoff
and replay on boot — and in the sharded future that drain step is the one place that learns about remote shards.
The ACL fan-out is already bounded-async (`apps/api/src/lib/drive/acl-propagation.ts`: bounded concurrency,
per-path FIFO), but in-flight deliveries are still lost on a crash. That window is what the outbox closes.

### Open Design Questions

- **Yjs collaboration across shards**: When user A edits user B's document, A's WebSocket connects to B's
  server. The load balancer routes the document WebSocket by the *document owner's* ownerId, not the
  editor's. This works naturally with the existing routing key.
- **User migration**: Moving a user's Home between servers requires copying their data directory and
  updating the shard map. During migration, `sendToHome` could queue messages until the new shard is ready.
- **Organization co-location**: Large orgs benefit from having members on the same or neighboring servers
  to minimize cross-shard communication for shared calendars and team drives.
