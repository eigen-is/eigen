# Proposal: Single-Machine Multi-Process Cluster

> **TLDR**: **Not implemented.** A concrete plan for running several API processes on one multi-CPU box,
> sharing `./data`, with Caddy hashing `ownerId` as the only router. None of it exists today: no
> `cluster.ts`, no `docker-compose.cluster.yml`, no Caddy `map`/`lb_policy header` block, no internal
> relay endpoints. Extends [SCALABILITY.md](SCALABILITY.md) with load balancing and a cross-process home relay.

## Architecture Overview

```
                    +------------------+
                    |      CADDY       |
                    |                  |
            :443    |  lb_policy       |   :8080
    ───────────────>|  header hash     |<─────────────
    external reqs   |  by ownerId      |  relay reqs
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
              v              v              v
     +--------+---+  +------+-----+  +-----+------+
     | API Proc 1 |  | API Proc 2 |  | API Proc 3 |
     | (homes     |  | (homes     |  | (homes     |
     |  A, B, C)  |  |  D, E)     |  |  F, G, H)  |
     +------------+  +------------+  +------------+
              shared filesystem: ./data
```

Multiple Docker containers each run a full Elysia server on port 8000. Caddy extracts the ownerId
from the URL path and uses consistent header hashing to route all requests for one ownerId to the
same backend. Caddy is the **single source of truth** for routing — the application never hashes
ownerIds. Cross-home relay sends requests through Caddy's internal listener (`:8080`) which applies
the same hashing, guaranteeing routing consistency.

## Why Caddy Is the Only Router

The relay (one user's action touching another user's Home) needs to reach the correct process. Two
approaches were considered and rejected:

1. **Application-side consistent hash** (e.g., FNV-1a mapping ownerId to peer) — rejected because
   Caddy uses a different hash algorithm internally. The two would disagree about which process owns
   which ownerId, causing relay messages to go to the wrong place.

2. **Broadcast to all peers, check `atHome()`** — rejected because `atHome()` only returns true if
   the Home singleton is currently cached in memory. Relay operations like shares and notifications
   need to **initialize** the Home (call `getHome()`) to write to its database. Broadcasting with
   an `atHome()` guard would silently drop messages for users whose Homes aren't loaded.

**Solution:** Route relay through Caddy. API processes send relay requests to
`http://caddy:8080/internal/relay/{ownerId}`. Caddy extracts ownerId from the path, applies the
same header hash, and routes to the correct peer. That peer calls `getHome(ownerId)` (initializing
if needed) and processes the message. No routing logic in the application.

## Caddy Configuration

Caddy's default build does **not** include `ring_hash`. Use the built-in `header` lb_policy instead:
set a request header from the mapped ownerId, then hash it.

**Validated with `caddy validate`** — the following config passes validation on `caddy:2-alpine`.

### External site (`:443`)

```caddy
{$DOMAIN} {
    # Extract ownerId from API paths
    map {path} {owner_hash_key} {
        ~^/eigen/ws/collab/([^/]+)     ${1}
        ~^/eigen/sse/([^/]+)           ${1}
        ~^/eigen/[^/]+/([^/]+)         ${1}
        default                         {remote_host}
    }

    # Block external access to internal relay endpoints
    handle /eigen/internal/* {
        respond 403
    }

    # API routing with consistent hash by ownerId
    handle_path /eigen/* {
        request_header X-Owner-Hash {owner_hash_key}
        reverse_proxy api-1:8000 api-2:8000 api-3:8000 {
            lb_policy header X-Owner-Hash
            flush_interval -1
            header_up X-Real-IP {remote_host}
        }
    }
}
```

The `map` directive extracts ownerId from the URL path (second segment after `/eigen/`). For routes
without ownerId (auth, health, setup), it falls back to `{remote_host}` (client IP), distributing
these requests across backends.

### Internal relay listener (`:8080`)

```caddy
:8080 {
    map {path} {relay_owner} {
        ~^/internal/relay/([^/]+)       ${1}
        ~^/internal/pull/([^/]+)        ${1}
        default                          ""
    }

    handle /internal/* {
        request_header X-Owner-Hash {relay_owner}
        reverse_proxy api-1:8000 api-2:8000 api-3:8000 {
            lb_policy header X-Owner-Hash
        }
    }
}
```

