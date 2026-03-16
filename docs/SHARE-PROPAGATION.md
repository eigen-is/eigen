# Share Propagation

> **TLDR**: Push-based sharing for Drive and Calendar. On share: resolve targets → write to recipient's DB. If target
> doesn't exist: write to share registry (`data/server/eigen.db`). On account/team join: pull from registry to reconcile
> missed shares. Team's own calendars are auto-synced into `shared_calendars` on fetch.

## Model

### Direct Push (on share)

1. Resolve targets (email → user, team → members)
2. For each resolved user: `getHome(userId)` → write to recipient's DB
3. For unresolved targets: write to share registry
4. For team targets: push to current members AND write registry (for future members)

### Pull (on account/team join)

1. Query share registry for entries targeting the new user/team member
2. For each `fromUserId`: call pull routes to fetch shared resources
3. Write to own DB, delete consumed user entries (keep team entries)

## Share Registry

**Database**: `data/server/eigen.db` (server-level, `ManagedDatabase`)

| Column             | Type | Description            |
|--------------------|------|------------------------|
| `fromUserId`       | TEXT | User who created share |
| `targetIdentifier` | TEXT | Email or `team_{id}`   |

PK: `(fromUserId, targetIdentifier)`. No share data — just the pair. Pull routes handle domain resolution.

### Write Rules

- User exists → push directly, no registry
- User doesn't exist → write to registry
- Team → push to members + always write to registry
- All shares removed between A and B → delete registry entry

## Reconciliation Triggers

- **Account created**: `databaseHooks.user.create.after` in `apps/api/src/lib/auth/auth.ts`
- **Team member added**: `organizationHooks.afterAddTeamMember` on the `organization()` plugin in `apps/api/src/lib/auth/auth.ts`

## Reconciliation Actions

On new user/team member, `reconcileSharesForNewUser()` runs:
1. `pullCalendarShares()` — shared calendar entries
2. `pullDriveShares()` — shared drive paths
3. `pullPendingInvitations()` — calendar invites (creates linked event copies for pending attendees)

## Pull Routes

```
GET /calendar/:ownerId/shared-with-me
GET /drive/:ownerId/shared-with-me
```

## Scalability

Fan-out only happens on share/unshare (rare). Event data stays in owner's Home — recipients pull on demand. 100 inserts
complete in milliseconds with Bun + SQLite. Non-issue for typical deployments.

## Files

| File                                             | Purpose                                    |
|--------------------------------------------------|--------------------------------------------|
| `apps/api/src/lib/share/schema.ts`               | Share registry Drizzle schema              |
| `apps/api/src/lib/share/db-config.ts`            | DatabaseConfig + migration                 |
| `apps/api/src/lib/share/db.ts`                   | `getEigenDb()` server-level DB singleton   |
| `apps/api/src/lib/share/registry.ts`             | Registry CRUD operations                   |
| `apps/api/src/lib/share/reconciliation.ts`       | Pull logic for new users/team members      |
| `apps/api/src/lib/calendar/share-propagation.ts` | Calendar-specific propagation + registry   |
| `apps/api/src/lib/drive/acl-propagation.ts`      | Drive-specific propagation + registry      |
