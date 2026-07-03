# Deep-dive: `drive.ts` and the ACL seam

_Companion to [AUDIT.md](AUDIT.md). Scope: `apps/api/src/lib/drive/` (drive.ts 1490 LOC, sharedDrive.ts
524, acl*, history, copy-across, versioning facade), `lib/versioning/`, `lib/share/`,
`routes/drive.ts` (633)._

The Drive layer is four tiers: `Route → SharedDrive (ACL wrapper) → Drive (business logic) → Mount
(storage)`. **Grade: B+.** The security model — the `Drive | SharedDrive` union type — is A-grade and
held up under adversarial review. The deductions are for edge leaks (a WebDAV recursion DoS, several
`shared_paths` staleness bugs, a couple of ungated wrappers) and a large-but-clean god file.

## The security model is genuinely good

`getSharedDrive()` returns `Drive | SharedDrive`, and routes can only call methods present on **both**.
So a public `Drive` method with no matching `SharedDrive` wrapper is a compile error at the callsite —
"reachable from a route" and "ACL-checked" become the same compile-time fact. Under review:

- Every route-callable `Drive` method has a `SharedDrive` wrapper with an _appropriate_ check (read vs
  write vs owner). No wrapper forgot a check or checked the wrong granularity — except the ungated
  `openDatabase` family (P2 below), which is a real gap.
- The two documented escape hatches (`/shared/by-me`, `/shared/with-me` using raw `getDrive`) both
  `requireSelf` first. No other route bypasses the wrapper.
- Watcher fan-out re-verifies ACL against the **pre-mutation** ancestor chain (deletePath:421,
  movePath:550, permanentlyDelete:490) — exactly right for trash/move re-parenting, and clearly
  commented.
- Collab WS re-checks `canWrite` per message, so write-revocation is immediate on the write path.

This is the best single idea in the codebase. The findings below are leaks _around_ it, not holes _in_
it.

## P1 findings

### WebDAV COPY of a folder into its own subtree → unbounded recursion (disk-fill DoS) [certain]

`webdav/move-copy.ts:160` calls `drive.copyPath(...)` with no cycle guard, and neither `Drive.copyPath`
(drive.ts:606), `SharedDrive.copyPath` (sharedDrive.ts:148), nor `Mount.copyPath` (mount.ts:539)
checks `isSelfOrDescendant`. The only guard is in the JSON route (routes/drive.ts:148), same-mount
branch only. `Mount.isSelfOrDescendant`'s own comment (mount.ts:330) says it exists to prevent exactly
"copyPath recurse forever" — but the copy path never calls it.

`COPY /webdav/{me}/{mount}/folder` with `Destination: .../folder/sub/copy`: for own-drive WebDAV,
`getSharedDrive` returns raw Drive, so there are zero checks between handler and `Mount.copyPath`'s
recursion, which re-runs `listFolder` at each level and keeps discovering its own partial output.
`Drive.movePath` _has_ the guard (drive.ts:545); COPY is the asymmetric hole. **Fix:** hoist the guard
into `Drive.copyPath` (one line); return 409/403 per RFC 4918 §9.8.5.

## P2 findings

### `renamePath` propagates the pre-rename snapshot [certain]

```ts
// drive.ts:588-590
await mount.updatePath(pathId, { name: newName });
await propagateACLChange(item, item.acl, item.acl, null);   // item was fetched BEFORE the update
const renamedItem = await mount.getPath(pathId);
```

`item` predates the update, so `receiveACLChange` writes the **old** name into every recipient's
`shared_paths` (drive.ts:1274), and the propagation call is a no-op (same ACL, same name). Recipients'
shared-with-me shows the stale name until some unrelated ACL change. **Fix:** fetch `renamedItem`
first and propagate that — `updateACL` already does it correctly (drive.ts:865).

### Inline-editor save bypasses quota and the 5 MB inline cap [certain]

