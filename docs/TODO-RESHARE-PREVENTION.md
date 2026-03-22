# Re-Share Prevention

> **TLDR**: Anyone with write access can currently modify ACLs and share with others. Add an owner-controlled
> `sharingRestricted` flag on paths that limits ACL modifications to the owner (or team owners for team drives).

## Problem

`SharedDrive.updateACL()` gates on `withWritePermission` — the same check as editing content. This means any editor can:

1. Add new users or teams to the ACL (escalate access).
2. Change existing entries from viewer to editor.
3. Change visibility to `public-read` or `public-write`.
4. Remove other users from the ACL.

In practice, sharing a document with a contractor gives them the same sharing power as the owner. Google Drive solves
this with an "Editors can share and change permissions" toggle (on by default, owner can turn it off).

## Proposed Solution

### Data Model

Add a `sharingRestricted` boolean to `DrivePath`:

```typescript
type DrivePath = {
    // ... existing fields
    sharingRestricted: boolean;  // default: false
}
```

When `false` (default), behaviour is unchanged — any editor can share. When `true`, only the owner (or team members for
team-owned paths) can modify ACLs and visibility.

Store as an integer column in the drive paths table, default `0`.

### Backend Enforcement

In `Drive.updateACL()`, after the existing write-permission check, add:

```
if sharingRestricted AND caller is not owner/team-member → throw 403 "Sharing is restricted by the owner"
```

The check applies to `SharedDrive` callers only. The owner's own `Drive` instance always permits ACL changes (the
owner check at the top of `canWrite` already grants this).

Concretely, `SharedDrive.updateACL()` currently delegates to `withWritePermission`. Change it to a dedicated
permission check:

```typescript
public async updateACL(mountId: string, pathId: string, acl: DriveACL[], visibility?: DriveVisibility) {
    const path = await this.sharedDrive.getPath(mountId, pathId);
    if (!path) throw new ApiError(404, 'Path not found');

    if (path.sharingRestricted) {
        throw new ApiError(403, 'Sharing is restricted by the owner');
    }

    return this.withWritePermission(mountId, pathId,
        () => this.sharedDrive.updateACL(mountId, pathId, acl, visibility));
}
```

No changes needed to `canRead` or `canWrite` — this only affects who can modify the ACL, not who can access the file.

### Changing the Flag

Add a separate route or extend the existing ACL route:

```
PUT /drive/:ownerId/:mountId/path/:pathId/acl
  body: { acl, visibility?, sharingRestricted?: boolean }
```

Only the owner (or team member for team-owned paths) can set `sharingRestricted`. If a non-owner tries to set it,
ignore it silently or return 403.

### Inheritance

`sharingRestricted` does NOT inherit. A restricted parent folder does not automatically restrict children. Rationale:

- Inheritance would be surprising — creating a subfolder inside a restricted folder would silently lock out editors
  from sharing it.
- The owner can set the flag on individual paths where it matters.
- This matches Google Drive's behaviour (the toggle is per-item, not inherited).

### Chat `/invite` Command

The `/invite` slash command in chat adds ACL entries. When `sharingRestricted` is true, `/invite` must fail with a
message like "Sharing is restricted by the owner. Ask the owner to invite this person." This is enforced by the same
backend check — the invite command calls `updateACL` internally.

### UI Changes

#### Share Dialog (`drive-access-list-edit.tsx`)

Add a toggle at the bottom of the "General access" section, visible only to the owner:

```
┌─────────────────────────────────────────────────┐
│ General access                                  │
│ 🔒 Restricted / 🔓 Unrestricted    [Can view ▾] │
│                                                 │
│ ☐ Editors can share                             │
│   When off, only the owner can add or           │
│   remove people                                 │
└─────────────────────────────────────────────────┘
```

- Default: checked (editors can share, `sharingRestricted: false`).
- Unchecked: `sharingRestricted: true`.
- Only shown to the owner. Non-owners don't see the toggle.

#### Non-Owner Editor View

When `sharingRestricted` is true and the caller is not the owner, the share dialog should:

- Show the current access list (read-only, no edit controls).
- Hide the "add contact" input, "Share with team" button, visibility toggle, and permission dropdowns.
- Show a muted note: "Sharing is restricted by the owner."

This means `DriveAccessListEdit` needs a `readonly` mode, or the dialog falls back to `DriveAccessList` (the
read-only component that already exists).

## Edge Cases

### Editor removes themselves

An editor with `write` access can currently remove their own ACL entry (effectively "leaving" the share). This should
remain allowed even when `sharingRestricted` is true — restricting self-removal would trap users in shares they don't
want.

Implementation: allow `updateACL` when the only change is removing the caller's own entry.

### Team-owned paths

For team-owned paths, any team member acts as "owner" for the purposes of this flag. This is consistent with how
team ownership already works — all team members have full read/write and are treated as co-owners.

### Inherited access + restricted child

A folder shared with Alice (editor) contains a file with `sharingRestricted: true`. Alice can edit the file (inherited
write) but cannot change who else has access to it. This is the intended behaviour.

### Visibility changes

`sharingRestricted` blocks visibility changes too. An editor cannot flip a restricted file to `public-read`. Only the
owner can change visibility on restricted items.

### Move into restricted folder

Moving a file into a folder does not change the file's `sharingRestricted` flag. The flag stays with the file wherever
it moves.

## Files to Modify

| File                                                                 | Change                                  |
|----------------------------------------------------------------------|-----------------------------------------|
| `apps/api/src/lib/drive/schema.ts`                                   | Add `sharingRestricted` column          |
| `apps/api/src/lib/drive/drive.ts`                                    | Pass flag in `updateACL`, store in path |
| `apps/api/src/lib/drive/sharedDrive.ts`                              | Check flag before allowing ACL changes  |
| `apps/api/src/routes/drive.ts`                                       | Accept `sharingRestricted` in body      |
| `packages/lib/src/types/drive.ts`                                    | Add `sharingRestricted` to `DrivePath`  |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | Owner toggle + readonly mode            |
| `apps/api/src/lib/drive/sharedschema.ts`                             | Add column to shared_paths mirror       |
| `apps/api/src/lib/drive/acl-propagation.ts`                          | Include flag in propagated data         |

## Not in Scope

- **Per-entry re-share control** (e.g., "Alice can share, Bob cannot"): Too complex, not worth it. The flag is
  all-or-nothing per path.
- **Cascading restrict** (set once on a folder, applies to all descendants): Surprising behaviour, hard to reason
  about. Keep it per-item.
- **Separate "can manage" permission**: Would require a third permission level beyond read/write. The current binary
  model is simpler and the restricted flag covers the main use case.
