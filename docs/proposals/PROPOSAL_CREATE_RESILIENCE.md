# Create/open resilience under degraded storage

> **Status — Proposal, written 2026-07-05, not started.** Re-verified against main 2026-07-06,
> after the storage-audit fixes (AUDIT_STORAGE.md items 1–11; doc removed after everything shipped, see git history) landed: nothing
> in this design has shipped, and the traces below still hold — the metadata.db v7 unique
> active-name index and `provisionManagedDbs`' inner rollback are in main as described, and the
> audit's `ManagedDatabase` failed-open cleanup/handle release only closes fd leaks (the
> create-path `exists` throw happens before any handle opens), changing nothing here.
> Design for the ROADMAP.md P1 row
> "Create/open resilience under degraded storage" (2026-07-03 incident follow-up). Companion to
> [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md) (written concurrently): that one finds and
> repairs damage in the background; this one stops the damage-shaped UX at the two request paths the
> 2026-07-03 incident actually hit — create and open. Uploads needed neither: they were already made
> safe by the write-behind queue ([SYNC.md](../SYNC.md)). No frozen-format impact anywhere in this design.

## Problem

2026-07-03, ~15:10–15:35 UTC: Hetzner nbg1 Object Storage degraded (slow, then 503
`Service is unable to handle request`) and recovered on its own. Two new testers were live on it:

- "New doc" showed **`Internal server error (500)`** — yet the doc existed server-side, appearing
  only after a manual refresh. The tester re-clicked and **created duplicate docs**.
- A sticky card posted **only on the 4th attempt**.
- Existing docs took **~a minute to open**, behind a generic spinner.

A read-only orphan scan of the affected home afterwards found **0 orphaned containers** — nothing was
lost, so this is UX/resilience work plus latent hardening, not recovery. The asymmetry is the story:
*edits* to existing documents rode out the outage invisibly, because every `data.db` sync goes through
the durable per-mount `UploadQueue` (staged copy + retry/backoff, [SYNC.md](../SYNC.md)). *Create* and
*open* still call storage synchronously on the request path, so the same 25-minute blip that uploads
absorbed silently became user-visible 500s, duplicates, and minute-long spinners.

## What actually happens (grounded trace)

**Create.** `POST /drive/:ownerId/:mountId/folder/:pathId/create/:type` (`../../apps/api/src/routes/drive.ts`)
→ `Drive.create` (`../../apps/api/src/lib/drive/drive.ts`), which runs in this order:

1. `mount.createFolder` — **commits the container `paths` row** (metadata-only; S3 mounts have no
   `mkdir`, so this step cannot fail from storage).
2. Provisioning — `ChatRoom.create` (`lib/chat/chat.ts`) or `CollabDocument.create`
   (`lib/collab/collabDocument.ts`), both via `Drive.provisionManagedDbs`: `touchFile` +
   `Mount.createDatabase` per managed db. `buildDocumentDb` (`lib/mount/document-db.ts`, mode
   `create`) calls `mount.storage.exists(storageKey)` — and `S3Storage.exists`
   (`lib/storage/s3-storage.ts`) has no try/catch, so Bun's `S3File.exists()` throwing on a provider
   503 propagates. `provisionManagedDbs` already rolls back **its own** rows on failure; the step-1
   container row is the unguarded remainder.
3. For chats only: `Drive.seedCommentRow` → `openCommentIndex` (`lib/chat/comment-index.ts`) →
   `drive.openDatabase` on the **parent board's** `comments.db` — a cold S3 GET / `exists` on the
   request path, *after* the chat container is fully provisioned.
4. `this.emit(SSEventType.DRIVE_FILE_CREATED, created)` — **only reached on full success.**

Any throw in steps 2–3 hits Elysia's `onError` fallback (`../../apps/api/src/app.ts`): a non-`ApiError`
becomes status 500 with body `'Internal server error'` — via `AppError`/`onMutationError`
(`../../packages/lib/src/core/api-error.ts`) that renders as the exact toast the testers quoted,
`Internal server error (500)`. Because the emit is step 4, these failed-after-commit creates
broadcast no container event: the committed row is invisible to every listing until a manual refetch. That is
the incident, mechanically: doc creates that threw in step 2 left a visible-after-refresh container
(the duplicate trap); card-chat creates that threw in step 3 left a **fully valid chat container no
card references** (§4 below) — which is also why the orphan scan found 0: those containers *have* a
`data.db`.

