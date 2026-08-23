# Proposal: Backup, restore & migration

> **Status — Proposal, written 2026-08-21. Not started.** This is the spec for phases ② (per-user backup/restore), ③ (whole-server backup) and ④ (migration) of the backup program agreed 2026-08-20 (see the ROADMAP's "Data integrity + verified backups" row). Phase ① (the admin Users page, the UI surface) shipped 2026-08-21.

> **TLDR**: One primitive does all the work: `snapshotHome` produces a **self-contained, storage-independent archive of one home** — every SQLite database captured with `VACUUM INTO` (never a raw copy of a live WAL file), every S3 object downloaded into the archive, plus the user's auth rows and share-registry rows. Per-user backup is that primitive with a download button. Whole-server backup is a loop over all homes plus the server databases. Migration is a restore pointed at a different server or a different storage backend. Restore is replace-with-a-safety-net: the current home is moved aside, never deleted, until the restored home passes verification.

## Why

Eigen's stated core weakness is "I would not yet trust it with data you cannot afford to lose". Today the only backup is `scripts/backup.sh`, which tars the **live** `data/` tree — no checkpoint, no `-wal`/`-shm` handling — so a tar taken mid-write captures torn SQLite files. eigen.is runs on those torn-capture backups right now.

We also know from three production incidents ([PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md)) that a backup nobody has verified is not a backup: a faithful copy of a corrupt database is a faithful backup of garbage, discovered at restore time, which is the worst possible time.

Finally, two features we want later — moving an instance to a new server, and moving a mount between local disk and S3 — are really the same problem as restore: "take a complete copy of this data and make it live somewhere else". Designing backup as a storage-independent archive gives us those features almost for free.

## The one primitive

Everything in this proposal composes a single function:

```
snapshotHome(ownerId, targetDir) → HomeManifest
```

It walks one home (`data/home/{userId}`, `data/team/{teamId}`, or `data/org/{orgId}`) and writes a complete, consistent, self-describing copy into `targetDir`. Three rules make the copy trustworthy:

1. **Databases are never copied as files.** Every SQLite database is captured with `VACUUM INTO`, which produces a frozen, WAL-complete, defragmented copy even while the source is being written. This is the same mechanism the S3 write-behind pipeline already uses for staging (`ManagedDatabase.stageCopy`).
2. **The freshest bytes win.** For container databases (`data.db` inside eigendocs, chats, sheets…) the source is picked in the same order the versioning code already uses: an open document's live handle first, then a pending staged upload copy, then the stored object. A backup taken during an S3 outage still contains the newest local bytes, not a stale remote object.
3. **The archive is storage-independent.** For S3 mounts, every object is downloaded and materialized into the archive's file tree. The archive never depends on a bucket still existing, credentials still working, or the storage type staying the same. This is the property that later makes migration a restore.

### Live homes vs cold homes

Opening a second connection on a database a live Home holds open is **not safe** — the close path checkpoints and deletes WAL files, and a second connection can silently break that (the full argument is in PROPOSAL_DATA_INTEGRITY § 2). So `snapshotHome` goes through the front door: it opens the home via `getHome(ownerId)` and snapshots each database through the home's own cached handles. For a cold home this warms it up briefly; for a live home it means the backup sees exactly what users see. Open collab documents are captured through `stageCopy` on their live handle.

This is a deliberate difference from the integrity sweep, which reads cold homes from disk to avoid warming hundreds of homes six times a day. A backup runs rarely, and correctness beats warm-cost here. It is also sharding-safe: a backup job runs on the server that owns the home, so `getHome` is always local.

### What consistency you get

Each database copy is internally consistent (that's what `VACUUM INTO` guarantees). The archive as a whole is **not** a single atomic snapshot — a mail arriving while the drive is being copied may or may not be included. That is the same guarantee every file-level backup of a running system gives, and it is fine: every database stands on its own, and cross-database references (a notification pointing at a deleted file) already have to be tolerated at runtime.

## The archive

One directory, then tarred and gzipped into a single artifact:

```
eigen-home-{ownerId}-{timestamp}/
├── manifest.json      what this is, when, from where, and a content listing
├── auth.json          the user's rows from the auth database (users only, not teams)
├── shares.json        share-registry rows where this owner is the sharer
└── home/              mirror of the home directory
    ├── settings.json          (mount configs — including any S3 credentials)
    ├── mounts/
    │   ├── default/
    │   │   ├── metadata.db    (VACUUM INTO copy)
    │   │   └── data/…         (all files; S3 objects materialized here)
    │   └── shared.db          (VACUUM INTO copy)
    ├── eigen.mail/            (mail.db vacuumed + Maildir/ files as-is)
    ├── eigen.contacts/        (contacts.db vacuumed + cards/*.vcf as-is)
    ├── eigen.calendar/        (calendar.db vacuumed)
    └── eigen.notifications/   (notifications.db vacuumed)
```

Not included, on purpose: `thumbs/`, `tmp/`, `staging/`, `versions/` snapshot folders, preview caches, avatar caches, FTS index content. All of it is either derived (regenerated on demand) or transport machinery. The trash **is** included — it counts toward quota and users expect restore to bring it back.

### manifest.json

Small, human-readable, and enough to verify the archive without trusting it:

```json
{
    "formatVersion": 1,
    "kind": "user",
    "ownerId": "a1b2c3d4-…",
    "email": "alice@example.com",
    "createdAt": "2026-08-21T03:00:00Z",
    "server": { "domain": "eigen.is", "orgId": "…", "appVersion": "…" },
    "counts": { "databases": 9, "files": 1842, "bytes": 5312478210 },
    "entries": [ { "path": "home/mounts/default/metadata.db", "bytes": 1048576, "sha256": "…" }, … ]
}
```

The `entries` list carries a size and sha256 per file, so a verify pass can prove the tar survived transport intact. `formatVersion` versions the archive layout itself; the databases inside already carry their own `__schema_version`, so restore-on-a-newer-server just runs the normal migrations on next open, and restore-on-an-older-server is refused by the existing forward-version guard.

### auth.json

A user's identity does not live in their home directory — it lives in `data/server/users3.db` (better-auth). Without it, a restored home is an orphan. So the archive carries the user's own auth rows: the user row, credential accounts, app passwords / API keys, 2FA secrets, and org/team memberships. Sessions are deliberately excluded (they are ephemeral and a restore should not resurrect logins).

### shares.json

Share-registry rows (`data/server/eigen.db`) where this user is the sharer, so that pending shares to not-yet-registered emails survive a restore. Shares *received* need nothing extra: the home's own `shared.db` is in the archive, and the existing reconciliation pull (`shared-with-me`) refreshes anything stale after a restore.

### A warning about credentials

`home/settings.json` contains mount configs, and for S3 mounts that includes the access key and secret. An archive is therefore a secret: it holds every file, every mail, and live storage credentials. Artifacts live in a server-side directory outside `data/` (default `./backups`, next to where `backup.sh` already writes), are admin-only to download, and should be treated like the `.env` file. We do not strip credentials from archives — a backup that cannot restore the mount config is not a complete backup — but the admin UI should say this plainly.

## Verification

A backup is not done until it is verified. After writing the archive, before declaring success:

1. **Transport integrity** — every entry's size and sha256 match the manifest.
2. **Database validity** — `PRAGMA quick_check` on every `.db` in the archive.
3. **Semantic validity** — for a sample of collab containers (and always the largest few), decode the `data.db` into a real Y.Doc and check the declared roots exist and are populated. This is `verifySnapshotDb` from [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md) § 3 — the same primitive, shared, built once.

A failed verify keeps the artifact (it is still evidence) but marks it failed and alerts the admin through the notification center. The admin UI never shows a failed artifact as a usable backup.

## Restore

Restore is **replace, with a safety net**. Restoring merges nothing — merge semantics are a tarpit of edge cases, and "put my account back the way it was at 03:00" is what people actually want.

The steps, in order:

1. **Verify the archive first** — the same three checks as above. A restore never starts from an unverified archive.
2. **Evict the home** — `evictHome(ownerId)` closes every database and cancels timers, the same seam user-deletion already uses. The user is effectively offline for the duration.
3. **Move the current home aside** — rename `data/home/{id}` to `data/home/{id}.pre-restore-{timestamp}`. Nothing is deleted.
4. **Materialize the restored home** — unpack `home/` into place. For `local` mounts the files are already where they belong. For S3 mounts, write each object's bytes as a staged copy plus a `pending_uploads` row, then let the existing `UploadQueue` drain them to the bucket with its normal retry, backoff and per-destination pacing. Reusing the write-behind pipeline means a restore to a flaky bucket is resumable by construction and the user can start working immediately — the same guarantee normal writes have.
5. **Reinsert auth rows** — if the user row is missing (restore-after-deletion), insert the rows from `auth.json`; if present, leave identity alone (same id, sanity-check the email matches). Reinsert missing share-registry rows from `shares.json`.
6. **Verify the result** — open the home, `quick_check` the databases in place, run the shared-with-me reconciliation pull.
7. **Keep the safety net** — the `.pre-restore-*` directory is kept until an admin deletes it (the admin UI shows it with a delete button). Restoring over a restore is thus always reversible by hand.

The one rule that makes restore safe to offer at all: **no step ever deletes bytes that are not already safely copied elsewhere.** The failure mode of every step is "restore didn't finish, old data still on disk, try again".

## Backup jobs, API and UI

Backing up a large S3 home means downloading gigabytes, so backup and restore run as background jobs with progress, not as request handlers. A small in-process job table (id, kind, ownerId, state, progress, error), progress pushed over the existing SSE channel, artifacts listed from the backups directory. No new subsystem — this is the same shape as the transform runner's job bookkeeping, minus the workers.

Routes are server-wide admin surface — the same carve-out as `settings.ts`: no `:ownerId` path segment, protected by `requireAdmin`:

```
POST   /admin/backup/home/:ownerId       start a per-home backup job
POST   /admin/backup/server              start a whole-server backup job (phase ③)
GET    /admin/backup/jobs[/:id]          job list / status
GET    /admin/backup/artifacts           list artifacts (+ verify status)
GET    /admin/backup/artifacts/:id       download (streamed)
DELETE /admin/backup/artifacts/:id       delete an artifact or a .pre-restore safety copy
POST   /admin/backup/restore             restore from a server-side artifact or an uploaded archive
```

UI lives where phase ① prepared for it: the admin Users page detail pane gets a Backup section — "Create backup", a list of this user's artifacts with verify status, download, and "Restore…" behind a typed-confirmation dialog (the `DeleteDialog` pattern). Teams get the same section on the team detail view. A self-service "download my data" takeout button for end-users is a natural later addition — same primitive, stricter rate limits — but is out of scope here.

## Phase ③ — whole-server backup

With the primitive in place, whole-server backup is a loop plus scheduling:

1. Snapshot every home — all users (including guests), all teams, the org home — with `snapshotHome` into one staging directory.
2. Add the server-level data: `users3.db` and `eigen.db` via `VACUUM INTO`, plus `data/server/`'s config and settings JSON files.
3. Tar the staging directory into one artifact, verify it (same three checks, sampled semantics), apply retention (keep the last N, prune oldest), alert on failure.
4. Register it as a scheduled job — `scheduleInterval('server-backup', …)` in the existing scheduler — with the schedule and retention count in server settings, and a "Back up now" button in an admin Settings § Backups section.

Two operational notes. The backups directory must live **outside** `data/` (it does — `./backups`) so a server backup can never recursively include itself. And a backup on the same disk as the data only protects against software failure — the real disaster-recovery story is shipping the artifact off the machine, so the settings should optionally take an S3 destination (endpoint, bucket, credentials — the existing `S3Config` type) to upload finished artifacts to. That destination should be a different bucket/provider than the one the data lives on.

This phase retires `scripts/backup.sh`. It also supersedes PROPOSAL_DATA_INTEGRITY's open question D7 (which sketched keeping backup.sh as a copy-then-tar script): the agreed direction is API-driven, scheduled, verified, with an admin UI. The ROADMAP note stands: eigen.is currently lives on torn-capture backups, so phase ③ must not slip far behind phase ②.

Per-user restore from a server artifact falls out for free: a whole-server artifact contains one `snapshotHome` directory per home, so "restore just Alice from last night's server backup" is the phase-② restore fed from a different source.

## Phase ④ — migration

Two different features, both already paid for.

**Moving to another server.** A whole-server artifact restored onto a fresh machine *is* the migration: unpack every home, import the server databases, done — every user id, share, and team survives because the auth and registry databases move wholesale. A *single-user* move to a different existing server is the per-user restore with one extra step: the user id already exists in nobody's auth DB there, so `auth.json` inserts cleanly; org and team memberships from the old server are dropped (they reference teams that don't exist there) and the user starts team-less. Shares to emails re-resolve through the share registry as recipients sign up, exactly like a normal new-user reconciliation.

**Moving a mount between storage backends** (local ↔ S3, or S3 bucket A → bucket B). This needs no archive at all — it is the materialize/re-upload half of the machinery running live:

1. Admin edits the mount's storage config. Instead of today's behavior, the mount enters a migrating state: reads keep coming from the old backend, writes go to the new one.
2. A background job walks `paths` and copies each object old → new, using the same freshest-first read and the same `UploadQueue` for writes — resumable, paced, retried, per-destination throttled, all for free.
3. When the walk completes and verifies (size/hash per object), the old backend is detached. Old-local files are kept aside like a `.pre-restore` directory; an old bucket is simply left untouched.

The per-destination upload semaphores already exist precisely so that one user's slow personal bucket can't starve anyone else — which is what makes this safe to offer once users can add their own drives.

## Teams, guests, and future user-added drives

- **Teams** are homes (`team_{teamId}`, Drive + Calendar only). The primitive treats them identically; a team backup carries no `auth.json` (a team has no credentials — membership rows travel with each member's user backup). The admin UI exposes team backup on the team detail view.
- **A user's backup is their home only.** Team data a user can see belongs to the team's home and is captured by the team's backup — same ownership boundary the whole product uses. The Users page should say this next to the backup button so nobody thinks a personal backup covers their team's drive.
- **Guests** have homes and are included in whole-server backups; per-guest backup is possible but pointless enough to hide in the UI.
- **User-added drives with their own S3 credentials** change nothing structurally: a mount is a mount, `snapshotHome` walks all of them, credentials ride in `settings.json`, and the per-destination semaphore paces each bucket independently. The one real consequence is size — a user mounting a 500 GB personal bucket makes "materialize everything" expensive. The manifest already records per-mount byte counts, so the backup UI can show the price up front; a per-mount include/exclude choice on the backup form is the escape hatch, with excluded mounts listed in the manifest as not-included so a restore is honest about what it can bring back.

## Open questions

- **B1 — Quiesce the home during backup?** We could block writes for the duration to get a globally atomic snapshot. *Recommendation: no.* Per-database consistency is the honest, standard guarantee; blocking a user's whole account for a gigabytes-long S3 download is far worse than a mail landing mid-backup.
- **B2 — Encrypt artifacts at rest?** They contain credentials and everything else. *Recommendation: not in phase ②* — the artifact directory has the same exposure as `data/` itself on the same disk. Revisit when the off-server upload ships (phase ③): an artifact leaving the machine should support age/GPG-style encryption with a key stored in server config.
- **B3 — Restore into a different ownerId?** "Duplicate Alice's home into Bob's account" enables account-splitting tricks but complicates identity (every `ownerId` embedded in metadata rows must be rewritten). *Recommendation: defer;* single-user migration to another server (where the id keeps its meaning) covers the real need.
- **B4 — Incremental backups?** Whole-archive every time is simple and matches the whole-file re-PUT philosophy of the sync pipeline, but nightly server backups of a large instance will hurt eventually. *Recommendation: ship full archives first;* the manifest's per-entry hashes are exactly what a later incremental mode needs (skip unchanged files against the previous manifest), so nothing here paints us into a corner.

## Phasing

1. **Phase ② — per-user backup/restore (M).** `snapshotHome` + archive format + verify pass (shared `verifySnapshotDb`), job runner + admin routes, restore-in-place with the safety net, Backup section in the Users detail pane. Team backup from the team view rides along since the primitive is owner-kind-agnostic.
2. **Phase ③ — whole-server backup (S–M on top of ②).** The all-homes loop + server DBs, scheduler job + retention + admin Settings section, optional off-server S3 upload of artifacts. Retires `backup.sh`. Must follow ② quickly.
3. **Phase ④ — migration (M).** Server-to-server restore polish (fresh-server bootstrap from a server artifact; single-user cross-server import) and the live mount storage-backend migration job.

Each phase ships independently and each is useful on its own; nothing in ② needs rework for ③ or ④ — that is the point of making the archive self-contained and storage-independent.
