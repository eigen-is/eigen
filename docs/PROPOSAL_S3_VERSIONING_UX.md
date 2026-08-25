# S3 bucket-safety UX (versioning + retention) in the admin app

> **Status — Proposed, not implemented.** Design for review; reconciled against code 2026-07-06
> (post storage-audit: `s3-minio.test.ts` live suite and the `S3Storage.size()` fix shipped, neither
> overlaps this work — detection is still versioning-only, the one-click fix is still 0%).
> Follow-on to the async S3 sync work (see [SYNC.md](SYNC.md)): that made the upload pipeline safe
> *given* a sane bucket; this makes the bucket sane **from inside the admin app** instead of a warning
> telling the operator to go click around their S3 provider. Surface: the shared `S3ConfigCard`
> (`packages/ui/src/components/mount/s3-config-card.tsx`), already rendered everywhere S3 is
> configured — server-default storage, team mounts, and the first-run setup wizard.

## Problem

Eigen stores every document/chat/sheet as a SQLite `data.db` the pipeline **re-PUTs whole** on sync.
On an S3 bucket **without versioning**, an accidental overwrite or a buggy/empty PUT is **permanent** —
the likely shape of the 2026-05-30 chat-data-loss incident. With versioning **on** but **no lifecycle
rule**, the opposite failure looms: every sync makes a new object version, old versions accumulate
**without bound**, and storage cost grows forever (the "version bloat" the sync proposal flags).

Today the admin app *detects* the versioning half of this and **punts to the human**. After "Test
Connection", `S3ConfigCard` shows (when versioning is `disabled`/`suspended`):

> *"Bucket versioning is off. Without it, accidental overwrites of database files … are permanent.
> Enable bucket versioning and a noncurrent-version lifecycle policy **in your S3 provider**."*

Correct, but **inert**: it asks the admin to leave the app, find their provider's console, and
hand-author a versioning toggle + a lifecycle rule. Many won't. So the safety net the whole
sync-resilience effort depends on is left **opt-in via a chore the UI can't verify got done**.
And the lifecycle half isn't even detected — a versioned bucket with no expiry rule shows no
warning at all today.

## Goals / non-goals

**Goals**
- When an admin configures S3, **make the safe configuration the easy default** — enable versioning +
  a noncurrent-version expiration rule in **one in-app action**, with the cost/retention trade-off
  explicit, and **verify it took** by reading the bucket state back.
- Keep the existing **detect → warn** behaviour as the honest fallback when the app *can't* fix it
  (insufficient key permissions, backend without the APIs, a foreign lifecycle config we must not touch).
- Land in the **shared `S3ConfigCard`**, so it covers the server-default bucket, team mounts, and the
  setup wizard uniformly.

**Non-goals**
- Fine-grained lifecycle policies. One sane rule (prefix-scoped when the mount has a prefix), tunable
  by retention days.
- Merging into or editing a **pre-existing foreign lifecycle configuration**. `PutBucketLifecycleConfiguration`
  replaces the whole config; if rules we didn't author exist, we punt to manual instructions rather
  than clobber or parse-merge someone else's rules.
- Migrating existing un-versioned data. Versioning is prospective; this only protects future writes.
- Surfacing S3 config outside the admin app. It stays where S3 config already lives (Permissions, below).

## Current state (grounded, 2026-07-06)

- **Selection + check.** `MountForm` (`packages/ui/src/components/mount/mount-form.tsx`) renders
  `S3ConfigCard` when `storageType === 's3'`; "Test Connection" calls the card's injected `onCheck`.
  There are exactly **two** check routes, both stateless (S3 config in the body):
  `POST /settings/s3check` (`routes/settings.ts`, `requireAdmin`) and `POST /setup/s3check`
  (`routes/setup.ts`, gated by `isSetupRequired()` — first run only). There is **no team-scoped
  s3check route**: the team-mount UI (`admin/team-detail.tsx`) calls the admin-gated one via
  `useCheckS3Connection` (`packages/lib/src/core/settings/hooks/use-s3-check.ts`).
  Both routes run `checkS3Connection` → `S3CheckResult` incl.
  `versioning: 'enabled' | 'suspended' | 'disabled' | 'unknown'` (`packages/lib/src/types/settings.ts`).
