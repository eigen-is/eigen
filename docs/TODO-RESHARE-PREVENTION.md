# Re-Share Prevention

> **TLDR**: Any editor can currently modify ACLs, change visibility, and share with others. Add a per-path
> `sharingRestricted` flag that limits ACL and visibility changes to the owner (or team members for team drives).
> ~80 lines of backend changes, ~30 lines of UI changes, 2 schema migrations.

## Is This Needed?

**Yes.** The current model treats "can edit content" and "can manage access" as the same permission. This means
sharing a document with a contractor gives them full sharing power — they can add anyone, change others'
permissions, flip visibility to public, or remove people. Google Drive has had the "Editors can share" toggle
since 2015. For a self-hosted workspace handling sensitive org data, this is a real gap.

The implementation is small (~80 lines of backend logic) and well-scoped — it doesn't require a new permission
level or changes to the read/write model.

## Current State

`SharedDrive.updateACL()` delegates to `withWritePermission()`:

```typescript
// sharedDrive.ts:185-186
public async updateACL(mountId: string, pathId: string, acl: DriveACL[], visibility?: DriveVisibility) {
    return this.withWritePermission(mountId, pathId,
        () => this.sharedDrive.updateACL(mountId, pathId, acl, visibility));
}
```

Any user with write access (direct ACL entry, inherited from parent, team membership, or `public-write` visibility)
can call this route. There is no distinction between "can edit" and "can manage sharing."

The ACL route (`PUT /drive/:ownerId/:mountId/path/:pathId/acl`) accepts `{acl, visibility}`. Both are
modifiable by any editor.

The `/invite` chat command builds ACL client-side (`use-chat-room.ts:133-134`) and calls the same ACL route.
It would be blocked by the same backend check.

## Implementation

### 1. Add `sharingRestricted` to `DrivePath` type

`packages/lib/src/types/drive.ts`:

```typescript
export type DrivePath = {
    // ... existing fields
    sharingRestricted: boolean;
}
```

Default: `false` (editors can share, current behaviour preserved).

### 2. Add column to mount paths table

`apps/api/src/lib/mount/db-config.ts` — add migration v2:

```typescript
{
    version: 2,
    up: (db) => db.exec(`
        ALTER TABLE paths ADD COLUMN sharingRestricted INTEGER NOT NULL DEFAULT 0;
    `)
}
```

Update `currentVersion` to `2`.

### 3. Add column to shared_paths mirror

`apps/api/src/lib/drive/db-config.ts` — add migration v2:

```typescript
{
    version: 2,
    up: (db) => db.exec(`
        ALTER TABLE shared_paths ADD COLUMN sharingRestricted INTEGER NOT NULL DEFAULT 0;
    `)
}
```

Update `currentVersion` to `2`.

Add the column to `sharedschema.ts`:

```typescript
sharingRestricted: integer('sharingRestricted').notNull().default(0),
```

### 4. Enforce in `SharedDrive.updateACL()`

**Key insight**: team members always go through `SharedDrive` because `getSharedDrive("team_xyz", user)` sees
`"team_xyz" !== user.id` and creates a `SharedDrive`. There is no team user that logs in — teams use a synthetic
`TeamHome`. So the restriction check must explicitly bypass team members of the owning team.

Replace the current one-liner with:

```typescript
public async updateACL(mountId: string, pathId: string, acl: DriveACL[], visibility?: DriveVisibility, sharingRestricted?: boolean) {
    const path = await this.withWritePermission(mountId, pathId,
        () => this.sharedDrive.getPath(mountId, pathId));
    if (!path) throw new ApiError(404, 'Path not found');

    const isEffectiveOwner = await this.isEffectiveOwner(path.ownerId);

    if (path.sharingRestricted && !isEffectiveOwner) {
        throw new ApiError(403, 'Sharing is restricted by the owner');
    }

    // Only effective owners can change the restriction flag
    return this.sharedDrive.updateACL(mountId, pathId, acl, visibility,
        isEffectiveOwner ? sharingRestricted : undefined);
}

private async isEffectiveOwner(ownerId: string): Promise<boolean> {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'team') return false;
    const memberships = await getMemberships(this.user.id);
    return memberships.teamIds.includes(parsed.id);
}
```

Order matters: check write permission first (non-editors get 403 "no write permission"), then check restriction
(editors without ownership get 403 "sharing restricted"). Viewers never see the restriction error.

The owner's own `Drive.updateACL()` is unaffected — it checks `canWrite(mountId, pathId, this.owner)` where
`this.owner` is the Home's synthetic user, and `path.ownerId === user.id` is always true for own paths.

### 5. Add `sharingRestricted` to the ACL route

`apps/api/src/routes/drive.ts` — extend the body schema:

