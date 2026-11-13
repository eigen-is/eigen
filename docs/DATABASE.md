# Databases

> **TLDR:** Every Eigen database is SQLite through Drizzle, opened by `ManagedDatabase` (`apps/api/src/lib/core/managed-database.ts`), which owns versioned migrations, WAL mode, dirty tracking, the sync tick and the snapshot trigger. Each domain keeps its schema and migrations in its own `db-config.ts`. There are three kinds: server databases in `data/server/`, a Home's local databases, and container databases that live in Drive and sync through their mount. Not obvious from the code: an open refuses a schema newer than the binary, only contacts and calendar ask for `synchronous = FULL`, the `-wal` and `-shm` files are SQLite's to remove, and an instance lock keeps a second API off a data folder.

Eigen has no central database of user content. Each user and team has a Home, its own data folder ([STORAGE.md](STORAGE.md#every-owners-data-lives-under-one-folder)), with small databases of its own: one per mount for the Drive tree, plus one for each domain it serves, such as mail, contacts and calendar. Each collab document and chat carries its databases inside its container, the Drive folder that is the document ([COLLAB.md](COLLAB.md)), so they go along when the document is copied or backed up. No database mixes two owners' content, and that keeps a Home movable ([SCALABILITY.md](SCALABILITY.md)) and a document portable. Read this doc before you add a table, a migration or a database.

## Databases come in three kinds

| Kind | Files | Opened by | Leaves the disk |
|---|---|---|---|
| Server | `users3.db` (better-auth), `eigen.db` (the [share registry](ACL.md#share-registry)), `waitlist.db`, all in `data/server/` (`SERVER_DATABASES`, `apps/api/src/lib/config/paths.ts`) | Once per process, through `createAsyncSingleton` (`apps/api/src/utils/singleton.ts`) | Only in a backup ([BACKUP.md](BACKUP.md)) |
| Home | `mounts/shared.db`, each mount's `metadata.db`, and the mail, contacts, calendar and notification databases (`PATHS`, `apps/api/src/lib/config/paths.ts`) | `Home.getLocalDatabase(config, relativePath)`, once per path | Only in a backup |
| Container | A collab document's or chat's `data.db` and a collab document's `comments.db`, stored as Drive files keyed by their `pathId` | `Mount.withDatabase` for a reader, `holdDatabase` for an open collab document, one slot per `pathId` | Through the mount, queued on `s3` ([SYNC.md](SYNC.md)), and in a backup |

A container database lives in its container folder:

```
test.eigendoc/          (pathId: abc123)
├── data.db             (pathId: xyz789, stored via storage backend)
└── comments.db         (pathId: def456, comment index)
```

On a temp-copy backend (`s3`, `local`) the mount downloads the object to a temp file and the database works on that copy. On `local-key` it opens the stored file itself.

drizzle's bun-sqlite driver types `.run()` as void, so a write that must count the rows it matched uses `.returning().all()`.

`users3.db` is the one database `ManagedDatabase` does not open. better-auth owns the connection, there are no versioned migrations, and `ensureAuthSchemaColumns` (`apps/api/src/lib/auth/auth-schema-columns.ts`) adds any missing column at boot. It also makes the indexes on `member.user_id` and `team_member.user_id`, and setup calls it too, so a fresh install has them. A user's memberships are read on every collab frame and every keepalive: that read took 1,952 µs at 20,000 users with a full scan, and 58 µs with the index.

## A migration runs in its own transaction

`__schema_version` holds the version stamp. Each pending migration runs between `BEGIN` and `COMMIT` together with the stamp update, so a failing one rolls back and leaves the version where it was. Any failure inside `open()` closes the raw handle before it rethrows, so the same file reopens cleanly once repaired.

`PRAGMA foreign_keys` can't change inside that transaction and is on, so a table rebuild that runs `DROP TABLE` on a referenced table cascades: on `paths` it silently empties `file_events` and `path_watchers`. Add, copy and drop columns instead.

## An open refuses a schema newer than the binary

Before applying anything, `runMigrations` refuses a database whose stamp is higher than `config.currentVersion` with a 503. After a deploy migrated a database forward, an older server would otherwise open it and keep writing to a schema it doesn't understand. The domain answers 503 until the binary is rolled forward, and nothing on disk is touched meanwhile. The same guard sends a rollback to the backup: `./eigen rollback` first has the build before check that it opens today's data, a migrated database fails that check, and the rollback restores the Full backup `./eigen update` made first ([BACKUP.md](BACKUP.md#a-rollback-keeps-the-data-when-the-build-before-opens-it)). So a migration needs no mark in CHANGELOG.md.

A stamp that is not an integer is refused the same way (503 `unreadable schema stamp`). Only Eigen's migrations write it, and a non-number compares false against every migration, so the database would open with nothing migrated and fail on its first query instead.

A missing stamp row is recreated at 0 by `INSERT OR IGNORE`, and every migration runs again. The `CREATE ... IF NOT EXISTS` steps pass. The first step that can't run twice, such as an `ADD COLUMN` or a `DROP COLUMN`, fails inside its transaction, and the open fails. A database whose migrations can all run twice just opens: collab, the share registry and `waitlist.db`, each a single v1 of `IF NOT EXISTS` steps. `shared.db` is not one: its v3 rebuilds `shared_paths` from the old columns, which a second run doesn't find.

## The dirty watermark moves only after `onSync` returns

A database with an `onSync` callback (a container database) syncs every 30 s and on close. `sync()` skips a clean database. Dirty means `total_changes()` differs from the watermark, or `markDirty` forced it ([SYNC.md](SYNC.md#a-crash-temp-is-adopted-and-re-synced)). A dirty one runs `PRAGMA wal_checkpoint(PASSIVE)` before `onSync`, so the main file holds the committed frames, without waiting on another connection. `uploadFromTemp` on `local` uploads that file, and on `local-key` it is the stored object a byte copy reads. An `s3` sync and a tick's snapshot read a staged copy or `VACUUM INTO`, which need no checkpoint.

The sync's checkpoint is the only one such a database gets while open. `open` sets `PRAGMA wal_autocheckpoint = 0` when there is an `onSync`, because `onSync` may copy the main file off the JS thread while commits go on. A checkpoint SQLite ran by itself on one of those commits would rewrite pages under that copy. A database without an `onSync` keeps SQLite's own checkpoint.

The watermark is read before `onSync` runs and stored only after it returns. `onSync` copies the bytes first, so a write landing during its later awaits is not in the copy, and reading the watermark afterwards would count it as synced. A throwing `onSync` stores nothing, so the database stays dirty: the next tick retries, `flush()` passes the error on, and `close()` still tears down and hands `syncFailed` to `onClose`. That flag means the working copy holds bytes storage lacks.

A tick, a flush and a close run one at a time under one lock. So two syncs can't stage the same bytes and race their watermark, and a close can't tear the database down under a tick in flight. `onSync` and `onSnapshot` run under that lock, so they must not call `flush()`: it would wait for itself. A tick's snapshot needs no flush anyway, because the sync just before it has run. A flush waits for a tick's snapshot as a close does, so a caller may hold the database's slot or container lock while it waits, because that snapshot only tries the container lock and never takes the slot.

## The database triggers snapshots, the mount takes them

A config with a `snapshot` key opts into file versioning. `snapshotIfDue` calls `onSnapshot` once `writesPerSnapshot` writes have piled up, and once more at close for any change left. `onSnapshot` answers `'skipped'` when the container lock is held, and a skip stays due, so the next tick tries again. A close whose final sync failed takes no snapshot, because a snapshot on `local` copies storage, which lacks the tail. Where versions live and why the close path try-locks is in [STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container).

## SQLite removes its own WAL and shared-memory files

`close()` syncs, runs `PRAGMA wal_checkpoint(TRUNCATE)` and closes strictly. On `local-key` the file is the stored object a close-time snapshot copies, so the checkpoint makes that copy complete. Drizzle's statements are finalized as they run (`withAutoFinalize`), so the file is released before the next open of the same path. The last connection to close removes the `-wal` and `-shm` files, after an exclusive lock proves no connection in any process still has the file. `open` sets `SQLITE_FCNTL_PERSIST_WAL` to 0, because macOS's system SQLite otherwise keeps both files after the last close.

**Never unlink them by hand.** A connection in another process keeps writing into the unlinked WAL, and its writes are lost or corrupt the file.

The one exception is a file with no connection on it that is being thrown away or replaced: a temp, or a restore's old `data.db` on `local-key`. Its `-wal` and `-shm` go with it (`Mount.cleanupTemp`, `replaceContainerDataDb`), because SQLite replays a leftover `-wal` into whatever main file next appears at that path. A download or a staged-copy recovery runs it before writing the fresh main file, and a download refuses to write while a `-wal` it could not remove is still there.

## A database that holds the truth runs synchronous FULL

Every open sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`. A database whose rows are the truth, rather than an index of something else, also sets `synchronous: 'FULL'` in its config, and `open` runs `PRAGMA synchronous = FULL` right after the WAL pragma. It is set per connection, never stored in the file.

`CONTACTS_DB_CONFIG` and `CALENDAR_DB_CONFIG` ask for it. The vCard and VCALENDAR bytes live in their rows, so an acknowledged CardDAV or CalDAV PUT must survive a power loss, and both write at address-book volume. Every other database takes the SQLite build's default for WAL. That default differs. Bun's bundled SQLite on Linux, so production and CI, stays at FULL. macOS's system library is built with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` and drops to NORMAL on entering WAL. So the option buys nothing in production today and everything on a developer's laptop. A crash on an index database costs at most the last commits of something that can be rebuilt.

## A container database has one slot per `pathId`

Every open, create and close of one container database runs through `withDocumentDb` (`apps/api/src/lib/mount/document-db.ts`), one at a time and in call order. So a fresh instance never shares a closing one's temp or journal files. The slot holds the live instance only while it is open. A close clears it before closing, so a snapshot read mid-close never sees the closing instance. It is a promise chain rather than `withPathLock`, because `has` must also see queued opens and closes.

Once `closeAllDatabases` starts its sweep, after the downloads abort, the reindex drain and the wait for the mount's background jobs, a new open is refused with a 503. The lock order is in [STORAGE.md](STORAGE.md#on-local-a-key-is-a-name-path-so-renames-lock-the-whole-tree).

## A reader holds a container database only while it runs

A slot counts its holders. A reader, such as the content reindex, an export's `captureCollabSource`, a chat request or a comment route, runs its queries inside `withDatabase`, which opens the database, counts the reader in, and counts it out when the callback ends. A hold's `release` counts out once, so a second call does nothing. An open collab document is a holder for its whole life (`holdDatabase`), because its `DbProvider` writes every edit to `data.db`. It lets go in its own close, right before the registry closes the database. Without that hold, a reader of an open document would start the idle close under the provider.

When the last holder lets go, the database stays open for `IDLE_CLOSE_MS`, five minutes, and then closes, unless a new holder came in. It is five minutes whatever the Home's own idle, which is 30 minutes for a team. A close takes a version snapshot, and on `s3`, and on a `local` mount that works on a temp copy, an open is a download and a close an upload. So a chat that gets a message now and then must not pay that per message. The content reindex reads a changed container again two minutes later (`CONTENT_REINDEX_CAP_SECONDS`), and a shorter wait would close a busy document just before that read opens it again.

A database that `createDatabase` makes has no holder, so the create arms the same idle close. A new document that nobody opens closes its `data.db` and `comments.db` after the idle window, instead of keeping them open until the mount closes. A collab document's `comments.db` is opened early the same way as a reader's, and closes after the idle window too.

A close, such as a trash, a version restore's `replaceContainerDataDb` or `closeAllDatabases`, waits inside its slot call for the holders to let go. After `HOLDER_WAIT_MS` (5 s) it closes anyway and logs, so a holder that hangs can't hang a shutdown. A close that gave up waiting forgets those holders, and a late release counts only against the database it was given, so the next open of that slot starts its count again. Because that wait can run under the container path lock, a holder never takes the container path lock and never calls `withDatabase` again for the same path: either one waits on the close that waits on the holder. A `ChatRoom` therefore runs the queries of one step in one `withDatabase`, after its path-locked create of a missing `data.db`. `postMessage` runs one for the insert and the participant read, and a second for the thread's search text inside the comment index's hold. Those are `comments.db` and then `data.db`, two different databases, never nested on one. The open collab document is the one holder that may take the path lock, for the version before a workbook compaction, because what closes its database closes the document first. A trash marks its folder before it closes the documents in it, and each document before its databases, so no open document is left holding a database the trash closed ([SOFT-DELETE.md](SOFT-DELETE.md#trash-marks-the-item-first-then-closes-what-is-open-under-it)). `apps/api/src/test/storage/docdb-open-close-race.test.ts` and `apps/api/src/test/collab/collab-restore-race.test.ts` pin the waits.

## One API process owns a data folder

Two API processes on one data folder corrupt its databases, so the first one locks it. The lock is a POSIX file lock, so it only reaches processes on one kernel that see the folder through one file system: a Mac host API and a Docker Desktop container on one bind mount, or two WSL2 distros over 9p, both start and both write. Nothing guards that case, so give each its own data folder. `index.ts` imports `src/instance-lock.ts` first and only then loads `src/server.ts` with `await import`, whose modules open server databases as they load. The import is dynamic because a static one guarantees no order in the `buildfordocker` bundle: `--splitting` hoists `auth.ts` and its top-level `users3.db` open into a shared chunk that evaluates before the entry's own code.

`lockDataDir()` (`apps/api/src/lib/config/data-lock.ts`) opens `data/server/instance.lock` as a SQLite database, runs `PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE;` and keeps the connection for the life of the process. Something must read that connection: the bundle drops a binding nothing reads, and the garbage collector then closes the connection and the lock with it. So `releaseInstanceLock` closes it, which keeps it referenced (a test bundles the module as `buildfordocker` does and runs the collector). `IMMEDIATE`, not `EXCLUSIVE`: two processes starting together both read the empty file first, and `BEGIN EXCLUSIVE` then fails them both, while `BEGIN IMMEDIATE` lets exactly one through. A second API gets `SQLITE_BUSY` and exits with code 1, naming the data folder.

The lock is a POSIX file lock, so the OS drops it however the holder ends, SIGKILL included, and a `bun --watch` reload takes it again. The open transaction keeps a 512-byte `instance.lock-journal` with no pages beside it, which a SIGKILL leaves behind. The next holder rolls it back as a no-op, so it is harmless.

The swap of `./eigen restore` takes the same lock (`lockData` in `apps/api/src/cli/restore-swap.ts`) and refuses while an API holds it, so it only runs with Eigen stopped. `./eigen backup` runs inside the API and needs none ([BACKUP.md](BACKUP.md#the-whole-server-backup-runs-inside-the-api)). Seeding and migration scripts don't take it. Tests that boot `app` in-process never take it, while `test/backup/process-lifecycle.test.ts` spawns `src/index.ts`, so each child takes it on its own data root.

## See also

- [SYNC.md](SYNC.md): how a container database reaches an `s3` bucket
- [STORAGE.md](STORAGE.md): mounts, the `metadata.db` paths table and version snapshots
- [CONTACTS.md](CONTACTS.md), [CALENDAR.md](CALENDAR.md): the two databases whose rows are the truth
- [CHAT.md](CHAT.md), [COMMENTS.md](COMMENTS.md), [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [FILE-HISTORY.md](FILE-HISTORY.md), [SEARCH.md](SEARCH.md): the domain schemas
