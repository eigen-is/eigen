# Databases

> **TLDR:** Every Eigen database is SQLite through Drizzle, opened by `ManagedDatabase` (`apps/api/src/lib/core/managed-database.ts`), which owns versioned migrations, WAL mode, dirty tracking, the sync tick and the snapshot trigger. Each domain keeps its schema and migrations in its own `db-config.ts`. There are three kinds: server databases in `data/server/`, a Home's local databases, and container databases that live in Drive and sync through their mount. Not obvious from the code: an open refuses a schema newer than the binary, only contacts and calendar ask for `synchronous = FULL`, the `-wal` and `-shm` files are SQLite's to remove, and an instance lock keeps a second API off a data folder.

Eigen has no central database of user content. Each user and team has a Home, its own data folder ([STORAGE.md](STORAGE.md#every-owners-data-lives-under-one-folder)), with small databases of its own: one per mount for the Drive tree, plus one for each domain it serves, such as mail, contacts and calendar. Each collab document and chat carries its databases inside its container, the Drive folder that is the document ([COLLAB.md](COLLAB.md)), so they go along when the document is copied or backed up. No database mixes two owners' content, and that keeps a Home movable ([SCALABILITY.md](SCALABILITY.md)) and a document portable. Read this doc before you add a table, a migration or a database.

## Databases come in three kinds

| Kind | Files | Opened by | Leaves the disk |
|---|---|---|---|
| Server | `users3.db` (better-auth), `eigen.db` (the [share registry](ACL.md#share-registry)), `waitlist.db`, all in `data/server/` (`SERVER_DATABASES`, `apps/api/src/lib/config/paths.ts`) | Once per process, through `createAsyncSingleton` (`apps/api/src/utils/singleton.ts`) | Only in a backup ([BACKUP.md](BACKUP.md)) |
| Home | `mounts/shared.db`, each mount's `metadata.db`, and the mail, contacts, calendar and notification databases (`PATHS`, `apps/api/src/lib/config/paths.ts`) | `Home.getLocalDatabase(config, relativePath)`, once per path | Only in a backup |
| Container | A collab document's or chat's `data.db` and a collab document's `comments.db`, stored as Drive files keyed by their `pathId` | `Mount.openDatabase`, one slot per `pathId` | Through the mount, queued on `s3` ([SYNC.md](SYNC.md)), and in a backup |

A container database lives in its container folder:

```
test.eigendoc/          (pathId: abc123)
├── data.db             (pathId: xyz789, stored via storage backend)
└── comments.db         (pathId: def456, comment index)
```

On a temp-copy backend (`s3`, `local`) the mount downloads the object to a temp file and the database works on that copy. On `local-key` it opens the stored file itself.

drizzle's bun-sqlite driver types `.run()` as void, so a write that must count the rows it matched uses `.returning().all()`.

`users3.db` is the one database `ManagedDatabase` does not open. better-auth owns the connection, there are no versioned migrations, and `ensureAuthSchemaColumns` (`apps/api/src/lib/auth/auth-schema-columns.ts`) adds any missing column at boot.

## A migration runs in its own transaction

`__schema_version` holds the version stamp. Each pending migration runs between `BEGIN` and `COMMIT` together with the stamp update, so a failing one rolls back and leaves the version where it was. Any failure inside `open()` closes the raw handle before it rethrows, so the same file reopens cleanly once repaired.

## An open refuses a schema newer than the binary

Before applying anything, `runMigrations` refuses a database whose stamp is higher than `config.currentVersion` with a 503. After a deploy migrated a database forward, an older server would otherwise open it and keep writing to a schema it doesn't understand. The domain answers 503 until the binary is rolled forward, and nothing on disk is touched meanwhile. Bumping the `currentVersion` of a `CONTAINER_DB_CONFIGS` entry (`archive-layout.ts`) needs a `(full backup)` line in CHANGELOG.md, which publish.yml enforces on a release tag, so the backup `./eigen update` makes first can bring the old schema back ([BACKUP.md](BACKUP.md#eigen-update-backs-up-before-it-writes-a-file)). Write it under `[Unreleased]` in the commit that bumps the version: a build of the main channel reads it there, and nothing enforces it before the release.

A stamp that is not an integer is refused the same way (503 `unreadable schema stamp`). Only Eigen's migrations write it, and a non-number compares false against every migration, so the database would open with nothing migrated and fail on its first query instead.

A missing stamp row is recreated at 0 by `INSERT OR IGNORE`, and every migration runs again. The `CREATE ... IF NOT EXISTS` steps pass. The first step that can't run twice, such as an `ADD COLUMN` or a `DROP COLUMN`, fails inside its transaction, and the open fails. A database whose migrations can all run twice just opens: collab, `shared.db`, the share registry and `waitlist.db`, each a single v1 of `IF NOT EXISTS` steps.

## The dirty watermark moves only after `onSync` returns

A database with an `onSync` callback (a container database) syncs every 30 s and on close. `sync()` skips a clean database. Dirty means `total_changes()` differs from the watermark, or `markDirty` forced it ([SYNC.md](SYNC.md#a-crash-temp-is-adopted-and-re-synced)). A dirty one runs `PRAGMA wal_checkpoint(PASSIVE)` before `onSync`, so the main file holds the committed frames a snapshot copies, without waiting on another connection.

The watermark is read before `onSync` runs and stored only after it returns. `onSync` copies the bytes first, so a write landing during its later awaits is not in the copy, and reading the watermark afterwards would count it as synced. A throwing `onSync` stores nothing, so the database stays dirty: the next tick retries, `flush()` passes the error on, and `close()` still tears down and hands `syncFailed` to `onClose`. That flag means the working copy holds bytes storage lacks.

A tick and a close never run their sync and snapshot at the same time, so a close can't tear the database down under a tick in flight. `flush()` takes only the sync lock, because `onSnapshot` flushes the very database it snapshots.

## The database triggers snapshots, the mount takes them

A config with a `snapshot` key opts into file versioning. `snapshotIfDue` calls `onSnapshot` once `writesPerSnapshot` writes have piled up, and once more at close for any change left. `onSnapshot` answers `'skipped'` when the container lock is held, and a skip stays due, so the next tick tries again. A close whose final sync failed takes no snapshot, because a snapshot on `local` copies storage, which lacks the tail. Where versions live and why the close path try-locks is in [STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container).

## SQLite removes its own WAL and shared-memory files

`close()` syncs, runs `PRAGMA wal_checkpoint(TRUNCATE)` and closes strictly. Drizzle's statements are finalized as they run (`withAutoFinalize`), so the file is released before the next open of the same path. The last connection to close removes the `-wal` and `-shm` files, after an exclusive lock proves no connection in any process still has the file. `openCold` sets `SQLITE_FCNTL_PERSIST_WAL` to 0, because macOS's system SQLite otherwise keeps both files after the last close.

**Never unlink them by hand.** A connection in another process keeps writing into the unlinked WAL, and its writes are lost or corrupt the file.

The one exception is a temp with no connection on it that is being thrown away or replaced. Its `-wal` and `-shm` go with it (`Mount.cleanupTemp`), because SQLite replays a leftover `-wal` into whatever main file next appears at that path. A download or a staged-copy recovery runs it before writing the fresh main file, and a download refuses to write while a `-wal` it could not remove is still there.

## A database that holds the truth runs synchronous FULL

Every open sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`. A database whose rows are the truth, rather than an index of something else, also sets `synchronous: 'FULL'` in its config, and `openCold` runs `PRAGMA synchronous = FULL` right after the WAL pragma. It is set per connection, never stored in the file.

`CONTACTS_DB_CONFIG` and `CALENDAR_DB_CONFIG` ask for it. The vCard and VCALENDAR bytes live in their rows, so an acknowledged CardDAV or CalDAV PUT must survive a power loss, and both write at address-book volume. Every other database takes the SQLite build's default for WAL. That default differs. Bun's bundled SQLite on Linux, so production and CI, stays at FULL. macOS's system library is built with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` and drops to NORMAL on entering WAL. So the option buys nothing in production today and everything on a developer's laptop. A crash on an index database costs at most the last commits of something that can be rebuilt.

## A container database has one slot per `pathId`

Every open, create and close of one container database runs through `withDocumentDb` (`apps/api/src/lib/mount/document-db.ts`), one at a time and in call order. So a fresh instance never shares a closing one's temp or journal files. The slot holds the live instance only while it is open. A close clears it before closing, so a snapshot read mid-close never sees the closing instance. It is a promise chain rather than `withPathLock`, because `has` must also see queued opens and closes.

Once `closeAllDatabases` starts its sweep, after the downloads abort, the reindex drain and the thumbnail wait, a new open is refused with a 503. The lock order is in [STORAGE.md](STORAGE.md#on-local-a-key-is-a-name-path-so-renames-lock-the-whole-tree).

## One API process owns a data folder

Two API processes on one data folder corrupt its databases, so the first one locks it. `index.ts` imports `src/instance-lock.ts` first and only then loads `src/server.ts` with `await import`, whose modules open server databases as they load. The import is dynamic because a static one guarantees no order in the `buildfordocker` bundle: `--splitting` hoists `auth.ts` and its top-level `users3.db` open into a shared chunk that evaluates before the entry's own code.

`lockDataDir()` (`apps/api/src/lib/config/data-lock.ts`) opens `data/server/instance.lock` as a SQLite database, runs `PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE;` and keeps the connection for the life of the process. `IMMEDIATE`, not `EXCLUSIVE`: two processes starting together both read the empty file first, and `BEGIN EXCLUSIVE` then fails them both, while `BEGIN IMMEDIATE` lets exactly one through. A second API gets `SQLITE_BUSY` and exits with code 1, naming the data folder.

The lock is a POSIX file lock, so the OS drops it however the holder ends, SIGKILL included, and a `bun --watch` reload takes it again. The open transaction keeps a 512-byte `instance.lock-journal` with no pages beside it, which a SIGKILL leaves behind. The next holder rolls it back as a no-op, so it is harmless.

The swap of `./eigen restore` takes the same lock (`lockData` in `apps/api/src/cli/restore.ts`) and refuses while an API holds it, so it only runs with Eigen stopped. `./eigen backup` runs inside the API and needs none ([BACKUP.md](BACKUP.md#the-whole-server-backup-runs-inside-the-api)). Seeding and migration scripts don't take it. Tests that boot `app` in-process never take it, while `test/backup/process-lifecycle.test.ts` spawns `src/index.ts`, so each child takes it on its own data root.

## A lease refuses the second API the lock cannot see

A POSIX lock only reaches the processes of one kernel that see the folder through one file system. Two containers in one Docker Desktop VM share the VM's kernel and lock each other out. The Mac host and a container over the same bind mount do not, so without more an API on each side would both start and both write.

So after the lock, the API writes `data/server/instance.lease`, a small JSON file with its host, pid and lock scope, and rewrites it every 5 s (`instance-lock.ts`, with the shared parts in `data-lock.ts`). The lock scope is the Linux boot id, which every container of one VM and the VM itself read the same, plus the device number of the folder. The boot id alone is not enough: WSL2 runs every distro and Docker Desktop's VM on one kernel, and one distro sees another's folder over 9p, which has its own device number and need not carry the lock.

A boot that finds a lease from another scope waits 30 s, six heartbeats. If the lease changed in that time, its holder is alive, and the boot exits with code 1, naming that host and pid. If it did not, it is stale and the boot takes it over. No clock is compared across machines, only whether the lease changed. The wait is long because a synchronous boot that runs migrations, or a VACUUM, blocks the holder's event loop and so its heartbeat. A holder blocked for longer than the wait looks dead. A lease that does not parse is waited on the same way, since it cannot say whose it is. A lease from our own scope is taken over at once: its holder would hold our lock, so it is dead. Only a regular file counts as a lease, opened once without following a symlink and checked on the open file, so a FIFO, a device or a symlink in its place cannot hang the boot or the swap, or point it at another file (`readLeaseText`).

A heartbeat that finds another holder's lease exits with code 1 at once, with no graceful shutdown, because another API took over and a shutdown would write more. The graceful shutdown in `server.ts` removes the lease after the homes close, so the heartbeat runs through the whole drain and a clean stop costs the next boot nothing. A crash leaves the lease behind, which costs a boot in the same scope nothing and one elsewhere a 30 s wait. A Linux reboot after a crash costs that wait too: it changes the boot id, so the lease the crash left is from another scope. A lease the shutdown cannot remove only costs the next boot elsewhere that wait, so it never keeps the process from exiting. The lease is in `SERVER_RUNTIME_FILES`, so no backup takes it and a staged restore drops it.

The restore swap reads the lease the same way and refuses while one from another scope is alive. It writes none, because it is synchronous and cannot heartbeat while it moves `data/`, so a lease it wrote would look stale. An API that boots on another kernel during a swap is therefore not refused.

Two APIs in different scopes that start in the same moment both find no lease and both write one. The first to write loses: its next heartbeat finds the other's lease and exits. Until then both may write, for 5 s, or longer while a synchronous boot blocks the loser's event loop. Closing that gap would cost every cold boot another wait, so it stays open.

## See also

- [SYNC.md](SYNC.md): how a container database reaches an `s3` bucket
- [STORAGE.md](STORAGE.md): mounts, the `metadata.db` paths table and version snapshots
- [CONTACTS.md](CONTACTS.md), [CALENDAR.md](CALENDAR.md): the two databases whose rows are the truth
- [CHAT.md](CHAT.md), [COMMENTS.md](COMMENTS.md), [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [FILE-HISTORY.md](FILE-HISTORY.md), [SEARCH.md](SEARCH.md): the domain schemas