- **All S3 surfaces live in the admin app and share the card.** `admin/storage-type-picker.tsx`
  (server-default storage; also reused by `admin/setup-wizard.tsx`, wired to `/setup/s3check`) and
  `MountForm` via `admin/mount-dialog.tsx` + `admin/team-detail.tsx` (team mounts). So there is no
  "where should this live" question — we're making the card's existing warning actionable, and every
  surface inherits it.
- **The read path already does signed bucket-API calls.** `checkS3Versioning`
  (`apps/api/src/lib/storage/s3-storage.ts`, module-private, called by `checkS3Connection`) hand-rolls
  an **AWS SigV4-signed GET** to `?versioning` (path-style, 5 s timeout; any non-2xx or thrown error →
  `'unknown'`, so `'unknown'` conflates "no permission to read" with "API not implemented"). The signing
  machinery (canonical request, `kSigning`, endpoint normalisation) already exists — *writing* config is
  the same signing with `PUT` + an XML body + the body's payload hash, and *reading lifecycle* is the
  same GET with `?lifecycle`. No new infrastructure, just a generalisation of code that already ships.
- **Lifecycle state is not detected.** `S3CheckResult` has no lifecycle field; the card never warns
  about unbounded version growth. Detection of the cleanup half is **new work in this proposal**.
- **The manual rule is documented.** [SYNC.md](SYNC.md) § Ops has the exact `aws s3api` lifecycle
  snippet (rule ID `expire-noncurrent-versions`, `NoncurrentDays: 30`,
  `AbortIncompleteMultipartUpload: 7 days`) — the in-app rule below is the same rule, applied and
  verified from the UI.

## Proposed UX

Turn the inert warning into a **guided, verifiable** flow inside `S3ConfigCard`, shown after a
successful "Test Connection".

### 1. Bucket-safety panel (always, when `result.ok`)
Replace the warning-only block with a small panel that always states where the bucket stands:

```
Bucket safety
  ✓ Versioning: on          ✓ Old-version cleanup: expire after 30 days
  ⚠ Versioning: off         — without it, overwrites are permanent          [ Enable safe defaults ]
  ⚠ Versioning: on          — but no cleanup rule; old versions grow forever [ Enable safe defaults ]
```

- **Both green** → a quiet confirmation, no nag.
- **Versioning off/suspended, or no Eigen cleanup rule** → a one-line risk statement + a primary
  **"Enable safe defaults"** button.