**Open.** The editor routes (shared scaffold `useEigenDocEditorRoute`,
`../../packages/ui/src/hooks/use-eigen-doc-editor-route.ts`) fetch `GET /collab/:o/:m/:p/info` — metadata +
ACL only, fast even mid-outage — then connect the collab WebSocket. The WS `open` handler
(`../../apps/api/src/routes/collab.ts`) calls `drive.getCollabDocument` → `CollabDocument.init` →
`openDatabase`, whose `onOpen` does the cold S3 GET of `data.db`. That GET is the ~1-minute open. The
client (`../../apps/docs/src/components/docs/editor.tsx` and its three siblings) renders `LoadingState`
until y-websocket's `sync` event; on server failure the WS closes `1008 'Failed to open document'`
and y-websocket silently reconnects forever — slow storage, erroring storage, and a genuinely broken
doc all look like the same infinite spinner. Worse, `useCollabDocumentInfo`
(`../../packages/lib/src/core/collab/hooks/use-collab.ts`) deliberately maps *every* error — 503s included —
to `{ canRead: false }`, so an infrastructure failure on the info call renders `RequestAccessView`:
"request access" for a doc the user owns.

**Timeouts.** There is no client-side timeout: the Eden Treaty client (`../../packages/lib/src/core/api.ts`)
sets only `credentials: 'include'`. The Caddyfile defines no `reverse_proxy` timeouts (Caddy defaults
to none). The one candidate in the chain is Bun's serve `idleTimeout` (not set in
`../../apps/api/src/index.ts`, Bun's default is ~10 s) — but a severed socket surfaces as a fetch rejection
("Failed to fetch"), not the `Internal server error (500)` the testers quoted, so the incident's 500s
were real API responses, per the trace above. Whether `idleTimeout` bites genuinely slow (>10 s)
requests is **unverified** — flagged in Open Questions.

### Corrections to the roadmap's dated section

Reading the source contradicts the 2026-07-03 section of [ROADMAP.md](../ROADMAP.md) on three points
(its line-number pointers have also drifted; this proposal supersedes them with symbols):

1. **"Slow-but-successful creates the client/proxy timed out on"** — no client or proxy timeout
   exists to fire. The 500s match the API's own `onError` fallback for post-commit throws inside
   `Drive.create` (steps 2–3 above). The docs-invisible-until-refresh symptom follows from the SSE
   emit being unreached, not from a timeout.
2. **"Orphaned container … later opens 503 via the `mustExist` guard"** — a container row with *no*
   `data.db` child does not 503: `CollabDocument.init` and `ChatRoom.init` both re-run `create` when
   `getChildByName('data.db')` returns null, so it **self-heals on the first open after storage
   recovers** (and 500s during the outage). The 503 shape is the *dead-letter row* — a `data.db`
   `paths` row whose storage object is missing/empty — refused by the storage-exists checks in
   `buildDocumentDb` and the `mustExist` guard in `ManagedDatabase.openCold`
   (`lib/core/managed-database.ts`). That is precisely what `provisionManagedDbs`' inner rollback
   already prevents; §2's outer rollback closes the remaining cosmetic-but-confusing shape.
3. **The sticky card's 4 attempts** are grounded to step 3 (`seedCommentRow`), the only storage-touching
   step after the chat container is complete — which is what makes the litter *valid* chat containers
   the orphan scan cannot see (roadmap §3 already infers this correctly).

## Goals / non-goals

**Goals**

1. One user intent = one document, under any storage weather: pending state while a create is in
   flight, and a **reconcile-before-error** step so a create that succeeded server-side is presented
   as a success, never as a failure that invites a duplicating retry.
2. `Drive.create` is atomic: a hard provisioning failure leaves no `paths` row and no SSE ghost;
   a retry starts clean.
3. Honest open path: "storage is slow, retrying" is distinguishable from "not found" and from
   "no access".
4. (Optional) Sweep up the existing dangling card-chats and stop making new ones.

**Non-goals**

- Making create/open *fast* under a degraded backend (e.g. moving provisioning behind the upload
  queue). Create writes through the queue already (`flush` → stage + enqueue); the residual synchronous
  calls are `exists` probes and the open-path GET, which are inherent to strict-open semantics.
- Client-side automatic retry of create POSTs. Reconcile replaces retry (see Q1).
- Offline/queued creates. Eigen assumes a reachable API; this is about a degraded *storage* backend.
- §4 of the roadmap section (author-name consistency) — separate cheap win, since completed and
  pruned from the roadmap (2026-07-05).

