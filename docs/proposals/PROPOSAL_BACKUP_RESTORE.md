# Proposal: Backup, restore & migration

This proposal designs what is left of moving Eigen's data: a mount that moves between storage backends while it keeps serving.

> **Status:** per-home and whole-server backup and restore are built, and so is a restore onto another server, of the whole server or of one home; [BACKUP.md](../BACKUP.md) describes them. This page designs the live move of a mount between storage backends (phase ④), the per-mount choice for user-added drives, and two open questions. None of it is built.

## Moving a mount between storage backends

A move is local ↔ S3, or S3 bucket A → bucket B. It needs no archive at all — it is the materialize/re-upload half of the machinery running live:

1. Admin edits the mount's storage config. Instead of today's behavior, the mount enters a migrating state: reads keep coming from the old backend, writes go to the new one.
2. A background job walks `paths` and copies each object old → new, using the same freshest-first read and the same `UploadQueue` for writes — resumable, paced, retried, per-destination throttled, all for free.
3. When the walk completes and verifies (size/hash per object), the old backend is detached. Old-local files are kept aside like a `.pre-restore` directory; an old bucket is simply left untouched.

The per-destination upload semaphores already exist precisely so that one user's slow personal bucket can't starve anyone else — which is what makes this safe to offer once users can add their own drives.

## User-added drives

- **User-added drives with their own S3 credentials** change nothing structurally: a mount is a mount, `snapshotHome` walks all of them, credentials ride in `settings.json`, and the per-destination semaphore paces each bucket independently. The one real consequence is size — a user mounting a 500 GB personal bucket makes "materialize everything" expensive. The manifest already records per-mount byte counts, so the backup UI can show the price up front; a per-mount include/exclude choice on the backup form is the escape hatch, with excluded mounts listed in the manifest as not-included so a restore is honest about what it can bring back.

## Open questions

- **B3 — Restore into a different ownerId?** "Duplicate Alice's home into Bob's account" enables account-splitting tricks but complicates identity (every `ownerId` embedded in metadata rows must be rewritten). *Recommendation: defer;* single-user migration to another server (where the id keeps its meaning) covers the real need.
- **B4 — Incremental backups?** Whole-archive every time is simple and matches the whole-file re-PUT philosophy of the sync pipeline, but nightly server backups of a large instance will hurt eventually. *Recommendation: ship full archives first;* the manifest's per-entry hashes are exactly what a later incremental mode needs (skip unchanged files against the previous manifest), so nothing here paints us into a corner.

## Phasing

Phase ④, migration (M): the live mount storage-backend migration job.
