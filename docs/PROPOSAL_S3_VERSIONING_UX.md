# S3 bucket-safety UX (versioning + retention) in the admin app

> **Status — Proposed, not implemented.** Design for review. Follow-on to the async S3 sync work
> (see [SYNC.md](SYNC.md)): that made the upload pipeline safe *given* a sane bucket; this makes the
> bucket sane **from inside the admin app** instead of a warning telling the operator
> to go click around their S3 provider. Surface: the shared `S3ConfigCard`
> (`packages/ui/src/components/layout/mount/s3-config-card.tsx`), already rendered everywhere the admin
> app selects S3 — server-default storage and team mounts.

## Problem

Eigen stores every document/chat/sheet as a SQLite `data.db` the pipeline **re-PUTs whole** on sync.
On an S3 bucket **without versioning**, an accidental overwrite or a buggy/empty PUT is **permanent** —
the likely shape of the 2026-05-30 chat-data-loss incident. With versioning **on** but **no lifecycle
rule**, the opposite failure looms: every sync makes a new object version, old versions accumulate
**without bound**, and storage cost grows forever (the "version bloat" the sync proposal flags).

Today the admin app *detects* this and **punts to the human**. After "Test Connection", `S3ConfigCard`
shows:

> *"Bucket versioning is off. Without it, accidental overwrites of database files … are permanent.
> Enable bucket versioning and a noncurrent-version lifecycle policy **in your S3 provider**."*
> — `s3-config-card.tsx:135-145`

Correct, but **inert**: it asks the admin to leave the app, find their provider's console, and
hand-author a versioning toggle + a lifecycle XML rule. Many won't. So the safety net the whole
sync-resilience effort depends on is left **opt-in via a chore the UI can't verify got done**.

## Goals / non-goals

**Goals**
- When an admin configures S3, **make the safe configuration the easy default** — enable versioning +
  a noncurrent-version expiration rule in **one in-app action**, with the cost/retention trade-off
  explicit, and **verify it took** by reading the bucket state back.
- Keep the existing **detect → warn** behaviour as the honest fallback when the app *can't* fix it
  (insufficient key permissions, incompatible backend).
- Land in the **shared `S3ConfigCard`**, so it covers both the server-default bucket and team mounts
  uniformly (and the first-run setup wizard, if it reuses the card).

**Non-goals**
- Fine-grained / per-prefix lifecycle policies. One sane bucket-wide rule, tunable by retention days.
- Migrating existing un-versioned data. Versioning is prospective; this only protects future writes.
- Surfacing S3 config outside admin. It stays an admin/team-owner operation (Permissions, below).

## Current state (grounded)

- **Selection + check.** `MountForm` renders `S3ConfigCard` when `storageType === 's3'`; "Test
  Connection" calls `POST /settings/s3check` (and the team equivalent) → `checkS3Connection` → returns
  `S3CheckResult` incl. `versioning: 'enabled' | 'suspended' | 'disabled' | 'unknown'`
  (`types/settings.ts`).
- **`S3ConfigCard` is already an admin component.** Rendered by `admin/storage-type-picker.tsx`
  (server-default storage), `admin/mount-dialog.tsx` + `admin/team-detail.tsx` (team mounts). So there
  is no "where should this live" question — the card already sits in the admin S3 flow; we're making
  its existing warning actionable.
- **The read path already does signed bucket-API calls.** `checkS3Versioning`
  (`lib/storage/s3-storage.ts`) hand-rolls an **AWS SigV4-signed GET** to `?versioning`. The signing
  machinery (canonical request, `kSigning`, endpoint handling) already exists — *writing* config is the
  same signing with `PUT` + an XML body + the body's payload hash. So this needs **no new
  infrastructure**, just a generalisation of code that already ships.

## Proposed UX

Turn the inert warning into a **guided, verifiable, reversible** flow inside `S3ConfigCard`, shown after
a successful "Test Connection".

### 1. Bucket-safety panel (always, when `result.ok`)
Replace the warning-only block with a small panel that always states where the bucket stands:

```
Bucket safety
  ✓ Versioning: on          ✓ Old-version cleanup: expire after 30 days
  ⚠ Versioning: off         — without it, overwrites are permanent          [ Enable safe defaults ]
```

- **Both green** → a quiet confirmation, no nag.
- **Versioning off/suspended, or no lifecycle rule** → a one-line risk statement + a primary
  **"Enable safe defaults"** button.

### 2. "Enable safe defaults" (the one-click path)
A small confirm naming the two actions and the one knob:

```
Make this bucket safe for Eigen
  • Turn on bucket versioning            (so overwrites/deletes are recoverable)
  • Expire old versions after [ 30 ] days (so storage doesn't grow forever)

  Keep more history = safer recovery, higher cost. Eigen re-uploads whole files on
  every save, so a heavily-edited doc can generate many versions/day.
                                                   [ Cancel ]   [ Enable ]
```