## 1 — Frontend create UX

All "new doc/board/sheet/chat" entry points (drive New menu, palette `create.*` commands, the four
eigendoc sidebars, chat sidebar) funnel into the shared `DriveCreateEigenDoc` dialog
(`../../packages/ui/src/components/drive/drive-create-eigendoc.tsx`) → `useCreateDriveItem`
(`../../packages/lib/src/core/drive/hooks/writes.ts`). One dialog, one hook — one place to fix.

**Pending state.** Today `DriveLocationPicker.handleSubmit` calls `onConfirm(...)` and
`onOpenChange(false)` synchronously: the dialog closes before the request resolves, so the user has
*nothing* on screen during a slow create — the duplicate trap. Change the picker's `onConfirm` to
`void | Promise<void>`, await it in `handleSubmit` behind a local `busy` state that disables the
confirm button (spinner label), and close only on resolve. Reject keeps the dialog open. Because
Move to…/Copy to…/Save-as flows share this picker, they inherit the pending guard for free.

**Reconcile before error.** Per CODE-STANDARDS this lives in the hook, not the dialog. Wrap the
mutation function:

```typescript
// useCreateDriveItem mutationFn, sketch
try {
    return await post(fileName, { signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
} catch (err) {
    const found = await findCreatedChild(ownerId, mountId, parentId, fileName, type);
    if (found) return found; // server won the race — present success
    throw err;
}
```

- `CREATE_TIMEOUT_MS` ≈ 15 s bounds the pending state (today an unbounded fetch would pin the dialog
  forever). Eden Treaty accepts per-call fetch options; if the signal can't be threaded there, a
  plain `AbortController` in the hook does the same.
- `findCreatedChild` refetches the parent folder listing directly (same endpoint
  `useFolderContents` uses) and matches by the name the client itself sent —
  `Drive.create` derives the stored name as `fileName + DRIVE_EXTENSIONS[type]` deterministically.
  Match after `.normalize('NFC')` on the client string — `validateName` (`lib/mount/helpers.ts`)
  stores names NFC-normalized, so a decomposed-unicode input would otherwise miss and falsely toast.
  Poll 2–3 times over ~10 s: a slow-but-successful create may land after the abort.
- Only when reconcile comes up empty does the mutation reject → `onMutationError` toasts. The toast
  copy is honest about the remaining ambiguity: *"Storage is responding slowly — creation may still
  complete; it will appear in the list automatically."* (True: on late success the server emits
  `DRIVE_FILE_CREATED`, and the existing handler in `../../packages/lib/src/core/drive/sse-handlers.ts`
  invalidates both the folder listing and the per-mime listing the eigendoc sidebars use.)
- On the reconciled-success path, skip `window.open` (the user gesture is long gone; popup blockers
  would eat it anyway) — the row appearing in the listing plus the dialog closing is the feedback.

The SSE event needs no bespoke listener in the hook: reconcile is a direct refetch, deterministic and
testable; SSE remains the ambient mechanism that keeps *other* views (and late successes) consistent.

**Idempotency (Q1, decided).** Two options were on the table: **(a)** reconcile-only, no API change;
**(b)** a client-generated idempotency key on the create route, deduped server-side. **Recommendation:
(a).** Reasoning: the observed duplicate class is a *human* retry after a false failure — pending
state plus reconcile removes the false failure, and the disabled confirm button removes the double
submit. For the same-name retry that still slips through, the server already dedups by construction:
`Mount.assertUniqueName` plus the metadata.db v7 unique index (translated to the same 409 in
`insertPathRow`) make an exact re-create fail loud rather than duplicate. Option (b)'s only marginal
win is an *automated* client retry of the POST — which this design deliberately does not do, so the
key would ship with no caller (a placeholder, against house rules). Retry-after-reload needs no key
either: a reload destroys the dialog; re-forming the intent in a fresh dialog *is* a new intent, and
the reconciled listing already shows the earlier result.

The residual window, named honestly: a create slower than the combined abort + reconcile budget
(~25 s — nbg1 ran minute-scale) still toasts a false failure. That residual cannot *duplicate*: a
same-name retry 409s on the v7 index while the late row still arrives via `DRIVE_FILE_CREATED`, and
a different-name retry is a genuinely new intent — a fresh dialog would mint a fresh idempotency
key too, so (b) closes nothing reconcile leaves open. Multi-tab and SSE-down change nothing:
reconcile is a direct refetch (no SSE dependency), and cross-tab same-name races resolve
server-side via the same index. Revisit (b) only if a future offline/queued
create feature adds an automated retry path.