`routes/editor.ts:21` (PUT) → `drive.writeFileContent` with no size checks. `MAX_INLINE_EDIT_SIZE` is
enforced only on _read_ (inline-edit.ts:27); `writeFileContent`'s other caller (WebDAV PUT) enforces
`enforceMountQuota` (resource.ts:144), the editor route enforces nothing. With a 1 GB global body limit
(index.ts:14), a single save can write 1 GB and repeated saves exceed the mount quota arbitrarily.
Also a UX trap: content edited past 5 MB saves fine, then the next open 413s. **Fix:**
`enforceMountQuota(...)` + a `content.length` cap in the PUT handler.

### `SharedDrive.openDatabase/createDatabase/closeDatabase` are ungated on the security-seam class [certain]

All three delegate with no permission check and no explaining comment (sharedDrive.ts:420) — silently
breaking the class's whole contract ("presence on SharedDrive = ACL-checked"). Today `openDatabase`'s
only union-typed caller (`openCommentIndex`, comment-index.ts:101) happens to be gated by a preceding
read-checked `getChildByName` — a load-bearing coincidence one refactor from an arbitrary-database-open.
`createDatabase`/`closeDatabase` have **zero** union-typed callers (ChatRoom/CollabDocument hold raw
`Drive`) — dead wrappers. **Fix:** gate `openDatabase` with `withReadPermission`; delete the other two.

### `Drive.create` lacks the parent-liveness guard its siblings have [likely]

`createFolder`, `uploadFiles`, `createFileFromData`, `movePath` all call `mount.getActivePath(parent)`;
`create` (drive.ts:232) only checks `canWrite`. `getBreadcrumb` includes trashed rows (mount.ts:1679,
no `trashedAt` filter) and trash preserves `acl`, so the write check passes for a _trashed_ parent.
A user trashes a shared folder; an SSE-lagged collaborator creates a doc in it → the doc lands inside
the trashed tree with `trashedAt = NULL`, appears in no listing or trash view, and is destroyed if the
folder is permanently deleted. **Fix:** mirror `createFolder`'s `getActivePath` + `isContainerType`
guard.

### The chat-attachment delete bug (the drive/collab seam) [certain]

Cross-referenced from the collab audit because the ACL escalation is a Drive-layer fact.
`ChatRoom.deleteMessage` passes each string attachment to `Drive.deletePath` (chat.ts:383), which
authorizes against `canWrite(..., this.owner)` — the **home owner**, not the acting user (drive.ts:414).
A crafted message with `attachments: ["<any pathId>"]` + deleting your own message trashes that path
with owner privileges (reachable by anyone with write to any chat in the mount). Simultaneously the
_legitimate_ path is dead: real attachments are stored by _name_ (`p.name`/`u.name`,
use-chat-room.ts:121,153), but `deletePath` expects a _pathId_ → `getActivePath(name)` throws 404,
swallowed → uploaded media never cleaned up. **Fix (one move):** resolve
`mount.getChildByName(mediaFolder.id, name)` and delete that id, scoping the delete to the chat's own
media folder.

### ACL.md claims registry cleanup that isn't implemented [certain]

ACL.md:121 says "all shares removed → delete registry entry", but `removeRegistryEntries`
(share/registry.ts:13) has **zero** callers (only `removeEntriesForTarget` runs, on user deletion).
Worse, `resolveACLUserIds` is called with `old ∪ new` ACLs (acl-propagation.ts:11), so _revoking_ a
share from a not-yet-registered email _adds_ a registry entry. Stale doc + dead export +
revoke-creates-pending-share inversion. **Fix:** call `removeRegistryEntries` from the removal diff in
`propagateACLChange`, or fix the doc and delete the dead function.

## P3 findings

- **`Drive.removeMount` is dead** (drive.ts:145, 0 callers, no wrapper, no `// Called by:` annotation —
  the exact state the class doc forbids). Delete it.
- **Permission-granularity asymmetry:** rename needs PARENT write (sharedDrive.ts:379), trash/move need
  ITEM write. Not a bypass (parent-write ⊃ item-write under additive inheritance), just surprising.
