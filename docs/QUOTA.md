# Quotas

> **TLDR**: Two independent quota buckets per user: **home data** (mail + contacts + calendar) and **drive mount**.
> Effective quota = `max(server default, ...team overrides)` — teams can only elevate, never restrict. Enforcement
> happens at upload time with a soft limit (no file-level locking). Exhausting a quota throws **507 Insufficient
> Storage**; 413 is only the per-file size cap.

## Quota Buckets

| Bucket      | What it covers                              | Server default |
|-------------|---------------------------------------------|----------------|
| Home data   | Combined mail, contacts and calendar storage | 100 MB         |
| Drive mount | Per-mount storage (each mount independent)  | 500 MB         |

These are separate because they have different growth patterns. An email-heavy user is not blocked from uploading
files, and vice versa.

The calendar half is the bytes on disk under `eigen.calendar/calendars/`, which `Calendar.size()` answers from the in-memory `eventsBytes` counter a reconcile seeds and every write, delete and calendar delete adjusts. Every code symbol says `homeData`, `HomeSizeResponse.homeData` included; only the persisted setting is still spelled `mailAndContactsMaxMB`, because an admin's configured quotas are not rebuildable.

## Resolution

`resolveUserQuotas(mountConfig, teamIds)` computes a user's effective quotas by gathering candidates from the
server default, the mount's own config, and all team memberships, then taking the maximum. Its data half,
`resolveHomeDataMax(teamIds)`, resolves on its own too: a team Home has no `default` mount, and its calendar is
metered against the server default (a team is in no teams, so no override elevates it).