**Card-chats get the same pattern** — see §4 (prevention).

## 2 — Backend: atomic `Drive.create`

Small and standalone. Wrap steps 2–3 (provisioning **and**, for chats, `seedCommentRow`) in
`Drive.create` with try/catch; on failure, `mount.deletePath(pathId)` the container before
rethrowing — the same shape as `provisionManagedDbs`' inner rollback, one level up:

```typescript
const pathId = await mount.createFolder(parentId, safeName, type);
try {
    /* ChatRoom.create | CollabDocument.create, seedCommentRow */
} catch (err) {
    await mount.deletePath(pathId).catch((e) => console.warn(`create rollback failed for ${pathId}:`, e));
    throw err;
}
```

- **`mount.deletePath`, not `Drive.deletePath`** — same reasoning as the inner rollback's comment:
  the row is brand-new and never announced, so trash semantics, ACL side effects, and delete-SSE
  don't apply. `Mount.deletePath` recursively removes any children the failed attempt did create
  (`media`/`chat` subfolders, a surviving managed-db row), cancels queued uploads for them
  (invariant 7 in [SYNC.md](../SYNC.md)), and is SSE-silent.
- **`seedCommentRow` inside the guard** (Q6, decided): if seeding fails, the client sees a failed
  create and never writes the card — a fully provisioned chat would be exactly the §4 litter.
  Rolling the chat back converts "dangling container" into "clean retry".
- **SSE on the rollback path**: `DRIVE_FILE_CREATED` is already emitted *after* provisioning, so the
  failure path emits no *container* event today and continues to emit none — no created-then-vanished
  event, and no delete event for a row nobody ever saw. (The `media`/`chat` subfolder creates do emit
  `DRIVE_FOLDER_CREATED` before a step-3 failure — harmless: handlers invalidate container-scoped
  keys nothing renders.) The fix must keep the container emit after the guarded block.
- **Partial rollback failure**: during a full outage `deletePath` itself is low-risk on S3 —
  metadata rows are deleted first and `S3Storage.delete` swallows storage errors — but a crash
  mid-rollback can still strand the row. Log + accept: the leftover is either a bare container
  (self-heals on first open, per the corrections above) or a dead-letter `data.db` row (503 on open),
  and the scheduled integrity sweep ([PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md)) catches
  both permanently — the bare container via the cheap-tier orphaned-container scan (check 2), the
  dead-letter row via the paced S3-presence HEAD (check 5, a later phase there). Don't build
  retry-of-rollback machinery.
- **Idempotent re-create**: after a successful rollback the name is free again —
  `assertUniqueName` passes and the retry runs the full create from scratch (fresh UUIDs
  throughout, so no collision with any garbage object a cancelled upload may have left in the
  bucket). After a *failed* rollback, the retry 409s on the name — honest, visible, and repaired by
  the sweep.

Roadmap done-when, unchanged: *provisioning forced to throw ⇒ no `paths` row remains, retry starts clean.*

## 3 — Open-path honesty (kept small)

Three minimal changes, no new machinery:

1. **Distinguish storage-unavailable on the WS close.** In the collab WS `open` catch
   (`routes/collab.ts`), close with `1013` (Try Again Later) + reason `'storage-unavailable'` when the
   error is an `ApiError` 503, keeping `1008` for auth/not-found. Server-side one-liner.
2. **Bounded "slow" notice in the editors.** The four editors already gate on y-websocket's `sync`
   with a bare `LoadingState`. Add a small shared component (packages/ui — this is the third-copy
   rule's moment: four editors render this state four ways) that upgrades the spinner after ~10 s
   unsynced to *"Storage is responding slowly — still connecting…"*, and on repeated `1013` closes
   shows a persistent *"Storage is temporarily unavailable — retrying automatically"* state.
   y-websocket's built-in reconnect keeps doing the actual retrying (it already resyncs the
   ~1-minute opens successfully); this only narrates it.
