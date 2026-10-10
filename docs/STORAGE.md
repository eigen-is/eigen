# Storage and Mounts

> **TLDR:** A Home is the per-owner object that holds an owner's databases and domain services (`apps/api/src/lib/home/`). Drive stores files through Mounts (`apps/api/src/lib/mount/`). A Mount is one storage root of an owner's Drive, with its own settings in the home's `settings.json`: a user has a default one, and a team has one per team drive. It is a `metadata.db` paths table over one storage backend, `local`, `local-key` or `s3` (`apps/api/src/lib/storage/`). Four things are not obvious from the code. On `local` a storage key is the name path, so every key-derived write holds the tree lock, one reader/writer lock over the mount's whole tree, and every rename takes it exclusively. Every storage read has a 30 s idle deadline, and a gone object answers 410 where an outage answers 503. Containers name users by email only, so they survive copy and restore anywhere. Folder sizes are a lazy cache, so a plain listing can write.

Drive is the file tree under every app. The Drive app shows it, WebDAV serves it to desktop clients ([WEBDAV.md](WEBDAV.md)), and every doc, sheet, deck, drawing, stickies board and chat lives in it as a container: a folder named like a file, such as `Notes.eigendoc`, that holds the document's databases and media ([ARCHITECTURE.md § Eigen file types](ARCHITECTURE.md#eigen-file-types)). A request reaches a file through four layers: the route, `SharedDrive`, which checks access when the caller is not the owner ([ACL.md](ACL.md)), `Drive`, which spans the owner's mounts, and the `Mount` ([ARCHITECTURE.md § Drive Architecture](ARCHITECTURE.md#drive-architecture)).

The idea underneath is that the mount's paths table is the tree and the backend holds only bytes. A row gives a file its name, its parent, its type and its sharing. The storage key is derived from the row: the name path on `local`, the id on the other two backends ([§ A mount is a paths table](#a-mount-is-a-paths-table-over-one-of-three-backends)).

## A Home is loaded on demand and dropped when idle

`getHome(ownerId)` (`apps/api/src/lib/home/get-home.ts`) builds the Home on first use and caches it. Each domain getter calls `touch()`, and a Home nobody touches for its idle window shuts down and closes its databases. A user home idles out after 5 minutes. A team home gets 30 (`TEAM_HOME_IDLE_MS` overrides it), because no event stream keeps it alive. `evictHome` shuts one down on purpose (user deletion, backup restore), `shutdownAllHomes` all of them at exit.

| Home | Folder | Services |
|---|---|---|
| `UserHome` | `data/home/{userId}/` | Drive, Mail, Contacts, Calendar, Notifications |
| `TeamHome` | `data/team/{teamId}/` | Drive, Calendar ([ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md)) |
| `OrgHome` | `data/org/{orgId}/` | Only its filesystem |
| `GuestHome` | `data/guest/{userId}/` | Drive, Notifications ([GUEST-ACCESS.md](GUEST-ACCESS.md)) |

A Home serves its own owner. Another owner's data goes through `home-relay.ts` ([SCALABILITY.md](SCALABILITY.md)).

## Every owner's data lives under one folder

```
data/home/{userId}/
├── settings.json
├── mounts/
│   ├── shared.db           paths others shared into this home (ACL.md)
│   └── {mountId}/          metadata.db, data/, thumbs/, tmp/, staging/ (s3 only)
├── eigen.mail/             mail.db, Maildir/
├── eigen.contacts/         contacts.db, avatars/
├── eigen.calendar/         calendar.db
└── eigen.notifications/    notifications.db
```

The names come from `PATHS` in `apps/api/src/lib/core/constants.ts`. Mail, Contacts and Calendar reach their folders through `home.fs`, a `LocalFilesystem` with the atomic and durable write family those domains need. Contacts and calendar events live as BLOBs in their databases, with columns projected from them ([CONTACTS.md](CONTACTS.md), [CALENDAR.md](CALENDAR.md)). `staging/` sits outside `tmp/` so the stale-temp sweep can never purge an upload the bucket has not acknowledged ([SYNC.md](SYNC.md)).

## Containers name users by email, never by id

A container (`.eigendoc`, `.eigenchat` and their siblings) is the portable unit. It is copied, moved and version-restored as a self-contained set of files. So its databases reference users by email only: chat authors, comment authors, assignees and mentions. Home-level databases (`metadata.db`, `contacts.db`, `calendar.db`, `notifications.db`) sit beside their owner and may hold user ids. Because containers carry no ids, a copy or a backup restore keeps every user reference intact on any server and in any id space.

## A mount is a paths table over one of three backends

Every Drive row lives in the mount's `paths` table (`apps/api/src/lib/mount/schema.ts`). The bytes live in a `StorageBackend` (`apps/api/src/lib/storage/types.ts`):

| Type | Where a file's bytes live |
|---|---|
| `local` | `data/` under the file's name path, so the tree on disk mirrors Drive |
| `local-key` | `data/{id}.{ext}`, flat |
| `s3` | `{prefix}/{id}.{ext}` in a bucket: a plain file is PUT in its request, a container database is written behind by the upload queue ([SYNC.md](SYNC.md)) |

An id key never moves, so on `local-key` and `s3` a rename, a move or a trash changes only the row. On `local` the same operations rename files and directories on disk. That difference drives the [tree lock](#on-local-a-key-is-a-name-path-so-renames-lock-the-whole-tree) and the `.trash/` directory ([SOFT-DELETE.md](SOFT-DELETE.md#only-local-moves-bytes-into-trash)).

`read()` returns a `StorageFile`, a lazy `BunFile` or `S3File` that holds no bytes yet. A local file goes into a `Response` as is, which keeps serving zero-copy. An `S3File` goes in as `file.stream()`, since it takes no `ResponseInit` options. Both local backends resolve every key through `resolveWithinBase` (`apps/api/src/lib/core/path-utils.ts`), and `S3Storage` validates key segments, so no key escapes its base.

## Writes to one row serialize on its path lock

A write to an existing row runs under `Mount.withPathLock(pathId)`: an overwrite, a rename or move, a trash or restore, a version snapshot on the container, the chat restore. A backup holds a file's path lock while it copies the file, because `LocalStorage.write` rewrites a local file in place, so a read beside an overwrite would end short ([BACKUP.md](BACKUP.md#a-home-archive-holds-every-database-file-and-auth-row)). A create takes no lock. The partial unique index on `(parentId, LOWER(name))` over untrashed rows closes the race between two creates of one name, and the loser gets a 409. On `local` both creates write the same name path before either row lands, so the surviving row can hold the loser's bytes ([ROADMAP.md](ROADMAP.md)).

## On `local` a key is a name path, so renames lock the whole tree

`LocalStorage.write` recreates any missing directory (`createPath: true`). So a save that resolved its key before a folder rename would rebuild the old folder and orphan the save. A `local` mount therefore has one reader/writer lock over its whole tree (`Mount.withTreeShared` / `withTreeExclusive`, `apps/api/src/utils/rw-lock.ts`). On `s3` and `local-key` both methods pass straight through.

- **Shared:** every write whose key comes from the paths table, from the key resolution through the storage call and the row write, so the row and the bytes agree. That covers file writes and creates, folder creates, a file delete and a managed database's sync.
- **Exclusive:** every storage rename of a file or a directory and every directory removal: rename and move, trash, restore and folder delete.

Waiters are served in arrival order. A rename queued behind a stream of saves runs after the saves in flight and before the saves that arrive after it. The lock order is path lock, then document-db slot, then tree lock. A tree-lock holder takes no further lock, because a shared region inside a shared region deadlocks once an exclusive is queued. Most reads take no lock, and one that races a move answers a transient 404, a document-db open a 503. A Drive copy and the download of a document or a version into a temp file read under the shared tree lock. A backup's copy of a file holds the shared tree lock and the file's path lock. `apps/api/src/test/storage/overwrite-ancestor-move.test.ts` pins the races.

## Every storage read has a 30 s idle deadline

Bun's `S3Client` takes no timeout and no signal, and gives up on a silent request only after about 360 s. Eigen's own bound is `STORAGE_TIMEOUT_MS` (30 s, `apps/api/src/lib/storage/deadline.ts`). `S3Storage` races `exists`, `size` and `delete` against it. A timed-out `exists` or `size` answers 503, a timed-out `delete` returns `false` like any failed delete.

Every storage read the server consumes itself runs through `streamStorageFile`, the storage form of the one stream loop `consumeStream`. A read that delivers no byte for 30 s is cancelled with a 503.

On a warm local file `consumeStream` never gives up the event loop, so a read that does not hold the file's path lock ends before an overwrite that arrives during it can start. That matters because a local write goes into the same file, not into a temp file renamed over it, so a reader of a live file and an overwrite must not interleave. The cost is that such a read holds the API for its length ([ROADMAP.md](ROADMAP.md)). Only the backup passes `yields`, which gives a turn every 2 MB: it holds the path lock of each drive file it copies, and nothing rewrites its own staged copies.

Most reads also pass the mount's `downloads` signal. `closeAllDatabases` and `Drive.destruct` abort it first, so no teardown waits on a stalled download or extraction read. Copy and version snapshots read without it, because a close-time snapshot runs after that abort.

A file served to a client (`/download`, `/embed`, WebDAV GET) is the exception. Its stream goes straight into the Response, so a stalled body there is bounded only by the server's 200 s `idleTimeout`. It holds no lock and no Home while it waits.

## An S3 read tries three times before it answers 503

Hetzner Object Storage sheds load with a 503 `SlowDown`, and the same request a second later succeeds. Bun's `S3Client` never retries a read (its `retry` covers only multipart parts), so one throttled HEAD failed a whole docx export. `retryStorageRead` (`apps/api/src/lib/storage/deadline.ts`) gives `exists`, `size`, `list` and every `streamStorageFile` GET three attempts, about 200 ms and then 800 ms apart, with jitter. It retries a throttle, a 5xx, a refused or closed connection, and Bun's `UnknownError`, which is all a HEAD reports for any status but 200 and 404, a 403 included. A missing key and a definite refusal (`NoSuchKey`, `AccessDenied` in a GET body) fail at once. Writes are not retried, because not every write path is idempotent.

All attempts share one deadline. For `exists`, `size` and `list` it is the 30 s of `withStorageDeadline`, whose signal stops a wait when it fires. A GET retries only while no byte has reached the caller, since a second GET would hand it the first bytes again. A GET that stalled into its idle deadline is not retried, and the mount's `downloads` signal stops its wait. The last failure keeps its 503. `apps/api/src/test/storage/s3-read-retry.test.ts` pins this.

## A gone object answers 410, an outage 503

Only the GET body tells a missing object from a sick bucket: `NoSuchKey` on S3, `ENOENT` on disk (`isMissingObjectCause`). `Mount.downloadKeyToTemp` answers that with 410 (`storageGone`) and every other failure with 503. A 410 tells the client to stop retrying, a 503 to retry ([COLLAB.md](COLLAB.md#each-close-code-tells-the-tab-what-to-do)).

A container database's open reads the freshest copy first: the crash temp, then the staged copy of an unacknowledged upload, then the stored object ([SYNC.md](SYNC.md)). So a 410 means no copy exists anywhere, and a version restore is the way back. On a `local-key` mount the open does not GET but stats `data.db`, and answers 410 only on `ENOENT`.

## Creating a container is all or nothing

`Drive.create` (`apps/api/src/lib/drive/drive.ts`) creates the container folder, then provisions it (`ChatRoom.create` or `CollabDocument.create`, plus the comment row a card chat seeds). When provisioning throws, `mount.deletePath` removes the row and the error propagates. That delete sends no SSE, because the row was never announced. On a remote mount it cancels the container's queued uploads, so a staged PUT cannot bring the object back. The name is free again, so an immediate retry with the same name starts clean. A rollback that itself fails is logged and the container stays: a row nobody has seen, which holds the name and fails every open. No scan finds it: the orphaned-container scan is open work in the "Data integrity + verified backups" row of [ROADMAP.md](ROADMAP.md).

The stem passes the mount's name rule (`validateName`, `apps/api/src/lib/mount/names.ts`) before the extension goes on, so an empty stem cannot become a nameless `.eigendoc`. Names are stored NFC. Every dedup (copy, upload, chat `dedupeName`, trash restore) compares in NFC, and `getUniqueFileName` trims the stem so the ` (n)` suffix still fits the 255-byte limit.

## A create that timed out may still have landed

Slow storage can make a create look failed when it is not: the request times out or answers 503 while the server keeps writing, and the row lands seconds later. So the two create hooks (`useCreateDriveItem` and `useCreateChatRoom`) post through `createWithReconcile` (`packages/lib/src/core/drive/reconcile-create.ts`) with a 15 s timeout.

Before posting, the hook lists the folder once and keeps the ids it sees. After an abort, a network error or a 5xx it polls that listing for the name it sent. A row matches when it has that name and an id the snapshot did not hold. That means created by this request or by a concurrent create of the same name, with no clock on either side. A same-name sibling that existed before is in the snapshot, so it never passes for ours. A match resolves the mutation as a success, and a miss throws `CreateUnconfirmedError`, whose message is the toast.

- A 4xx is never reconciled: it is the server's definitive no (409 duplicate name).
- A failed snapshot skips reconcile, since there is no honest anchor.
- The chat wizard can create without a parent. The route then resolves the lazily created `chats` folder, which no client endpoint names, so the hook polls the mount's chat listing instead.
- A chat create through `dedupeName` lets the server suffix the name (`Name (2)`), so no poll could find it. It passes no `expectedName` and runs no polls. An indeterminate failure still becomes `CreateUnconfirmedError`, so a chat that may well exist reads as slow storage rather than a raw timeout.

`packages/lib/src/test/core/drive/reconcile-create.test.ts` pins the contract.

## Folder sizes are a lazy cache, so a listing can write

A folder row caches its recursive size in `paths.size`, and `NULL` means stale. A mutation does not recompute. It NULLs the whole ancestor chain (`invalidateSizesFrom`, or `invalidateAncestorsOf` for a content write). The next read that hydrates the folder (`toDrivePath`) recomputes the subtree bottom-up in one transaction and writes the totals back, reusing every descendant total still cached.

So a GET can write, which matters for any read-replica idea. The first listing after a large move or delete pays the recompute, and every later read is a column read. A trashed item hangs under the mount root and is left out of the totals ([SOFT-DELETE.md](SOFT-DELETE.md)).

## Version snapshots live inside the container

A container that opts in (collab documents and chats, the `snapshot` key in their database config) keeps file-level snapshots of its `data.db` in `<container>/versions/<iso-ts>.db` (`apps/api/src/lib/versioning/`). `ManagedDatabase` takes one every 100 writes and on close, and each snapshot prunes by the retention policy. A database adopted from a crash temp ([SYNC.md](SYNC.md#a-crash-temp-is-adopted-and-re-synced)) owes its close a snapshot even with no new write, because the fresh connection counts no change for the recovered tail.

- A manual save and the pre-restore snapshot block on the container's path lock, because an explicit user action must never skip. They read the live db, or with none open the crash temp an unclean shutdown left, then the staged copy, then the stored object (`stageManagedDbCopy`).
- The timer and close path try-locks and skips when the lock is held (`trySnapshotContainerDataDb`). It runs inside a close that a lock holder may be waiting on, and a skip loses one history entry, never bytes.
- A restore first copies the chosen snapshot to a temp file, since the pre-restore snapshot prunes and could delete it. It then replays the snapshot into the live Y.Doc for a collab document ([COLLAB.md](COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction)) or overwrites the chat's `data.db` bytes under the same row (`replaceContainerDataDb`): one slot call closes the live db, removes its crash temp and writes the bytes, through the upload queue on `s3` and as a fresh file on `local-key`. No lock is held across the steps.

## Copy goes anywhere, a move stays in its mount

A copy within one owner and mount takes the fast path `Drive.copyPath` → `Mount.copyPath`. Any other copy takes the bridge `copyPathAcross` (`apps/api/src/lib/drive/copy-across.ts`), which downloads and re-uploads each file and recreates each container typed. A byte copy of a container is a valid independent document, because its internal children reference each other by name, not by path id. A copy flushes the live `data.db` first and leaves `versions/` behind, so the copy starts with a clean history. A copied file keeps the source's media facts and thumbnail. `originalName` and the WebDAV dead properties stay with the source.

The copy route (`POST /drive/:ownerId/:mountId/path/:pathId/copy`) dedups the destination name itself, not in `Drive.copyPath`, so WebDAV COPY keeps its overwrite and 409 behavior. `Drive.copyPath` refuses to copy a folder into its own subtree for both callers, since the copy would otherwise recurse forever. A move makes the same check inside `Mount.updatePath`, in one synchronous transaction with the row write, so two opposite moves cannot form a cycle between check and write. A cycle would spin every recursive walk over the tree.

The copy route and WebDAV COPY send nothing while a deep tree copies, so both lift the server's 200 s `idleTimeout` for their request (`server.timeout(request, 0)`). Otherwise the client would see an empty reply and retry into a duplicate tree.

A move never crosses mounts. It would change the row's owner, mount and id, and that breaks shares, links and history.

## See also

- [SOFT-DELETE.md](SOFT-DELETE.md): trash and restore
- [FILE-HISTORY.md](FILE-HISTORY.md): the event log and watches in `metadata.db`
- [SYNC.md](SYNC.md): the upload queue, staged copies and freshest-first reads on `s3`
- [DATABASE.md](DATABASE.md): schemas and migrations
- [ACL.md](ACL.md): permissions and `shared.db`
- [PREVIEWS.md](PREVIEWS.md): thumbnails and cached previews in `thumbs/` and `tmp/previews/`
- [QUOTA.md](QUOTA.md): what counts toward a mount's size