```typescript
.put("/drive/:ownerId/:mountId/path/:pathId/acl", async ({params, body, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);
    await drive.updateACL(params.mountId, params.pathId, body.acl, body.visibility, body.sharingRestricted);
    return {success: true};
}, {
    body: t.Object({
        acl: t.Array(t.Object({
            id: t.String(),
            read: t.Boolean(),
            write: t.Boolean(),
        })),
        visibility: t.Optional(t.Union([
            t.Literal('private'),
            t.Literal('public-read'),
            t.Literal('public-write'),
        ])),
        sharingRestricted: t.Optional(t.Boolean()),
    }),
    auth: true
})
```

Only the owner (or team member) can set `sharingRestricted`. In `Drive.updateACL()`, add:

```typescript
if (sharingRestricted !== undefined) {
    updates.sharingRestricted = sharingRestricted;
}
```

`SharedDrive.updateACL()` passes `sharingRestricted` through to `Drive.updateACL()` only when the caller is an
effective owner (team member for team-owned paths). For all other callers the parameter is dropped. See step 4.

### 6. Include flag in ACL propagation

`receiveACLChange()` in `drive.ts` already mirrors all `DrivePath` fields to `shared_paths`. Add
`sharingRestricted` to the insert and update calls alongside the existing fields.

### 7. UI: owner toggle in share dialog

`packages/ui/src/components/layout/drive/drive-access-list-edit.tsx`:

Add a checkbox below the "General access" section, visible only when `path.ownerId === currentUserId`
(or team member for team paths):

```
☐ Editors can share
  When off, only the owner can add or remove people
```

- Checked (default) → `sharingRestricted: false`
- Unchecked → `sharingRestricted: true`
- Hidden for non-owners

### 8. UI: readonly mode for restricted non-owners

When `path.sharingRestricted === true` and the caller is not the owner, the share dialog should show the
existing read-only `DriveAccessList` component instead of `DriveAccessListEdit`. The dialog component
(`drive-access-dialog.tsx`) already selects between these — add the restriction as a condition.

Show a muted note: "Sharing is restricted by the owner."

## Design Decisions

### No inheritance

`sharingRestricted` does NOT inherit from parent folders. Rationale:
- Inheritance would be surprising — creating a subfolder inside a restricted folder silently restricts it
- The owner can set the flag on individual paths where it matters
- Matches Google Drive's behaviour (per-item, not inherited)

### No self-removal exception

The original proposal suggested allowing editors to remove their own ACL entry ("leave share") even when
restricted. This adds complexity: you'd need to diff old vs new ACL arrays to detect "only change is
self-removal."

Instead: when `sharingRestricted` is true, editors cannot modify the ACL at all. To "leave" a share, the
user can hide it from their shared-with-me view (client-side only) or ask the owner to remove them. This
keeps the backend simple. If self-removal becomes a real need, add a dedicated `DELETE /drive/:ownerId/:mountId/path/:pathId/acl/me` endpoint later.

### Team-owned paths

Team members always go through `SharedDrive` — there is no team user that logs in. `getSharedDrive("team_xyz",
user)` always creates a `SharedDrive` because `"team_xyz" !== user.id`. Team members pass the `withWritePermission`
check because `canWrite()` in `acl.ts` grants write access to team members via `parseOwnerId()` +
`getMemberships()`.

The `sharingRestricted` check in `SharedDrive.updateACL()` explicitly bypasses team members via
`isEffectiveOwner()` (see step 4). This means team members can both modify ACLs on restricted team paths and
toggle the `sharingRestricted` flag itself — consistent with their co-owner role.

### Visibility changes blocked too

`sharingRestricted` blocks both ACL changes and visibility changes. An editor cannot flip a restricted file
to `public-read`. Both go through the same `updateACL` route and the same `SharedDrive.updateACL()` check.

## Files to Modify

| File | Change |
|---|---|
| `packages/lib/src/types/drive.ts` | Add `sharingRestricted: boolean` to `DrivePath` |
| `apps/api/src/lib/mount/db-config.ts` | Migration v2: add `sharingRestricted` column to `paths` |
| `apps/api/src/lib/mount/schema.ts` | Add `sharingRestricted` column to Drizzle schema |
| `apps/api/src/lib/drive/db-config.ts` | Migration v2: add `sharingRestricted` column to `shared_paths` |
| `apps/api/src/lib/drive/sharedschema.ts` | Add `sharingRestricted` column to Drizzle schema |
| `apps/api/src/lib/drive/sharedDrive.ts` | Check flag in `updateACL()` |
| `apps/api/src/lib/drive/drive.ts` | Store flag in `updateACL()`, include in `receiveACLChange()` and `sharedRowToDrivePath()` |
| `apps/api/src/routes/drive.ts` | Accept `sharingRestricted` in ACL route body |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Owner toggle checkbox |
| `packages/ui/src/components/layout/drive/drive-access-dialog.tsx` | Show read-only view when restricted |

## Not in Scope

- **Per-entry re-share control** (e.g., "Alice can share, Bob cannot"): Too complex. The flag is all-or-nothing
  per path.
- **Cascading restrict** (set once on folder, applies to descendants): Surprising behaviour, hard to reason about.
- **Separate "can manage" permission level**: Would require a third permission beyond read/write. The binary model
  with a restriction flag covers the use case without adding complexity.
