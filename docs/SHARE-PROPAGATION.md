# Share Propagation

How shares are delivered across Eigen, how missed shares are recovered, and how this could evolve toward federation.
Cross-cutting concern affecting Drive, Calendar, and any future sharing domain.

## The Problem

Both Drive and Calendar use push-based propagation: when Alice shares something, the system resolves all target users
and writes to their local databases. This breaks when:

- **User doesn't exist yet**: Alice shares with `eve@company.com`, Eve hasn't created her account.
- **New team member**: Alice shared with `team_engineering` last month, Charlie joins the team today.

## The Model

Two mechanisms: **direct push** for immediate delivery, **share registry** for deferred recovery.

### Step 1: Direct Push (On Share)

When Alice shares a calendar or Drive path:

1. Resolve targets (email → `getUserByEmail`, team → `getTeamMembers`)
2. For each resolved user: `getHome(userId)` → `home.[domain].receiveShare(...)` writes to recipient's DB
3. For each **unresolved** target (user doesn't exist): write `(alice.id, targetIdentifier)` to the **share registry**
4. For **team** targets: push to current members AND write to registry (for future members)

### Step 2: Pull (On Account/Team Join)

When a new user or team member is created, they **pull** from flagged users:

1. Query share registry: "did anyone try to share something with me?"
2. For each `fromUserId` found: call the pull routes to fetch what's shared
3. Write results to own `shared_calendars` / `shared_paths` (same as if pushed directly)
4. Delete consumed registry entries (for user-targeted shares; keep team entries)

### Pull Routes

Both Drive and Calendar expose a route the recipient calls to discover what an owner has shared with them:

```
GET /calendar/:ownerId/shared-with-me    → calendars this owner shared with the requesting user
GET /drive/:ownerId/shared-with-me       → paths this owner shared with the requesting user
```

Authenticated via `{auth: true}`. The route checks the owner's shares/ACLs for entries matching the requester (by
email and team memberships via `parseOwnerId` + `getMemberships`). Returns matching resources with permission level.

These routes are useful for:
- Reconciliation on account/team creation
- Manual refresh if a user suspects missing shares
- Future: federation (HTTP call to another Eigen instance instead of local `getHome()`)

## Share Registry

### Table: `share_registry`

Lives in the **auth database** (`users3.db`) alongside `user`, `member`, `teamMember`:

| Column             | Type    | Description                                           |
|--------------------|---------|-------------------------------------------------------|
| `fromUserId`       | TEXT    | User who created the share                            |
| `targetIdentifier` | TEXT    | Email address (for users) or `team_{id}` (for teams)  |
| `createdAt`        | INTEGER | Unix timestamp                                        |

**Primary key**: `(fromUserId, targetIdentifier)`

No share data, no permissions, no resource IDs, no domain. Just the pair. The actual share details live in the owner's
Home database. The pull routes handle domain-specific resolution.

### Write Rules

- **User target, user exists** → push directly. No registry entry.
- **User target, user doesn't exist** → write to registry.
- **Team target** → push to current members. Always write to registry (for future members).
- **All shares removed** between A and B → delete `(A, B)` from registry. This check runs when A updates shares: if
  A has zero calendars and zero Drive paths shared with B, delete the entry.

### Reconciliation Triggers

**User account created** — extend `databaseHooks.user.create.after` in `auth.ts`:

```typescript
async function reconcileSharesForNewUser(newUser: User): Promise<void> {
    const db = getAuthDrizzleDb();
    const entries = await db.select().from(shareRegistry)
        .where(eq(shareRegistry.targetIdentifier, newUser.email.toLowerCase()))
        .all();

    for (const entry of entries) {
        // Pull shares from each flagged user
        const home = await getHome(entry.fromUserId);
        await home.calendar.pushSharesTo(newUser);
        await home.drive.pushSharesTo(newUser);
    }

    await db.delete(shareRegistry)
        .where(eq(shareRegistry.targetIdentifier, newUser.email.toLowerCase()))
        .run();
}
```

**User added to team** — hook on team member creation:

```typescript
async function reconcileSharesForNewTeamMember(userId: string, teamId: string): Promise<void> {
    const db = getAuthDrizzleDb();
    const entries = await db.select().from(shareRegistry)
        .where(eq(shareRegistry.targetIdentifier, `team_${teamId}`))
        .all();

    const user = await getUserById(userId);
    for (const entry of entries) {
        const home = await getHome(entry.fromUserId);
        await home.calendar.pushSharesTo(user);
        await home.drive.pushSharesTo(user);
    }
    // Don't delete — future team members need these entries
}
```