- **Ghost `shared_paths` rows never cleaned** — team-member removal has no reconciliation hook, and
  deleting an owner's home doesn't notify recipients. Departed members / recipients of deleted owners
  keep dead shared-with-me rows that 403/404 forever.
- **`validateACLEntries` accepts write-only + junk-id entries** (validation/acl.ts:3) — `{read:false,
  write:true}` is storable, but `receiveACLChange` keys on `read` so the share never appears in
  shared-with-me and read-gated endpoints 403; non-email junk ids flow into `addRegistryEntry`. Enforce
  "write implies read" server-side.
- **Trashed-item metadata/history readable by revoked-by-trash users** — trash preserves `acl` and
  `getBreadcrumb` includes trashed rows, so `getPath`/`getFileHistory` succeed on trashed items (content
  correctly blocked by `getActivePath`). Leaks name/size/history. Consider a `trashedAt` guard in
  `canRead` for non-owners.
- **`request-access` email is not rate-limited** (access-request-propagation.ts:31) — tag-deduped
  notification but a fresh email per POST. Reuse the guest-OTP limiter.
- **Versioning restore residual window** (restore.ts:25) — edits between `snapshotContainerDataDb` and
  `applySnapshotState` are in neither; the no-lock-across-steps design is deliberate but undocumented
  as a window. One sentence in the doc.
- **Barrel type re-export** (drive/index.ts:1 re-exports `DriveACL`/`DrivePath`/`DriveVisibility`) —
  violates "domain barrels export values only."

## Duplication

- **Upload-finalize block** duplicated verbatim (~15 lines) between `uploadFiles` (drive.ts:304) and
  `createFileFromData` (drive.ts:380): sanitize → `getChildByName` → `getUniqueFileName` →
  `createFileFromTemp`. A `dedupeName(mount, parentId, desired)` helper folds both (and the copy route
  is a third instance, though its placement is the documented WebDAV-semantics exception).
- **Owner-only trash gate ×4** (sharedDrive.ts:345) repeats `isEffectiveOwnerSync` + throw in
  restore/list/permanentlyDelete/emptyTrash. A `withOwnerPermission` sibling to `withReadPermission`
  matches house style.
- **`getEffectiveMembers`** (drive.ts:897) re-implements `resolveACLToEmails`'s merge with hardcoded
  `read:true,write:true`.

## Decomposition proposal for `drive.ts`

**Key constraint: `SharedDrive` mirrors Drive's public surface, so extractions must move method
BODIES, not methods.** Every step keeps the Drive method as a 2-4 line delegate (exactly how
`saveVersion` → `lib/versioning/save.ts` already works), which means **zero SharedDrive churn and zero
route churn per step** — each is independently reviewable. Precedents already in the dir: `copy-across.ts`
(functions over `Drive|SharedDrive`), `versioning/restore.ts` (takes `drive, mount, container`),
`history.ts` (Mount-owned class), `lock-manager.ts` (state-owning field).

### Responsibility inventory (1490 LOC)

| # | Responsibility | ~LOC |
|---|---|---|
| A | Mount registry + lifecycle | 130 |
| B | Path reads (thin delegates) | 55 |
| C | Creation + upload + write | 320 |
| D | Serving (`serveFile`, `readRange`) | 75 |
| E | Trash lifecycle (+ recursive ACL/close helpers) | 200 |
| F | Move/copy/rename | 105 |
| G | Mime listings + search (thin) | 55 |
| H | ACL + sharing ops | 180 |
| I | Shared-with-me mirror (owns `sharedDb`) | 150 |
| J | Collab-doc registry (owns `documents` map) | 90 |
| K | Versioning facade (thin) | 20 |
| L | History + watches (thin) | 70 |
| M | Managed-DB plumbing | 90 |
| N | SSE emit | 3 |

### Coupling

Shared spine: `getMount()`, `emit()`, `home`, `owner`. Beyond it: **E (trash)** is the coupling hub
(needs J, `propagateACLChange`, history, emit). **J** and **I** each own exclusive state and touch
little else. **C (upload)** is self-contained given a Mount + emit + history. **B, G, K, L, M** are
_already_ thin 1-6 line delegates — they ARE the facade, not god-file mass.

