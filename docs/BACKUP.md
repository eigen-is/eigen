# Backup & Restore

> **TLDR:** Eigen backs up at two sizes, both made by the running API from one primitive, `snapshotHome`, in `apps/api/src/lib/backup/`. An admin backs up one home (a user or a team) from the admin pane into a verified `.tar.zst` artifact, and restores it with the home offline for the length of the restore. The owner backs up the whole server from Settings, on a schedule or on demand, or with `./eigen backup`: one plain tar of per-home artifacts plus the server's own databases, `.env.production`, the DKIM key and the mail server's TLS certificate, optionally uploaded to a bucket of its own. `./eigen restore` (`apps/api/src/cli/restore.ts` and the `eigen` launcher) puts such an archive back offline, on this machine or a new one with no setup first. Not obvious from the code: nothing a restore replaces is ever deleted, a home member restores on its own only when its manifest says it is complete, the backup bucket's keys live only inside the archives in that bucket, and archives are not encrypted.

## One primitive captures a home, at one of three levels

`snapshotHome` (`apps/api/src/lib/backup/snapshot-home.ts`) writes a storage-independent copy of one home into a folder: a manifest, the `home/` tree one for one with the home directory, and for a user `auth.json`, `shares.json` and `avatar/`. The per-home backup and the whole-server backup both go through it, so there is one spelling of what a home is.

| Level | Name in the UI and CLI | Takes | Leaves out |
|---|---|---|---|
| `full-s3` | Full + S3 | Everything, every `s3` object downloaded | Nothing |
| `full` | Full | Everything of `local` and `local-key` mounts; of an `s3` mount its `metadata.db`, its thumbnails and the uploads still in `staging/`, after its open documents are flushed there | An `s3` mount's objects |
| `light` | Light | Every home database, each mount's `metadata.db`, the home tree outside the mounts, the auth rows | Every file body, every container database, thumbnails, the Maildir |

`full-s3` is the default, and the only level a per-home backup writes, so a per-home artifact is always a complete home. Full is the schedule's level: an `s3` bucket keeps its own history once versioning is on, and downloading every object each night would double it. Light is the pre-update default: it is small and fast, and a rollback keeps the files and mail in place.

The manifest records the level in `level`, and every mount whose bodies are not in the archive gets `contents: 'metadata'`: every mount at Light, an `s3` mount at Full. A manifest without `level` is complete.

## A home archive holds every database, file and auth row

- Every database, copied with `VACUUM INTO` through the running server's own handle, never as a file copy of a live WAL database: the drive's `shared.db`, each mount's `metadata.db`, `calendar.db`, and for a user `mail.db`, `contacts.db` and `notifications.db`. A database under the home that `HOME_DATABASES` (`apps/api/src/lib/backup/archive-layout.ts`) does not list fails the backup, so a new subsystem's database is noticed the day it lands.
- Every mount the home declares, disabled ones too. A disabled mount is not in the drive's map, so nothing else walks it, and it comes back disabled because `settings.json` rides along. A disabled mount whose storage cannot be read is skipped with the reason in the manifest, since its bucket is often unreachable because it was turned off, and a restore leaves it disabled and absent. An enabled mount's storage failure fails the backup, naming the mount and the error code: that archive would miss files the home is serving. So does a file whose row records bytes and whose object is gone. A file with no bytes on record, or one deleted during the backup, is left out.
- Every file the drive knows about, by the path it would have on a `local` mount, on all three backends. A restore re-derives whatever keys the target mount needs, so an archive never depends on a bucket, its credentials or the storage type staying the same.
- Every container's `data.db` and `comments.db`, freshest first: an open document's live handle, then a crash temp in `tmp/`, then a pending staged upload, then the stored object. A backup taken during an S3 outage holds the newest local bytes.
- Version history and trash (`versions/` and `.trash/`). Version history is the only copy of an old file state, and trash is data the user can still restore.
- Thumbnails. A thumbnail is made once, at upload, and never again, so it is not derived data.
- The contacts avatar renditions (`eigen.contacts/avatars/`). The served webp keeps the animation and alpha the card's Apple-safe `PHOTO` gave up ([CONTACTS.md](CONTACTS.md#the-avatars-folder-is-a-second-source-of-truth-not-a-cache)).
- Mail as Maildir files, empty folders included. A mailbox nobody delivered to still needs its `new/` and `cur/`, because the mail sync watches them.
- The home's `settings.json`, mount configs and every `s3` mount's keys included.
- For a user, `auth.json` (their `user`, `account`, `apikey`, `two_factor`, `member` and `team_member` rows), `shares.json` (the share-registry rows they granted) and their avatar.

