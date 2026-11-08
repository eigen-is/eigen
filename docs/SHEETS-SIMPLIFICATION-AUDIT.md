# Sheets simplification audit

> **TLDR**: An audit of `packages/sheet` (the grid, its state, the formula engine), the op log around it in `apps/sheets` and `packages/lib/src/sheets`, and the server's replay and compaction. Like the [API audit](API-SIMPLIFICATION-AUDIT.md), it looks for patches stacked on patches, runs of `fix(...)` commits where each fix guarded the corner the previous one opened. It found about 40 findings, a dozen smaller items and 12 redesigns. Five roots explain most of the piles ([§ Where the piles come from](#where-the-piles-come-from)). The biggest is that the wire carries whatever immer happened to write, then patches the leaks with deny lists. On the way, the reviewers found about a dozen live bugs, among them a row insert that overwrites a peer's rename, and a sort that leaves links on the wrong rows ([§ Bugs found on the way](#bugs-found-on-the-way)). The package is a fork of fortune-sheet, nothing has to stay backward compatible, and the owner asked for a bold audit. So beside the local fixes, [§ If we built it today](#if-we-built-it-today) sketches one target design, in steps that each stand alone. Rough size: about 4,000 production lines and 3,000 test lines go with the local findings, and about 2,000 more with the redesigns. The API run showed that such estimates shrink once the work is correct, so judge each item by the mechanism it removes.

Audited 2026-11-08 at `594bc63df` on `api-audit`. Six reviewers each read one area's code and git history: the op log and sync (S), undo (U), the formula engine (E), editing and clipboard (D), render and input (R), and floating objects and range rules (F). The sheet code has about 305 `fix` commits since May 2026, 620 of its 1,355 commits since October. Anchors are relative to `packages/sheet/src/`, except `apps/sheets/` (the app), `lib/` (`packages/lib/src/`) and `api/` (`apps/api/src/lib/`). Line numbers drift, so functions are named. LOC figures are honest guesses. I re-checked these claims against the code: the forward row op shipping its sheet's other fields whole (`patchToOp`, `sheetMetadataOps`), that nothing outside the tests writes `rowReadOnly` or `colReadOnly`, that fill's `applyType` is only ever `'0'` or `'1'`, that the `state/api` functions in D3 have no production caller, that sort writes `sheetData[r][c]` without carrying anything, that `mousePosition` subtracts the fixed 41 and 29 px bar heights, and that only the API import calls `renameSheetRefs`. The rest is each reviewer's own reading. Treat every finding as a lead to confirm before a fix, not a verdict.

Like ROADMAP and the proposals, this doc holds only open work: strike a finding when it is fixed or ruled out, and delete the doc when it is empty.

**The owner's rulings (2026-11-08).**
- The measure of every unit: the code ends up flatter, with fewer patches on patches and fixes on fixes, fewer lines, and easier to understand.
- Adding tests is fine when they add real value. Lines are judged on production code.
- The goal is cleaner and simpler code. A product loss that removes a whole mechanism is welcome; there is no backward compatibility to keep, stored formats included.
- U2 is accepted: once another user edits, your own row, column or sheet insert or delete can no longer be undone. Pick the simplest cut rule that removes the machinery; a peer batch on that sheet, or any peer batch, are both fine. U1 is folded into U2, and U3 (the alternative if U2 were declined) is ruled out.
- A tab rename rewrites the formulas that name the tab, as Excel does. It is one `renameSheet` op kind, which every reader applies, not a cell write per formula: 107 bytes on the wire against 14.6 MB on 100,000 rewritten formulas.
- The batch of product calls, all as recommended:
  - [D2](#d2) yes: sort moves borders, links and validation with their rows, fill copies links, and a paste adds no duplicate rule.
  - [D4](#d4) yes: fill drops Chinese numeral and weekday series and the geometric guess.
  - [D8](#d8) yes: a cut over filter-hidden rows, and a copy whose merge straddles one, get a notice.
  - [E2](#e2) yes: the import recalcs once, with no `computed` flag and no export recalc.
  - [F3](#f3) yes: past the validation cap the rule stops extending and the edit goes through.
  - [F4](#f4) yes: sheet charts store their parts as Canvas and Docs do, and concurrent restyles of one part are last write wins.
  - [F6](#f6) yes: chart code stops carrying keys a newer build might store.
  - [F7](#f7) yes, after checking what Google does: pie slice colours stay at their index. If Google follows the rows, it comes back to the owner.
  - [F8](#f8) yes, last in Wave 2: a tick box draws its box alone, and corner marks don't outrank the handles.
  - [S4](#s4) skipped: [S9](#s9) removes the base and the remount.

## Where the piles come from

The API audit's six patterns all show up here. Read across the six areas, though, most findings trace back to five roots, and fixing a root removes several findings at once.

1. **The wire is whatever immer wrote.** An op is a raw immer patch. So everything a reducer happens to write reaches every peer, and every leak got its own filter or repair: the recalc list on the wire ([E1](#e1)), per-tab fields on the shared sheet ([S7](#s7)), merge stamps that must land after the cells ([D9](#d9)), a link companion op for `hl` ([F2](#f2)), a pre-apply simulation of what `applyPatches` would throw on ([S5](#s5)), and `normalizeSheetConfig` at six entry points because a first write to a missing collection ships it whole. The cure is a closed op vocabulary ([S10](#s10)).
2. **Facts stored twice inside the workbook.** `calcChain` beside the cells' `f` ([E1](#e1)), `cell.mc` beside `config.merge` ([D9](#d9)), `cell.hl` beside `sheet.hyperlink` ([F2](#f2)), `ctx.filter` beside `sheet.filter` ([D7](#d7)), the freeze and pixel boxes beside the indices ([R1](#r1), [R9](#r9)), the clipboard. Every writer has to keep the two in step, and each one that didn't is a fix in the log.
3. **Two paths for one job.** The editor's batch applier beside the engine's replay ([S2](#s2)), writers doing their own formula bookkeeping beside the patch-derived recompute that undo already uses ([E7](#e7)), sort and fill outside `carryCells` ([D2](#d2)), four ways to turn a pointer into a cell ([R3](#r3)), and row and column handlers written twice ([R9](#r9)).
4. **Structural undo across peers.** Undoing your own row, column or sheet op after a peer edited since needed a three-way merge, trial runs, a refusal path and half the shifter. The owner accepted the smaller undo, and that is done.
5. **Fork scaffolding.** fill modes no menu can choose and Chinese numeral series ([D4](#d4)), dead formula state ([E6](#e6)). Each is still checked on edits, and at least one got a fix (`b6ecee4d3`, protection checked before a delete, for a protection nobody can switch on).

The API audit's tripwire applies here unchanged: at the third `fix(x)` on one mechanism within a week, stop and ask which root it is before a fourth patch lands.

## Bugs found on the way

Each comes from reading or tracing the code, not from running it, unless it says so. Each one gets a red test first.

| Bug | Finding | How sure |
|---|---|---|
| Sort moves cells but leaves their borders, links and validation behind, and the moved `hl` stamp points at a link that stayed, so the link lands on another row's text | [D2](#d2) | Sort's write read; link outcome traced |
| A refused table paste still changes row heights (`setRowHeight` runs before the guards) | [D5](#d5) | Traced |
| A peer's column filter change leaves this tab's `ctx.filter` stale, so the next local filter edit can leave the peer's rows hidden for good | [D7](#d7) | Traced |
| The link card over a frozen column of a scrolled sheet shows the cell scrolled underneath; a row-header drag while composing a formula picks rows offset by the grid's page top minus 70 px | [R3](#r3) | Offsets read; outcome traced |
| The first formula typed on an uncomputed sheet ships chain entries, so the server treats that sheet as computed and its export skips the recalc | [E1](#e1) | Traced |

## Shortlist

The best payoff per unit of risk, with no redesign. **Product** marks a finding that changes what a user sees, the owner's call.

| # | Finding | Removes | Risk | Product? | What is lost |
|---|---------|---------|------|----------|--------------|
| [D4](#d4) | Fill keeps four series kinds; dead modes and Chinese series go | ~850 | low | small | 一, 二 and 周一 copy instead of counting; 1, 2, 4 fills linearly |
| [E1](#e1) | Drop `calcChain`; build the formula map from the cells | ~250 + ~200 test, three open TODO rows | med | no | nothing; every edit gets faster |
| [F2](#f2) | A link lives on its cell | ~45 net + ~50 test, the link map, `hl`, a sync loop, an open bug | low-med | no | nothing |
| [R1](#r1) | View geometry derived in the commit | ~110 + ~40 test | med | no | nothing; a cell edit stops recomputing every row and rendering twice |
| [R3](#r3) | One pointer-to-cell function | ~80, two bugs | low-med | no | nothing |
| [E2](#e2) | The import recalcs once; no `computed` flag, no export recalc | ~90 + ~150 test | low | small | a failed import later shrunk below the budget isn't recomputed at export |

## If we built it today

The owner's message for this audit: the package is old, there is no backward compatibility to keep, and with hindsight the design could differ. These are the redesigns the reviewers proposed, put in an order where each step stands on its own and makes the next smaller. None needs a migration beyond "old documents are converted once at decode, or lose the field", which the no-compatibility ruling allows.

1. **Close the vocabulary** ([S10](#s10)). Seven op kinds instead of raw patches. Do [S5](#s5), [E1](#e1), [S7](#s7) and [F2](#f2) first, since each is a local step towards it. Then [D9](#d9) (merges recorded once) removes the stamp-ordering rules, and normalization stops being a correctness rule.
2. **Let the server order the log** ([S9](#s9)). A tab sends batches and the server appends them, so the log grows only at its end. The anchors, the mid-log insert handling, the compaction's no-swap-while-connected rule and the base chain ([S4](#s4)) go, and folding the log while editors are connected becomes cheap.
3. **One block of cells and one rule store** ([D10](#d10), [F9](#f9)). Every writer lands a `Block` through one function, and conditional formats and validation rules become keyed, ordered records with one shifter, one carry and one write rule shared with floating objects.
4. **Derive formula state from patches, read formulas with one tokenizer** ([E7](#e7), [E8](#e8)). Writers only write cells. The commit works out the formula map and the recompute, as undo already does.
5. **Gestures and index-only selections** ([R9](#r9), [R10](#r10)). A drag lives in a gesture object, not twenty context flags, and a selection holds no pixels. Row and column handlers exist once.
6. **Upload names chosen before the write** ([F10](#f10)). No `pending:` name is ever stored, so nothing rewrites history.
7. **Stable row and column ids**, Shape 2 of [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md) ([U7](#u7)). The only change that removes the whole family of position fixes: `history-shift.ts`, the restore and repair machinery, the untransformed-op TODO rows and the codec and compaction. Steps 1 to 5 don't compete with it; they make its bridge smaller. A middle path for undo alone is [U6](#u6), one op transformer for undo entries and late batches.

Steps 1 and 2 remove the most mechanism, and step 7 is a cycle of its own (L to XL).

## Op log, sync, snapshot and compaction

<a id="s2"></a>**S2. A batch is applied by two paths, the editor's reducers and the engine's replay, kept in step by fixes.**
`state/modules/apply-ops.ts` (`applyOpBatch`) beside `engine/replay-ops.ts` (`replaySheetsOps`); the `fromBatch` flags on `insertRowCol`, `deleteRowCol`, `addSheet` and `deleteSheet`.
History: `c6b839be3`, `52c817a2b`, `9cb1085e7`, `fca68450d`, `59a34caff` (three disagreements on a batch that adds a sheet in one commit), `ffd396cd6`, `2bf964067`, and the "only the editor moved it" halves of `8e65b0259` and `a02c56f4a`.
Root cause: root 3. The editor applies a peer's row op through its own reducers, which add shifts the engine lacks and need `fromBatch` to skip the permission check and the selection change. `addSheet` drops the matrix a value carries, so `applyOpBatch` puts it back. Materializing a matrix is coded twice (`initSheetData`, `withMaterializedData`).
Simpler: lift the body of `replaySheetsOps`' loop into `applySheetsBatch(sheets, ops) → { sheets, moved }`, throwing on a refusal. The replay keeps its base normalization, rollback and final celldata sync. `applyOpBatch` sets `draft.sheets` from it and runs only the editor's after-effects (`followView`, `leaveCurrentSheet`, filter options, formula cache). The `fromBatch` parameters go. 
Lost: nothing. ~50 LOC + ~100 test (agreement tests become one path's tests), medium risk, medium-high confidence.

<a id="s4"></a>**S4. A new snapshot remounts the grid, a late batch resets it in place, and the compaction base exists to dodge the remount (small product).**
`apps/sheets/src/components/sheets/hooks/use-sheet.ts` (`pendingRef` and its effect, `reload`, `judgeTransaction`, `baseIdRef` written in six places, the `folded` and `overtaken` branches), `editor.tsx` (`key={snapshotVersion}`), `use-presence.ts` (republishes because a remount wipes presences), `lib/sheets/yjs-state.ts` (`SheetsBase`, `stampSheetsBase`, `compactedFrom`), `api/document/sheets.ts` (`stampMissingSheetsBase`, `restampRestoredSheetsBase`).
History: `88a5cc680`, `8034c9109` (the mount queue), `abe67365d`, `f0a1bdb24`, `d7ec45d8d`, `2556475ca`, `ce30ed790`.
Root cause: root 3 then pattern 4. `replayOps` already resets the grid in place, keeping view and current sheet. A new snapshot instead remounts through React and loses selection, scroll and presences, and batches arriving meanwhile need the queue. The base exists only for a tab that slept past the 60 s linger. This is the client half of the API audit's [T2](API-SIMPLIFICATION-AUDIT.md#t2).
Simpler: the Workbook mounts once. A later snapshot calls `workbook.replayOps(replaySheetsOps(decode(snapshot), log), …)` plus `seedCalcChain` (gone with [E1](#e1)). The first mount keeps a log index and applies `log.slice(at)`, not a queue. The base, the judge, both stampers and `compactedFrom` go.
Lost: a tab that slept through a compaction loses its undo stacks, but keeps selection, scroll and sheet, which is less than T2's remount. ~90 LOC + ~250 test, medium risk, medium confidence. [S9](#s9) removes the rest.

<a id="s5"></a>**S5. Ops apply through immer's all-or-nothing `applyPatches`, so "a write into something a peer deleted" is simulated beforehand.**
`lib/sheets/floating.ts` (`floatingWriteFilter`: shadow copies, `own`, `counts`), `lib/sheets/yjs-ops.ts` (`validationIds`, `isValidationWrite`), the `applyPatches` calls in `replaySheetsOps` and `applyOpBatch`.
History: `56ae43dd3`, `7fa056f4a`, `1b4bf2763`, `254b91976`, `1c2ba1a6e`. Two open SHEETS-TODO rows share the cause: a write into a field of a now-empty cell drops the whole batch, and a merge stamp on a missing cell drops an undo.
Root cause: root 1, pattern 1. The filter predicts what `applyPatches` would throw on, by replaying the batch's own writes on copies.
Simpler: one sequential applier (~35 lines) with JSON Patch semantics: a write needs its parent to exist, or that op alone is skipped. Delete-wins for rules, images and charts falls out. The entry caps and the "matrix is an array" check stay at the op, because a peer's op is untrusted.
Lost: a cell or field write is no longer all-or-nothing with its batch; a refused row or sheet op still rolls back the batch. ~60 LOC net + ~40 test, medium risk, medium confidence.

<a id="s7"></a>**S7. Per-tab view state lives on the shared `Sheet`, so the wire needs `PER_CLIENT_SHEET_FIELDS`.**
`state/utils/patch.ts` (`PER_CLIENT_SHEET_FIELDS`), `lib/sheets/snapshot-codec.ts` (strips `selections`), `sheet.selections` in `state/api/range.ts`, `state/modules/rowcol.ts` and `Workbook/index.tsx`, `sheet.status`.
History: `2bf964067` (a stored selection came back on the wrong row after a peer's delete).
Root cause: roots 2 and 5. `selections` is one tab's memory of each sheet's cursor; `status` is upstream's active-tab flag that nothing sets to 1.
Simpler: a `selectionsBySheet` map on the Context; delete `status`. `filterPatch` becomes `path[0] === 'sheets'`, and the list and the codec strip go.
Lost: nothing. ~20 LOC + ~20 test, low risk, high confidence.

<a id="s8"></a>**S8. Four readers each decide what a workbook without a snapshot is.**
`api/document/sheets.ts` (`readSheetsFromDoc`, `compactSheetsSnapshot`, `readLiveSheets`), `use-sheet.ts` (`loadSnapshot`), the fixed `'sheet-1'` id in `engine/defaults.ts`.
Root cause: root 3. A new workbook's ops are recorded against defaults no stored state holds.
Simpler: write the encoded default snapshot when the workbook is created (count every path: new file, template, copy). Every reader just decodes, and the default id need not be fixed.
Lost: nothing. ~15 LOC, low risk, medium confidence.

S6 (the recalc list on the wire) is [E1](#e1).

<a id="s9"></a>**S9. Redesign: the server orders the log and is the only writer of `ops`.**
Today every tab pushes onto a `Y.Array`, concurrent pushes land in clientID order, and an offline tab's batches land deep in the log. All of `use-sheet.ts`'s order handling exists for that: the anchors (`ANCHOR_EVERY`, `MAX_ANCHORS`, shifting them by `folded`, the reload past the oldest), the delta parsing and `overtaken`, the compaction's `generation` counter and its "no swap while a socket is connected", and [S4](#s4)'s base.
Design: a tab sends `{id, ops}` in a new collab message; the server appends it in its own transaction. The tab keeps its unacknowledged batches and one anchor, taken when that list went non-empty. A peer batch can only overtake the tab's own pending batches: `commutes` stays the fast path, otherwise the tab resets to that anchor and applies the log plus its pending list. Compaction deletes exactly the first N entries it folded, safe at any time, so the SHEETS-TODO row "Fold the op log while editors are connected" costs little more than the broadcast. A reconnecting tab resends; the server dedupes by a per-client last batch id in `state`.
Removes ~150 prod, adds ~120; most of `use-sheet-order.test.tsx` (713 lines) is rewritten. High risk. A user sees an offline tab's edits apply after the edits made meanwhile, which is arguably better. Migration: none. Medium confidence that the payoff is in mechanisms, not lines.

<a id="s10"></a>**S10. Redesign: ops are a closed vocabulary, not raw immer patches.**
Every leak in root 1 got a filter or a shipped repair: [E1](#e1), [S7](#s7), [S5](#s5), the `hl` companion op, the merge stamps, `normalizeSheetConfig` at six entry points, and a whole-list write of conditional formats that loses a peer's rule (open in SHEETS-TODO).
Design: seven ops. `cell(sheet, r, c, cell|null)`; `key(sheet, collection, key, value|null)` for config maps, links, images, charts and rules; `field(sheet, name, value)` for scalars; `appendRule`/`removeRule` for ordered lists (or none, with [F9](#f9)); `insertRowCol`/`deleteRowCol`; `addSheet`/`deleteSheet`. `patchToOp` maps patches onto these by path shape and drops anything else. The receiver applies them with S5's applier and creates a missing collection, so normalization stops being a correctness rule. With [D9](#d9), the stamps and undo's "a merge and its `mc` pass together" go too.
Removes ~250 prod, adds ~150; ~300 test lines that pin batch shapes are rewritten. High risk, nothing lost for a user. Migration: none; compaction folds old logs at first close. Medium confidence.

Judged essential: the log-order rule and `commutes` (61 lines, keeps undo when two people type at once); `replayOps`' handling of the editor and selection; the shape checks `insertRowColOf`, `deleteRowColOf` and `isNewSheet` at the boundary; the interning snapshot codec; compaction at close under one budget; the version before the swap; the read-only lock on an undecodable snapshot; `storedCopy`; `normalizeSheetConfig` for as long as the wire stays patch-shaped.

## Undo and redo

The history is two bursts: about 20 commits on 2026-10-27 (`da208cb7a` to `92a67c419`) built the current design, and a refusal pile followed on 2026-11-02. Cell undo that follows a peer's insert is cheap and earned. Structural undo across peers is where the pile is.

U1 and U2 are done, U3 is ruled out, and U4 (the recalc list in undo entries) is [E1](#e1).

<a id="u6"></a>**U6. Redesign: one op transformer for undo entries and late batches.**
Today `Shifter` transforms immer patch shapes eagerly on every peer row op, while late batches aren't transformed at all. Two SHEETS-TODO M rows ask for exactly that missing transform ("A batch recorded before a peer's row insert writes at the rows it recorded", and the paste-past-the-grid row). Pattern 5: one job, one path built and one missing.
Only cell and field entries are left to transform, which makes this smaller. Design: entries are the ops they sent plus inverse ops, tagged with their batch's log index. An undo rebases its inverse through later log batches with `transformOps(ops, rowColOp)`; the receiver uses the same function on a late batch whose only conflict is structural, instead of an anchor replay. The hard part: an op and its own undo must be skipped as a pair.
~250 LOC replacing `Shifter`'s ~390, plus ~80; net about −100, two TODO rows closed. High risk, medium-low confidence. No migration.

<a id="u7"></a>**U7. Redesign: stable row and column ids, the only change that removes the whole family.**
Shape 2 of [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md). In this area it removes all of `history-shift.ts` (484 lines), the restore and repair machinery (~150), the refusal pile, `replayOps`' stack emptying and the untransformed-op TODO rows. A partial version (op paths by id, formulas still A1) keeps half the shifter and buys little, so it is all or nothing. L to XL, high risk; already parked in ROADMAP-POST-1.

Smaller: `hyperlink` is the one cell-keyed map `normalizeSheetConfig` leaves out, so a sheet's first link is recorded as a whole map and needs `Shifter.cellKeyed`'s whole-map branch ([F2](#f2) removes it). The `cfg.merge = {}` / `cfg.rowlen = {}` guards in `merge.ts`, `paste.ts` and `cell.ts` sit on maps normalization already guarantees. ~15 LOC.

Judged essential: `stillWritten` for cell and field undo, with merge and link units; the shifter's moves of cell paths, keys, axis maps, validation ranges and formula text; structural steps applied through `applyOpBatch`; the eager `contextRef`; `withoutComputedValues` with `recalculate`; gesture merging; sheet batches by id that carry the orders.

## Formula engine and formula state

<a id="e1"></a>**E1. `calcChain` is a second copy of the formula cells, stored in the state, shipped in ops, shifted, merged on undo and rebuilt by the codec.**
Three reviewers found it independently (it was U4 and S6 too). `state/modules/formula-exec.ts` (`getAllFunctionGroup`, `delFunctionGroup`, `insertUpdateFunctionGroup`, `execfunction`'s `calcChainSet`/`notInsertFunc`), `formula-cache.ts`, `state/api/sheet.ts` (`seedCalcChain`), `state/modules/rowcol.ts` (the chain shifts), `history.ts` (`restoredChain`), `history-shift.ts` (`calcChain`, `chainEntry`), `state/utils/patch.ts` (the `calcChain.length` rewrite), `state/utils/commute.ts`, `engine/replay-ops.ts`, `engine/recalc.ts` (`sheetsNeedRecalc` reads chain presence as "computed"), `lib/sheets/snapshot-codec.ts`, `api/document/sheets.ts`.
History: `4d0ae0bd1` already called it "a derived cache that scales with formula count". Since then `a80dea4c5`, `2029643c7`, `ec7a87d10`, `58602b6c3` (the list must count as a write in `commutes`), `78c3df73d`, `5fc5065d0`, plus `ce30ed790` reversed four days later by `78c3df73d`. Three SHEETS-TODO rows are open on it: a copied sheet's formulas don't recalc, undoing a formula drops a peer's formula from the list, and chain bookkeeping costs about a third of a warm edit on the 125k-formula workbook.
Root cause: root 2. "This cell holds a formula" is already `cell.f`. Because the list is shared state, two tabs typing formulas at once both append at one index, never commute, and the tab replays the log and empties its undo.
Simpler: drop the field. The formula map is built by scanning `data` for `f`, as `recalcSheets` already does. `seedCalcChain` goes and mount gets cheaper. "Computed" travels only as the envelope flag, or goes with [E2](#e2).
Lost: nothing. Every edit stops building a string per formula, and concurrent formulas commute. ~250 LOC + ~200 test, medium risk (undo, commute, replay), high confidence.

<a id="e2"></a>**E2. The `computed` flag and the export recalc retry a failure that is deterministic (small product).**
`engine/recalc.ts` (`sheetsNeedRecalc`, `sheetHasFormula`), `api/document/sheets.ts` (`readSheetsFromDoc`'s `recalc` option, the flag logic in `compactSheetsSnapshot`), `api/export/sheets/transform.ts` (`recalc-failed`), `api/import/sheets/transform.ts` (`recalcImportedSheets`), the `computed` field in the codec.
History: `3493e91b3`, `a5c17095d`, `a80dea4c5`, `78c3df73d` (every close paid the failing recalc again).
Root cause: pattern 4. With no older builds, the only uncomputed workbook is an import whose recalc failed. `SERVER_RECALC_BUDGET` counts work, not time, so the export's retry fails exactly as the import did.
Simpler: the import recalcs once; a failure keeps Excel's cached values and its warning. Every reader serves the replayed values. The flag, `sheetsNeedRecalc`, the `recalc` option and the compaction's flag logic go.
Lost: a failed import later cut below the budget isn't recomputed at export. ~90 LOC + ~150 test, low risk, high confidence.

<a id="e4"></a>**E4. A whole column is closed at the grid's current last row, so every change in grid size must reset the formula map.**
`engine/formula-utils.ts` (`resolveCellRange` sets `row[1] = matrix.length - 1` and caches by text), `engine/dependency-index.ts` (`layoutOf`), `formula-cache.ts` (`sheetExtents`), the resets in `expandRowsAndColumns` and `updateFormulaCache`.
History: `fb733f291`, `31dc3e4fe` (a paste that grows the grid must reset), `680ba1e3d`, `d649008d1`, `2c63ee0a0`, `63281af69`, `6b9775d24`.
Root cause: pattern 1. An open reference is closed at registration, so it goes stale when the grid grows. It also needs the target's matrix, so a reference to an unopened sheet records no dependency (part of the copied-sheet TODO).
Simpler: a whole column or row stays open; the index lists it by shape. The server's `withinSheet` clamp stays for its budget. The extents, the grid-size resets and the matrix requirement go.
Lost: nothing. ~50 LOC + ~60 test, low-medium risk, medium-high confidence.

<a id="e5"></a>**E5. A recompute passes inputs, an overlay of computed values and outputs through four long-lived fields that callers must clear.**
`FormulaCache.execFunctionExist`, `pendingChangedCells`, `execFunctionGlobalData`, `ctx.groupValuesRefreshData`; flushed by `triggerGroupValuesRefresh` (`Workbook/index.tsx`), with a paint guard in `Sheet/index.tsx` and manual `= null` resets in `paste.ts` (twice), `history.ts`, `toolbar.ts`, `refresh.ts` and `cell.ts`.
History: inherited; touched by `77ef9d2ac`, `4d90409ff`, `6890d5b29`.
Root cause: roots 2 and 5. The engine reads the overlay before the cell, so one missed clear shadows a cell with a stale value.
Simpler: `execFunctionGroup(ctx, changedCells)` takes its cells as an argument, keeps the overlay local, and writes changed values at its end. The staging, the trailer and the paint guard go .
Lost: nothing. ~80 LOC + ~40 test, low-medium risk, medium-high confidence. [E7](#e7) makes most of it moot.

<a id="e6"></a>**E6. Fork scaffolding in formula state.**
`SheetInfo.calculationChain` and `dynamicArrayCompute` (the only caller of `getSheets()` reads ids), `Sheet.dynamicArray`/`dynamicArray_compute` (never written), `FormulaCellInfo.children` (never read), `formulaDependency` (tests only), `color` (DFS state on long-lived nodes), `execfunction`'s nine positional parameters, `Parser`'s `tiny-emitter` for two reads (pass functions, drop the dependency), `createContextResolver` re-implementing `createArrayResolver`, and `ID_CARD_NUMBER` keeping an 18-digit Chinese ID as text (small product). Pattern 6. ~150 LOC + ~60 test, low risk, high confidence.

<a id="e7"></a>**E7. Redesign: the commit works out the formula map and the recompute from the edit's patches, as undo already does.**
20 `jfrefreshgrid`/`execFunctionGroup` calls in 11 files, 7 explicit `setFormulaCellInfo` calls, `refresh.ts`. The template exists: `patchStep` in `history.ts` runs `applyPatches` → `updateFormulaCache(patches)` → `produceWithPatches(recalculate(patches))`.
History: one day, Sep 23, of writers that forgot to register or recompute: `cb6f3cebf`, `7ba1ecb59`, `4fa9a7b27`, `a951dc3b9`, `58da56564`, `4d90409ff`, `6890d5b29`, `5ebe3568e`, `bfd05a159`, `1ef8c68c7`; later `31dc3e4fe`.
Design: the Workbook's commit does what `patchStep` does for every local recipe and sends both produces as one batch and one undo entry. Writers only write cells. Peer batches stay as they are, since the author computed them.
~300 LOC + ~200 test rewritten, medium-high risk: every writer changes, and a paste whose formulas read each other is evaluated in dependency order instead of cell order. Medium confidence.

<a id="e8"></a>**E8. Redesign: one tokenizer for formula text, the grammar's own lexer, behind every reader.**
Five readers lex one formula's text: the jison lexer (`grammar-parser.ts`), `walkFormulaRefs`, `tokenize` in `recalc.ts`, the fork's highlighter `functionHTML` (`formula-editor.ts`) and `findRefSpans` (`formula-reference-cycle.ts`, F4). `9c6d0e040` left unquoted non-Latin sheet names failing in the grammar while the walkers kept their own `SIMPLE_SHEET_NAME`.
Design: run the jison lexer alone for tokens with offsets; dependencies, copy and fill, shifts, renames, name inlining, highlighting and F4 all read that stream, so a reference is what evaluation reads, by construction.
~450 LOC of walkers replaced by ~250; medium-high risk (the highlighter's `rangeindex` order is tied to the range picker), medium confidence.

Judged essential: `DependencyIndex`'s block, column and row layouts (2.9 s → 78 ms); the iterative DFS in `getCalculationOrder`; the four server recalc budgets, which guard an untrusted import and bound memory; the error-as-value rules; "recalc keeps what it can't improve"; the hand-edited grammar and the formulajs patch; conditional formats compiled once with offsets; `function-list.ts`, descriptions kept a subset of the engine's functions by a test. Storing sheet references by id was considered and rejected: the translation at every boundary costs more than the rename lookups it removes.

## Editing, selection and clipboard

`0e7a1fab1` (Nov 2) already merged three carry loops into `carryCells`, so copy, cut, move and the format painter share one primitive, and five more fixes landed on it the same day. What is left: writers that still go around it, the paste entry points, and the two second copies every writer keeps in step (`mc`, `hl`).

<a id="d2"></a>**D2. Sort and fill land cells outside `carryCells`, and conditional formats are carried five ways (product).**
It was F5 too. `state/modules/sort.ts` (`sortDataRange` writes only `sheetData[r][c]`), `state/modules/drop-cell.ts` (`updateDropCell`: its own `carrySides`, its own validation map, `cdformat[i].cellrange.push(applyRange)`), and the conditional-format blocks in `paste.ts` (`pasteHandlerOfCutPaste` with `cfSplitRange`, `pasteHandlerOfCopyPaste` with `landedRanges`), `move-cells.ts` (`onCellsMoveEnd`) and `selection.ts` (`pasteHandlerOfPaintModel`).
History: `a7efb97e1`, `0e127c464`, `bfd05a159`, `58da56564`, `c885c852d`, `530108ef2`.
Root cause: root 3. The paths already disagree: sort leaves links, borders and validation behind; fill never carries links and extends a rule over the whole apply range when any source cell overlaps it; a same-sheet paste joins the source validation rule but appends a copy of the conditional-format rule every time; the painter's formats ignore a filter's skipped rows.
Simpler: conditional formats land inside `carryCells` through `landedRanges` and `withCfRanges`, joined to the rule on the sheet. Sort becomes `carryCells` with the permuted rows as one tile (safe, since `carryCells` reads every source before it writes). Fill precomputes its series and lands through `carryCells`' `land` callback.
Lost (product): sort moves borders, links and validation with their rows, as Excel does; fill copies links; the per-paste duplicate rules go. Decide whether fill keeps skipping hidden rows. ~100 LOC net + ~60 new test, medium risk, high confidence.

<a id="d4"></a>**D4. Most of `drop-cell.ts` is fill modes nothing can choose, and Chinese numeral and weekday series (small product).**
`state/modules/drop-cell.ts`: `getDataByType` branches `'4'`–`'8'`, the `'2'`/`'3'`/`'8'` arms of `getApplyData`, `chineseToNumber`, `sectionToChinese`, `numberToChinese`, `isChnNumber`, `isChnWeek2/3`, `fillChnWeek*`, `fillChnNumber`, the `chn*` tables, flags 3–6 of `getTypeItemHide`, the geometric branch of `fillSeries`; `dropCellCache` as module state passing arguments.
History: no fix pile; luckysheet scaffolding. The header says "as the fill menu chooses", but no fill menu exists, `applyType` is only ever `'0'` or `'1'` (checked), and no test covers a Chinese series.
Root cause: roots 5 and 4.
Simpler: one series step per source line: numbers (linear trend), dates (days or months), text ending in a number, otherwise copy. `updateDropCell(ctx, copyRange, applyRange, direction)` takes plain arguments.
Lost: 一, 二 and 周一 copy instead of counting; 1, 2, 4 fills linearly, Excel's default. ~850 LOC, low risk, high confidence.

<a id="d5"></a>**D5. Writers refuse in four styles, and some write before they refuse.**
String codes (`deleteSelectedCellText` → `'partMC'`, `hideSelectedRowCol` → `'noMulti'`, `CLEAR_ERRORS`), `ctx.warnDialog = …` (`onCellsMoveEnd`), a plain `throw` (`expandRowsAndColumns`), and `ValidationLimitError`, the only one that drops the edit whole. `handlePaste`'s HTML arm calls `setRowHeight` before the guards. `onPaste` (twice) and the overlay's `onMouseUp` catch inside the recipe and keep partial writes (open in SHEETS-TODO).
History: `d368dcbcc` ("seed config keys after the guards"), `2354a8666`, `60de3a61f`, `eeae07d20`, and `rejected-writes.test.ts`, whose header calls itself a gate against order slips.
Root cause: pattern 1. "Validate before you write" is a convention a table of tests enforces.
Simpler: one `EditRefused(message)` any writer throws; `setContextWithProduce` drops the edit and shows the notice. The catch-inside-recipe sites go. With normalization at every entry point, `config` and its collections become non-optional in the `Sheet` type, so the `??=` seeding and the `bareSheet` half of the gate go. [F3](#f3) is compatible: the validation cap stops refusing at all.
Lost: nothing. ~50 LOC + ~70 test, low-medium risk, high confidence.

<a id="d7"></a>**D7. `ctx.filter` and `ctx.filterRange` mirror the current sheet's filter, as the deleted `ctx.config` mirror did.**
`state/modules/filter.ts` (`applySheetFilter`, `saveFilter` writes both, `getFilterHiddenRows` and `clearFilter` read the mirror), `state/events/mouse-cell.ts`, the sync effect in `SheetOverlay` (fires on `filterRange`, not `filter`), the special case in `apply-ops.ts`.
History: `12eddde7c` deleted the `ctx.config` mirror after `e74cb5c54`, `5727c45c7` and `60de3a61f`; `62925f961`, `1602a406b`.
Root cause: root 2. A peer's filter change updates `sheet.filter` but not the mirror (the bug in [§ Bugs](#bugs-found-on-the-way)).
Simpler: read `getSheet(ctx).filter` and `.filterRange`; keep `ctx.filterOptions` (button geometry), derived in the commit by [R1](#r1).
Lost: nothing. ~30 LOC, low risk, high confidence.

<a id="d8"></a>**D8. A copy over an active filter closes up the block, and a cut doesn't (product).**
`carriedLines` (the filter-hidden intersection), `carriedSpan`, `landedRuns`, the `cut` flag through `copy`, `rangeValueToClipboard` and `isOwnCopyTable`.
History: `0e7a1fab1`, `4bc87bf39` (a merge whose rows a filter left out shifted the pasted table), `e74f58b7d`.
Root cause: pattern 4. Copy and cut carry different lines, and a merge straddling a filtered row needs its own span arithmetic.
Simpler: refuse a cut whose range holds filter-hidden rows, and a copy whose merge straddles one. Copying only the visible rows stays, an everyday workflow.
Lost: those two rare cases get a notice. ~35 LOC + ~60 test, low-medium risk, medium confidence.

D6 (links beside the cell) is [F2](#f2).

<a id="d9"></a>**D9. Redesign: `config.merge` becomes the only record of a merge, and `cell.mc` goes.**
72 reads of `.mc` (`cell.ts` 16, `selection.ts` 13, `merge.ts` 9, `render/phases.ts` 8, `history-shift.ts` 7, `paste.ts` 7, …), `mergeStampOps` and its ordering in `patch.ts`, the engine's stamping after a shift, `carryCells`' `anchors`, `offsetMC` in `pasteHandler`, the import's stamps.
History: `4545e95ac`, `dcc177a07`, `4d0ae0bd1` (stamps applied before the cells existed crashed the replay), `5a19520d2` (a joiner's stamps disagreed with `config.merge`), `8e65b0259` (concurrent row ops put stamps on moved cells and lost the batch).
Design: readers ask `mergeAt(sheet, r, c)`, an index built from `config.merge` and cached in a WeakMap keyed by the merge object. Immer keeps that object's identity until a merge changes, so the paint pays one lookup per cell. Writers touch only `config.merge`. The decoder ignores `mc`, and the import stops stamping.
~150 LOC + ~100 test, high risk (render, export, ops and replay all change), medium-high confidence that the stamp-order family goes with it.

<a id="d10"></a>**D10. Redesign: one block of cells is the currency of every writer.**
`ctx.copyState` (coordinates read back live), `carriedLines` at paste time, `pasteHandler`'s object arm (its own merge and border landing, about 90 lines, which replaces neither validation nor links), its plain-text arm (splits on tabs without unquoting, an open bug), `handlePasteByClick`, and Steps 1–4 of the clipboard work in SHEETS-TODO.
Root cause: root 3. Each source of cells (live coordinates, HTML from Excel, Google or our own copy, TSV, the future grid clipboard item) lands through its own code, so each fix lands two or three times.
Design: a `Block` is `{cells, merges, borders, links, rules, cf, rowHeights}` relative to its corner. `copy` snapshots one; the HTML parser, `parseTsv` and the grid item each build and validate one at the boundary. `carryCells` becomes `landBlock(ctx, block, tiles, land)`; a cut is a land plus a clear; fill and sort produce blocks. Cross-tab sheets-to-sheets paste works once the producer is wired in.
Lost: copy, edit, paste lands the copied cells, as Google does. Measure the block clone on a 20k-row copy. About −400/+200 LOC + a rewrite of `paste*.test.ts` and `hidden-carry.test.ts`, high risk, medium confidence. Subsumes most of D2.

Judged essential: `carryCells` and `carrySides`' overwrite rule; `numberDisplay` and `copiedNumberText` in every writer; `readStyleRules` for Office's commented style block; `runStyleOf`/`hexColor` keeping stored styles out of CSS; the inline-string editor model; the validation caps and rules moving before any formula is evaluated; the Excel hidden-carry rule; `clipToUsedExtent`; `writeBackSheets` writing field by field. `toolbar.ts` has no pile: one generic `updateFormatCell` plus small wrappers. Its 390-line AutoSum is upstream code with one open TODO; narrow it when that TODO is fixed.

## Rendering, input events and the React shell

<a id="r1"></a>**R1. View geometry is worked out in effects after the render that needs it, and kept in three mirrors.**
`components/Sheet/index.tsx` (`useStableJson` over `rowlen`, `columnlen`, `rowhidden`, `colhidden`; the geometry effect with its `geometrySheetId` skip; the `initFreeze` effect), `state/modules/freeze.ts` (`initFreeze`, `FreezenAxisData.scroll` always 0, `cumulative`, `edge`), `GlobalCache.freezen` (33 readers), `SheetOverlay`'s `applySheetFilter` effect, the Workbook's `viewStale`.
History: `1602a406b`, `792b0ac6a` (a switch computed geometry three times), `e5ad62798` (the first frame painted the new sheet on the old layout), `2bf964067`, `3ff83720d`. The precedent is the `ctx.config` mirror, deleted in `12eddde7c`.
Root cause: roots 1 and 2 (pattern 1). A recipe changes the config, frozen panes or filter, React renders, and only then effects recompute `visibledatarow`, the panes and the filter rects with a second `setContext`, or for the freeze a silent `globalCache` write that triggers no render. In between, a peer's row op moves the selection's indices but not its pixel box, and after a freeze the overlay builds regions from the old panes. The effect depends on `data`, whose identity changes on every edit, so every commit reruns `calcRowColSize` over all rows (34 ms at 100k rows, `792b0ac6a`'s measurement) and renders twice; `useStableJson` stringifies four maps on every render, each drag frame included.
Simpler: one `deriveView(base, next)` inside `commit`, so edits, undo, redo and peer batches all pass through it, running only when the current sheet, `data.length` or the identity of a geometry map, `frozen` or `filterRange` changed. The freeze becomes an O(1) read, `freezeOf(ctx)`; `scroll`, `cumulative` and `globalCache.freezen` go. With [D7](#d7), readers take the sheet's filter directly.
Lost: nothing; a cell edit gets faster. ~110 LOC + ~40 test, medium risk, high confidence.

<a id="r3"></a>**R3. Every pointer handler turns page coordinates into sheet coordinates itself, four different ways, and two are wrong.**
48 lines in 11 files (`mouse-cell.ts`, `mouse-drag.ts`, `mouse-header.ts`, `mouse-resize.ts`, `move-cells.ts`, `drop-cell.ts`, `formula-range.ts`, `hyperlink.ts`, `useSheetContextMenu`, both headers) compute `e.pageX - rect.left (- scrollX) (- rowHeaderWidth) + scroll` against different elements and scroll sources, then call `fixPositionOnFrozenCells` (15 sites), or don't. `getCellRowColumn` (`hyperlink.ts`) applies no freeze. `mousePosition` (`location.ts`) subtracts fortune-sheet's fixed `toolbarHeight` (41) and `calculatebarHeight` (29) instead of the grid's top (checked).
History: `a3f0dd9b9` ("mousedown measured from the header while mouseup measures from the overlay, and the 3 was bridging that gap by hand"), `5daf7dbac`, `505e131c9`, `4747f70ca`.
Root cause: root 3. No function owns "where on the sheet is this pointer".
Simpler: `sheetPoint(ctx, e, cellArea)` → `{ viewX, viewY, x, y, inside, pane }` from the cell area's rect, the live scroll and `freezeOf(ctx)`. `mousePosition` and the bar-height constants go.
Lost: nothing; two bugs go. ~80 LOC, low-medium risk, high confidence.

<a id="r6"></a>**R6. The cell editor loads its text in a layout effect, so every opener that fills it first sets a one-shot flag to stop the effect.**
`InputBox`'s `useLayoutEffect`, guarded by `usePrevious` of the position and sheet, reads and clears four `GlobalCache` flags: `overwriteCell` (a typed key), `ignoreWriteCell` (the date shortcut), `doNotUpdateCell` (Insert function, autosum), `doNotFocus` (the formula bar). A second effect clears the editor when the position empties.
History: `76fbfb1dd` (a peer's row op moved the position, the effect reloaded the cell and wiped the typing), `6a302654f`, `8378fd986`, `5a5dff428`.
Root cause: pattern 1. Opening writes the position in a recipe but the content after render.
Simpler: `openCellEditor(ctx, input, { r, c, content, caret })` sets the position and writes the DOM in the recipe, as the date shortcut and Insert function already do by hand. The effect, its refs and the four flags go.
Lost: nothing. ~50 LOC + ~10 test, medium risk (caret timing after a click), medium-high confidence.

<a id="r7"></a>**R7. Host props reach the context through an effect that reruns on every render of the host.**
The Workbook effect keyed on `currentSheetId`, `sheets.length`, `originalData` and nine `mergedSettings` fields does five jobs: the one-time load, copying settings and `hooks` into `ctx`, a fallback `initSheetData`, adopting a stored selection (`viewStale`) and `applySheetView`. `mergedSettings` is memoized on `Object.values(props)` and `editor.tsx` passes `hooks` inline, so every host render reruns it and renders the workbook twice. The comment corner marks depend on that accident: only the rewritten `ctx.hooks` makes the grid repaint when a card's colour changes. `SheetOverlay` seeds a first selection in an effect of its own.
History: `3295ff781`, `792b0ac6a`, `2f6db5b69`, `c21d7c021`, `2bf964067`.
Root cause: patterns 1 and 5.
Simpler: load in the `useState` initializer and seed the selection there; keep hooks in a ref read at call time; sync `allowEdit` in the recipe; hand comment info to the painter as data whose identity changes with the cards; the `initSheetData` fallback is already gone.
Lost: nothing. ~70 LOC, medium risk, medium-high confidence.

R8 (two paste paths) is [D1](#d1).

<a id="r9"></a>**R9. Redesign: a selection holds pixels beside its indices, and every handler keeps both, twice over for rows and columns.**
`Selection` (`state/types.ts`) carries `left`, `top`, `width`, `height` and a `*_move` set; `normalizeSelection` recomputes them (17 calls), `mergeMoveMain` returns pixels (15 calls), and `extendSelectionGeometry`, `formulaCache.func_selectedrange` and `formulaRangeHighlight` store rects too. They come in axis-swapped twins: `handleRowHeaderMouseDown` and `handleColumnHeaderMouseDown` (about 290 lines each), `RowHeader` and `ColumnHeader`, the resize and freeze handlers, `rangeDragRow` and `rangeDragColumn`. Fixes land twice: `a3f0dd9b9`, `d927a646e`, `145594cf8`.
Design: a selection is indices only. The overlay computes each box at render from `visibledatarow` and `visibledatacolumn` in O(1), as find highlights already do. Header, resize and freeze handlers take an `Axis` and exist once.
~500 LOC removed + ~150 test touched, medium-high risk, medium confidence on the size. No migration: selections are never stored.

<a id="r10"></a>**R10. Redesign: a drag is twenty flags in the immer context, ended by resetting each one.**
`selectionActive`, `scrolling`, `rowsSelected`, `colsSelected`, `rowsResizing`/`rowsResizeStart`, `colsResizing`/`colsResizeStart`, `colsFreezeDragging`, `rowsFreezeDragging`, `cellSelectMoving`/`cellSelectMoveIndex`, `cellSelectExtending`/`cellSelectExtendIndex`, the `formulaCache.range*` starts and `globalCache.dragCellStartPos`. `handleOverlayMouseMove` and `mouseRender` dispatch over them in a fixed precedence, `handleOverlayMouseUp` resets them, and previews are written into the DOM from inside recipes. Every frame of a resize, freeze or move runs a `produce` and rerenders every context reader.
History: `7060e6a73` ("the flags the mouse-up resets lived in the edit it threw away, so the next click ran the fill or the move again"), `a3f0dd9b9`, `505e131c9`, `d368dcbcc`, `559e3c344`.
Design: a pointerdown creates a gesture `{ onMove, onUp, onCancel }` holding its own start state, with `setPointerCapture`. Its preview lives in a ref; only its result goes through `setContext`, on pointerup. Touch long-press moves onto the same pointer events.
~300 LOC net plus drag-test rewrites, high risk, medium confidence. Do it after R3, with R9.

Smaller:
- Tab reordering has three paths (`SheetItem.onDrop` with a −0.1 trick, move left and right through `api.setSheetOrder` with a tied order and a stable sort, and `setSheetOrder` renumbering). One `moveSheet(ctx, id, toIndex)`, ~25 LOC.
- `drawMain` clears the text-measure cache 100 ms after every draw, so every edit after a pause measures the view from scratch. A size cap bounds it without that.
- `MemoizedSheetOverlay` memoizes a component with no props that reads the context, so the memo does nothing.
- RENDERING.md § 2 says the header labels are React DOM; the canvas paints them (`render/headers.ts`).

Judged essential: `scrollFrame`/`planScroll` with its shared-pixel and edge-band rules (measured to 120 fps); the font watcher and `loadCellFont`; one rect shared by painter and hit test; the `OverlayRegion` pane model and the scroll bus; rAF-coalesced mousemove; the modal slot's opening id; `SHEET_HOTKEYS`; `useCellEditorRefocus`; the rich-text run model; grid lines as one `Path2D`; `pressClosesMenu`.

## Floating objects, charts and range rules

Answers to questions the audit asked itself: a chart's Setup block is not a second copy, since `chartRangeOf` derives it from the refs on every read (`f7662c628`). Conditional formats, validation and chart refs already share `shiftRangeForInsert`/`Delete`, and borders and links share `shiftCellKeyedFor*`. The chart redraw cache is one earned `WeakMap` (`4749f1c5e`, `8955f236f`).

<a id="f2"></a>**F2. A link lives in a side map keyed by position, and the cell carries a stamp of where the link was made, which no row op moves.**
It was D6 too. `sheet.hyperlink` with `cell.hl = {r, c, id}` (`state/modules/hyperlink.ts`: `saveHyperlink`, `removeHyperlink`), the loop in `patchToOp` that ships `['hyperlink', key]` beside any whole write of a linked cell, the editor-only shift in `state/modules/rowcol.ts`, the link carry in `carryCells` (`linkMap`), the link loop in `deleteSelectedCellText`, `delete value.hl` in the format painter, the API's `v.hl.id = id` rename.
History: `c885c852d`, `0bda5dec0`, `42269e140`, `0e7a1fab1`, `36a095a36` (the painter carried `hl` and the server replay dropped the whole batch). SHEETS-TODO has the open bug: a row op ships `hyperlink` whole, so a peer's link is lost and two concurrent inserts leave a link one row off. (The SHEETS-TODO row about pasted links only working from A1 names a `pasteHyperlinks` that no longer exists, so it looks stale.)
Root cause: root 2. The link is the cell's, but every writer that moves cells carries it by hand.
Simpler: `cell.link = {type, address}` on the `Cell`, as runs and `commentCardIds` already are. The matrix shift, `carryCells`, sort, fill, undo and the op log move it for free; the map, `hl`, the sync loop, `linkMap` and the editor-only shift go. Delete drops it with the value; Clear formatting and the painter keep it. The import, the exports and `document/sheets.ts` read it from the cell (about 10 lines each). Old snapshots drop their links, or the decoder converts them once. 
Lost: nothing. ~45 LOC net + ~50 test, low-medium risk, high confidence on the problem.

<a id="f3"></a>**F3. An edit that would push a validation rule past its cap throws, and the Workbook rolls the whole edit back (small product).**
`ValidationLimitError` (`state/modules/validation-rules.ts`: `addValidation`, `clearValidations`), `refuse` in `setContextWithProduce` (runs `resetEngine` and `warmFormulaCellInfoMapOnIdle`, ends the drag), three rethrows in the paste and mouse-up handlers, and the ordering rule that `carryCells` must move rules before any cell so no formula is evaluated before the throw.
History: `530108ef2` (ranges bounded), `3f4473bc4` (rules capped), `19a94d756` (the editor throws): three fixes in a day on one cap.
Root cause: pattern 3. The caps belong at the boundary (`wellFormedValidations`, `opToPatchOnSheets`), where they stay. The editor's own writer predicts that a peer would drop the rule and refuses the edit.
Simpler: past a cap, a carry lands its cells without extending the rule, or drops a rule a cut would split past it. The edit goes through: "may forget, must not corrupt".
Lost: the "too complex" alert; in a pathological paste the rule silently doesn't extend. ~45 LOC + ~150 test, low risk, high confidence.

<a id="f4"></a>**F4. Sheets keeps a chart codec of its own (keyed records, entry writes, an entry cap) so two peers can restyle two series of one chart at once (small product).**
`lib/charts/spec.ts` (`SHEET_CHART_KEYED_PART_KEYS`, `keyedPart`'s record branch, `entryPath`, `sheetChartSpecWrites`, `entryWrites`, `newSheetChartSpecParts`), `lib/sheets/floating.ts` (`chartWrite`, `chartEntries`, `chartsFit`, `chartsWithinEntryCap`), `MAX_CHART_SPEC_ENTRIES`, `engine/chart-data.ts` (`writeSheetChartSpec`, `withSheetChartSpecWrites`, `copySheetChartSpec`), the record loop in `writeBackSheets`.
History: `1d65b5a72`, then `1b4bf2763` (a whole write to a keyed part applies only as a record) and `07298670f` (a duplicated chart gets records of its own) on Oct 24, then `b98f85bea`, `2d185b9ca`.
Root cause: patterns 4 and 5. Canvas and Docs store each part as one JSON string through `chartSpecWrites`; only Sheets splits four parts into entries.
Simpler: a sheet chart stores its parts as Canvas and Docs do. `floatingWriteFilter` shrinks to "a write into an object applies when it is held", and the entry cap goes, since the byte limit bounds a string.
Lost: two peers editing two series of one chart at the same instant; the last write wins for that part. ~230 LOC + ~300 test, medium risk, high confidence.

<a id="f6"></a>**F6. Chart code keeps every key a newer build might store, and guards each writer for it.**
`holdsUnknownChartData` (`lib/charts/resolve.ts`) and the read-only Setup and Edit data rows it drives, `walkRefs` and `mapChartRefs` moving "every ref under any key, even in a chart this build can't draw", `chartPointMoves` for "series this build doesn't read", `laidOver` (`lib/charts/change.ts`), `chartSpecTexts` and `copySheetChartSpec` carrying every `spec*` key.
History: `baff5a4c0`, `90fe6212d`, `bbd34f905`, `69b4fe8e8`, `11744cd42` (Oct 24).
Root cause: pattern 4. Forward compatibility is the mirror of the backward compatibility the owner ruled out; it matters only while a tab from an older build edits during an upgrade.
Simpler: the resolved `ChartSpec` is the truth; writers apply a change onto the chart as resolved at write time; refs and points move through the known fields.
Lost: an old tab open across an upgrade may drop a newer build's chart fields. ~110 LOC + ~150 test, medium risk (shared with Docs, Slides and Vector), medium confidence.

<a id="f7"></a>**F7. A pie's slice colours follow their rows through row ops and Edit data (product).**
`pointsForInsert`, `pointsForDelete`, `runsAlong` (`engine/rowcol.ts`), the `points` parameter of `mapChartRefs` and `shiftChartsAcrossSheets`, `chartPointMoves`, the row tracking in `chart-data-dialog.tsx` Save.
History: `49e0d2bb5`, `2d185b9ca`, `69b4fe8e8`, `11744cd42`.
Root cause: pattern 4. Moving index-keyed styles needs ordered move ops with their own race rule.
Simpler: point styles stay keyed by index.
Lost: after a row insert or delete inside a pie's categories, custom slice colours stay at their index. Check what Google does first. ~75 LOC + ~120 test, low-medium risk, medium confidence.

<a id="f8"></a>**F8. Tick box and corner-mark rules that are precision the owner could drop (small product).**
`showsCheckboxLabel` and `checkboxAlign` (`state/modules/data-validation.ts`), the comment, invalid and forced-string branches of `cellGlyphAt` (`state/modules/cell-glyph.ts`), which claim a corner only to keep the move band and fill handle off it.
History: `0578953d3`, `ea5bffa8b`, `948d4e2f8`, `505e131c9`.
Simpler: a tick box draws its box alone, centred unless the cell sets an alignment; only the chevron and the tick box outrank the handles.
Lost: the label beside a tick box with custom values, and a click on a corner mark sometimes starts a move. ~35 LOC + ~40 test, low risk, high confidence; low payoff.

F5 (conditional formats carried outside `carryCells`) is [D2](#d2).

<a id="f9"></a>**F9. Redesign: one keyed, ordered "range rule" store for conditional formats and validation rules, sharing one record-write rule with floating objects.**
Today one job has three shapes. Conditional formats are an ordered array: a whole-list write drops a peer's rule (SHEETS-TODO), Manage rules deletes by index, the shift is inline, the carry sits at five sites ([D2](#d2)), and only the export checks a rule's shape. Validation rules are a map by id whose cell winner is the "highest id" (`compareValidationIds`), arbitrary for random uuids, so every apply cuts the cells out of other rules. Images and charts use `floatingWriteFilter`.
Design: both rule kinds become `Record<id, {ranges, order, …}>` with `order` a fractional key, as floating objects already have. A reorder writes one key; the newest validation rule wins by construction. One `shiftRangeRecords`, one carry in `carryCells`, one boundary check with caps per kind, and one record-write rule for rules, images and charts.
Removes the conditional-format and index-delete races, five carry sites, the inline shift loops, `validationIds`, `compareValidationIds` and `alternateFormatRules`. About 400 LOC rewritten for ~130 net fewer, ~200 fewer test lines, high risk, medium confidence that it pays; the duplication itself is certain. Migration: a decoder conversion, or old workbooks lose their rules.

<a id="f10"></a>**F10. Redesign: the client names an upload's file before it writes the reference, so no `pending:` name is ever stored (small product).**
Sheets' `replaceImageMediaName`, `removeImageByMediaName` and `replaceMediaNameInHistory` (`state/modules/image.ts`; the last rewrites patches at four depths, whole sheets and `deletedSheet` in both undo stacks), the swap, remove and zombie sweep in `apps/sheets/src/components/sheets/editor.tsx`; Docs' `swapFigureMediaName` and its sweep; Canvas's untracked swap and sweep; `use-zombie-media-sweep.ts`; the pending map in `media-resolver.tsx`.
History: `ac40137ce` (a settled name reaches every undo and redo entry), `d3f5245f3`, and the 60 s sweep wait.
Root cause: roots 2 and 1. A temporary name is stored, so every copy of the document (other sheets, undo, redo, a deleted sheet, a closed tab) must be found and rewritten.
Design: `startUpload` names the file `<uuid>.<ext>` before the upload, registers its blob URL under that name, and the caller writes the final name at once. Nothing swaps, no history is rewritten, and a tab closed mid-upload leaves a name that reads as missing, so the sweep goes too.
Lost: peers see the missing-image mark instead of a loader during someone's upload; the media folder shows uuid names. ~150 LOC + ~150 test across Sheets, Docs and Canvas, medium risk, medium-high confidence.

Judged essential: the `sheetChartSvg` redraw cache; Setup derived from the refs; the shared range shifters; `sheetFloatingBox` clamping a peer's or a file's box; `validationLookup`'s once-per-paint grid; `coalescedRanges` and the boundary caps; one `FloatingObjectFrame` for both kinds; `chartRangeText` by sheet id; `resolveRangeChartData` refusing a range by its refs before reading a cell; `currentRegion`'s bounded growth; the fractional z-order shared with Vector.

## Run plan

Run it as an orchestrated program (the [orchestrate skill](../.claude/skills/orchestrate/SKILL.md)) on its own branch, `sheets-audit`, in its own git worktree, since another session works on other parts of Eigen in the main checkout.

**Rules for every unit.**
- One implementer per unit, one commit per unit. The implementer loads the [source-file skill](../.claude/skills/source-file/SKILL.md) and follows [CODE-STANDARDS.md](CODE-STANDARDS.md) on every file it touches: the header comment, no dead code, no module-level state, explicit types, and a redesign instead of a second patch.
- Step 0 first: check the finding against the current code and say what mechanism or risk goes. Stop without building if it is wrong, already fixed, or smaller than stated, and strike it with the reason. The "Simpler" here is a hint, not a spec; a simpler design than the one written is better.
- Every bug gets a red test first. A unit is judged by the mechanism it removes, not its line count. A unit that grows the code needs a reason.
- The orchestrator, not the implementer, strikes a finding from this doc when it merges the unit, so parallel units never edit this doc at once. It also updates SHEETS.md and SHEETS-TODO.md where the unit changed what they say, through the [domain-doc skill](../.claude/skills/domain-doc/SKILL.md).
- A cold review only on a risk seam: the op pipeline, undo, the replay, the codec, a stored format, `packages/lib` shared with other apps. Otherwise the orchestrator reads the diff.
- Sheets performance must not regress ([SHEETS-AT-120fps.md](SHEETS-AT-120fps.md)): measure before and after on the reference workbooks where a unit touches an edit, a recalc, the paint or a load.

**Parallel lanes.** Units in one lane touch the same files and run in order; lanes run side by side, each implementer in its own worktree off `sheets-audit`, at most five at a time. The orchestrator merges finished units into `sheets-audit` one at a time and reruns the touched package's suite (`bun run test:sheet`, `cd apps/sheets && bun run test`, or the API files the unit touched). `bun run check` runs alone, at each wave's end.

Wave 1 (nothing lost, or decided):

| Lane | Units, in order | Main files |
|---|---|---|
| Op log | [S7](#s7), [S8](#s8) | `state/utils/patch.ts`, `state/modules/sheet.ts`, `engine/replay-ops.ts`, `use-sheet.ts` |
| Formulas | [E6](#e6), then [E4](#e4), [E5](#e5) | `engine/formula-shift.ts`, `engine/recalc.ts`, `formula-*` |
| Editing | [D7](#d7), [D5](#d5) | `state/api/*`, `paste.ts`, `clipboard.ts`, `filter.ts` |
| Render and input | [R3](#r3), then [R6](#r6), [R7](#r7) | `state/context.ts`, `context/modal.tsx`, `state/events/*`, `SheetOverlay/*` |
| Rules | [F3](#f3) | `protection.ts`, `validation*.ts`, `DataValidation/*` |

Wave 2 (cross-cutting, after the lanes they depend on merged): [E1](#e1) then [E2](#e2); [F2](#f2) (after D2); [D2](#d2) after D4 is ruled; [S2](#s2) then [S5](#s5); [R1](#r1) (after D7 and R3); [D4](#d4), [D8](#d8), [F4](#f4), [F6](#f6), [F7](#f7), [F8](#f8) as ruled. F4, F6 and F7 change `packages/lib/src/charts`, which Docs, Slides and Vector share: tell the other session first.

Wave 3, the redesigns, in [§ If we built it today](#if-we-built-it-today)'s order. Each is sized again at its Step 0 and shown to the owner before it is built: [S10](#s10) with [D9](#d9), [S9](#s9) (which supersedes [S4](#s4)), [D10](#d10), [F9](#f9), [E7](#e7) and [E8](#e8), [R9](#r9) with [R10](#r10), [F10](#f10) (touches Docs and Canvas: tell the other session), [U6](#u6) only if still worth it. [U7](#u7) stays parked in ROADMAP-POST-1.

**Talking to the other session.** Another session works on other parts of Eigen in the main checkout. At the start and before each wave, list the other sessions (`ListAgents`) and send each one message: the branch, the worktree path, the paths this run owns (`packages/sheet`, `apps/sheets`, `packages/lib/src/sheets`, the sheets files under `apps/api/src/lib/document`, `export/sheets` and `import/sheets`, the sheets parts of `apps/api/src/lib/collab/collab-document.ts`), and the shared paths it will touch next. Ask for its own. Before changing a shared path (`packages/lib/src/charts`, `packages/lib/src/core`, `packages/ui`, `apps/docs`, the collab store, CODE-STANDARDS, ROADMAP, README), message first and wait for an answer. The API audit's [T2](API-SIMPLIFICATION-AUDIT.md#t2) is the server half of S4 and S9, so this run takes it and says so. Announce each merge to `develop`. Never push, and never merge to `develop`, without the owner's go.

**Run state.** Started 2026-11-08 on `sheets-audit` in the worktree `eigen-sheets`, cut from `develop` at `d55da56c1`. This section is the resume point: what merged, what was ruled out and why, and what comes next.

- This run also takes the API audit's T2 and X2 (the other session agreed). Don't edit `API-SIMPLIFICATION-AUDIT.md` on this branch, because that session keeps editing it: tell it when T2 or X2 lands, and it strikes them. Its X2 ruling: a flat cap, the runner's deadline and its memory limit, and a timeout or out-of-memory is an accepted outcome. X2 joins Wave 2.
- The owner allows an implementer to hand mechanical work (a grep sweep, rewiring similar test call sites, running a suite) to a cheaper sub-agent: Sonnet, or Haiku for a lookup, at low or medium effort. The implementer keeps Step 0, the design, the diff read and the commit. A sub-agent uses the implementer's worktree with no isolation option, one editing at a time, and never commits.
- Wave 1 is running. Merged: E3, U2, S3, R2, D1, F1, E9, S1, R5, R4 (`ctx.rowHeaderWidth` and `columnHeaderHeight` stay for R3 to inline), D3 (the ref's `setSelection` stays: 13 test callers and no other door to the stored selection copy; S7 may remove it). Running: E6, F1 fixes then F3, D7, U2 and E9 review fixes, R3. In cold review: S3. Next: S7, S8, E4, E5, D5, R6, R7, then the wave's close.
- For E4: half-open legs (`B2:1`, `A:B1`, `TRUE:A1`) read more than their dependency list, and `A1\n:B2` is missed because only spaces join a range.
- For R6: R2's implementer read that the date shortcut's `updateCell` with the closed, empty editor clears a filled cell before opening the edit, so Escape wouldn't restore it. Not run.
- For R3: `handleCellAreaMouseDown` sets `ctx.selectionActive = true` and then tests it, so that block is always true.
- For D5: `handlePaste` sits below its helpers; `setRowHeight` still runs before the guards in `pasteHandler`.
- After S3, `Sheet.data` is optional only because the type is shared with stored sheets. An editor-side required type would remove the guards in `paste.ts`, `refresh.ts`, `api/cell.ts`, `apply-ops.ts`, `applySheetView` and `comment-anchors.ts`.
- Open for the wave's docs unit: SHEETS.md and SHEETS-TODO.md statements S1, R5 and the units in review make false; the help center and CHANGELOG for U2 (undo limit), E9 (rename rewrites formulas), R4 and S1's fixes. Each unit's report names them, and the orchestrator's merge list holds them.
- F1's review fixes, running now with F3 next: an imported "any date" rule stores `1899-12-31`, which `dateSerial` rejects, so every date fails it. Validation reads the display text `m` in the painter and on entry, so `1,234.50` fails a number rule and a dd/MM/yyyy date refused on Enter: rules should read the parsed value.
- For the closing review: D3 deleted the API insert and delete tests as covered by `rowcol.test.ts` and `rowcol-ops` without comparing assertions. `state/modules/cell.ts` got only a light pass; `carryCells` could split out.