Port 8080 is **not published** in docker-compose — only reachable within the Docker network.
Both the external and internal sites use the same `lb_policy header X-Owner-Hash` against the same
backends, so they produce identical routing for the same ownerId.

## Application Changes

### New file: `apps/api/src/lib/config/cluster.ts`

Minimal module. No hashing, no peer selection — just knows whether cluster mode is active and
how to build relay URLs.

```typescript
const peers = (process.env['CLUSTER_PEERS'] ?? '').split(',').filter(Boolean);
const self = process.env['CLUSTER_SELF'] ?? '';
const relayHost = process.env['CLUSTER_RELAY_HOST'] ?? 'caddy:8080';

export function isClusterMode(): boolean {
    return peers.length > 1 && self !== '';
}

export function getRelayUrl(path: string): string {
    return `http://${relayHost}${path}`;
}
```

Environment variables:
- `CLUSTER_PEERS` — comma-separated list of all peer addresses (e.g., `api-1:8000,api-2:8000,api-3:8000`)
- `CLUSTER_SELF` — this instance's address in the peer list
- `CLUSTER_RELAY_HOST` — Caddy's internal address (default: `caddy:8080`)

When `CLUSTER_PEERS` is not set, `isClusterMode()` returns false and all code takes the original
single-process path.

### Modified: `apps/api/src/lib/home/home-relay.ts`

The existing `sendToHome()` switch statement is extracted into `dispatchToLocalHome()` (exported,
used by internal endpoints). `sendToHome()` wraps it with the cluster routing:

```typescript
export async function sendToHome(targetUserId: string, message: HomeMessage): Promise<void> {
    // Fast path: Home is loaded on this process
    if (atHome(targetUserId)) {
        await dispatchToLocalHome(targetUserId, message);
        return;
    }

    // Single-process mode: original behavior
    if (!isClusterMode()) {
        if (message.type === 'broadcast') return; // No SSE connection = skip
        await dispatchToLocalHome(targetUserId, message);
        return;
    }

    // Cluster mode: send through Caddy (ring_hash routes to correct peer)
    await fetch(getRelayUrl(`/internal/relay/${targetUserId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    });
}
```

Key behaviors:
- `atHome()` is a **pure optimization** — if the Home is already loaded on this process, skip the
  network hop. It is NOT a routing decision.
- In single-process mode, `broadcast` type is skipped when `!atHome()` (user has no SSE connection).
  All other types call `getHome()` directly (original behavior).
- In cluster mode, everything goes through Caddy's `:8080` listener. Caddy routes to the correct
  peer based on the ownerId in the URL path. The receiving peer calls `getHome()` to initialize the
  Home if needed.

Pull functions (`pullSharedPaths`, `pullCalendarShares`, etc.) follow the same pattern: local fast
path if `atHome()`, else fetch through Caddy relay:

```typescript
export async function pullSharedPaths(ownerUserId: string, user: User): Promise<DrivePath[]> {
    if (atHome(ownerUserId) || !isClusterMode()) {
        const home = await getHome(ownerUserId);
        return home.drive.getSharedWith(user);
    }
    return fetchFromRelay(ownerUserId, 'shared-paths', { user });
}
```

### Modified: `apps/api/src/routes/internal.ts`

New endpoints with `:ownerId` in the path (so Caddy can extract it for routing):

- `POST /internal/relay/:ownerId` — receives `{ message: HomeMessage }`, calls
  `dispatchToLocalHome()`. For `broadcast` messages only: checks `atHome()` first and skips if the
  Home isn't loaded (user has no active SSE connection, so broadcasting is pointless).
- `POST /internal/pull/:ownerId/shared-paths` — calls `getHome()`, returns shared paths
- `POST /internal/pull/:ownerId/calendar-shares` — returns calendar shares
- `POST /internal/pull/:ownerId/pending-invitations` — returns pending invitations
- `POST /internal/pull/:ownerId/calendar-permission` — returns permission level
- `POST /internal/pull/:ownerId/calendars` — returns calendars
- `GET  /internal/pull/:ownerId/avatar/:filename` — streams avatar binary
- `POST /internal/pull/:ownerId/team-quota-overrides` — returns team quota overrides
- `POST /internal/pull/:ownerId/team-mounts` — returns team mounts

All endpoints use `requireLocalhost(request, server)` for access control. This passes for
Docker-internal traffic (Caddy's IP is in `TRUSTED_NETWORKS: 172.16.0.0/12`). External access
is blocked by Caddy's `handle /eigen/internal/* { respond 403 }` rule, and port 8080 is not
published.

### Modified: `apps/api/src/index.ts`

- Read port from `PORT` env var (default 8000)
- Log cluster mode and `CLUSTER_SELF` on startup

## Docker Compose

Create `docker-compose.cluster.yml` as an overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.cluster.yml up -d
```

This overlay:
- Disables the single `eigen-api` service via `profiles: [disabled]`
- Adds `eigen-api-1`, `eigen-api-2`, `eigen-api-3` with identical config (YAML anchors) except
  `CLUSTER_SELF`
- Sets `API_BACKENDS` on Caddy (note: if env var expansion into multiple upstreams doesn't work,
  hardcode backends in a separate `Caddyfile.cluster`)
- Updates `postfix` and `dovecot` `depends_on` to point to all 3 instances

All instances mount the same `./data:/app/data` volume (shared filesystem on one machine).

**Each of the three services needs its own `ulimits: nofile:` block.** The pin currently lives on the
single `eigen-api` service; the anchor that clones the three cluster services must carry it, or each
process inherits the Docker default and hits the fd wall described below. See
[PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md).

## What Works Without Changes

- **SSE**: Each user subscribes to their own Home's SSE stream (`/sse/:ownerId/events`). Caddy
  routes this to the process that owns the user's Home. SSE keepalive calls `home.touch()` every
  15 seconds, preventing idle timeout while connected.
- **Collab WebSocket**: URL includes document owner's ownerId (`/ws/collab/:ownerId/:mountId/:pathId`).
  All editors of the same document connect to the same process.
- **Auth DB**: Shared `data/server/users3.db` — SQLite WAL mode handles concurrent access from
  multiple processes.
- **Rate limiting**: Per-process (300 req/min/IP each). Total capacity = N x 300. Acceptable for
  a small deployment.
- **Idle timeout**: Homes auto-destruct without `touch()` — 5 min for a `UserHome`, 30 min for a
  `TeamHome`.

### The binding resource is file descriptors, not memory

An earlier version of this doc said the idle timeout makes memory self-limiting. That is the wrong
resource. A warm Home holds ~30 fds (six SQLite WAL triples plus 12 maildir `fs.watch` handles), and
an fd burst happens in *seconds* — one ACL fan-out to a 26-member team opens 26 Homes at once — while
the idle window that releases them is minutes long. So fds, not memory, decide how many Homes one
process can hold, and exhaustion shows up as `SQLITE_IOERR` in whatever subsystem opens the next file.
Per-process fd limits are therefore a hard input to any cluster sizing here. Accounting and the
proposed startup check are in [PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md).

## Acceptable Tradeoffs

- **Relay adds ~1ms** per cross-home operation (API → Caddy → API). Relay is low-frequency
  (file shares, calendar invites), not per-request.
- **Topology changes require restart** of all instances (hash redistribution). Fine for a VPS
  that rarely changes.
- **Auth/share DBs shared on disk** — SQLite WAL handles concurrent writes but may show contention
  under heavy auth load. Acceptable for small-to-medium user counts.

## Implementation Checklist

1. Create `apps/api/src/lib/config/cluster.ts` — `isClusterMode()`, `getRelayUrl()`
2. Add internal relay/pull endpoints to `apps/api/src/routes/internal.ts` (with `:ownerId` in path)
3. Refactor `apps/api/src/lib/home/home-relay.ts` — extract `dispatchToLocalHome()`, add Caddy
   relay for cluster mode
4. Update `apps/api/src/index.ts` — configurable port, cluster logging
5. Update `Caddyfile` — `map` + `request_header` + `lb_policy header`, internal `:8080` listener
6. Create `docker-compose.cluster.yml` — 3 API instances with cluster env vars and a `ulimits: nofile:`
   block on each
7. Verify home-imports lint rule allows `getHome` in `internal.ts` (it's a route file, should pass)
8. Run `bun run check` to verify single-process mode is unchanged
9. Docker smoke test with cluster overlay
10. Update this doc with any adjustments found during implementation
