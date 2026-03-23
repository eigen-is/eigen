# Re-Share Prevention

> **TLDR**: Per-path `sharingRestricted` flag that limits ACL and visibility changes to the owner (or team members for
> team drives). Editors keep full read/write access to content but cannot add/remove people or change visibility.
> Default: `false` (editors can share, matching pre-flag behaviour).

## Why

The ACL model treats "can edit content" and "can manage access" as the same permission. Without this flag, sharing a
document with a contractor gives them full sharing power — they can add anyone, change permissions, flip visibility to
public, or remove people. The `sharingRestricted` flag separates these concerns without adding a third permission level.

## Schema

Both `paths` (mount DB) and `shared_paths` (drive DB) have the column:

```sql
sharingRestricted INTEGER NOT NULL DEFAULT 0
```

Drizzle schemas: `apps/api/src/lib/mount/schema.ts`, `apps/api/src/lib/drive/sharedschema.ts`.
TypeScript type: `sharingRestricted: boolean` on `DrivePath` in `packages/lib/src/types/drive.ts`.

## Backend Enforcement

**`SharedDrive.updateACL()`** (`apps/api/src/lib/drive/sharedDrive.ts`) checks the flag after verifying write
permission:

1. `withWritePermission()` — non-editors get 403 "no write permission" (viewers never see the restriction error)
2. `isEffectiveOwner()` — returns `true` if the path is team-owned and the caller is a team member
3. If `sharingRestricted && !effectiveOwner` — 403 "Sharing is restricted by the owner"
4. The `sharingRestricted` parameter itself is only passed through to `Drive.updateACL()` when the caller is an
   effective owner; for all other callers it is silently dropped

The owner's own `Drive.updateACL()` is unaffected — it operates on the Home's synthetic user who always passes
ownership checks.

Chat `/invite` goes through `SharedDrive.inviteToChat()`, which applies the same `sharingRestricted` check before
delegating.

## ACL Route

`PUT /drive/:ownerId/:mountId/path/:pathId/acl` accepts an optional `sharingRestricted: boolean` in the body.
Defined in `apps/api/src/routes/drive.ts`.

## Propagation

`receiveACLChange()` in `drive.ts` mirrors `sharingRestricted` to `shared_paths` alongside all other `DrivePath`
fields, so recipients see the current restriction state in their shared-with-me view.

## Frontend

**Share dialog** (`packages/ui/src/components/layout/drive/drive-access-dialog.tsx`):

- `useIsEffectiveOwner()` determines if the caller is the owner or a team member
- When `sharingRestricted && !isEffectiveOwner`, the dialog renders the read-only `DriveAccessList` instead of
  `DriveAccessListEdit`

**Edit view** (`packages/ui/src/components/layout/drive/drive-access-list-edit.tsx`):

- Shows an "Editors can share" checkbox, visible only to effective owners
- Checked (default) = `sharingRestricted: false`; unchecked = `sharingRestricted: true`
- The `sharingRestricted` value is only included in the save payload when the caller is an effective owner

## Design Decisions

**No inheritance.** The flag is per-path, not inherited from parent folders. Creating a subfolder inside a restricted
folder does not restrict it. Matches Google Drive's behaviour.

**No self-removal exception.** When restricted, editors cannot modify the ACL at all — including removing themselves.
To "leave" a share, hide it client-side or ask the owner. A dedicated `DELETE .../acl/me` endpoint can be added later
if needed.

**Visibility blocked too.** The flag blocks both ACL and visibility changes. An editor cannot flip a restricted file to
`public-read`. Both go through the same `updateACL` route and the same check.

**Team members are co-owners.** Team members always go through `SharedDrive` (no team user logs in).
`isEffectiveOwner()` uses `parseOwnerId()` + `getMemberships()` to grant team members full ACL control on team paths,
including toggling the flag itself.

## File Reference

| File                                                                 | Role                                                                  |
|----------------------------------------------------------------------|-----------------------------------------------------------------------|
| `packages/lib/src/types/drive.ts`                                    | `sharingRestricted` on `DrivePath` type                               |
| `apps/api/src/lib/mount/schema.ts`                                   | Column on `paths` table                                               |
| `apps/api/src/lib/drive/sharedschema.ts`                             | Column on `shared_paths` table                                        |
| `apps/api/src/lib/drive/sharedDrive.ts`                              | Enforcement in `updateACL()` + `inviteToChat()`, `isEffectiveOwner()` |
| `apps/api/src/lib/drive/drive.ts`                                    | Storage in `updateACL()`, propagation in `receiveACLChange()`         |
| `apps/api/src/routes/drive.ts`                                       | Route body schema with optional `sharingRestricted`                   |
| `packages/ui/src/components/layout/drive/drive-access-dialog.tsx`    | Read-only fallback when restricted                                    |
| `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx` | "Editors can share" checkbox                                          |
| `apps/api/src/test/sharing-restricted.test.ts`                       | Integration tests                                                     |
