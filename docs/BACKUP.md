# Backup & Restore

> **TLDR**: An admin backs up one home (one user, or one team) from the admin pane. The result is a single `.tar.zst` artifact in the server's backups folder that holds every database, every file and, for a user, their auth rows: complete, storage-independent, and verified before it counts as good. Restore replaces that home from an artifact and moves the home as it stands aside as a safety copy, which nothing ever deletes automatically. The home is offline for the length of a restore and nothing else notices. Whole-server backup is still `scripts/backup.sh`, the offline stop-and-tar script, until phase ③ lands.

Design rationale, and the phases beyond this one, live in [PROPOSAL_BACKUP_RESTORE.md](proposals/PROPOSAL_BACKUP_RESTORE.md). This page is what an operator needs.

## What a backup contains

One archive is one home. A user home and a team home are the same shape, minus the parts a team has no equivalent for.

- **Every database**, captured with `VACUUM INTO` through the running server's own handle, never as a file copy of a live WAL database: the drive's `shared.db`, each mount's `metadata.db`, `calendar.db` (teams have one too, when an admin has enabled it), and, for a user, `mail.db`, `contacts.db` and `notifications.db`.
- **Every file the drive knows about**, by path, on all three storage backends. A `local` mount's tree as it is, a `local-key` mount's flat objects put back under their real names, and an `s3` mount's objects downloaded out of the bucket. An archive never depends on a bucket, credentials, or the storage type staying the same.
- **Every container's `data.db` and `comments.db`** (eigendocs, sheets, slides, stickies, vector drawings, chats), taken freshest-first: an open document's live handle first, then a pending staged upload, then the stored object. A backup taken during an S3 outage holds the newest local bytes, not a stale remote object.
- **File version history** (`versions/` inside a container) and **trash** (`.trash/`). Version history is the only copy of an old file state, so it is always included; trash is data the user can still restore.
- **Thumbnails** (`thumbs/` beside a mount's files). A thumbnail is generated once, when a file is uploaded, and never regenerated, so it is not derived data: an archive without them is a restore that loses every thumbnail the home ever had. They are keyed by path id, which a restore preserves.
- **The home's `settings.json`**, mount configs included, and for S3 mounts that means the access key and secret.
- **Mail as Maildir files** and **contacts as the `.vcf` cards themselves**, so both survive a rebuild of their index database. Empty directories come along too: a mailbox nobody has ever been delivered to still needs its `new/` and `cur/`, because that is what the mail sync watches.
- **Users only**: `auth.json` (the `user`, `account`, `apikey`, `two_factor`, `member` and `team_member` rows for this user, every column carried), `shares.json` (the share-registry rows this user granted), and the user's avatar.

Each database copy is internally consistent. The archive as a whole is not one atomic instant: a mail arriving while the drive is being copied may or may not be in it. That is the standard guarantee for a backup of a running system, and it is why users keep working during one.

## What it does not contain

- **Derived caches**: previews, the `tmp/` scratch dirs, the mount `staging/` folder as a folder (its pending bytes are materialized into the file tree instead, where they win over the stored object), the contacts avatar cache, and the Maildir delivery spool.
- **Sessions.** A restore never signs anybody out, and an archive cannot be used to resurrect a session.
- **Server-level data**: `users3.db`, `eigen.db`, `waitlist.db`, the server config and settings, the avatars folder as a whole, and `.env.production`. A user archive carries that user's own auth rows and nothing else about the server.
- **Other homes.** A user's archive is their home only. Team data lives in the team's home and is covered by the team's own backup, so back a team up separately.
- **Guest homes and org homes.** Guest homes are disposable (guest cleanup deletes them) and an org home holds no databases, so the routes refuse both: a guest or org ownerId gets a 400. Guests are not on the admin Users page either, they have their own page.

## Where the artifacts live, and why they are secrets

The backups folder is `EIGEN_BACKUPS_DIR` if it is set, otherwise `backups` next to the data root. On a Docker install that is `EIGEN_BACKUPS_DIR=/app/backups` inside the container, bind-mounted from `./backups` on the host (`/opt/eigen/backups` on eigen.is). It sits outside `data/` on purpose: a wipe of the data directory cannot take the backups with it, and a future whole-server backup can never recursively include itself. It is the same folder `scripts/backup.sh` writes to.

The server never creates the folder at boot, only when the first backup or upload needs it. Create the host folder yourself before the first `docker compose up`, because a bind-mount source Docker has to create comes out owned by root and the API runs as uid 1000:

```bash
mkdir -p data backups && chown -R 1000:1000 data backups
```

`scripts/update.sh` does the same for an install that predates the folder.

**An archive is a secret, at the level of `.env.production`.** It holds every file and every mail, the user's password hash, their app passwords and API keys, their 2FA secret, and the S3 credentials of every mount they own. Credentials are not stripped, because a backup that cannot restore a mount is not a complete backup. Downloads are admin-only. Anything you copy off the server, keep encrypted, and delete the copy when you are done with it.

## Backing up a home

Admin → Users → pick a user → the **Backup** section (Teams → pick a team → same section). Everything happens there.

**Create backup** starts a background job. It snapshots the home into a staging folder, verifies the folder, packs it into the artifact, and writes a sidecar next to it with the manifest and the verify result. Progress shows in the section while it runs, and the artifact appears in the list when it is done. A backup that does not verify still keeps its artifact, in red, with its failures listed and no Restore button, and the admin who started it gets a notification.

One job per home at a time. A second request while one runs is refused with a 409, so a backup can never read a folder another job is writing. Job state lives in memory and finished jobs drop after an hour; the backups folder and the sidecars are the durable record, so nothing is lost when the API restarts.

The user keeps working: no read-only window and no downtime. The only thing that waits is per document and lasts as long as one copy: capturing a container's `data.db` takes that container's own path lock, so a sync or close of that one document queues behind the copy. Typing is not affected, and no other document is.

## Verifying

Every artifact is verified after the backup that wrote it, on demand from the **Verify** button, and again at the start of every restore. The three stages run over the unpacked folder:

1. **Transport**: every file the manifest lists exists with exactly the stated size and sha256, and the folder holds nothing the manifest does not list.
2. **Structure**: `PRAGMA quick_check` on every database the archive owns, opened read-only. Eigen's own databases only, because a file a user uploaded that happens to be SQLite is stored byte for byte and opening it is not verify's business.
3. **Content**: for the ten largest collab documents plus ten more (a deterministic sample, so two verifies of one folder check the same documents), every Yjs blob in the `data.db` has to decode, and a document that has blobs has to decode into a document with shared types. A document nobody has typed in yet holds no blobs at all and passes. Chat containers are skipped: their `data.db` is not Yjs.

The verdict is written into the sidecar, which is what the artifact list reads. The manifest inside the archive is canonical; the sidecar is a cache.

## Restoring

**Restore** on an artifact replaces that home with the copy inside it. It asks for confirmation first, naming the home, and the dialog says plainly that the home is unavailable while the restore runs, that open editors reload, and that the state the home is in now is kept beside it as a safety copy.

The order is what makes it safe. Nothing is deleted at any point, and nothing is written to `users3.db` until the restored databases have been checked:

1. The home is marked as restoring, which is also the lock against a second restore.
2. The artifact is extracted into the job's staging folder and fully verified. A failure ends the job here, with nothing on the home touched.
3. The home is evicted (every database closed, every timer cancelled) and its collab sockets are closed.
4. The home folder is renamed aside as `{id}.pre-restore-{timestamp}`. If the user was deleted there is no folder to move.
5. The archive's home folder is installed in its place. A `local` mount's files go in as they are, a `local-key` mount's are written to their flat keys, and an `s3` mount's are staged with a pending-upload row each, so the existing upload queue drains them to the bucket with its normal retry and backoff. The user can work at once, and a flaky bucket makes the restore resumable by construction.
6. Every restored database is checked in place: `quick_check`, plus its schema stamp against what this server supports.
7. Only then are the identity rows written: if the `user` row is gone, every row from `auth.json` is inserted in one transaction; if the user is still there, identity is left alone and a restore is refused when the email no longer matches the archive. Missing share-registry rows are inserted, and the avatar is put back only if the server has none.
8. The mark clears. The next load runs migrations if the server is newer, heals contact-card drift, and refreshes shared-with-me. A restored home is opened right away, so a remote mount's queued uploads start draining immediately instead of waiting for the user's next request.

If anything fails after step 4, the half-written folder keeps a name of its own (`{id}.failed-restore-{timestamp}`), the original folder is renamed back, and the job ends failed with the error.

## What the user experiences during a restore

Their home is refused on every surface that resolves it per request: HTTP, SSE, the collab WebSocket, CalDAV, CardDAV and WebDAV all get `503 Restore in progress`. Sessions are untouched, so nobody is signed out; requests simply fail until the mark clears. A restore of a normal home takes seconds to minutes, dominated by the size of the extract.

Open editor tabs are closed with WebSocket code 1012 (`home-replaced`) and reload the page instead of reconnecting. This is deliberate: a tab that reconnected would sync the document it still holds in memory back over the restored copy and silently undo the restore. No editor persists to IndexedDB, so a reload is a clean slate, and the unsynced-edits guard is disarmed first so the reload is not blocked by a "leave without saving?" prompt.

**IMAP is the one exception.** Dovecot runs in its own container and reads the Maildir straight off the shared volume, so a mail client connected while the restore runs keeps working against the folder that was moved aside. Deliveries and flag changes made in that window end up in `{id}.pre-restore-{timestamp}`, not in the restored home. Nothing is lost (the safety copy holds them) but they are not in the live home, so for a mail-heavy restore either stop Dovecot for the window or copy the missing messages out of the safety copy afterwards.

## Safety copies

A safety copy is a complete home folder that a restore left beside the live one, in `data/home/` or `data/team/`:

- `{id}.pre-restore-{timestamp}` is the home exactly as it was before a restore.
- `{id}.failed-restore-{timestamp}` is the half-written folder of a restore that did not finish. It is not a home, so it can only be deleted.

Nothing deletes either automatically. Both are listed in the admin pane with their size, a **Delete** button, and, for a pre-restore copy, a **Restore** button.

A safety copy is complete on S3 homes too. A restore onto a remote mount gives every restored row a storage key of its own and never writes over a bucket object, so the safety copy's `metadata.db` still points at objects that hold its bytes. Two consequences worth knowing:

- **Delete** removes the bucket objects that only that copy references, and leaves anything the live home or another safety copy still points at. If any object cannot be deleted the whole folder is kept and the request answers 503, because the folder is the only record of which objects those bytes belong to. So the bucket holds two generations of the home's bytes until you delete the safety copy.
- **Restore** on a pre-restore copy evicts the home, moves the home as it stands aside as a new pre-restore copy, and renames the chosen copy back. No bytes are written and none are deleted, which is what makes a restore of a restore reversible by hand.

A safety copy of a user who has since been deleted can only be deleted, not restored: the folder on its own would leave a home nobody can sign in to. Restoring a deleted user goes through an artifact, which carries their auth rows.

## Bringing an archive from another machine

Up to 1 GB, use **Upload backup** in the same section. The file has to be named the way this server names artifacts, `home-{ownerId}-{yyyymmdd-hhmmss}.tar.zst`, and the ownerId in the name has to match the home in the archive's own manifest.

Above 1 GB, copy the file into the backups folder by hand (chunked upload is a later phase):

```bash
scp home-<ownerId>-<stamp>.tar.zst you@server:/opt/eigen/backups/
ssh you@server sudo chown 1000:1000 /opt/eigen/backups/home-<ownerId>-<stamp>.tar.zst
```

An artifact that arrives this way has no sidecar, so it lists as **unverified** and the row can say nothing about what is in it. Press **Verify**: the job unpacks it, runs the three stages and writes the sidecar. Restore works on an unverified artifact too, because a restore verifies its own extract before it touches anything, but verify first anyway: that way a bad archive is caught without taking the home offline for it.

## Verifying an archive by hand

An artifact is a plain tar piped through zstd, so any machine with `tar` can read it:

```bash
tar --zstd -tf home-<ownerId>-<stamp>.tar.zst | head          # what is in it
tar --zstd -xf home-<ownerId>-<stamp>.tar.zst -C /tmp/check   # unpack it
jq '{kind, ownerId, name, createdAt, appVersion, counts, mounts}' /tmp/check/home-<ownerId>/manifest.json
```

Everything is inside one `home-{ownerId}/` folder: `manifest.json`, the `home/` tree one-for-one with the home directory, and for a user `auth.json`, `shares.json` and `avatar/`. The manifest lists every file with its size and sha256, which is what stage 1 of the verify re-checks. The server-side sidecar `{artifact}.manifest.json` holds the same manifest plus the last verify result.

## The archive format

An artifact is a plain POSIX tar (pax headers for long paths, empty folders included) streamed through zstd, so any machine with `tar --zstd` reads one and nothing about it is Eigen-specific. Eigen writes the tar itself rather than through `Bun.Archive`; the reason is in `apps/api/src/lib/backup/archive.ts` and matters only to someone changing that file.

## Interrupted restores

A restore writes a marker in its staging folder before it moves the home folder aside. If the process dies between the move and the install, the next boot reads that marker, renames the pre-restore copy back to the home folder, and logs loudly. Staging is wiped afterwards, which is what clears the markers of restores that finished.

A marker lost to a torn write fails safe: the boot recovery does nothing, and the home's data is sitting complete in `{id}.pre-restore-{timestamp}`. Rename it back by hand (or use **Restore** on the safety copy once the home folder exists again).

## Restoring onto an older server

Every restored database is checked against the schema version this build expects, and one that came from a newer server is refused with a message naming both versions. Without that check the archive would land, pass `quick_check`, and then fail the whole home on the next load, long after the job said it was done. So restore an archive on a server at least as new as the one that wrote it, and upgrade the target server first if it is behind.

An `s3` mount additionally needs a `metadata.db` at the schema version that shipped with per-home backup or newer, because restoring a remote mount writes pending-upload rows in a column older archives do not have. Local and `local-key` mounts are not gated this way. No older archive of an `s3` mount can exist, so this only ever fires on a hand-edited one.

## The whole-server stopgap

Per-home backup does not cover the server as a whole: `users3.db`, `eigen.db`, `waitlist.db`, the server config and settings folder, and `.env.production` are all outside a home. Until phase ③ ships, the whole-server backup is still `scripts/backup.sh`, which stops `eigen-api`, tars the quiesced `data/` tree plus `.env.production` (WAL files included, so the never-checkpointed server databases come out crash-consistent), and starts the API again. A few seconds of downtime, no verification, no per-home restore, and its counterpart `scripts/restore.sh` puts a whole tree back. Keep running it on a schedule; [the setup guide](../docker/SETUP-GUIDE.md) has the cron line.

Use per-home backup for what the script cannot do: an archive of one user before a risky change, a verified copy of one home, and a restore that does not take the server down.

## Known limitations

- **A backup fails if a bucket cannot be read.** It fails loudly, naming the mount and the storage error code. That is deliberate: an archive silently missing a mount's objects is worse than no archive. Fix the bucket, then back up again.
- **The IMAP window** described above: mail delivered or flagged during a restore lands in the safety copy.
- **Disk**: a restore transiently needs roughly twice the home's uncompressed size in the backups folder, for the decompressed tar and the extracted tree side by side, on top of the artifact itself. Safety copies then keep a second full copy of the home on the data disk (and, for S3 mounts, a second generation of objects in the bucket) until you delete them.
- **One job per home at a time**, and a safety-copy delete holds the same slot.
- **No scheduling, no retention, no off-server upload, no encryption at rest, and no incremental archives.** Those are phase ③ and later. Anything you want off the machine you copy off yourself, encrypted.