```
homeDataMax = max(server default, ...team overrides where set)
mountMax    = max(mountConfig.maxSizeMB ?? server default, ...team overrides where set)
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
    homeDataMax: number;   // bytes
    mountMax: number;      // bytes
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

The attachment ceiling: `min(maxUploadSize, 25 MB)` intersected with what is left of the home data quota.
Throws 507 when that bucket is already full.

The mail half of that bucket is the index sum plus the staging directory: `SUM(emails.size)` over the message index and the bytes of the draft attachments staged in `draft-attachments/` (`readDraftStagingSize` in `maildir-store.ts`, a walk of that one small directory). So a staged attachment is charged from the moment it lands until the draft save or the 24 h sweep removes it, and staging is refused once the bucket is full. Bytes no sync ever indexed and outside staging do not count — the welcome mail, appended with `skipReconcile`, Dovecot's own per-folder index files, and the `draft-meta/` sidecars. `MaildirStore.size()` answers both parts from in-memory byte counters, the way `Contacts.size()` does: they are seeded at `init` (one `SUM` query, one staging walk) and adjusted wherever the index gains or loses a row — the sync's own insert and delete phases included, so a Dovecot expunge lands in them too — and by a re-walk of the staging directory whenever its contents change. Nothing is memoized, so every write is charged to the very next check in both directions, and a metered CardDAV sync costs no query per card. A staged attachment is the one write charged only once it lands: the ceiling is read before its bytes stream in, so uploads in flight at the same moment each see the same room and can jointly overshoot the bucket by what they carry. The admin Users page sizes homes nobody has loaded, so it reads the same two parts from the home's own files through `pullHomeSize` (`readMailTotalSize` in `maildir-store.ts`, the one reader mail exports, over the index sum and the same `readDraftStagingSize`), and both surfaces report the same number.

### `enforceAvatarUpload(userId, fileSize)`

Runs `enforceMaxUploadSize` (413 on an oversized file), then checks the combined home data usage against
`homeDataMax` (507).

### `getMountQuotaState(ownerId, userId, mountId)`

Read-only `{ used, max }`. Used for reporting rather than blocking.

**Callers.** Drive uploads and copy go through `routes/drive.ts`; contact avatars through `routes/contacts.ts`;
team avatars call the bare `enforceMaxUploadSize` in `routes/team.ts` (a team logo must not consume a member's
personal data quota). WebDAV `PUT` calls `enforceMountQuota` in `lib/webdav/resource.ts`, and WebDAV `PROPFIND`
reports quota-used / quota-available from `getMountQuotaState` in `lib/webdav/propfind.ts`. Editor saves call
`enforceMountQuota` in `routes/editor.ts`, crediting the size of the file being replaced. Mail draft
attachments and mail-to-drive saves use `getMailUploadMaxSize` / `getUploadMaxSize` in `lib/mail/mail.ts`.

Contact-card writes, `.eml` imports and calendar resource writes share one gate on the data half of the budget, `enforceHomeDataQuota(ownerId, addBytes, creditBytes)`: `enforceCardBudget` (`lib/contacts/contacts.ts`), `Mail.messageImport` (`lib/mail/mail-domain.ts`) and `writeResource` (`lib/calendar/calendar-store.ts`) all run it before writing, 507 on a projection over budget. `creditBytes` is the size of the stored resource the write replaces, 0 for a create. One rule covers every edit at a full budget, and it bounds the total. A rewrite (`creditBytes > 0`) that does not grow what it replaces (`addBytes <= creditBytes`) is never refused, however far `used` sits above `max`: shrinking and cleaning up must work at any usage. A rewrite that grows it by at most `HOME_DATA_EDIT_GRACE_BYTES` (1 KiB) passes while the Home stays within `HOME_DATA_EDIT_HEADROOM_BYTES` (1 MiB) above its budget — `used + addBytes - creditBytes <= max + HOME_DATA_EDIT_HEADROOM_BYTES` — so a title fix, an RSVP, an exclusion, a cancelled override or a truncated RRULE lands on REST and CalDAV alike at a full budget, and the overshoot every such edit adds up to is at most the headroom. Past the headroom those edits answer 507 too, so an admin who lowers the budget freezes a Home's growth, while its owner still shrinks rewrites and deletes whole events and calendars (a delete is metered by nothing). A create and a rewrite that grows by more than the grace are metered on the projection as before.

The calendar's one write seam is `writeResource`, where `EVENT_MAX_BYTES` is bounded: inside the write gate, before any intent is recorded or byte written, crediting the stored resource's size so every rewrite goes through the edit grace above. Every ingress inherits it — a REST create, update or override raises the 507; a CalDAV PUT and an import take it as the typed `quota` result of `PutResourceResult`, which `davPutResponse` turns into a 507 and `importEvents` into a 507 naming how many events it managed. A move between calendars is a rename, so it adds no bytes and a full budget never refuses it; a whole event and a whole calendar are deletes of files, metered by nothing. An inbound write (an iMIP `REQUEST`, `CANCEL` or `REPLY`, the relayed `calendar:invitation*` and `calendar:rsvp` messages) has nobody to answer a 507 to: it is dropped and logged, the remaining VEVENTs of the message still file, and the mail it rode in on still lands. Metering is `meteredIngest = atHome(...)`, set at the end of `Calendar.init` the way contacts sets its own: a home nobody registered — a test harness, a seeding script — stays unmetered, because its quota lookup goes through `getHome` and would boot a second Home over the same files. Contacts needs the END of its init, where the calendar does not: seeding the owner contact writes through the metered seam, and the lookup would there await the very init doing the write. The calendar's init writes only through `writeResourceFile` (the copy rule reminting a duplicated resource's event ids), which no ceiling meters. `EVENT_MAX_BYTES` bounds every resource either way.

The admin Users page sizes homes nobody has loaded, so `pullHomeSize` reads the calendar half from the folder too (`readCalendarTotalSize` in `lib/calendar/resource-store.ts`): the `.ics` files of every directory under `eigen.calendar/calendars/`, skipping the `.`-prefixed staging a crashed calendar delete leaves behind, which is what the counter drops the moment that rename lands. The contacts half reads the same way (`readContactsTotalSize` in `lib/contacts/card-store.ts`: the `.vcf` files plus the derived `avatars/` cache). Both scan the directory through the very function the booted counter is seeded from, and over the same set: every directory whose name is a valid calendar id, which is what the counter holds a row for — a reconcile recovers a row for each one it finds. A file neither reader indexes (a note dropped into a calendar or into `cards/`) and a directory no calendar row can own are counted by neither, so the two surfaces report the same number.

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
