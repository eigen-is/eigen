# Scalability

Multi-server scaling design for Eigen. The architecture is built around per-user data isolation (the Home
singleton) and consistent routing by `ownerId`, which together make user-sharding a natural extension of
the single-server model.

## What's Implemented Today

### Per-User Data Isolation

Every user has an isolated Home with its own SQLite databases, file storage, and SSE broadcast channel.
There is no shared database for user content — the only server-level databases are `users3.db` (auth) and
`eigen.db` (share registry). This isolation is the foundation for sharding: a user's Home can live on any
server without schema changes.

### ownerId Routing Key

Every authenticated route includes `:ownerId` as the second path segment (`/drive/:ownerId/...`,
`/calendar/:ownerId/...`). A load balancer can extract `ownerId` and use consistent hashing to route all
requests for one Home to the same server.

### Home Relay Layer

All cross-home interactions — where one user's action touches another user's Home — flow through a single
relay module (`apps/api/src/lib/home/home-relay.ts`). This is the sharding seam.

**Push operations** use `sendToHome(targetUserId, message)` with a typed `HomeMessage` discriminated union:

| Message type                 | What it does                                  |
|------------------------------|-----------------------------------------------|
| `drive:acl-change`           | Propagate ACL change to target's shared.db    |
| `calendar:share`             | Share/unshare a calendar with target          |
| `calendar:invitation`        | Deliver a calendar invitation                 |
| `calendar:invitation-update` | Update an existing invitation                 |
| `calendar:invitation-removal`| Cancel/remove an invitation                   |
| `calendar:rsvp`              | Update attendee RSVP on organizer's event     |
| `broadcast`                  | Send SSE event to target's connected clients  |
| `notification`               | Persist notification in target's center       |

**Pull operations** use individual typed functions for cross-home reads:

| Function                  | What it reads                                     |
|---------------------------|---------------------------------------------------|
| `pullSharedPaths`         | Drive paths an owner has shared with a user       |
| `pullCalendarShares`      | Calendars an owner has shared with a user         |
| `pullPendingInvitations`  | Events where a user is an attendee                |
| `pullCalendarPermission`  | A user's permission level on an owner's calendar  |
| `pullCalendars`           | All calendars from an owner's home                |

Today these are direct in-process calls via `getHome()`. In a sharded deployment, only `home-relay.ts`
changes — `sendToHome()` routes to the correct server or enqueues a message, and pull functions become
remote API calls.

### Self-Contained Receive Methods

Calendar and Drive `receive*` methods handle DB writes, SSE broadcast, and notification persistence
internally. This means a single `sendToHome()` message triggers a complete operation on the target — no
multi-step coordination needed across servers.

## Future: Multi-Server Architecture

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

### Shared State That Needs Addressing

| Component          | Current                        | Sharded approach                             |
|--------------------|--------------------------------|----------------------------------------------|
| Auth DB            | `data/server/users3.db`        | Shared database (PostgreSQL or replicated)   |
| Share registry     | `data/server/eigen.db`         | Shared database or distributed registry      |
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

### Open Design Questions

- **Message delivery guarantees**: Should `sendToHome` be fire-and-forget, at-least-once (queued), or
  exactly-once? Current propagation code uses try/catch and logs failures — acceptable for single-server,
  but sharding may need a message queue (Redis Streams, NATS) for reliability.
- **Yjs collaboration across shards**: When user A edits user B's document, A's WebSocket connects to B's
  server. The load balancer routes the document WebSocket by the *document owner's* ownerId, not the
  editor's. This works naturally with the existing routing key.
- **User migration**: Moving a user's Home between servers requires copying their data directory and
  updating the shard map. During migration, `sendToHome` could queue messages until the new shard is ready.
- **Organization co-location**: Large orgs benefit from having members on the same or neighboring servers
  to minimize cross-shard communication for shared calendars and team drives.