3. **Stop rendering `RequestAccessView` for infrastructure errors.** `useCollabDocumentInfo` maps
   every error to `{ canRead: false }`. Let 401/403 keep that mapping and rethrow the rest so the
   route can render `ErrorState` (with TanStack Query's normal retry) instead of a dishonest
   "request access" screen. The comment in that hook already concedes this is a compromise.

Explicitly out: retry/backoff loops in the open hook (y-websocket and TanStack Query already retry),
and any loosening of the strict-open 503 — `mustExist` refuses silent empty-db materialisation
([SYNC.md](../SYNC.md) § Recovery integrity) and stays untouched.

## 4 — Dangling card-chats (optional phase)

`useCreateCommentCard` (`../../packages/lib/src/core/comments/hooks/use-create-comment-card.ts`) awaits the
HTTP `create/chat` and writes the card (with `chatName`) into the board's Yjs only after it resolves.
A create that succeeded but errored past the client (the step-3 500s) leaves a valid, invisible chat
container in the board's `chat/` subfolder. Cosmetic litter; nothing breaks.

**Prevention (do this with §1):** the client *generates* the chat's `fileName`
(`comment-<ts>-<nanoid>`), so it already holds a per-intent unique key. Apply the §1 pattern to
`useCreateChat`'s use here: on error, reconcile against the `chat/` subfolder listing for the known
name and proceed to write the card if found; a retry of the same intent reuses the same `fileName`
(today each retry generates a fresh name — guaranteed litter). Writing the card optimistically
*before* the HTTP create was considered and rejected: it inverts the litter into cards pointing at
chats that never materialised, which is user-visible breakage rather than invisible litter.

**Cleanup (Q4, decided): one-off maintenance script, not a sweep check.** A `../../scripts` script that,
per board container, loads `data.db` server-side and collects `chatName` from the `tasks`/`comments`
Y maps (the extract-text loaders in `../../apps/api/src/lib/document/stickies.ts` already read exactly
these maps server-side — extend that reader to surface `chatName`), lists the `chat/` subfolder, and
reports unreferenced chat containers older than a 24 h grace window (never race an in-flight create).
Report-only by default; `--trash` moves them via `Drive.deletePath` — the normal app delete, which
trashes via `Mount.trashPath` and stays restorable. Rationale for script-over-sweep: the check needs
a Yjs decode of every board (deep-tier cost, against the integrity sweep's cheap-tier no-storage-calls
design), the finding class is cosmetic, and prevention stops the inflow — a recurring sweep check
earns its keep only if litter reappears, in which case it slots into the data-integrity proposal's
paced tier alongside the snapshot sampling.

## Failure-mode table (acceptance spec)

Storage states: **healthy** / **slow** (requests succeed in 10–60 s) / **erroring** (503s) /
**down** (all calls fail). "After" assumes §1 + §2 + §3 shipped.

| Operation | State | Today | After |
|---|---|---|---|
| Create doc | healthy | Works; dialog closes instantly | Same, dialog closes on resolve (sub-second) |
| Create doc | slow | Dialog closes with no feedback; success invisible until SSE/refetch; user re-clicks → duplicate | Dialog pends (button spinner, ≤15 s); abort → reconcile finds the row → presented as success, exactly one doc. Slower than the whole budget: honest may-still-complete toast; a same-name retry 409s rather than duplicating |
| Create doc | erroring | 500 toast; container row committed but unannounced → phantom doc after refresh, errors on open until it self-heals | Rollback: no row, no event; honest toast; retry starts clean |
| Create doc | down | As erroring | As erroring; if rollback also dies, retry 409s and the integrity sweep flags the orphan |
| Create card-chat | slow / erroring | 500 after the chat is provisioned (`seedCommentRow`) → card unwritten, retries mint new names → dangling chats (the 4-attempt card) | Seed inside the §2 guard → rollback; client reconciles by its own generated name and reuses it on retry → card lands exactly once, no litter |
| Open doc | healthy | Fast | Same |
| Open doc | slow | Generic infinite spinner (~1 min, then syncs) | Spinner upgrades to "storage slow, still connecting" after ~10 s; still syncs |
| Open doc | erroring / down | Spinner forever (silent y-websocket reconnect against `1008`); info-call failure shows "request access" | Persistent "storage unavailable, retrying" (`1013`); infra errors render `ErrorState`, never `RequestAccessView`; a dead-letter row's 503 reads as unavailable-retrying until the sweep repairs it |
| List folder | any | Unaffected — metadata.db is local | Unchanged (already safe, like uploads) |

This table restates the roadmap's done-when: *under throttled/failing storage, "new doc" shows a
pending state and the doc appears exactly once even if the request is slow or errors.*

## Open questions

- **Q1 — Idempotency key vs reconcile-only.** Decided above: reconcile-only. *Recommendation:* (a);
  revisit (b) only when an automated-retry caller exists.
- **Q2 — Timeout/reconcile budgets.** 15 s abort + ~10 s reconcile window are educated guesses.
  *Recommendation:* ship them as named constants in the hook and calibrate once against a throttled
  backend during the VERIFICATION.md run; don't build configurability.
- **Q3 — Does Bun's default `idleTimeout` sever slow requests?** Unverified; if it does (~10 s), slow
  creates/exports die at the socket regardless of client patience. *Recommendation:* measure with a
  delayed `exists` on a local run; if confirmed, set an explicit `idleTimeout` in `app.listen`
  (`../../apps/api/src/index.ts`) as part of Phase 2 — a deliberate number, not Bun's default.
- **Q4 — Dangling-chat cleanup placement.** Decided above: one-off script now, sweep only on
  recurrence. *Recommendation:* script, report-only default.
- **Q5 — WS close-code vocabulary.** `1013` for storage-unavailable is the standards-shaped choice;
  the alternative is a JSON error frame before close. *Recommendation:* close code + reason string —
  y-websocket surfaces both, and no protocol change touches the sync stream.
- **Q6 — `seedCommentRow` inside the rollback scope?** Decided above: yes — a failed seed must roll
  the chat back or it recreates the §4 litter class.

## Phasing (each independently shippable)

1. **Backend atomicity (§2)** — S. No API change, no client change. Ships alone; immediately closes
   the phantom-row class.
2. **Frontend create UX (§1)** — S–M. Awaitable picker confirm + pending state + bounded timeout +
   reconcile in `useCreateDriveItem`/`useCreateChat`. The user-visible payoff; depends on nothing in §2
   (reconcile works against today's backend too).
3. **Open-path honesty (§3)** — S. Close-code + shared slow/unavailable state + info-hook error
   mapping.
4. **Card-chat cleanup + prevention (§4)** — S, optional. Script any time after §1's prevention lands.

## Testing

**Unit (backend, §2).** Extract the existing `FaultStorage` test double
(`../../apps/api/src/test/storage/sync-resilience.test.ts` — a `StorageBackend` wrapper over `LocalStorage` with
injectable write delays/failures) into a shared test helper — `mount-mutation-sync.test.ts` already
carries a sibling `S3LikeStorage`, so this is the third copy — and extend it with `failNextExists` /
`existsDelayMs`. Then, in a `create-resilience.test.ts` using the established
`createS3Mount`-style setup (swap `mount.storage` for the fault wrapper): force `exists` to throw
mid-provisioning and assert `Drive.create` rejects, the parent listing contains **no** container row,
no `DRIVE_FILE_CREATED` was emitted, and an immediate retry with the same name succeeds. Repeat with
the failure injected at the chat `seedCommentRow` step. Also pin the dead-letter contrast: a manually
constructed `data.db` row with a missing object still 503s on open (the `mustExist` behaviour this
design must not loosen).

**Integration (fault injection at the storage seam).** No proxy infrastructure: a ~20-line dev-only
wrapper in `lib/storage/` that delays or throws on `exists`/`write`/`read`, applied at the single
place `Mount` constructs its backend (its constructor), active only under an env flag
(e.g. `EIGEN_STORAGE_FAULT=exists-throw` / `exists-delay=8000`). This is the same wrapper shape the
tests use, promoted behind a flag so the full HTTP stack can be exercised.

**Frontend (§1).** The pending/reconcile behaviour is hook logic; its deterministic branch (POST
aborts → listing refetch finds the row → mutation resolves) is assertable with a mocked treaty call +
mocked listing response where FE test scaffolding exists. The real gate is the manual
[VERIFICATION.md](../VERIFICATION.md) recipe against the dev app with the fault flag set: create a doc
under `exists-delay` and read the screenshots — confirm button pends, dialog closes once, exactly one
row in the listing (and in the sidebar's per-mime listing); under `exists-throw`, the honest toast,
no phantom row, and a clean successful retry. For §3, open an existing doc under delay and confirm
the slow-notice replaces the bare spinner; kill the backend's storage entirely and confirm the
unavailable-retrying state, then recovery without a reload once the fault clears.