### Split order

1. **`serve-file.ts`** — move `serveFile`'s 60-line header/range/CSP body (pure Mount function).
2. **`upload.ts`** — `finalizeUpload`, `regenerateThumbnailAsync`, and the shared dedup block into
   `(mount, args) → DrivePath` functions; Drive keeps check → call → emit → history. Kills the
   duplication item. _(−180 LOC)_
3. **`trash.ts`** — `deletePath`/`restorePath`/`permanentlyDelete`/`emptyTrash` bodies + the three
   recursive helpers (the `versioning/restore.ts` signature precedent; they need `drive` for
   `closeCollabDocument`). _(−170 LOC)_
4. **`shared-with-me.ts`** — move I wholesale (`receiveACLChange`, listings, `sharedRowToDrivePath`)
   as functions over `(sharedDb, home)`; cleanest cut (exclusive state). _(−140 LOC)_
5. **`collab-registry.ts`** — extract the `documents` map + J as a small state-owning class held as a
   private field (the `lock-manager.ts` precedent). Do LAST. _(−80 LOC)_
6. Optional **`acl-ops.ts`** for H, only if it keeps growing; cohesive in place today.

End state: `drive.ts` ≈ 850-900 LOC of thin, annotated facade — the correct permanent shape for the
class the SharedDrive seam mirrors.

### What should NOT be split, and the routes verdict

- **B, G, K, L, M** (thin delegates): extracting creates pass-through files with no bodies to move.
- **`canRead`/`canWrite`**: 6 lines each; they are the seam vocabulary — moving them obscures the
  security-critical call graph.
- **Mount registry (A)**: the class's identity.
- **Don't convert Drive to composition-of-managers.** The standards reject service layers; the
  facade-with-lib-functions shape above is the house pattern.
- **`routes/drive.ts` (633 LOC): leave as one file.** ~18 lines/handler including schemas is thin; the
  copy route's ~45 lines are the documented WebDAV exception; splitting into subrouters would diverge
  from every other domain (mail.ts, calendar.ts are single files) for no gain. Revisit past ~900 LOC.

## Debt themes

1. **The `shared_paths` mirror has no freshness story.** Rename (broken, P2), move, size,
   owner-deletion, team-departure all leave stale/ghost rows. Decide what the mirror guarantees and
   enforce it in one place — the rename bug shows the intent _was_ to keep names in sync.
2. **Guards live at the wrong layer once a second caller appears** — cycle guard (route-only → the P1),
   quota (WebDAV-only → editor P2), parent-liveness (`create` missed it). Domain invariants belong in
   Drive/Mount.
3. **Trash preserves ACL + trash-blind breadcrumbs** interact subtly (the `create`-into-trash and
   metadata-leak findings). A `trashedAt`-aware permission helper closes the family.

## Strengths

- The `Drive | SharedDrive` union is an unusually good compile-time ACL-coverage guarantee, and the
  `// Called by:` annotation discipline is ~90% followed.
- Pre-mutation chain capture for watcher ACL re-verification is exactly right and clearly commented.
- Fire-and-forget discipline is clean: every unawaited async has `.catch()`; `notifyWatchers` isolates
  per-watcher failures.
- Versioning restore's grab-before-prune ordering and self-locking snapshot design show real races
  were thought through.

---

_Postscript 2026-07-03: decomposition executed on `refactor/drive-split` (merged c5d7526f) — bodies moved to `serve-file.ts`, `upload.ts` (folds the duplicated upload-finalize block), `trash.ts`, `shared-with-me.ts`, `collab-registry.ts`; drive.ts 1549→1118 LOC; sharedDrive.ts + routes/drive.ts zero-diff. Deviations: extracted bodies take `drive` + public annotated `emit` (not pure `(mount,args)`); `acl-ops.ts` skipped per default; `emptyTrash`/`getSharedWith` stayed._