Each database copy is one committed state. The archive as a whole is not one instant: a mail that arrives during the backup may or may not be in it. That is the standard guarantee for a backup of a running system, and it is why users keep working during one.

## A home archive leaves out caches, sessions and other homes

- Derived caches: previews, the `tmp/` scratch folders, the mount's `staging/` as a folder (a Full or Full + S3 capture writes its pending bytes into the file tree, where they win over the stored object), and each mailbox's `tmp/` delivery spool.
- Sessions. A per-home restore never signs anybody out, and no archive can bring a session back into a server that has lost it.
- Server data: `users3.db`, `eigen.db`, `waitlist.db`, the server config and settings, and `.env.production`. The whole-server archive holds those.
- Other homes. A team's data lives in the team's home, which has its own archive.
- Guest and org homes. Guest homes are disposable (guest cleanup deletes them) and an org home holds no databases, so the per-home routes answer a guest or org ownerId with 400. The whole-server archive takes the org folder as plain files and leaves guest homes out: a guest keeps their account and gets a new home on their next visit.

**A restore does not put mtimes back.** The extractor writes every file with the clock of the restore. Mail is the only domain that reads a file's stats, and its first pass re-reads what looks drifted.

## Archives live outside data/

The backups folder is `EIGEN_BACKUPS_DIR` if set, else `backups` beside the data root. On a Docker install that is `/app/backups` in the container, bind-mounted from `./backups` in the install folder. It sits outside `data/` so that a wipe of the data folder cannot take the backups with it. Every job's scratch space is `backups/.staging/`, on the same disk as the archives so the last rename of a pack is atomic, and the boot wipes it.