- **Versioning** is additive/safe → enabled without extra ceremony.
- **The lifecycle rule auto-deletes old versions** → the only destructive-leaning part, so the
  retention number is shown explicitly and it's a deliberate confirm, not a silent toggle.
- On success, re-run the check and flip the panel to all-green. The flow is **verifiable** (we read the
  state back), unlike "go do it in your provider".

### 3. Fallback when the app can't do it (honest degradation)
The in-app action requires the configured key to have **bucket-admin** permissions
(`PutBucketVersioning`, `PutBucketLifecycleConfiguration`). Least-privilege deployments scope the key to
objects only. So:

- On `AccessDenied` / not-supported, **don't fail silently** — collapse to today's message, upgraded to
  **the exact manual steps** ("your access key can't change bucket settings; enable versioning + a
  30-day noncurrent-version expiry in <provider>") with a copy-able lifecycle snippet. Strictly better
  than the status quo even where automation is blocked.
- `versioning: 'unknown'` (backend doesn't expose the API) → manual fallback, hide the button.

### 4. Advanced (collapsed)
A disclosure for operators who want control: retention-days input (default 30, min 1), a read-only view
of the resolved lifecycle rule, and an "Apply" that sets versioning + lifecycle independently. Most
admins never open it; the one-click path covers them.

## Backend design

Small, reuses the existing signing:

1. **Extract `signedS3Request(config, { method, query, body? })`** from `checkS3Versioning` — generalise
   `GET`→any method and the hardcoded empty-body hash → `sha256(body)`. `checkS3Versioning` becomes a
   thin caller; net code shrinks.
2. **`setS3Versioning(config, enabled)`** → `PUT ?versioning` with
   `<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`.
3. **`setS3LifecycleRule(config, { noncurrentDays })`** → `PUT ?lifecycle` with the
   noncurrent-version-expiration rule (+ abort-incomplete-multipart). Same rule documented in
   [SYNC.md](SYNC.md) § Ops.
4. **Route**, admin-gated like the existing `/settings/s3*` (team-scoped for team mounts):
   `POST /settings/s3/harden` (does both, body `{ s3Config, noncurrentDays }`) returning a fresh
   `S3CheckResult`. One endpoint keeps the client simple and the re-check atomic with the change.
5. Map provider errors to a typed result (`{ ok, applied: {versioning, lifecycle}, reason? }`) so the
   UI picks success / partial / permission-denied deterministically.

No new persistent state — it mutates the *bucket*, then re-reads it. Works on any S3 backend that
implements the versioning + lifecycle APIs (AWS, MinIO, Hetzner, R2); others degrade to the manual
fallback.

## Permissions

Flipping bucket config is privileged. Gate by the owner of the S3 config being edited — the same gates
already used for the corresponding mount config:
- **Server-default S3** → server admin (`requireAdmin`), like `POST /settings/s3config`.
- **Team-mount S3** → team owner/admin, like `POST /team/:ownerId/mount`.

## Open questions / decisions

- **D1 — Default retention.** 30 days (recovery-safe) vs 7 (cost-lean) vs a count cap
  (`NewerNoncurrentVersions`, not universally supported across S3-compatible backends).
  *Recommendation:* default 30, exposed + adjustable; revisit once WAL-shipping removes the whole-file
  churn that drives version bloat.
- **D2 — Auto-offer vs explicit button.** Auto-running on detect is friendlier but surprising for a
  destructive-leaning change. *Recommendation:* always-visible status panel + explicit one-click button
  + confirm step — no silent mutation.
- **D3 — Surface in the first-run setup wizard too?** Setup already runs `checkS3Connection`. If the
  wizard reuses `S3ConfigCard`/`MountForm`, it inherits this for free; if it has a bespoke S3 form, add
  the panel there so a bucket is hardened at the moment it's first configured. *Recommendation:* yes,
  via the shared card.

## Phasing

1. **Backend:** `signedS3Request` extraction + `setS3Versioning` / `setS3LifecycleRule` +
   `POST /settings/s3/harden` + typed result. Unit-test against MinIO (`scripts/s3-local/` already
   exists).
2. **Shared card:** the bucket-safety panel + "Enable safe defaults" confirm + permission-denied
   fallback in `S3ConfigCard`; every admin S3 surface (server default, team mounts, setup) gets it.

## Testing

- MinIO integration (`scripts/s3-local/`): enable versioning, apply lifecycle, read both back; assert
  the panel flips to green.
- Permission-denied: a key without bucket-admin perms → typed `AccessDenied` → manual fallback shown,
  button hidden.
- Idempotency: "Enable safe defaults" twice is a no-op the second time.
- Backend variance: `versioning: 'unknown'` path hides the button and shows manual steps.
