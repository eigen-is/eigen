# Quotas

> **TLDR**: Two independent quota buckets per user: **mail + contacts** and **drive mount**. Effective quota =
> `max(server default, ...team overrides)` — teams can only elevate, never restrict. Enforcement happens at
> upload time with a soft limit (no file-level locking). Exhausting a quota throws **507 Insufficient Storage**;
> 413 is only the per-file size cap.

## Quota Buckets

| Bucket          | What it covers                             | Server default |
|-----------------|--------------------------------------------|----------------|
| Mail + Contacts | Combined mail and contacts storage         | 100 MB         |
| Drive mount     | Per-mount storage (each mount independent) | 500 MB         |

These are separate because they have different growth patterns. An email-heavy user is not blocked from uploading
files, and vice versa.

## Resolution

`resolveUserQuotas(mountConfig, teamIds)` computes a user's effective quotas by gathering candidates from the
server default, the mount's own config, and all team memberships, then taking the maximum.

```
mailAndContactsMax = max(server default, ...team overrides where set)
mountMax           = max(mountConfig.maxSizeMB ?? server default, ...team overrides where set)
```

Rules:

- Teams can elevate members' quotas, never restrict below server default
- `undefined` in `TeamSettings.memberOverrides` means "inherit" (no contribution to max)
- User in no teams gets the server default
- A mount's own `maxSizeMB` (from `MountConfig`) takes precedence over the server default when set
- Team overrides are read through `pullTeamQuotaOverrides` (`lib/home/home-relay.ts`), which calls
  `getTeamHome()`. That opens the team home if it is not cached — a `TeamHome` idles out after 30 minutes
  like any other home, so it is not guaranteed to be in memory

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

Everything lives in `apps/api/src/lib/config/enforcement.ts`. Each function resolves quotas on the fly
(stateless, no cache).

**Two different status codes, and they mean different things:**

- **507 `Insufficient Storage`** — the quota bucket is full. Thrown by every quota check.
- **413 `File exceeds max upload size`** — the single file is bigger than the server's per-file cap
  (`maxUploadSizeMB`, default 35 MB). Only `enforceMaxUploadSize` (and `enforceAvatarUpload`, which calls it)
  throws this.

### `getUploadMaxSize(ownerId, userId, mountId)`

Returns the maximum allowed upload size in bytes for a single streaming upload:
`min(maxUploadSize, remainingQuota)` where `remainingQuota = mountMax - currentUsage`. Throws 507 up front if
the mount is already at or over quota, so a full mount is rejected without reading the request body. The drive
route passes this max to the streaming upload handler, which enforces it mid-transfer.

### `enforceMountQuota(ownerId, userId, mountId, addBytes, creditExisting)`

Up-front projected-write check for callers that know the byte count before writing. Throws 507 when
`used + addBytes - creditExisting > max`. `creditExisting` is the size of the file being overwritten, so
saving a document does not double-count its current bytes.

### `getMailUploadMaxSize(userId)`

The attachment ceiling: `min(maxUploadSize, 25 MB)` intersected with what is left of the mail + contacts
quota. Throws 507 when that bucket is already full.

### `enforceAvatarUpload(userId, fileSize)`

Runs `enforceMaxUploadSize` (413 on an oversized file), then checks combined mail + contacts usage against
`mailAndContactsMax` (507).

### `getMountQuotaState(ownerId, userId, mountId)`

Read-only `{ used, max }`. Used for reporting rather than blocking.

**Callers.** Drive uploads and copy go through `routes/drive.ts`; contact avatars through `routes/contacts.ts`;
team avatars call the bare `enforceMaxUploadSize` in `routes/team.ts` (a team logo must not consume a member's
personal mail quota). WebDAV `PUT` calls `enforceMountQuota` in `lib/webdav/resource.ts`, and WebDAV `PROPFIND`
reports quota-used / quota-available from `getMountQuotaState` in `lib/webdav/propfind.ts`. Editor saves call
`enforceMountQuota` in `routes/editor.ts`, crediting the size of the file being replaced. Mail draft
attachments and mail-to-drive saves use `getMailUploadMaxSize` / `getUploadMaxSize` in `lib/mail/mail.ts`.

## Over-Quota Behavior

When an admin lowers a quota below current usage (or team membership changes):

- Existing data is never deleted
- New uploads are rejected with 507
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
    s3Config?: S3Config;
};
```

- Users always have a `default` mount, stamped from server settings at first home init
- Teams start with no mounts; admins add them explicitly
- Mounts can be enabled/disabled but never deleted (data preservation)
- `storageType` is immutable after creation

Stamping happens at first `UserHome.init()`, not at signup. If an admin changes defaults between signup and first
login, the user gets the latest defaults.

Server settings use a different storage-type vocabulary: `ServerStorageType` is
`'local-id' | 'local-fullnames' | 's3'`, translated to the `MountSettings` values above by `mapStorageType`
(`packages/lib/src/types/settings.ts`).

Quota resolution itself lives in `apps/api/src/lib/config/quota.ts`, server defaults in
`server-settings.ts`, and the shared types (`ServerSettings`, `MountSettings`,
`TeamSettings.memberOverrides`) in `packages/lib/src/types/settings.ts`.