The server creates the folder only when a backup needs it, so it must be writable by uid 1000, the user the API runs as. Who creates it and owns it on an install: [SELF-HOSTING.md § backups/ is outside data/](SELF-HOSTING.md#backups-is-outside-data).

## An archive is as secret as data/ itself

A home archive holds every file and mail, the password hash, app passwords, API keys, the 2FA secret and every mount's S3 keys. A whole-server archive adds `users3.db` with every session, the auth secret in `config.json`, the relay password in `.env.production`, the DKIM key and the TLS key. Credentials are not stripped, because a backup that cannot restore a mount or send mail is not a complete backup. Archives are not encrypted: they sit beside `data/` on the same disk, with the same exposure. So the per-home routes are admin-only, the whole-server ones owner-only, and the backup bucket must be private.

## One job per home at a time, and the user keeps working

**Create backup** in the Backup section of a user or team in the admin app starts a job. It captures the home into staging, verifies the folder, packs it into `home-{ownerId}-{yyyymmdd-hhmmss}.tar.zst` and writes a sidecar beside it with the manifest and the verify result. An artifact that does not verify is kept, with its failures and no Restore button, and the admin who started it gets a notification.

A second job on a home while one runs gets a 409, so a backup never reads a folder a restore is writing. Job state lives in memory (`apps/api/src/lib/backup/jobs.ts`) and a finished job drops after an hour. The artifacts and sidecars are the durable record, so a restart loses nothing but the progress line. The `backup:job-updated` SSE event only tells the pane to refetch ([SSE.md § A backup job's event is only a nudge](SSE.md#a-backup-jobs-event-is-only-a-nudge)). The pane polls as well, because an admin restoring their own home gets no event while that home is offline.

There is no read-only window. Capturing a container's `data.db` takes that container's path lock, so a sync or close of that one document waits for one copy. Typing is not affected.

A backup reaches a home through `pullHomeSnapshot` (`apps/api/src/lib/home/home-relay.ts`), and `lib/backup/` never imports `getHome`. A home the backup had to boot gets a 30 s idle (`BACKUP_RELEASE_MS`) once it is captured, so a nightly Full does not keep every home resident. It is never evicted: a user may have opened it meanwhile, and a home a request reached after the capture started keeps its normal idle.

## Verify runs in three stages

Every home archive is verified after the backup that wrote it, on **Verify**, and again before every restore:

1. Transport: every file the manifest lists has exactly its size and sha256, and the folder holds nothing it does not list.
2. Structure: `PRAGMA quick_check` on every database the archive owns, opened read-only. Only Eigen's own: a user's upload that happens to be SQLite is stored byte for byte and is not verify's to open.
3. Content: for the ten largest collab documents plus ten more, a sample that is the same on every run, every Yjs blob decodes and a document with blobs decodes to shared types. Chat containers are skipped, since their `data.db` is not Yjs.

The verdict goes into the sidecar, which the artifact list reads. The manifest inside the archive is canonical; the sidecar is a cache.

## A restore deletes nothing and writes identity last

**Restore** asks first, naming the home. Then:

1. The home is marked as restoring (`markHomeRestoring` in `apps/api/src/lib/home/get-home.ts`), which is also the lock against a second restore.
2. The artifact is extracted into staging and fully verified. A failure ends the job with nothing touched.
3. The home is evicted and its collab sockets are closed.
4. The home folder is renamed aside as `{id}.pre-restore-{timestamp}`. A deleted user has none.
5. The archive's home folder is installed. A `local` mount's files go in as they are, a `local-key` mount's under their flat keys, and an `s3` mount's are staged with a pending-upload row each, so the upload queue drains them with its retry and backoff. Every restored row gets a fresh key, so no bucket object is overwritten. The home's data epoch rotates once the folder is whole.
6. Every restored database gets `quick_check` and a schema check against this server.
7. Only then do identity rows go into `users3.db`, because nothing takes a row back. A missing user is inserted from the archive; a present one is left alone, and the restore is refused when the email no longer matches. Missing share rows are inserted, and the avatar only when the server has none.
8. The mark clears and the home is opened, so a remote mount's queue starts draining at once. The first load runs migrations and reseeds the byte counters.

A failure after step 4 parks the half-written folder as `{id}.failed-restore-{timestamp}` and renames the original back.

## A restore refuses a member that is not a whole home

`incompleteReason` (`packages/lib/src/validation/backup.ts`) reads the manifest: a Light member holds no files and no mail, and a mount with `contents: 'metadata'` holds no file bodies. `restoreHome` refuses such an archive right after it reads the manifest, before the verify and before the home goes aside, where a refusal would already have cost the user their open pages. `materializeMount` refuses a metadata-only mount a second time, where the harm would be. The admin pane shows why on the row and offers no Restore.

So a Full + S3 member restores any home, a Full member a home without `s3` mounts, and a Light member none. The refusal trusts the manifest. One stripped of `level` and `contents` over missing bodies still verifies, because verify has to let a body be missing (a delete can race the backup), and it restores to files with no bytes.

## A restore never grants privilege

`auth.json` is the one part of an archive that writes to `users3.db`, and an archive is a file somebody uploaded. So a restore takes only what is this home's:

- Only this owner's rows. A row that names anybody else is dropped and logged. An archive with a second `user` row is refused: it holds exactly one, with this home's id and the manifest's email, or nothing is inserted.
- No privilege. The restored user is a plain user of this server's organization, whatever the archive says. An admin before the restore is made one again by hand.
- No teams this server lacks. A membership of a team that is not on this server is dropped.

## The home is offline during a restore, and every tab reloads after

Every surface that resolves the home per request (HTTP, SSE, collab, CalDAV, CardDAV, WebDAV) answers `503 Restore in progress`. Sessions are untouched, so nobody is signed out.

Every open tab of the home reloads once the restore is done: the event stream announces the home's new data epoch ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home)). Editor tabs don't wait. Their sockets close with 1012 (`home-replaced`) at the start and reload instead of reconnecting, because a tab that reconnected would sync the document it holds back over the restored copy ([COLLAB.md](COLLAB.md#home-replacement-closes-every-socket)).

## IMAP keeps writing the old folder during a restore

Dovecot runs in its own container and reads the Maildir straight off the volume, so a mail client connected during a restore works on the folder that went aside. What a client does in that window, a flag, a move or a saved message, lands in `{id}.pre-restore-{timestamp}`. Nothing is lost, but it is not in the live home ([ROADMAP.md](ROADMAP.md)). New mail is not affected: Postfix delivers through the API (`mailboxDeliver` in `apps/api/src/lib/mail/mail.ts`), which answers 503 for the home, so Postfix keeps the message queued and delivers it after the restore. For a mail-heavy restore, pause the account's mail clients for the window, or copy what is missing out of the safety copy afterwards.

## Safety copies are never deleted automatically

A restore leaves `{id}.pre-restore-{timestamp}` (the home as it was) or `{id}.failed-restore-{timestamp}` (a restore that did not finish) beside the live home. The pane lists both with their size, **Delete**, and for a pre-restore copy **Restore**.

A safety copy of an `s3` home is complete, because a restore never writes over an object. **Delete** removes only the objects no other copy and not the live home references. When an object cannot be deleted it stops, keeps the folder and answers 503, because the folder is the only record of whose bytes those are. **Restore** of a pre-restore copy moves the live home aside as a new copy and renames the chosen one back: no bytes are written or deleted. A copy of a deleted user can only be deleted, since the folder alone would be a home nobody can sign in to. A delete holds the home's job slot.

A restore needs about twice the home's uncompressed size free in the backups folder, for the decompressed tar and the extracted tree side by side. The safety copy then keeps a second copy of the home on the data disk, and of an `s3` home a second generation of objects in the bucket, until it is deleted.

## An archive from another machine goes in by upload or scp

**Upload backup** takes an archive up to 1 GB, named as this server names them, with the ownerId in the name matching its manifest. A larger one is copied into the backups folder by hand and given to uid 1000 ([ROADMAP.md](ROADMAP.md) has the chunked upload). A file copied in has no sidecar and lists as unverified until **Verify** runs. A restore verifies anyway, but a bad archive is better caught without taking the home offline.

A member of a whole-server archive is an ordinary per-home artifact: extract `homes/home-{ownerId}-{stamp}.tar.zst` into the backups folder and it lists on that home's pane.

## An archive is a plain tar anyone can read

A home artifact is a POSIX tar (pax headers for long names, empty folders included) through zstd, so `tar --zstd -xf` reads it anywhere. Everything is inside one `home-{ownerId}/` folder. The server-side sidecar `{artifact}.manifest.json` holds the manifest and the last verify.

`apps/api/src/lib/backup/archive.ts` writes and reads the tar itself. **Never pack or read through `Bun.Archive`**: its writer stores a lazy `Bun.file` entry as an empty one and buffers the whole archive in memory, and its reader (Bun 1.3.14) stops at the first non-ASCII name on a pax archive and segfaults on a ustar one, so a home with one accented file name could not be restored.

## Boot recovery finishes or undoes an interrupted restore

Before a per-home restore moves the home aside, it writes `restoring.json` in its staging folder, and `restore-complete.json` beside it once the install is whole. The next boot (`apps/api/src/lib/backup/recovery.ts`) reads them before the staging wipe:

- Marker without the completion note: the process died in the install. The half-written folder is parked as `{id}.failed-restore-{timestamp}` and the pre-restore copy goes back. This is the window an OOM kill lands in, and it is long when the backups folder is on another disk, since the install then copies instead of renaming.
- Both notes: the restore finished, and both folders stay.

A marker lost to a torn write does nothing, and the home sits complete in its pre-restore copy, to rename back by hand.

## A restore refuses databases from a newer server

Every restored database is checked against the schema this build supports, and one from a newer server is refused with both versions named. Without it the archive would pass `quick_check` and then fail the home on its next load. So restore onto a server at least as new as the one that wrote the archive.

## The whole-server backup runs inside the API

`startServerBackup` (`apps/api/src/lib/backup/server-job.ts`) runs as a job in the org's slot, so one runs at a time and a second start gets a 409 naming it. It starts from Settings § Backups (**Back up now**), from the schedule, or from `./eigen backup` over the control socket (`apps/api/src/routes/control.ts`). It runs in the API because the job map is where the guards live: a separate process would bypass the per-home 409, the restore mark and the shutdown drain. So `./eigen backup` refuses with Eigen stopped, where a copy of `data/` and `.env.production` is a backup too, and it takes no `.eigen/lock`, since it stops nothing. Every command and its flags: [SELF-HOSTING.md § The commands](SELF-HOSTING.md#the-commands).

The job:

1. Writes the sidecar `{archive}.json` as `running` under the archive's final name, so even a refused attempt leaves a dated record.
2. Refuses with 507 unless the backups folder has room: twice the largest member plus the sum of all of them, uncompressed.
3. Captures the server member, verifies it and packs `server.tar.zst`.
4. Lists the homes from the `users3.db` it just captured, so accounts and homes are one moment: every non-guest user and every team with a folder. A folder with no row is named in `orphans` and left out.
5. Captures each home at the archive's level, verifies it, packs it and appends it. It waits for the home's slot rather than failing a night on an admin's click, and while it holds the slot a per-home job on that home gets the 409.
6. Appends `.env.production`, the DKIM files, the TLS certificate and its key, and the manifest, then renames the temp file into place.
7. Reads the finished tar back and checks every member against the manifest's sha256.
8. Writes the sidecar, prunes, and starts the upload.

Shutdown gives a running backup 30 s. Its staging goes in the next boot's wipe, and the boot marks its `running` sidecar failed, "interrupted by a restart". So `./eigen restore`, `./eigen rollback` and `./eigen update` wait for a running server backup to end before they stop Eigen, by its `running` sidecar in `backups/`.

## A server archive is a plain tar of home archives, manifest last

```
server-{scheduled|manual|pre-update}-{light|full|full-s3}-{yyyymmdd-hhmmss}.tar
├── server.tar.zst                        server/ (databases, config.json, settings.json, avatars/) and org/
├── homes/home-{ownerId}-{stamp}.tar.zst  one per-home artifact per home
├── .env.production                       absent when the API cannot read it
├── dkim/                                 absent when unreadable or mail is off
├── certs/                                cert.pem and key.pem; absent when either is unreadable or missing
└── manifest.json                         last
```

The outer tar is not compressed: its members already are, and a plain tar reads member by member without unpacking. Reason and level are in the name (`parseServerArchiveName` in `packages/lib/src/validation/backup.ts`), so retention and the schedule never open an archive. The manifest (`ServerArchiveManifest` in `packages/lib/src/types/backup.ts`) lists every member with its sha256, each home with its member or why it has none, the orphans, whether `.env.production`, the DKIM key and the TLS certificate are in it, and the images the install pinned. A manifest without a `certs` field holds no certificate.

The server member holds `users3.db`, `eigen.db` and `waitlist.db`, each through `VACUUM INTO` on the server's own handle, and the files `SERVER_FILES` names (`apps/api/src/lib/config/paths.ts`). The runtime files in `SERVER_RUNTIME_FILES` are never captured: the instance lock, the control socket, the setup token and the two data-epoch files. Leaving the epoch out is what reloads every tab after a whole-server restore.

The API reads `.env.production` through a read-only mount at `EIGEN_ENV_FILE`, and the DKIM key and the TLS key under `data/`, all three as group 1000 ([SELF-HOSTING.md § The API reads three secrets as group 1000](SELF-HOSTING.md#the-api-reads-three-secrets-as-group-1000)). Caddy's `export-certs.sh` and a certbot hook write the key 0600, so an archive made between a renewal and Dovecot's next check, at most ten minutes, leaves the certificate out. With mail off no Dovecot shares the key, and nothing needs it. What the API cannot read stays out and the manifest says so: a restore then keeps the install's own `.env.production` and certificate, and a move to another machine needs new DKIM DNS. In `bun run dev` there is no `EIGEN_ENV_FILE`.

## A home that fails is named, and the archive goes on

A home whose capture or verify fails gets `failed` with the reason in the manifest, and the loop carries on: one broken bucket must not leave every other home without a backup. The job then ends failed, naming the homes, and the owner is alerted. The archive is kept, verified and uploaded all the same. A home deleted during the run is `skipped`, which is no failure.

## The schedule makes one attempt per UTC day

`serverBackupTick` (`apps/api/src/lib/scheduler/jobs.ts`) runs every five minutes, never at boot, when the server is busiest. It starts a Full (Full + S3 with `withS3`) once the UTC hour reaches `hourUtc` and no scheduled archive or record carries today's UTC date. A failed or refused attempt leaves its record, so it counts: a bad night is one alert, not a retry every tick. A restart neither skips nor doubles a night. A tick within 15 minutes of a pre-update backup's end starts nothing: the update stops Eigen next, which would kill the Full or wait for it. The settings live in `settings.json` under `backups.schedule` ([SERVER-SETTINGS.md](SERVER-SETTINGS.md)).

## Retention keeps good scheduled archives and every manual one

`pruneServerArchives` (`apps/api/src/lib/backup/retention.ts`) runs after a job writes its sidecar, never before, and groups by the reason in the name:

| Reason | Kept |
|---|---|
| scheduled | The newest `keep` whose job ended done, plus up to `keep` failed ones newer than the newest good one |
| pre-update | The same rule with a `keep` of two, plus the newest good one made by another build than the one running: `.eigen/last-update` names it, which the API cannot read, and an update that failed after its backup leaves a newer one |
| manual | All of them; the owner deletes them |

A failed night never pushes out the last good archive, and nights that keep failing don't pile up. An archive without a readable sidecar is never deleted, and neither is one a running job still reads. A name the grammar does not read is never touched.

## Failures reach the owner

Every failure of a server backup or its upload sends an `admin-alert` to `getOrgOwner()`, tagged per archive so repeats coalesce. `./eigen status` shows a Backup row from `ControlStatus.backup` (`apps/api/src/lib/config/server-status.ts`): red while the newest scheduled attempt failed, yellow while it is not in the bucket or while the schedule is on and no Full verified in two days. With Eigen stopped the row reads the names in `backups/`.

## Upload goes to a bucket of its own

A verified scheduled or manual archive goes to the backup bucket as an upload job of its own, which holds no home slot, so a backup never waits for the bucket and a pre-update backup never waits for an upload. Uploads take turns. **Upload to the bucket** on an archive's row in Settings sends one again. Pre-update archives never leave the box: they exist for `./eigen rollback` on it.

`apps/api/src/lib/backup/upload.ts` streams the file as a multipart upload, reads the object's size back, and deletes an object that came out short. A failed or aborted upload makes Bun abort the multipart upload. Archives go under `<prefix>/<domain>/`, so two servers can share a bucket and each prunes only its own folder.

`checkBackupDestination` runs on the owner's **Test Connection**, on every save with upload on, and before every upload, since a mount can be added after the destination was saved. It refuses:

- a bucket name any mount of this server uses, the default mount's or any home's, safety copies included, and any access key they use. One lost bucket or leaked key must not take the data and its backups together. While some home's `settings.json` does not read, any bucket may be a data bucket, so it refuses them all.
- a bucket that answers an unsigned GET of its probe object: a backup bucket must be private.

It warns, without refusing, when no lifecycle rule aborts incomplete multipart uploads under the server's folder, since the parts of an upload cut off halfway stay and cost money.

The backup bucket's secret reaches no browser, the owner's included, and a blank secret in a save or a **Test Connection** keeps the stored one unless the endpoint, bucket or access key changed. The endpoint, bucket and keys live only in `settings.json`, which is inside the archives in that bucket. So a save that changes the destination answers with a one-time notice (`BACKUP_DESTINATION_NOTICE` in `packages/lib/src/constants/backup.ts`) to keep them somewhere off the server. A restore on a new machine starts from them.

## The bucket keeps its own count, and always the newest complete archive

After a successful upload, `pruneBucketArchives` (`apps/api/src/lib/backup/retention.ts`) lists the server's folder and deletes scheduled archives past `upload.keep`, by name. An archive whose manifest names a failed home counts toward `keep`, but the newest complete archive stays whatever came after it, because only it restores every home. Manual archives and names the grammar does not read are never deleted. An archive uploaded late that the count would drop is left, and that round deletes nothing. Pruning never runs after a failed upload.

## No server archive leaves the box through a browser

The server backup routes (`apps/api/src/routes/server-backup.ts`) have no download. An archive is large, and one click would carry every mailbox out through a session. It leaves by scp or through the bucket. A per-home artifact does download, for an admin, from the home's pane (`GET /admin/backup/artifacts/:name` in `apps/api/src/routes/backup.ts`): to keep a copy of one home off the server. They are owner-only, like the settings that hold S3 secrets, and server-wide, so they carry no `:ownerId` (`OWNER_ID_EXEMPT` in `scripts/check-standards.ts`).

## ./eigen restore stages while Eigen runs, then swaps under a marker

`./eigen restore <archive>` takes a name in `backups/` or a path, which the launcher mounts read-only into a one-off container. It works in two steps so that Eigen is down only for the renames:

1. Stage (`restore <archive> --stage`, as uid 1000 while Eigen runs). It reads the archive and checks every member's sha256, refuses before anything moves, shows level, version, age, home count, failed homes and whether `.env.production`, the DKIM key and the TLS certificate are in it, and asks. Then it extracts member by member into `data/.restoring/`, verifies each, and installs each home by its mode. A stale `data/.restoring/` from a stage that died is wiped first; `stage.lock` in it keeps two stages apart.
2. Pull: on a release install, the images the archive's `.env.production` pins, while Eigen still runs.
3. Swap (`restore --swap`, as root with Eigen stopped). It writes `.eigen/restore-swap`, the full list of copies and renames, and syncs it to disk before the first rename. Then it runs them, clears `backups/.staging/`, whose per-home restore notes name homes of the `data/` that went aside and would make the boot recovery act on the restored ones, removes the marker and starts Eigen on the pinned images, with their launcher and Compose files. A local build runs `configure --backfill` instead.

A swap cut off anywhere is finished by the next `./eigen` command: `preflight` finds the marker and runs `restore --swap` again with the build whose files wrote it, which skips the renames already done. The staged tree was verified before the marker existed, so rolling forward is safe. The swap holds the API's instance lock ([DATABASE.md](DATABASE.md#one-api-process-owns-a-data-folder)) and `.eigen/restore.lock`; the launcher holds `.eigen/lock` throughout.

## A Full restore swaps data/ whole, a Light one merges

A Full or Full + S3 archive replaces `data/` whole: the live one becomes `data.pre-restore-<stamp>` and the staged one moves in, two renames on one disk. A home that failed in the archive is therefore only in the folder kept aside. When the archive has no DKIM key or no TLS certificate, the current one is copied into the staged tree first: mail would sign with a key DNS does not publish, and IMAP and SMTP would fall back to a self-signed certificate.

A Light archive holds no file bodies, so it merges. `server/`, `org/`, `dkim/` and `certs/` go aside whole and the staged ones move in. In a home that already exists, every file of its light set goes aside into `data.pre-restore-<stamp>`, whether the archive has it or not, so a leftover `-wal` is never replayed onto another database. The staged files move in, and the drive files and the Maildir stay. A home only in the archive moves in whole, without its files. The uploads pending in each mount's `staging/` stay for the restored rows that name them, and a copy goes aside, since the next start sweeps the rest.

`.env.production` goes aside as `.env.production.pre-restore-<stamp>` and the archive's comes in; an archive without one keeps the current file. Anything aside that keeps nothing is removed: a new machine's empty `data/`, and an `.env.production` identical to the archive's. The launcher ends with "Check that all is well, then delete what was kept aside."

## An s3 mount keeps its bucket as it is

By default an `s3` mount comes back on its bucket as it stands: `metadata.db` as archived, which names keys, not object versions. A file edited since reads its new bytes, and a file deleted since reads as gone, which is what the bucket's versioning is for. The pending uploads in the archive are replayed, except those the live mount no longer has a row for, since it already uploaded, replaced or canceled them and a replay would put older bytes on the key. The stage prints how many it left out, and how many had no bytes in the archive.

`--s3-from-archive` uploads a Full + S3 archive's objects under fresh keys instead, as a per-home restore does. It is for a damaged bucket. The default avoids doubling an intact one.

## The trash starts over after a whole-server restore

Every trashed file of every restored mount is re-dated to the restore, whatever its storage and whatever the level (`redateTrash` in `apps/api/src/lib/backup/restore-server.ts`). The operator gets the whole retention window to look through what came back, and no purge deletes an `s3` object the data kept aside may still name.

## A restore refuses what root must not swap in

The stage refuses an archive that is damaged, one from a newer Eigen, one from a release install on a local build or the other way around (one pins images, the other builds its own), `--s3-from-archive` on an archive without S3 files, and an archive the data disk has no room to stage. The launcher refuses an archive path with a colon, which Docker cannot mount, and an archive uid 1000 cannot read, such as a copy root left 0600, with the `chown` that fixes it.

The swap runs as root on files the API's user wrote, so it refuses a staged tree with a link, a device or a setuid or setgid file, and drops fifos and sockets. It needs `data/`, `data/.restoring/` and every home on the install folder's disk, not a link or another mount, because it only renames.

## A restore on a new machine needs no setup

On a release install with no `.env.production`, or one with no `DOMAIN` (a mirror's, which is set aside and put back on failure), `restore_fresh` in `eigen` pulls `api:latest`, which writes the archive's `.env.production` (`restore --env`) and so pins the build that restores it. It pulls that build, writes its launcher and Compose files, prepares `data/` and `backups/`, and hands over to the new launcher's `./eigen restore`. The installer passes it through: `curl -fsSL https://eigen.is/install | sh -s -- restore <archive>`. Setup would write an `.env.production` and an org the restore throws away. An archive without `.env.production`, or one from a local build, is refused there.

## Sessions come back as the archive had them

`users3.db` comes back whole, so everyone is signed in as they were when the archive was made, and the swap says so. After a restore that follows a compromise, an attacker's session from before the archive works again: reset the passwords of the accounts involved, which signs them out everywhere ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#an-admin-password-reset-revokes-every-way-in)).

## ./eigen update backs up before it writes a file

`update_get` in `eigen` asks the new image `update-check --level`, which answers `level=full` when a release since the running one lists a `(breaking)` change in its CHANGELOG, else `level=light`. A breaking release may convert what a Light archive leaves out, so only a Full one could bring it back. `--full` forces Full. Then, after the images are pulled and before any file of the new version is written, it runs `backup --reason pre-update --wait` on the running API, which waits out a scheduled backup instead of failing on it. A failure ends the update with Eigen running as it was. The archive's name goes to the new launcher, which records it in `.eigen/last-update` once the switch is written. `./eigen rollback` restores the archive that file names, with the images it pins. Any restore or finished swap clears the file: the data swapped in makes the old way back meaningless. Changes between the end of the backup and the stop are not in it, so the launcher prints the time it was made until.

With Eigen stopped the update refuses, since the backup runs on the running server. `--no-backup` makes none and clears `.eigen/last-update`, so a rollback has nothing to go back to.

## An update from 0.3.0 hands over to that image's snapshot

The 0.3.0 launcher makes no pre-update backup and passes no archive. It asks the new image `snapshot --check` (`apps/api/src/cli/snapshot.ts`, which serves that call alone), which answers `kind=full` for a breaking update, and passes that on as `--full`. The new launcher's `update_apply` then saves a snapshot with the 0.3.0 image after the stop, in `snapshots/`, and records that image beside it in `.eigen/last-update`. A retry of an update from 0.3.0 that failed past its files does the same, since the running 0.3.0 CLI has no `backup`. Only 0.3.0 can put such a snapshot back, so `./eigen rollback` prints three commands: bring back 0.3.0's launcher, restore the snapshot with it, and clear what the new version recorded.

## An archive holds what the API can read

The backup runs in the API, whose container mounts `data/`, `backups/` and `.env.production` and nothing else of the install. So `caddy-data/`, `docker-compose.override.yml` and the Postfix queue, a Docker volume of its own, are not in an archive, and `backups/` would hold itself. Caddy gets its certificates again. A restored TLS certificate is only as fresh as the archive: Caddy exports its own again, and behind another web server the certbot hook runs on the next renewal. The bucket's keys are inside the archives only ([Upload goes to a bucket of its own](#upload-goes-to-a-bucket-of-its-own)). What the operator keeps by hand, in their words: the help center's [What a backup leaves out](https://eigen.is/support/self-hosting/back-up-and-restore#what-a-backup-leaves-out).

## See also

- [SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home): the data epoch that reloads a tab after a restore
- [COLLAB.md](COLLAB.md#home-replacement-closes-every-socket): the socket half of a per-home restore
- [SYNC.md](SYNC.md): the upload queue a restored `s3` mount drains through
- [SELF-HOSTING.md](SELF-HOSTING.md) and the help center's [Back up and restore the whole server](https://eigen.is/support/self-hosting/back-up-and-restore): the operator's side
- [PROPOSAL_BACKUP_RESTORE.md](proposals/PROPOSAL_BACKUP_RESTORE.md): the design and the phases after this one
