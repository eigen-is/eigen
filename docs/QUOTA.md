# Quotas

## TLDR

Two independent quota buckets per user: **mail + contacts** and **drive mount**. Effective quota =
`max(server default, ...team overrides)` -- teams can only elevate, never restrict. Enforcement happens at upload
time with a soft limit (no file-level locking).

## Quota Buckets

| Bucket          | What it covers                             | Server default |
|-----------------|--------------------------------------------|----------------|
| Mail + Contacts | Combined mail and contacts storage         | 100 MB         |
| Drive mount     | Per-mount storage (each mount independent) | 500 MB         |

These are separate because they have different growth patterns. An email-heavy user is not blocked from uploading
files, and vice versa.

## Resolution

`resolveUserQuotas()` computes a user's effective quotas by gathering candidates from the server default and all
team memberships, then taking the maximum.

```
effective = max(server default, ...team overrides where set)
```

Rules:

- Teams can elevate members' quotas, never restrict below server default
- `undefined` in `TeamSettings.memberOverrides` means "inherit" (no contribution to max)
- User in no teams gets the server default
- Team homes are always active in memory, so `getHome(teamOwnerId(teamId))` reads settings directly

`ResolvedQuotas` returns values in bytes:

```typescript
type ResolvedQuotas = {
    mailAndContactsMax: number;   // bytes
    mountMax: number;             // bytes
};
```

## Team Member Overrides

Teams configure member quota elevations in `TeamSettings.memberOverrides`:

```typescript
memberOverrides?: {
    mailAndContactsMaxMB?: number;   // undefined = inherit
    defaultMountMaxSizeMB?: number;  // undefined = inherit
};
```

These are independent from the team's own drive storage. A team's own mount quota comes from its per-mount
`MountSettings.maxSizeMB` (or server default if unset).

## Enforcement

Three enforcement functions, all in `enforcement.ts`. Each resolves quotas on the fly (stateless, no cache).

### `enforceFileUpload(ownerId, userId, mountId, fileSize)`

Two-stage check for single file uploads:

1. `fileSize > maxUploadSizeMB` -> 413 "File exceeds max upload size"
2. `currentUsage + fileSize > mountMax` -> 413 "Storage quota exceeded"

### `enforceBatchUpload(ownerId, userId, mountId, files)`

Checks each file against `maxBatchUploadSizeMB`, then checks total against mount quota.

### `enforceAvatarUpload(userId, fileSize)`

Checks file size against `maxUploadSizeMB`, then checks combined mail + contacts usage against
`mailAndContactsMax`.

All throw `ApiError(413, ...)` on violation. Called from `apps/api/src/routes/drive.ts` and
`apps/api/src/routes/contacts.ts`.

## Over-Quota Behavior

When an admin lowers a quota below current usage (or team membership changes):

- Existing data is never deleted
- New uploads are rejected with 413
- UI shows over-quota state
- User must delete files to get back under quota

Concurrent uploads may slightly exceed quota (soft limit). This is by design -- the overage is small and
self-correcting on the next upload attempt.

## Mount Settings

Mount configuration is shared between users and teams via `MountSettings`:

```typescript
type MountSettings = {
    storageType: 'local' | 'local-key' | 's3';
    maxSizeMB?: number;     // falls back to server default if unset
    enabled: boolean;
    name?: string;
};
```

- Users always have a `default` mount, stamped from server settings at first home init
- Teams start with no mounts; admins add them explicitly
- Mounts can be enabled/disabled but never deleted (data preservation)
- `storageType` is immutable after creation

Stamping happens at first `UserHome.init()`, not at signup. If an admin changes defaults between signup and first
login, the user gets the latest defaults.

## File Reference

| File                                         | Purpose                                                           |
|----------------------------------------------|-------------------------------------------------------------------|
| `apps/api/src/lib/config/quota.ts`           | `resolveUserQuotas()`, `ResolvedQuotas` type                      |
| `apps/api/src/lib/config/enforcement.ts`     | `enforceFileUpload`, `enforceBatchUpload`, `enforceAvatarUpload`  |
| `apps/api/src/lib/config/server-settings.ts` | Server defaults, `getMaxUploadSize()`, `getMaxBatchUploadSize()`  |
| `packages/lib/src/types/settings.ts`         | `ServerSettings`, `MountSettings`, `TeamSettings.memberOverrides` |
| `apps/api/src/routes/drive.ts`               | Calls enforcement on upload routes                                |
| `apps/api/src/routes/contacts.ts`            | Calls enforcement on avatar upload                                |