- **`versioning: 'unknown'`** (key can't read bucket config, or API not implemented) → today's manual
  warning, upgraded with exact provider steps; **no button** (a key that can't read bucket config
  can't write it).
- **Foreign lifecycle rules present** (a lifecycle config exists that Eigen didn't author) → versioning
  line as measured; cleanup line says an existing lifecycle configuration was found and shows the manual
  rule to add (copyable snippet); the button only applies the versioning half.

### 2. "Enable safe defaults" (the one-click path)
A small confirm naming the actions and the one knob:

```
Make this bucket safe for Eigen
  • Turn on bucket versioning            (so overwrites/deletes are recoverable)
  • Expire old versions after [ 30 ] days (so storage doesn't grow forever)

  Versioning applies to the whole bucket. Keep more history = safer recovery,
  higher cost. Eigen re-uploads whole files on every save, so a heavily-edited
  doc can generate many versions/day.
                                                   [ Cancel ]   [ Enable ]
```

- **Versioning** is additive/safe → enabled without extra ceremony (the confirm notes it is
  bucket-wide — relevant when the mount uses a `prefix` into a shared bucket).
- **The lifecycle rule auto-deletes old versions** → the only destructive-leaning part, so the
  retention number (default 30, min 1) is shown explicitly and it's a deliberate confirm, not a
  silent toggle. When the mount config has a `prefix`, the rule is **scoped to that prefix** so Eigen
  never expires another tenant's object versions in a shared bucket; without a prefix it is
  bucket-wide.
- On success, the response carries the **re-read** bucket state and the panel flips green. The flow is
  verifiable, unlike "go do it in your provider".
- **Re-click is a no-op**: versioning already `enabled` → skip the PUT; our rule already present
  (matched by rule ID) → re-PUT only if the retention days changed.

### 3. Fallback when the app can't do it (honest degradation)
The in-app action requires the configured key to have **bucket-admin** permissions
(`s3:PutBucketVersioning`, `s3:PutLifecycleConfiguration`), and a provider that implements both APIs.
Least-privilege deployments scope the key to objects only; some providers don't implement the APIs at
all (see Provider behaviour). So:

- On `AccessDenied` / `NotImplemented` / any non-2xx, **don't fail silently** — show which half failed
  and why, with **the exact manual steps** ("your access key can't change bucket settings; enable
  versioning + a 30-day noncurrent-version expiry in your provider") and the copyable lifecycle snippet
  from SYNC.md § Ops. Strictly better than the status quo even where automation is blocked.
- **Partial application is a first-class outcome**, not an error page: versioning enabled but the
  lifecycle PUT refused leaves the bucket *safer than before* but with unbounded growth — the panel
  must show green versioning + amber cleanup + manual instructions for the remaining half.

## Backend design

Small, reuses the existing signing. All in `apps/api/src/lib/storage/s3-storage.ts` next to
`checkS3Versioning`:

1. **Extract `signedS3Request(config, { method, query, body? })`** from `checkS3Versioning` —
   generalise `GET` → any method and the hardcoded empty-body hash → `sha256(body)` (the body hash goes
   into both the `x-amz-content-sha256` header and the canonical request; `PUT ?lifecycle` additionally
   requires a `Content-MD5` header on AWS — include it always, it's ignored where optional).
   `checkS3Versioning` becomes a thin caller; net code shrinks.
2. **`checkS3Lifecycle(config)`** → `GET ?lifecycle`. Returns
   `'none'` (404 `NoSuchLifecycleConfiguration`) | `{ noncurrentDays }` (a rule with ID
   `eigen-expire-noncurrent` is present — regex extraction is fine, we authored the doc) |
   `'foreign'` (a config exists without our rule ID) | `'unknown'` (non-2xx/`AccessDenied`/timeout).
   Called from `checkS3Connection`; extends `S3CheckResult` with
   `lifecycle?: 'none' | 'foreign' | 'unknown' | { noncurrentDays: number }`.
3. **`setS3Versioning(config)`** → `PUT ?versioning` with
   `<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`. (No disable path —
   we never suspend versioning.)
4. **`setS3LifecycleRule(config, noncurrentDays)`** → `PUT ?lifecycle` with a single rule, ID
   `eigen-expire-noncurrent`: `NoncurrentVersionExpiration.NoncurrentDays` +
   `AbortIncompleteMultipartUpload.DaysAfterInitiation: 7`, `Filter` = the mount's `prefix` (with
   trailing `/`) when set, empty otherwise. Same rule as [SYNC.md](SYNC.md) § Ops.
   **Precondition enforced by the route, never inside this function:** only PUT when the current
   lifecycle state is `'none'` or already ours — `PutBucketLifecycleConfiguration` **replaces the whole
   configuration**, so a `'foreign'` state must short-circuit to the manual fallback.
5. **`hardenS3Bucket(config, noncurrentDays)`** orchestrates: read state → versioning PUT if needed →
   lifecycle PUT if `'none'`/ours → **re-read both** → return
   `{ ok, versioning, lifecycle, applied: { versioning: boolean, lifecycle: boolean }, reason?: 'access-denied' | 'not-supported' | 'foreign-lifecycle' | 'error' }`
   (a superset of `S3CheckResult`, shared type in `packages/lib/src/types/settings.ts`). Versioning
   first, lifecycle second: if lifecycle fails the bucket is at worst safer-but-growing (surfaced as
   partial), whereas some backends reject noncurrent-version rules on an unversioned bucket.
6. **Routes**, exactly mirroring the two existing check routes (stateless, S3 config in body — this is
   inherently **per-bucket**, so it serves server-default and team mounts alike; no per-mount route
   needed):
   - `POST /settings/s3harden` (`routes/settings.ts`, `requireAdmin`, body
     `{ ...s3ConfigBody, noncurrentDays }`) — note sibling naming `s3check`/`s3config`, not `s3/harden`.
   - `POST /setup/s3harden` (`routes/setup.ts`, `isSetupRequired()` gate) — the wizard already lets the
     unauthenticated first-run visitor write a test object via `/setup/s3check`; hardening at the moment
     the bucket is first configured is the same trust level and the best moment to do it.
   Both return the typed harden result so the UI picks success / partial / denied deterministically.
7. **Frontend**: `useHardenS3Bucket` mutation next to `useCheckS3Connection`
   (`packages/lib/src/core/settings/hooks/use-s3-check.ts`); `S3ConfigCard` grows an `onHarden` prop
   injected per surface exactly like `onCheck` (settings route in admin surfaces, setup route in the
   wizard).

No new persistent state — it mutates the *bucket*, then re-reads it.

## Permissions

Flipping bucket config is privileged, but the route is stateless over caller-supplied credentials —
the gate only controls *who can drive Eigen's UI to do it*. Mirror the check routes exactly:
server admin (`requireAdmin`) on `/settings/s3harden`, first-run gate on `/setup/s3harden`. All
current S3-config surfaces (server default, team mounts, wizard) already run their checks through
these same two gates — team mounts have no team-scoped check route today, so this proposal doesn't
invent one. If a team-owner-facing mount UI ever appears outside the admin app, it adds a
`requireTeamAdmin` twin then.

## Provider behaviour (what "honest degradation" must cover)

- **AWS S3 / Hetzner Object Storage (Ceph RGW) / other Ceph-based**: both APIs supported;
  versioning can be enabled on an existing bucket. This is the eigen-drive prod case (nbg1).
- **MinIO**: `PutBucketVersioning` on an existing bucket works on erasure-coded backends (incl.
  modern single-node single-drive, which `scripts/s3-local` runs); **legacy filesystem-mode servers
  return `NotImplemented`** → `not-supported` fallback.
- **Cloudflare R2, GCS S3-interop**: no S3 bucket-versioning API (unverified for changes after
  2026-01) → the existing `GET ?versioning` already yields `'unknown'` there, the button never shows.
- **Backblaze B2**: versioning is native/always-on through the S3 layer; lifecycle exists but with
  quirks — whatever the reads report drives the panel; no special-casing.

The design never keys on provider names — it keys on the **measured responses** (`'unknown'`,
`AccessDenied`, `NotImplemented`, `'foreign'`), which is what makes the degradation honest.

## Open questions / decisions

- **D1 — Default retention.** 30 days (recovery-safe) vs 7 (cost-lean) vs a count cap
  (`NewerNoncurrentVersions`, not universally supported across S3-compatible backends).
  *Recommendation:* default 30 (matches the documented SYNC.md rule), exposed + adjustable; revisit
  once WAL-shipping removes the whole-file churn that drives version bloat.
- **D2 — Auto-offer vs explicit button.** Auto-running on detect is friendlier but surprising for a
  destructive-leaning change. *Recommendation:* always-visible status panel + explicit one-click button
  + confirm step — no silent mutation.
- **D3 — Foreign lifecycle configs.** Parse-merge-write would preserve foreign rules but means
  round-tripping arbitrary provider XML — a clobber bug here deletes someone else's retention policy.
  *Recommendation:* never write over a foreign config; manual fallback with the snippet. Cheap, safe,
  and rare in practice (a bucket with hand-authored lifecycle rules has an operator who can add one more).

## Phasing

1. **Backend:** `signedS3Request` extraction + `checkS3Lifecycle` (extends `S3CheckResult`) +
   `setS3Versioning` / `setS3LifecycleRule` / `hardenS3Bucket` + the two routes + typed result.
2. **Shared card:** the bucket-safety panel + "Enable safe defaults" confirm + partial/denied
   fallbacks in `S3ConfigCard`, `onHarden` wired on every surface (server default, team mounts, setup).

## Testing

Extend the existing MinIO-gated live suite (`apps/api/src/test/storage/s3-minio.test.ts`, opt-in via
`S3_TEST_ENDPOINT`, harness in `scripts/s3-local/`):

- Happy path: harden a fresh bucket → versioning `enabled`, lifecycle `{ noncurrentDays: 30 }` read
  back; panel state derivable from the returned result.
- Idempotency: harden twice → second run applies nothing (`applied: { versioning: false, lifecycle: false }`),
  still `ok`.
- Retention change: harden with 30 then 7 → our rule re-PUT with 7, still exactly one rule.
- Foreign lifecycle: pre-seed a rule with a different ID → harden applies versioning only, returns
  `reason: 'foreign-lifecycle'`, and the pre-seeded rule is untouched (read it back).
- Prefix scoping: config with `prefix` set → the stored rule's `Filter` carries the prefix.
- Permission-denied: a MinIO user with an object-only policy → typed `access-denied`, bucket unchanged.
- Route gating (network-free, in `settings.test.ts` conventions): non-admin on `/settings/s3harden` →
  403; `/setup/s3harden` after setup completed → 403.
