# API simplification audit

> **TLDR**: An audit of `apps/api` for patches stacked on patches: fixes that kept fixing the corner the previous one created, where one change at the source, or a slightly smaller feature, would have kept the code flat. It found about 50 candidates. Together they remove roughly 3,000 lines of production code, about 5,500 with the dev-only audit scripts, plus several thousand test lines. That is only a few percent of the API, but it sits in exactly the mechanisms that cost data when they go wrong: trash, uploads, restore, drafts and invitations. Most of the piles have one of seven shapes ([§ Patterns](#patterns)). Our own CODE-STANDARDS already forbids all seven, so the gap is enforcement, not the rule. [§ Shortlist](#shortlist) ranks the best of them. The rest are listed per area.

Audited 2026-11-05 at `76071ffda` on `document-lifecycle`. Six reviewers each read one area's code and its git history, and only report accidental complexity, or essential complexity bought for a feature or a precision the owner could drop. Anchors are `apps/api/src/lib/`-relative, except `routes/`, `cli/`, `scripts/`, `test/` and `instance-lock.ts`, which sit directly in `apps/api/src/`, and `eigen`, the launcher at the repo root. Line numbers drift; the function names don't. LOC figures are honest guesses, not measurements. I re-checked a sample of claims against the code (the lease commit run, the transform `settle` order, the sheet-export rates, the test-only calendar methods, the trash map, the two reconciliation functions and the cross-drive sweep); everything else is the reviewer's own verified reading. Treat each finding as a lead to confirm before a fix, not a verdict.

Like ROADMAP and the proposals, this doc holds only open work: strike a finding when it is fixed or ruled out, and delete the doc when it is empty.

## Patterns

[CODE-STANDARDS.md](CODE-STANDARDS.md) already says: "when a second fix in one module needs a patch, the module's design is wrong: redesign it", "drop the feature or accept the edge case", "no module-level maps, sets or caches", and "no code for data an older build wrote". The git history shows runs of 4 to 10 `fix(...)` commits on one mechanism within days, so the rule was known but not triggered. Seven shapes recur.

1. **Wrong order, then guards for the gap.** A step runs before the fact it depends on is written, and each later fix guards another way into the gap. The cure is to reorder: write the fact first. Examples: the trash closes documents before it marks the row ([M1](#m1)) and a PUT may start while its predecessor is still on the wire ([M2](#m2)).
2. **A second copy of the truth.** A sidecar, an extra row or a cache beside the real thing, and every reader has to merge the two. Examples: the draft sidecar ([ML1](#ml1)), a stored "cancelled" event row per EXDATE ([C2](#c2)), a contact photo in three forms ([C5](#c5)), preview `.failed` markers next to a compaction strike map next to an extract-text 413 ([T4](#t4)).
3. **Predicting the cost exactly instead of capping it.** Exchange rates, line estimates and predicted waits, each tuned after a crafted input. Examples: the sheet export's six rates ([X2](#x2)), the runner's admission by predicted wait ([T8](#t8)), the footnote line estimate ([X6](#x6)) and the text-box height estimate ([X7](#x7)).
4. **Precision for a rare race or a rare setup.** Exactly what [the owner's rule](CODE-STANDARDS.md) says to drop: "may forget, must not corrupt". Examples: maildir watchers that match a recreated folder by inode ([ML6](#ml6)), rollback checking data twice ([B4](#b4)), a stop that waits for a running backup ([B3](#b3)), the sheets compaction base for a tab that slept through it ([T2](#t2)).
5. **Two paths for one job.** These drift, and every fix lands twice. Examples: invitations by relay and by iMIP ([C1](#c1)), the two ways a failed copy is cleaned up ([M6](#m6)) and two object-delete loops ([B8](#b8)).
6. **Backward compatibility the standards forbid.** Readers for old archive and launcher formats ([B1](#b1)).
7. **Scaffolding left after its job was done.** The audit scripts' importer-measuring modes ([X1](#x1)) and a closed-one-endpoint-at-a-time deny list ([ML4](#ml4)).

A cheap tripwire would catch the next pile early. When a review sees the third `fix(x)` on one mechanism within a week, it stops and asks which of the seven shapes this is, before a fourth patch lands.

## Shortlist

The best payoff per unit of risk. **Product** marks a finding that drops or changes something a user or operator sees; that is the owner's call. The others are pure refactors.

| # | Finding | Removes | Risk | Product? | What is lost |
|---|---------|---------|------|----------|--------------|
| [M1](#m1) | Trash marks the rows first, then closes documents | ~70 + ~250 test | med | no | nothing |
| [M9](#m9) | A copy leaves unnamed parts out, instead of sweeping them after | ~80 | med | no | nothing |
| [ML1](#ml1) | The draft `.eml` is the only copy; drop the sidecar and fast save | ~250 + ~270 test | med | small | Drafts in IMAP clients show no link pills; a large-attachment autosave rewrites the file |
| [B1](#b1) | Delete old-format readers in backup and the launcher | ~120 | low | small | a restore killed under 0.4.1 is not auto-recovered |
| [X1](#x1) | Delete the audit scripts' `run`/`compare`/`split` modes | ~2,200 + ~1,000 test | low | no (dev) | an independent Word reader to measure ours against |
| [C1](#c1) | Eigen-to-Eigen invites carry the iMIP body over the relay | ~200 | med-high | no | nothing |
| [M2](#m2) | Never two PUTs of one key at once; drop orphan repair | ~90 | med | no | one key waits behind a hung PUT |
| [X2](#x2) | Sheet export: flat caps, not six exchange rates | ~90 + ~300 test | med | decided | a workbook of huge distinct PNGs may time out instead of printing with a warning |
| [C2](#c2) | EXDATEs as a list on the master, no cancelled rows | ~150 | med | small | a stale per-occurrence REQUEST after its CANCEL can restore it |
| [ML2](#ml2) | One message per send, no per-recipient copies | ~60 + most of 565 test | low | yes | a guest types their address on the login page |

## Mount, drive and versioning

<a id="m1"></a>**M1. The trash closes documents before it marks the row, then guards the gap in five layers.**
`drive/collab-registry.ts` (`trashing`, `isTrashing`, `whileTrashing`), `drive/drive.ts:609,660,842`, the `isTargetTrashing` option in `mount/mount.ts` (`updatePath`, `assertMovableInTx`), `drive/trash.ts`.
History: `2ad5bc796` (refuse an open), `8b836cd59` (second close, counted keys), `04fa2707d` (refuse a create), `ab46de8ea` (and a subfolder), `9d64bb547` (thread `isTargetTrashing` into Mount), `7e8157f13`, `d0eeb4089`. About 320 test lines exist only for this (`trash-collab-close`, `trash-create-race`).
Root cause: `deletePath` closes the documents while the row is still live, and `trashedAt` is written afterwards, so an in-memory map stands in for a DB fact that isn't there yet.
Simpler: in one transaction, write `trashedAt`/`trashedFrom` on the item and its descendants, keeping `parentId` and the storage key. Then close the documents, whose final sync lands at the unchanged key. Then, under the lock, rename in storage and reparent. `getActivePath` and `targetFolderErrorInTx` already refuse a trashed row and a trashed ancestor, so the map, its plumbing and the second close all go. A crash between the steps leaves a trashed row at its old key, which restore and purge already resolve from the row.
~70 LOC + ~250 test, medium risk (the order of the `local` rename), high confidence.

<a id="m2"></a>**M2. UploadQueue repairs late orphan PUTs after the fact.**
`mount/upload-queue.ts` (`OrphanState{count, canceled, isDatabase, lastAcked}`, `orphansAtStart`, the cancel flag set in the timeout, re-staging acked bytes).
History: `b9eb9eccd` → `40b526d06` → `09f9e0ae6` → `6debd112c` ("two review-found interleavings") → `72e27b043` → `6bb5c362d`.
Root cause: after a timeout, the next PUT of a key may start while the old one is still on the wire, and all of the repair code exists to fix the order afterwards.
Simpler: a `Map<key, Promise>` of unsettled writes. The drain skips a key that still has a write on the wire, and a cancel deletes the object again once that write settles. The semaphore slot is still freed at the timeout.
Lost: one key's upload waits behind a hung PUT, up to the existing give-up time. ~90 LOC, medium risk (S3 durability), medium-high confidence.

<a id="m4"></a>**M4. A loose end of the lifecycle branch.**
- The canvas comment card's `deletedAt` mark (`f85396647`) no longer serves the sweep. Its only use now is letting a version restore bring back a deleted canvas comment. Keep it or drop it.

<a id="m5"></a>**M5. Path-keyed `local` storage drives most of the mount's race code (product).**
`mount/trash.ts` (`renameTarget`, `moveAside`, `onDisk`), `mount/mount.ts` (`claimCreateKey`, the case-fold check against disk, key re-resolution on every sync), the tree read/write lock. Because the default `local` mode keys a file by its name path, every rename, move, trash and restore moves bytes on disk, and each of those can crash halfway.
Simpler: make `local-key` the only local mode.
Lost: a human-readable tree on disk, and it needs a one-off migration. ~250–300 LOC plus the path-based branches in backup. High risk, medium confidence that it is worth it; the complexity itself is real.

<a id="m6"></a>**M6. A failed copy is cleaned up two ways.**
`drive/trash.ts:110-137` (`holdsOnlyCopy`, the fallback to the trash), `drive/drive.ts`, `drive/shared-drive.ts`. History: `a229e9231`, `e73b70bf3`, `823bf894a`, `530e42c12`.
Simpler: delete exactly the `createdIds` for good, deepest first, and leave anything else.
Lost: a half-built copy that someone shared within seconds goes for good instead of to the trash. ~25 LOC, low risk.

<a id="m9"></a>**M9. A copy writes every part, then sweeps the ones the document doesn't name.**
`drive/sweep.ts` (`sweepCopy`, `listWritten`, `writtenIds`, the `written` filter in `sweepParts`), `drive/drive.ts` (`copyPath`, `listCopyWithinLimits`), `mount/copy.ts`. History: `0f611bacc` (the copy shows in the target's tabs before the sweep runs, so the sweep had to learn which parts it wrote, matched by name) and `3e550fe36`.
Root cause: pattern 1. The copy writes the deleted images and idle comment threads first and deletes them afterwards, so the copy is visible with parts that are about to go. The zombie bytes are also written, uploaded on S3 and charged against the quota: `listCopyWithinLimits` passes `copySize(tree)`, zombies included, to `enforceMountQuota`, so a copy can be refused for bytes it would delete a moment later. A sweep that fails halfway leaves them for good, as a copy has no versions and Delete history is the only other sweep.
Simpler: the copy listing asks each source document which parts it names (the same `runDocumentReferences` call, on the source, which the copy already flushes) and leaves the others out of the `CopyTree`. Nothing unnamed is written, so `sweepCopy` and the `written` set go, and `sweepParts` serves only Delete history. The owner's ruling (2026-11-05): the cleanup stays automatic on every copy, of a document or of a folder holding documents, with no separate "clean copy" action.
Lost: nothing. The cost stays one background transform per copied document. ~80 LOC, medium risk (with no grace, a source part may be one whose naming edit hasn't landed yet; check that the copy's flush covers it), high confidence.

**M8. The opt-in `withHomeHeld` wrappers** in `routes/drive.ts` (`c92fa31ab`, `add1d3be8`, `107f5c65c`, `7b104458f`) could become one per-request hold. This is not sized yet.

Judged essential: holders and idle close of document databases, the two copy orders in `versioning/snapshot.ts`, the `SharedDrive` proxy, `refuseDocumentPart`/`refuseVersionsName` (now about 25 compact lines), and `withFreeName`.

## Transforms, collab, preview, core and storage

<a id="t2"></a>**T2. The sheets compaction base, and the chain of fixes around the swap.**
`collab/collab-document.ts`, `document/sheets.ts` (`stampMissingSheetsBase`, `restampRestoredSheetsBase`), `packages/lib/src/sheets/yjs-state.ts`, the client's `beforeObserverCalls` verdict. History: `44b54bf`, then `a7fb960`, `ce30ed7`, `54ee957`, `32604c2`, `ec2e818` (`skipFinalSnapshot`), `73f770c` and `4192d3b` in four days.
Root cause: compaction runs only when no socket is connected, so the `{id, compactedFrom}` base exists for one case: a tab away longer than the 60 s linger.
Simpler: drop the base, and remount the grid on any new snapshot. Also consider swapping only when `dropped === 0`, which makes the pre-swap version and `skipFinalSnapshot` optional.
Lost: a tab that slept through a compaction loses its undo stack, selection and scroll. ~80 LOC across API, lib and client. Medium risk, medium-high confidence.

<a id="t4"></a>**T4. Three "this input keeps failing" memos.**
Preview `.failed` marker files (`preview-cache.ts:86-104`, from `2789b4d` and `412b8af`). The compaction strike map with reset calls from other modules (`sheets-compaction.ts`, `import/import-document.ts:141`, `versioning/restore.ts:68`). And extract-text's timeout turned into a 413 that search reads as "empty".
Simpler: one memo in `run-transform`, keyed by `kind + pathId + updatedAt`, that refuses a job which timed out or ran out of memory, for an hour. New content gets a new key, so the reset calls go too.
Lost: the preview memo forgets on restart. ~40 LOC, low-medium risk.

<a id="t5"></a>**T5. In-place local writes force "never yield" on every reader.**
`storage/local-storage.ts:26-28` (`Bun.write` onto the key), `core/stream.ts` (`yields`), `storage/deadline.ts`, `backup/capture.ts`. History: `9912ee3` (yield every 2 MB), revert `54ffddf`, `f61e5aa` (pin that it never yields), `075a5a1`, `12eabfa`.
Root cause: an overwrite truncates the live file, so an unlocked reader stays whole only because it never leaves the microtask queue, and a large local read blocks the event loop.
Simpler: `LocalStorage.write` writes a temp file and renames it, as `LocalFilesystem.writeAtomic` already does. An open handle keeps the old bytes, every stream can yield, and the `yields` option goes. First check that nothing streams a live SQLite file of a local mount without the lock. ~30 LOC, and this change lowers risk.

<a id="t6"></a>**T6. S3 "harden" writes the user's bucket configuration (product).**
`storage/s3-storage.ts:47-117`, `:221-307`. History: `8003b9f` (MinIO's `&#39;`), `deba85a`, `1d20d19` (foreign rules), and a refusal of control characters. A lifecycle PUT replaces the whole configuration, so Eigen has to parse every provider's dialect so it doesn't clobber other tenants' rules.
Simpler: check only, and show the exact rule for the admin to apply.
Lost: one-click hardening. ~120 LOC, low risk.

<a id="t7"></a>**T7. Two Home holds per collab document.**
`routes/collab.ts:214-220,303`, `collab-document.ts` (the linger hold taken and released in `scheduleClose`). History: `7eb0b80`, `4192d3b`, `685f2f9`.
Simpler: the document takes one hold in `init` and releases it in `destruct`. An open that races a closing Home gets a 503, and the client retries. ~20 LOC, medium risk.

<a id="t8"></a>**T8. The runner admits jobs by predicted wait.**
`runner.ts:30-58,249-260` (`admissionCostMs` on every kind, "~10–20× the worst measured time"). With one child, a count cap on the foreground queue (for example 8, beside the background cap of 8) does the same job. ~20 LOC, low risk.

Smaller: `ManagedDatabase` has two locks (`managed-database.ts:60-66`) only because the snapshot calls `flush()` right after `sync()` (`versioning/snapshot.ts:72`).

Judged essential: the one-shot child with its ack and media round trip, the collab snapshot-plus-updates scheme with its awareness caps, `yjs-loader`'s skip-or-throw split, and the storage retry and deadline logic (Bun's S3Client never retries and goes silent for about 360 s).

## Backup, home, config and the launcher

<a id="b1"></a>**B1. Backward-compatibility code that CODE-STANDARDS forbids.**
`backup/recovery.ts` (`recoverOlderBuildRestores`, `homeInDataRoot`, `closeArchives`), `backup/archive.ts` (`chargeFolders`, `counts.dirs ?? 0`), `packages/lib/src/validation/backup.ts:108` (`dirs` optional), `backup/verify.ts:121-137` (a row mismatch is only a warning "so older archives restore"), `backup/materialize-mount.ts:312-323` (`PENDING_UPLOAD_KIND_VERSION`), `restore-server.ts:241` (legacy absolute path), `cli/update-check.ts:23-26` (`--level` for the 0.4.1 launcher), `eigen:646-663` (the sidecar-grep fallback). History: `be1329178`, `80a8a9ee1`, `943c8e320`.
Simpler: delete all of it, make `dirs` required and make the verify mismatch fail.
Lost: a restore killed under 0.4.1 and then upgraded is not recovered automatically, and archives made before 0.4.1 stay world-readable until a manual chmod. ~120 LOC, low risk, high confidence.

<a id="b2"></a>**B2. The archived `metadata.db` is reconciled after the capture walk.**
`backup/snapshot-mount.ts:34-68` (`pruneUnreachableRows`), `:184-229` (the `kept`/`gone`/`stale` walks, `staleAbove`). Ten commits on this one mechanism in five days: `cc8160b02`, `d53c1c813`, `c83964c6a`, `a16f24ff7`, `5367e13f1`, `d45ac2325`, `a5737be39`, `943c8e320`, `4a24c68e1` and `c46ad94dc`.
Simpler: delete only the rows of files that are gone, rewrite size and hash for overwritten ones, and run `UPDATE paths SET size = NULL WHERE type != 'file'` so folder sizes are recomputed lazily.
Lost: an empty folder deleted during the backup comes back. ~35 LOC, medium risk.

<a id="b3"></a>**B3. Stopping Eigen waits for a running backup (product).**
`eigen:646-710` (`running_backup`, `ask_backup` with retries, `wait_backup`, `before_stop`, called from five places), `cli/status.ts` (`--running`), `backup/server-archives.ts:87,119`.
Simpler: a stop just stops. Boot already marks the record as interrupted, so the schedule should treat an interrupted night as not attempted and retry it on the next tick. `./eigen update` keeps its own `backup --wait`.
Lost: a manual stop during a manual backup aborts it. ~90 LOC, medium risk.

<a id="b4"></a>**B4. Rollback checks the data twice (product).**
`cli/restore.ts` (`--since`, `changedSince`, the ctime reasoning), `eigen:1575-1640` (`check_again`, the exit-2 branch). It checks while Eigen runs, then patches up the writes made since, with a 5-minute clock margin.
Simpler: stop Eigen, then run one `--check-data`.
Lost: Eigen is down for one check (minutes on a big server) instead of only for the switch. ~70 LOC, low risk.

<a id="b5"></a>**B5. The instance lease, built to catch a second API on another kernel. Decided: remove it entirely.**
`config/data-lock.ts` (`lockScope`, `liveLeaseHolder`, `readLeaseText`), `instance-lock.ts` (heartbeat, takeover exit), the lease read in `cli/restore-swap.ts`, DATABASE.md § "A lease refuses…". History: `8466fe6e3`, then seven `fix(api)` commits the same day: `1ea8912a4`, `38458eb10`, `68d0e4c3d`, `61a266a48`, `a66f43946`, `df04aab02`, `de161794e`.
The owner's ruling (2026-11-05): the lease only guarded the owner's own dev setup, a Mac host API next to a Docker Desktop container on one `data/`. It goes completely. The file lock stays, there is no `data-dev` folder in its place, and no ROADMAP row follows from it. ~140 LOC plus the lease tests and the DATABASE.md section. Done on 2026-11-05 in `58d0f0f1e`; DATABASE.md and the verify-in-browser skill now say the lock stops at one kernel.

<a id="b6"></a>**B6. Three restore modes for an S3 mount (product).**
`backup/restore-server.ts:184-265` (`s3FromArchive`, the level-equality refusal, the `fromFiles` replay), `cli/restore-stage.ts:75`, `cli/restore.ts`, `schedule.ts` (`withS3`), `server-settings.ts:14`.
Simpler: server archives are always Full, and per-home archives keep Full + S3.
Lost: a whole-server archive no longer holds the S3 objects, so a damaged bucket relies on bucket versioning or per-home archives. ~70 LOC plus a setting and its UI. Medium risk.

<a id="b8"></a>**B8. Overlapping per-home locks, and two object-delete loops.**
`backup/jobs.ts:31-40` (`heldSlots` plus `inFlight` for one slot) with four entry points. `home/get-home.ts:48-55`, where `markHomeRestoring` doubles as a lock with its own 409. `delete-home.ts`, which checks the slot twice instead of holding it. `backup/safety-copy.ts`: `deleteRemoteObjects` (sequential, reference-counted) beside `deleteBucketObjects` (batched).
Simpler: one `ownerId → {holder, released}` map, which a deletion holds too, and a safety copy deletes "its keys minus the other folders' keys" through `deleteBucketObjects`. ~50 LOC, low risk.

Judged essential: the per-home two-rename swap with its notes, the completion note, fresh S3 keys on restore, auth-row scoping, `VACUUM INTO` captures, the lock discipline, verify's stages, and root's careful copy of the mail keys. Four fixes in one day there (`a09bc5703`…`4c35dd015`) suggest moving `dkim/` and `certs/` out of `data/` instead.

## Mail, auth, share, chat and the route layer

<a id="ml1"></a>**ML1. The draft sidecar and fast save keep a second copy of every draft.**
`mail/mail-domain.ts` (fast-save gate, `draftFastSave`, the sidecar merge, the `messageGet` overlay, `flushDraftSidecars` on destruct), `mail/maildir-store.ts` (sidecar IO, the Drafts sync projection), `mail/mail-store.ts`, `mail/maildb.ts` (`updateDraftContent`), the `forceFullSave` plumbing through `routes/mail.ts` and the client.
History: recipients the sidecar brought back after removal (`bc20caad2`, `03f735aa9`); four fast-save gate fixes (`c95afd641`, `9145d2832`, `9454f1881`, `613a8b948`); atomic write and projection over the stale `.eml` (`6fb2e8e65`); `721879daa`, `3e2f2b4ae` and `ef564df79`. `MAX_SEND_REFERENCES` is now checked three times.
Root cause: the `.eml` couldn't hold Bcc, drive references or `repliedToId`, and it had the link pills baked into its HTML.
Simpler: `keepBcc = true` on the compiled MimeNode (nodemailer 6.10.1 supports it), `X-Eigen-Drive-References` and `X-Eigen-Replied-To` headers, pills baked only into the Sent copy, and every autosave a full save. It is already debounced to 2.5 s, and every full save re-parses the draft's attachments.
Lost: Drafts in IMAP clients show no link pills, and a large-attachment autosave rewrites the file. ~250 LOC + ~270 test lines. Medium risk (Bcc and threading on the send path), high confidence.

<a id="ml2"></a>**ML2. A personalised copy per external recipient (product).**
`mail/mail-domain.ts:620-662`, `mail/recipients.ts` (`MAX_PERSONALISED_SEND_BYTES`), `packages/lib` `types/mail.ts` and `use-draft.ts` (`failedRecipients`). History: `bed09fb26` → `6110ad170` → `8314970d2` → `5dc66a405`. `mail-send-copies.test.ts` is 565 lines. Each external recipient gets links that carry `?email=`, so each copy needs its own envelope, a fan-out byte budget, an attempt-every-copy loop and a partial-failure toast.
Simpler: one message with bare links, which either sends or fails. The per-recipient share emails keep `buildAttachmentUrl(ref, email)`.
Lost: a guest types their address on the login page, and partial-failure reporting goes (Postfix bounces cover single rejections). ~60 LOC + most of the test. Low risk.

<a id="ml4"></a>**ML4. better-auth's admin router is closed one endpoint at a time.**
`auth/auth.ts:54-59,132-157,239-242` (a custom role, a before-hook for owner, guest and busy-home targets, the `disabledPaths` deny list). History: `f0209612c`, `117d7e4eb`, `7f2ef4932`, `fdce56dcb`, `138f78ce2`, `b1e18dd82`, `c708bdbd7`, `adba8f86d`. The admin app only calls `createUser` and `setRole`.
Simpler: allow, rather than deny. Close every `/admin/*` path, and put create and set-role behind `requireAdmin` routes that call `auth.api` from the server. First check that `disabledPaths` leaves the server-side `auth.api.removeUser` working (`user/delete-user.ts:46`). ~25 LOC, with a much smaller attack surface.

<a id="ml6"></a>**ML6. Watchers recognise a recreated folder by its inode.**
`mail/maildir-store.ts:153-198`. History: `a080484a5` → `0553dd204` → `a5c3a74cb` (inode plus birth time) → `0e4d8c7bc`. This is all for a standard folder deleted and recreated while the Home is loaded.
Simpler: drop the identity check. A recreated folder stays unwatched until the Home reloads, and `listMessages` already reconciles on open. ~25 LOC, low risk.

<a id="ml7"></a>**ML7. Routes repeat their guards, and some carry logic.**
`routes/mail.ts` has 47 `requireNonGuest`/`requireSelf` calls, `contacts.ts` 16 and `calendar.ts` 21. The four preview routes at `routes/mail.ts:341-430` are near-identical. Logic that belongs in lib: `routes/settings.ts:46-114` (`adminUserRows`), `:119-132` (hiding owner-only settings), and `routes/chat.ts:63-131` (create, share and roll back).
Simpler: an `{ auth: 'self' }` macro variant, one `mailPreviewRoute` helper, and the three blocks moved into `lib/user`, `lib/config` and `lib/chat`. ~110 LOC removed and ~150 moved. Low risk.

<a id="ml8"></a>**ML8. The guest code limiter has its own refund logic.**
`auth/otp-rate-limit.ts` (`92cc28ef6`). Use two `WindowLimiter`s, and on success `release(email)` only.
Lost: an office making more than 100 code requests an hour from one IP waits for the window. ~45 LOC, low risk.

Judged essential: mail reconcile coalescing, `storeLock`, the deliveries map, fsync durability, `canonicalMailbox`, protocol auth's uniform 401, whisper redaction, the notification center, and the live mail byte counter.

## Calendar, contacts and DAV

<a id="c1"></a>**C1. Eigen-to-Eigen invitations use their own relay protocol beside iMIP.**
`calendar/invite-propagation.ts` (`sendSeriesExceptions`), `calendar/invitations.ts` (`receiveInvitationUpdate`, `relayedRequest`), `calendar/types.ts:9-57`, `home/home-relay.ts`. Local guests get four typed relay messages (invitation, update, removal, rsvp), while external guests get an iMIP body that already carries master plus exceptions, CANCEL and REPLY (`imip.ts:239-291`). `relayedRequest` rebuilds a `ParsedEvent` just to share `decideInboundRequest`. Fixes landed on both paths: `1f0fa0632`, `e46faf63f`, `63e2c3cd4`, `0cbfe2972` and `e8f6f48d4`.
Simpler: one relay message, `{type: 'calendar:imip', method, ics, organizerUserId, organizerEventId}`, carrying the `serializeEventForImip` body, which the receiver runs through `processInboundImip`. The envelope stays the trusted link, so team organizers with no address keep working. RSVPs travel back as a REPLY by the same rule. This also does most of the ROADMAP row "An invitation carries the projected event". ~200 LOC, med-high risk (the invitation tests are dense), medium-high confidence.

<a id="c2"></a>**C2. Every EXDATE becomes a stored cancelled-event row (product).**
`ical/ical-parse.ts`, `ical/ical-component.ts` (`X-EIGEN-EXDATE` stamps with a row id, SEQUENCE and DTSTAMP), `calendar/events.ts`, `calendar/invitations.ts:719-745` (`restoreCancelled`, threaded through 8 places). The row model from before files-as-truth (`bea4d04f1`) survived. History: `d3f8fe21e`, `3c9936b65`, `4d8fc7117`, `e1dd6ebb4`.
Simpler: the master projects `exdates: string[]`, and deleting an occurrence becomes `DELETE …/occurrence/:date` calling `addExclusion`. A cancelled occurrence orders by the master's SEQUENCE.
Lost: a stale per-occurrence REQUEST after its CANCEL can restore it (it forgets, nothing corrupts), and a guest can't bring back an occurrence they removed by answering it. ~150 LOC, medium risk (a frontend call changes; the index rebuilds from files).

<a id="c5"></a>**C5. A contact photo is kept in three forms.**
`contacts/avatars.ts`, `contacts/card-store.ts:62-98`, `contacts/contacts.ts`. An upload stages a webp plus a JPEG, PNG or GIF copy for Apple, with a fallback for GIFs over 2 MiB. Saving promotes the webp to a cache file named by the other copy's hash, a DAV PUT builds the same cache another way, and the cache bytes are counted in four places. History: `5a4f236e3`, `8bc8e29b4`, `0b646eb73`, `359880592`, `2b870cd82`.
Simpler: stage only the PHOTO copy, always build the cache through `deriveCardPhotoCache`, and stop counting the cache against quota (its bytes are already counted in the card).
Lost: the web thumbnail is encoded from the 512 px copy. ~60 LOC, medium risk.

<a id="c6"></a>**C6. A guest can remove "this and following" occurrences of an invitation (product).**
`calendar/invitations.ts` (RRULE truncation on the guest copy), `calendar/recurrence.ts:41-48` (`constrainRRule`), `ce46d6854`. The organizer is still sent a decline for the whole series, so the two sides already disagree.
Simpler: a guest declines the whole series or one occurrence. ~35 LOC plus a UI branch, low risk.

<a id="c7"></a>**C7. A guest can hold one occurrence of a series they don't hold.**
`calendar/invitations.ts:145-150,323-413`, `invite-propagation.ts:268-271`. History: `e46faf63f` (+100 lines), `63e2c3cd4`, `488cb2c97`.
Simpler: such an invite files as a plain, unlinked event.
Lost: that event no longer gives way to the series, and its RSVP no longer reaches the organizer's override. ~60 LOC + ~400 test. Medium risk.

Judged essential: the shared `lib/dav` (sync-collection, report rows, propfind and the multiget resolver remove real CalDAV and CardDAV duplication), file-as-truth with `rebuildProjection`, wall-clock recurrence keys, SEQUENCE-then-DTSTAMP ordering, DKIM sender binding, and the 6-line Thunderbird ctag bump.

## Import, export and OOXML

**The owner's ruling on exports (2026-11-05).** An export to PDF or HTML of a doc, sheet or deck may fail on a crafted or very large document, with one plain message such as "Export failed: the document is too big, or it used too much memory". What matters is that the server stays stable, fast and responsive. So an export needs no prediction of its own cost: a flat cap, the runner's deadline and its memory limit are enough, and a timeout or out-of-memory is an accepted outcome, not a bug. This settles X2 and X6, and applies to any other export guard that predicts cost.

Format mapping is essential and large. The three importers already share their budget, loss counter, `importMedia` and `writePackage`, and no pipeline is built three ways. What piled up is mostly round-trip precision and its gate.

<a id="x1"></a>**X1. The audit scripts' importer-measuring modes are leftover scaffolding.**
`scripts/docx-audit.ts:510-1923` (`readStyles`, `readNumbering`, `spell`, `auditSource`, `auditImported`, `compareRuns`, its own Worker harness) and `scripts/xlsx-audit.ts:198-940` plus `drawHeldout`. TESTING.md documents only `roundtrip`, the writer gate. `run`, `compare` and `split` were the gate for replacing ExcelJS (`72cb99109`, `df8776031`). `auditSource` is a second, independent Word reader ("Spelled here, not with the reader's spellNumber"), kept in step by hand (`0e95f11a1`, `0fb1be158`, `470ecf9d2`, `a6f6e0146`), and each script has a process harness beside `office-audit.ts`'s.
Simpler: keep `roundtrip` and delete the other modes with their tests (`test/scripts/docx-audit.test.ts:63-826`, `xlsx-audit.test.ts:60-302`). Git history keeps them for a one-off tally.
Lost: measuring the reader against an independent Word model across a corpus. ~2,200 LOC + ~1,000 test, low risk (dev-only). Whether the tallies are still used is your call.

<a id="x2"></a>**X2. The sheet HTML/PDF export prices everything in "cells" at six exchange rates.**
`export/sheets/render.ts:73-101` (`PREVIEW_FLOATING_CELLS`, `PDF_PAGE_CELLS`, `CHART_CELLS`, `CELL_BYTES`, `IMAGE_TAG_BYTES`, `PIXELS_PER_CELL`), the second windowing after `printedPages`, `chargeFloating`, `export/sheets/transform.ts` (`decodedPixels`). Fifteen commits in three days, each a new rate after a crafted workbook: `439bc8f75`, `cb29015e9`, `28443ac0c`, `c5a0946bf`, `828f5716b`, `7416f14a7`, `c869842ab`, `de02b6bc6`, `891edadb0`, `56b0a6560`, `6ae12e1c8`, `efa5452c4`, `9cabdca45` and `5b1b8c6b1`. About 25 tests pin the pricing.
Root cause: predicting WeasyPrint's cost exactly, when the 60 s render timeout already bounds it.
Simpler: keep `MAX_EXPORT_CELLS` and the per-page charge, and replace the rest with a flat cap on floating objects (per export and per preview) plus the existing media byte cap.
Lost: a workbook full of huge distinct PNGs may hit the timeout instead of printing with some pictures left out. ~90 LOC + ~300 test, medium risk, high confidence.

<a id="x3"></a>**X3. Docx line spacing: the writer scales per face, and the reader undoes it exactly.**
`document/looks.ts:226` (`familyLineScale`), `export/doc/docx/paragraphs.ts:292-295` with faces threaded through `runs.ts`, `import/doc/paragraphs.ts:567-700` (`faces`, `noteNumbered`, `dropOwn`, `unlessOwn`, `keptLineSpacing`). History: `fa15df577`, then `d3fd13cf0`, `12f14084c`, `4bf6802ad`, `1c174f6d4`, `b9f00435a` and `540550550`, so that the reader inverts exactly the faces the writer counted. Also `ec9ff57ec` and `d79c377d5`.
Simpler: the writer writes `normalLine` (Normal font only), and the reader reads `lineMultiple(line, normal.font)`.
Lost: a paragraph set entirely in Source Serif, JetBrains Mono or Excalifont has a slightly different line pitch in Word. ~70 LOC + ~120 test, medium risk.

<a id="x4"></a>**X4. `asWritten` in docx-audit is a second copy of the writer's rules.**
`scripts/docx-audit.ts:2081-2219`. Every writer change needed a mirror patch here: `c73b548a5`, `cd69face9`, `f96f8016e`, `d7fd4167d`, `297cba00b`, `79a334cf1`, `f18949d2c` and `4e764511f`.
Simpler: normalise both sides the same way before comparing. Merge the pieces of a textblock, ignore spacing on figure-only paragraphs, and compare figures by their place in the flow.
Lost: the gate stops catching spacing regressions right around a split figure. ~120 LOC, low risk.

<a id="x5"></a>**X5. The table-of-contents import cuts and holds at piece level, mostly for malformed fields.**
`import/doc/paragraphs.ts:361-452` (`held`, `whole`/`cut`, run-on detection), `abandonToc`, `runs.ts`. History: `55a7ba786`, `3e0e3466e`, `c1f2f17fa`, `3a15f070c` in two days.
Simpler: work per paragraph. The paragraph where the field separates becomes the TOC node, paragraphs are dropped until the field ends, and a heading, a table or the body's end closes it. Nothing is held.
Lost: in a malformed file, paragraphs between an unclosed TOC and the next heading are dropped (counted as `blocks-flattened`). ~90 LOC + ~150 test, medium risk.

<a id="x6"></a>**X6. `notesFitPages` estimates footnote lines.**
`export/doc/transform.ts:221-258` (`c00908252`, `8ae135bcc`). Keep only the `MAX_PAGE_NOTES` count.
Lost: in the PDF, one note taller than a page loses its overflow. ~40 LOC, low risk.

<a id="x7"></a>**X7. The docx text box writer estimates content height to choose autofit.**
`export/doc/docx/text-boxes.ts:79-161` (`173a0f9d1`, `024ca9686`). Always write `spAutoFit` at the stored height.
Lost: a box taller than its text shrinks to fit in Word. ~50 LOC, low-medium risk.

Judged essential: zip and OPC hardening, the package parse budget, the batched xlsx grid parser, the chart caps, pptx geometry, and `asOpened`'s bounded `fixTables` net.

## Run state

The run of this audit started on 2026-11-05 on the branch `api-audit`, cut from `develop` at `9388751ff`, as an orchestrated program (orchestrate skill). It moved from a Windows machine to the owner's Mac after checkpoint 1. This section is its resume point, and goes with the doc when the doc is empty.

**How it runs (owner's rules for this run).** One finding at a time, never in parallel: one implementer subagent per finding (general-purpose, Opus, effort medium for mechanical work, high for judgment), one commit per finding that also strikes the finding from this doc. Each implementer first checks the finding against the current code and stops without building if it is wrong, already fixed or bigger than stated; the audit's "Simpler" is a hint, not a spec. Anything needing a new route, migration or package, or a product or UX choice, comes to the owner as its own question. A cold Opus review only for a unit on a risk seam (lock, ACL, persisted format, cross-home call, parser, shared helper); otherwise the orchestrator reads the diff. Every 4 to 5 units a checkpoint: a cold standards audit and one `bun run check`, run alone. After each wave one closing review fan-out, one fix wave, a scoped re-review, `bun run check`, then the wave merges `--no-ff` to `develop`; never push without the owner's go. After each wave the owner gets: commits, net lines removed, what was ruled out and why, the ledger, what's next.

**No backward compatibility, the owner's ruling (2026-11-05).** Nothing an older build wrote needs to keep working, stored formats included. A format change is fair game when it makes the code cleaner or shorter, and only then. For example, backups could use our own zip implementation in place of tar if that removes lines. Size such a change before proposing it.

**Done in Wave 1 so far.** T1 (`52fbde92a`, `f0eea3d07`), M3 (`69d85f327`), ML5 (`f9964fd04`, `3b262c6ed`), B7 (`f760fff66`, `b6442f019`), C8 (`c9b85e731`), the recurrence-key year (`5663407ea`, `a099be67b`), C3 (`ab0dd4fc1`, 65 lines), ML3 (`a77a2ab46`, 38 lines; a part request re-parses the .eml, about 5 ms at 2.5 MiB and 30 ms at 25 MiB, and opening a message sends none). T3 (`a9680f2f9`, `29dace119`). Cheap-wins round: X8 (`9f2025c02`, narrowed: the element cap stays), X9 (`d51d2b986`: a timed-out or out-of-memory export is a 413 with one plain message; a failed Print now reads "The PDF failed: Export failed: …", a double "failed" in `usePrintPdf`'s prefix, left for the small leads). M7 (`9df48f70a`, `ce8a49197`, `ecbf78743`), the single-route schemas beside their route (`70fb948af`), `ChatRoom.open` without its lazy `data.db` (`c87bb7ccd`, 40 lines; a room with no `data.db`, only possible mid-copy, answers 503 like a collab document), M4's docs items (the proposal's Goal 1 already said it; the v9 dev-data reset went to the owner), the `.eml` download revalidating like its parts (`5a8ec978e`), the small leads (`93f93910b`, `c49ce4027`, `4faab664a`, `e9bd8a079`, `0c3c94c2e`, `90a13a6db`), a Windows TZID edit no longer 500s (`64adce8f5`), C4 (`34388b1ad`, 24 lines; cold review clean): backup verify, the boundary an uploaded `metadata.db` enters by, refuses a trash root trashed from inside itself and a reserved name or file, in linear time, and every in-memory cycle and `.trash` guard behind it is gone. Checkpoint 2 fixes: `3e6423ea4`, `f27243dda`, `4d5a1966f`; a full `bun run check` passed after them (8,216 pass, 0 fail). Bugs found on the way, each its own commit: a failed folder removal stopped the boot (`06b8e62ae`), an IMAP login during a restore or deletion recreated the home folder (`5de07d536`, owner approved). Checkpoint 1 code fixes: `bd757ca0f`, `8b8c6ecc4`, `a8269f16d`, `1b1369374`. Standards and skills: `c0f3c0b56`, `b52603062`, `023a2f571`. Docs shrink: `7dcf458c0` (skills), `1ea181ad9` (TESTING, CONTRIBUTING and SUPPORT-STYLE-GUIDE, only 5 to 10% smaller: the rest is rules, values and gotchas, so nearer the aim means moving content to docs read on demand, the owner's call). Checkpoint 1 comment sweep: `84076d131`. On macOS at `5fe1850f6`, the backup and restore suites and the transform runner's signal tests passed (181 pass, the 5 Linux-only memory-limit tests skipped), and a full `bun run check` passed (8,205 pass, 0 fail).

**Next, in order.**
4. The rest of Wave 1: B1, ManagedDatabase's two locks. B1 also takes the orphan-row arms of `authDeleteUserReferences` in `auth/auth.ts` and rewrites `recoverBackupsAfterRestart`'s comment, and the `?? 'UTC'` in `getIntlFormatter` (`ical/wall-clock.ts`) that heals rows an older build wrote. Checkpoint every 4 to 5 units, then the wave's closing fan-out. Also small: `occurrenceDateToString` in `packages/lib` still writes the year unpadded. The owner's rulings at checkpoint 2 (2026-11-05): the rest of Wave 1 runs as a cheap-wins round, one implementer and one commit per item in sequence, no per-item review except on a risk seam (B1, the two locks, the migration), then one whole-branch review, one fix wave and one `bun run check`. The round also takes: TESTING's task-only content (the Docker harness table, the Office round-trip gate) moved to docs read on demand; a `metadata.db` migration making `paths.createdAt`, `updatedAt` and `visibility` NOT NULL, dropping the fallbacks in `toDrivePath`; and the small leads (the `recurrenceDate` alias in `invitations.ts`, `occurrenceDateToString`'s unpadded year and lenient trim, calendar import counts that mix series and events, the facade comments naming a file path).
5. Wave 2, each red-test first, starting with a sizing of the CalDAV PUT's synchronous work: at 5 MiB, `restampResource` (about 1.5 s, superlinear: five times the bytes takes about thirty times as long) and `prepareResource` (about 3.4 s) block the event loop inside the write lock, about 5 s per maximal PUT. Then: M1, M9, M2, ML1, C1, X2, X6, then M6, B2, B8, T4, T5 (moved from Wave 1: it changes how local files are written; first check nothing streams a live SQLite file without the lock), T7, T8, ML4, ML6, ML7, ML8, X4, X7, M8 as a sizing only, and a sizing of backup archives as zip through our own zip code in place of tar (worth it only if it removes lines). Show the owner the triaged list before dispatch.
6. Wave 3, one list of product calls with a recommendation each, before any is built: ML2, B3, B4, B6, C2, C5, C6, C7, T2, T6, X3, X5, M5, X1, M4's `deletedAt`, the hand-inserted guest row in `auth/guest-auth.ts` (it bypasses better-auth, so `requestOtp` repeats the before-hook's own-domain refusal), and `rebuildProjection` in calendar and contacts, which only tests call. C5 moved here from Wave 2: building the web avatar from the vCard copy would stop an animated upload over 2 MiB from animating, and the owner wants animated avatars, so any C5 keeps the upload's webp as the served copy.

**Rulings made on the owner's behalf**, each with its cost if wrong:
- T1: a child message without a reply, and a failure status outside 400 to 599, still fail the job. A malformed `{ok:false}` reply without `error` would throw in the IPC callback and stop the API; our typed child can't send one. Undo: settle `invalid-response` for it, two lines.
- M3: besides a crash mid-extract, a close that gives up on a hung extract and a backup taken during one leave one file's text stale in search until its next write. No stored data is lost.
- ML5: a team join pulls no invitations (invitations are registered per address); guests skip the calendar pulls; the new-user path holds no Home while it runs. Accepted as before: a team join can bring back a shared calendar the member removed, if the same owner shared anything with that team.
- B7: the "already parked" boot branch is gone; in that rare state the home stays shut and the log tells the operator to move the folder at the home path aside. Its cause, an IMAP login recreating the folder, is fixed in `5de07d536`.
- IMAP fix: no own cold review (one call to `refuseShutHome` after the password check, with a red test). A deletion answers 404, which `eigen-checkpassword` also maps to a temporary failure. An IMAP session that was already open during a swap, and a login a few milliseconds before the mark, are accepted as rare.
- Recurrence keys (`5663407ea`, `a099be67b`): a year past 9999 after a UTC value shifts into the series zone has no key. A CalDAV PUT naming one is a 403, and a read skips that VEVENT. An inbound iMIP mail naming one drops that mail's remaining VEVENTs (caught and logged, the mail still delivered). Years 0 to 99 key as 19xx through ical.js; accepted. A CalDAV PUT now parses its body inside the Home's calendar write lock, one Semaphore per Home, so every calendar write of that Home may wait for it. A Fable check on 2026-11-05 kept this: the parse is about 47 ms at 5 MiB beside the 1.5 s re-stamp and 3.4 s `prepareResource` the lock already held, and both alternatives (a second try, or keying the body before the lock) add a second refusal site to save about 1%.
- T3: a foreground request that joins a background generation (only when no older version is cached) gets that job's result, a null or a 503, instead of retrying at foreground priority.
- Checkpoint 2: a SQLite or disk failure during a calendar or contacts import rejects the import instead of counting the item as failed; the items already written stay and a retry finishes the file. A REST occurrence date sent as a full ISO datetime is a 400 (no current client sends one; CalDAV never reaches this parser).
- M7: a dangling `trashedFrom` passes verify, since live deletes leave one and restore sends the item to the root. A parent loop can only come from a hand edit now; a request that walks it hangs instead of answering 500. Verify of a deep tree that passes every check still grows with the square of its depth (3.3 s at 20,000 levels, 15 s at 40,000), so the owner ruled (2026-11-06) a folder depth cap of 256 levels: live creates, moves, uploads and WebDAV refuse deeper, and verify refuses a deeper archive. Built in `4ea3f7e80`: the one check sits in `targetFolderErrorInTx`, which every create, move and restore passes, and a copy fails at its first row past the cap and is cleaned up. A move or restore from trash now walks the moved subtree to find its height (an insert checks one row); that cost at 100,000 descendants is unmeasured, for the closing efficiency seat. A document at depth 255 or 256 can't add media or versions.
- Small leads: `occurrenceDateToString` takes `Date | string`, because Eden's reviver turns an occurrence's `YYYY-MM-DD` into a `Date` while its type says `string`; the cause, the date-only payload not going through `plainApi`, is for the closing review. Found on the way, open: a CalDAV event with a Windows TZID and no VTIMEZONE makes a later edit 500 in `buildVTimezone` (`syncVTimezones` should keep only a zone `normalizeTimezone` returns unchanged); fixed.
- C4: a byte-identical CardDAV re-PUT is a no-op, so it no longer rebuilds a missing avatar cache file or re-pushes the self card's profile after an earlier failed push; a card stored in other bytes than sent gets no ETag and, on a no-op, no delta row. For the closing fix wave: a test that a stale `If-None-Match: *` with identical bytes still answers 412, and the two DELETEs judging If-Match through `failsPreconditions`.
- C8: of its four bullets, two were wrong and stayed: the recurrence key re-applied on read, since resolved by zero-padding the key's year, and the shared calendar permission resolved on every list, which keeps it correct after a team change.
- Checkpoint fixes: `shutdownAllHomes` keeps resetting `shuttingDown` for tests, the one exception to the no-test-code rule, because folder-level test runs share modules; undo by running the API tests with `--isolate`. An invitation without an `organizerEventId` now sends no RSVP relay, where it used to send one naming `undefined`.
- X8: a pptx made only of unknown or hidden shapes now imports mostly empty instead of a 413; the element cap stays beside the weight, since folding it in would loosen tiny-element decks 2.5×.

**Machine notes.** Windows with Bun 1.4.4 could not run the backup and restore suites (EBUSY and EPERM on folders still open), signal tests or symlink and chmod tests; a checkpoint there compared the names of failing tests with a checkout of the base commit, and found no regression.
