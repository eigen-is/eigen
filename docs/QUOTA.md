# Quotas

> **TLDR:** Every user has two kinds of budget: one for their home data, and one per Drive mount. `apps/api/src/lib/config/quota.ts` resolves the limits and `enforcement.ts` holds every check, without cache or reservation. Not obvious from the code: a team override only raises a limit, and only the owner's teams count, never those of the user writing. A user's default mount cap is stamped the first time their home opens, usually at first sign-in, so changing the server default after that moves no existing user. A full home-data budget still lets its owner shrink, delete and make small edits. A 507 means a full budget, but a streamed upload that outgrows what is left is cut with a 413.

Quotas keep one user from filling the server's disk or bucket. The owner sets the server defaults and the per-file cap in the Admin app ([SERVER-SETTINGS.md](SERVER-SETTINGS.md)), an org admin can raise them for a team's members on the team's page, and the app sidebars show each user their usage.

The two budgets follow what a Home holds. A Home is the data folder of one user or team ([STORAGE.md § A Home is loaded on demand](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)). Its mail, contacts and calendar databases share the home-data budget, and each Drive mount, one drive with its own storage backend, has a budget of its own ([STORAGE.md § A mount is a paths table](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)). The checks in `enforcement.ts` sit on the writes a person starts: an upload, copy or save into a mount, a contact card or photo, a calendar resource, an imported message and an attachment staged for a draft, from the web apps, WebDAV, CalDAV and CardDAV alike. Mail that arrives, drafts, sent copies, messages an IMAP client appends, and edits to a collab document or a chat room are counted but never refused. The one idea is that a limit is soft: it refuses growth and never deletes, and writes at the same moment may overshoot it a little ([§ Over quota](#over-quota-keeps-the-data-and-refuses-growth)).

## Two budgets, because they grow differently

| Budget | What it covers | Server setting |
|---|---|---|
| Home data | Mail, contacts and calendar of one Home, together | `quotas.mailAndContactsMaxMB` |
| Drive mount | One mount; each mount has its own | `quotas.defaultMountMaxSizeMB` |

An email-heavy user is not blocked from uploading files, and a file-heavy user can still receive mail. Every code symbol says `homeData`, `HomeSizeResponse.homeData` included. Only the persisted settings, the server's and a team's override, keep the name `mailAndContactsMaxMB`, because stored quotas cannot be rebuilt after a rename. The settings themselves are in [SERVER-SETTINGS.md](SERVER-SETTINGS.md).

## Teams can only raise a limit

```
homeDataMax = max(server default, ...team overrides that are set)
mountMax    = max(mount's maxSizeMB ?? server default, ...team overrides that are set)
```

A team sets `TeamSettings.memberOverrides` (`packages/lib/src/types/settings.ts`), and an unset field means inherit, so it adds no candidate. A user in no team gets the server default. `resolveUserQuotas` returns both limits in bytes. Its data half, `resolveHomeDataMax`, also stands alone, because a team Home has no `default` mount yet meters its calendar. A team is in no teams, so its calendar meters against the server default.

Nothing is cached, so every upload resolves again. The overrides come through `pullTeamQuotaOverrides` (`apps/api/src/lib/home/home-relay.ts`), one relay read per team, which opens a team Home that is not in memory. That Home then stays loaded for a team home's longer idle window ([STORAGE.md § A Home is loaded on demand and dropped when idle](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)).

## A mount's cap takes its owner's overrides

`getMountQuotaState(ownerId, userId, mountId)` reads the mount and the team overrides from the owner, as `getHomeDataQuotaState` does for home data. So a mount has one cap, whoever uploads into it and whoever reads WebDAV's quota properties. A user writing into a folder another user shared with them meets the owner's cap, lifted by the owner's teams and never by their own. A team is in no teams, so a team mount's cap is its own `maxSizeMB`, and a member's override never lifts it.

## A mount keeps what it was stamped with

A user's `default` mount is written into their settings at the first `UserHome.init()`, the first time the home opens, with the server's current storage type and `maxSizeMB` set to `defaultMountMaxSizeMB`. That is usually the first sign-in, and at signup only when shares are waiting for the new user (`reconcileSharesForNewUser` opens the home to deliver them). So a change to the defaults before the home first opens reaches that user. A change after it does not: the stamped `maxSizeMB` wins over the server default in the `mountMax` formula ([Teams can only raise a limit](#teams-can-only-raise-a-limit)), and no route edits a user's mount. A team mount is stamped when an admin adds it, and its `maxSizeMB` stays editable per mount (`TeamHome.updateMount`, which pushes the change onto the live mount).

A mount's `storageType` never changes after it is made, since its bytes live in that backend: `updateMount` does not accept it. A mount is enabled or disabled, never deleted, so its data is kept.

## 507 is a full budget, 413 a file too large

`enforcement.ts` answers 507 `Insufficient Storage` when a budget is full or a projected write would overfill it. It answers 413 when one file is larger than it may be. The per-file cap is `quotas.maxUploadSizeMB` (`enforceMaxUploadSize`). The settings route takes it up to `UPLOAD_CAP_MAX_MB` (1023, `packages/lib/src/constants/backup.ts`): the API's `maxRequestBodySize` is 1 GiB for every route, and a multipart body's framing puts a 1 GiB file just over it. `getMaxUploadSize` caps a value saved above it too.

The two meet in `getUploadMaxSize`, which returns `min(per-file cap, what is left of the mount)` and throws 507 up front when nothing is left, so a full mount is refused before any bytes move. A streamed Drive upload hands that number to `streamFilesToTemp` (`apps/api/src/lib/drive/streaming.ts`) as the ceiling per file, and a file that runs past it mid-transfer is a 413, whichever of the two was smaller.

Every other route that brings a whole file into a mount takes the same number and answers 413 above it: a Drive copy and a conversion check the source's size, an import into a document bounds the body it reads (`apps/api/src/routes/drive.ts`), and saving mail attachments to Drive checks each attachment (`apps/api/src/lib/mail/mail.ts`). WebDAV `PUT` checks the per-file cap and the quota against a `Content-Length` before any bytes move, and counts a chunked body as it streams, stopping at the same bounds ([WEBDAV.md](WEBDAV.md#put-stages-the-body-before-the-row)).

## A write that knows its size is checked on the projection

`enforceMountQuota(ownerId, userId, mountId, addBytes, creditExisting)` throws 507 when `used + addBytes - creditExisting > max`. `creditExisting` is the size of the file being overwritten, so saving a document is charged only its growth. The editor save and WebDAV `PUT` use it. WebDAV only checks when the client sends `Content-Length` ([WEBDAV.md](WEBDAV.md)). `getMountQuotaState` reports `{ used, max }` without refusing, for WebDAV's quota properties.

A team avatar calls the bare `enforceMaxUploadSize` (`apps/api/src/routes/team.ts`), because a team logo must not consume the uploading admin's own home-data budget.

## Home data has one gate with an edit grace

A contact card, an imported `.eml` and a calendar resource are all written through `enforceHomeDataQuota(ownerId, addBytes, creditBytes)`: `Contacts.writeCard`, `Mail.messageImport` and `Calendar.writeResource`. `creditBytes` is the size of the stored resource the write replaces, and 0 for a create.

- A rewrite that does not grow (`addBytes <= creditBytes`) is never refused, however far over the budget the Home is. Shrinking and cleaning up must always work.
- A rewrite that grows by at most `HOME_DATA_EDIT_GRACE_BYTES` (1 KiB) passes while the Home stays within `HOME_DATA_EDIT_HEADROOM_BYTES` (1 MiB) over its budget. A title fix, an RSVP or a cancelled occurrence lands at a full budget, on REST and CalDAV alike, and all such edits together overshoot by at most the headroom.
- Past the headroom those edits answer 507 too. Lowering a budget, the owner's server default or an admin's team override, therefore freezes a Home's growth, while its owner can still shrink and delete.
- A create, and a rewrite that grows by more than the grace, are checked on the plain projection.
- A delete is metered by nothing. Neither is a move between calendars, which re-points one row.

Each ingress turns the 507 into its own answer: a CalDAV `PUT` gets the typed `quota` result (`dav-store.ts`), and an `.ics` import stops with a 507 that names how many events went in (`calendar/transfer.ts`). An inbound invitation has nobody to answer, so it is dropped while its mail still lands ([CALENDAR.md](CALENDAR.md)).

A Home that `atHome()` does not know, such as a test harness or a seeding script, is not metered, because the quota lookup goes through `getHome` and would boot a second Home over the same files. Contacts turns metering on only at the end of its init ([CONTACTS.md](CONTACTS.md)).

Mail attachments and contact avatars take their own checks. `getMailUploadMaxSize` returns `min(per-file cap, 25 MB, what is left of home data)` and throws 507 when nothing is left. `enforceAvatarUpload` runs the per-file cap and then `used + fileSize > max`, with no credit and no grace ([ROADMAP.md](ROADMAP.md)). A label rename is unmetered by decision: it rewrites every member card's `CATEGORIES` with no ceiling in front, but a typed name is capped at `LABEL_NAME_MAX_LENGTH` (100 characters), so each card grows by at most one such name, and the delta settles into `cardsBytes` after the commit (`settleFanOut`, `contacts/labels.ts`).

## What the home-data budget counts

Each domain answers `size()` from in-memory byte counters, seeded at init and moved wherever a row is gained or lost. Nothing is memoized on top, so every write is charged to the very next check, both ways, and a device sync costs no query per resource.

- **Contacts**: the stored vCards plus the `avatars/` folder ([CONTACTS.md](CONTACTS.md)).
- **Calendar**: the stored bytes of every resource, `SUM(length(ics))` over `calendar.db` ([CALENDAR.md](CALENDAR.md)).
- **Mail**: `SUM(emails.size)` over the message index, plus the draft attachments staged in `draft-attachments/` (`MaildirStore.size()`). The sync's own insert and delete phases move the index counter, so a Dovecot expunge counts too. Dovecot's index files and the `draft-meta/` sidecars are not counted. The welcome mail is: `skipReconcile` only delays its indexing to the first pass over the inbox.

A staged attachment is charged from the moment it lands until the draft saves or the 24-hour sweep removes it, and staging is refused once the budget is full. It is the one write charged only after it lands: the ceiling is read before its bytes stream in, so uploads running at the same moment each see the same room and can overshoot together by what they carry.

## A cold read reports what a live Home reports

The admin Users page sizes homes nobody has loaded, through `pullHomeSize` ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#the-users-page-sizes-homes-without-booting-them)). It reads each part from the home's own files with the query its counter is seeded from, so the page and a live Home report the same number.

- Mail: `readMailTotalSize` (`maildir-store.ts`), the index sum plus the same `readDraftStagingSize` walk. On a server with mail turned off a live Home opens no mail store, so `Mail.init` takes this same read once and `Mail.size()` answers it: the mail kept from before still counts toward storage.
- Contacts and calendar: `readContactsTotalSize` (`card-store.ts`, plus the `avatars/` folder) and `readCalendarTotalSize` (`resource-store.ts`), both through `readBlobTableSize` (`apps/api/src/lib/core/blob-store.ts`).

`readBlobTableSize` sizes a missing database as 0. It also sizes as 0 a database whose schema stamp is not this build's `currentVersion`, a newer stamp and a missing stamp table included. The column it would sum may not exist yet or may mean other bytes, and the pending migration drops those bytes anyway. So a home not opened since an upgrade reports no cards and no events rather than dropping the user off the page.

## Over quota keeps the data and refuses growth

When the owner lowers a server quota or an admin a team override below what a user has, or the user leaves the team that raised it, nothing is deleted. New writes answer 507 until the user deletes enough. The usage bar (`packages/ui/src/components/home/usage.tsx`) clamps at full and turns red above 85%.

The limits are soft. Every check reads usage and writes after, with no reservation, so concurrent uploads and several files in one request can each pass and together overshoot. That is by design: the overage is small, and the next write sees it.

## See also

- [SERVER-SETTINGS.md](SERVER-SETTINGS.md): the quota settings and the admin usage view
- [STORAGE.md](STORAGE.md): mounts and what their size counts; [SOFT-DELETE.md](SOFT-DELETE.md): trashed bytes count until purged
- [CONTACTS.md](CONTACTS.md), [CALENDAR.md](CALENDAR.md), [WEBDAV.md](WEBDAV.md): the metered write paths
- The help center: [Storage quotas](../apps/index/src/data/support/admin/storage-quotas.md)