## Scalability: Is 100-Person Team Fan-Out a Problem?

**Honest answer: no**, because the fan-out only happens on **share/unshare**, not on every event or file operation.

Let's separate the concerns:

| Operation | Fan-out | Frequency |
|-----------|---------|-----------|
| Alice shares calendar with `team_engineering` (100 people) | Push to 100 Homes | Rare (once) |
| Alice creates an event on the shared calendar | **Zero** — event stays in Alice's DB | Frequent |
| Bob views Alice's shared calendar | Bob's frontend pulls from Alice's Home | On demand |
| Alice updates an event | **Zero** — Alice's DB only | Frequent |

**Event data never fans out.** It stays in the owner's Home. Recipients pull events on demand when they view the
calendar. This is the same model Google Calendar uses — there's no real-time push for every event change on shared
calendars.

**SSE for shared calendar events:** When Alice creates an event, SSE fires on Alice's Home only. Bob sees the new
event next time his frontend re-fetches (page load, tab focus, navigation). This is fine — calendars don't need
sub-second real-time updates like chat. If Bob has Alice's calendar open, a reasonable poll interval (or refetch on
window focus) is sufficient.

**The 100-Home creation on share:** This does happen once when Alice shares with a 100-person team. Each Home is created
(or already exists if the user is active). The `receiveShare()` call is a single SQLite insert per user. On a modern
machine with Bun + SQLite, 100 inserts complete in milliseconds. The Home creation overhead is the real cost, but Homes
are cached as singletons — once created, they stay in memory.

If this ever becomes a bottleneck (10,000-person organization), the propagation could be made async (queue + worker).
But for typical Eigen deployments (small to medium teams), it's a non-issue.

## Alternative: Team-Owned Calendars

For team calendars specifically, there's an even simpler model: **let the team own the calendar directly.**

Currently, `TeamHome` only has Drive. If it also had a Calendar instance, team calendars would live in the team's Home
— not in any user's Home. No propagation at all for team-level calendars:

```
/data/home/team_{teamId}/
├── eigen.calendar/
│   └── calendar.db        # Team calendars live here
└── mounts/
    └── ...                 # Team drive already lives here
```

- **Team calendars**: live in TeamHome, all team members access them directly (like team drive)
- **Personal calendars**: live in UserHome, shared via propagation (user-to-user only)
- **Creating a team calendar**: `POST /calendar/team_{teamId}/calendars`
- **Viewing team events**: `GET /calendar/team_{teamId}/calendars/:calId/events`
- **Permission check**: `getMemberships(user.id).teamIds.includes(teamId)` — same as team drive

This eliminates team-targeted propagation entirely. The `share_registry` and propagation only handle user-to-user
shares (which are far less common and involve fewer recipients).

Whether this is worth adding depends on how important team calendars are. It adds a Calendar instance to TeamHome, but
the code is identical — just initialized in a different Home.

## Future: Federation

The model already decouples "when a share is created" from "when it's received":

- **Local** (current): `getHome(userId)` → direct function call
- **Remote** (future): `GET https://other-instance/calendar/:ownerId/shared-with-me` → HTTP pull

The share registry + pull routes are the exact abstraction federation needs. The registry stores the pending pair,
the pull route is already an HTTP endpoint. Switching from local to remote is swapping `getHome()` for `fetch()`.

## Summary

| Mechanism | When | What happens |
|-----------|------|-------------|
| Direct push | On share, target exists | Write to recipient's DB immediately |
| Share registry | On share, target missing | Store `(fromUserId, targetId)` in auth DB |
| Reconciliation | Account or team join | Pull from flagged users, write to own DB |
| Pull route | On demand | `GET /:domain/:ownerId/shared-with-me` |

### Files

| File | Purpose |
|------|---------|
| `apps/api/auth-schema.ts` | Add `shareRegistry` table |
| `apps/api/src/lib/auth/auth.ts` | Reconciliation in user create hook |
| `apps/api/src/lib/share/propagation.ts` | Shared propagation logic (push + registry) |
| `apps/api/src/routes/calendar.ts` | Add `/shared-with-me` pull route |
| `apps/api/src/routes/drive.ts` | Add `/shared-with-me` pull route |
| `apps/api/src/lib/team/` | Hook on team member add → reconcile |
