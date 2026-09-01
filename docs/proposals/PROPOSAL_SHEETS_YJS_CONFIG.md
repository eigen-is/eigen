# Proposal: make concurrent same-cell sheet edits converge

> **Status — Proposal, written 2026-08-30 after N2 landed, not started.** Asked for by Reinder as the follow-up to the config-mirror work ([SHEETS-TODO.md § Next up](../SHEETS-TODO.md#next-up--kill-the-config-mirror-bug-class)). The question it answers: now that `config` is keyed and every write is granular, is "use Yjs structures for the config instead of an op log" still worth doing? **Short answer: not on its own.** The divergence that remains is not a config problem, it is a same-key problem, and cells have it worse than config. The cheap fix is to make the op log respect Yjs's order for conflicting keys (§ Design A). Real Yjs structures (§ Design B) are the long-term answer for the whole workbook, not for `config` alone.

## TL;DR

- Sheets uses Yjs purely as **transport**: a `Y.Array` op log plus a `Y.Map` holding one JSON snapshot string. Yjs converges the *array*; nothing converges the *workbook* each client derives from it.
- After N1 and N2, two clients editing **different** keys converge. Two clients editing the **same** key — the same cell value, the same row height, the same cell's border — end up with each other's value, permanently. Probed, reproducible, not theoretical.
- The same-key case is inherent to "apply mine now, apply theirs when they arrive". It is not specific to `config`; cell values (`sheets[i].data[r][c]`) go through the same path and are edited concurrently far more often than config.
- **Design A (recommended next):** keep the op log, resolve same-key conflicts by the converged order of the `Y.Array`. About a hundred lines in `use-sheet.ts` + `Workbook.applyOp`, no data-model change, no migration. Closes the case for cells *and* config.
- **Design B (later, bigger):** cells and config as real Yjs structures (`Y.Map` per collection, keyed `"r_c"`). Closes the case by construction, removes the snapshot string, and makes undo, versioning and BE reads uniform with the other editors. It needs the [CRDT migration machinery](PROPOSAL_CRDT_MIGRATION.md) first, and the formula engine's recalc has to learn to run off Yjs events. Not a config-only change; doing it for config alone buys nothing A doesn't.

## Problem

### How sheets sync today

Documented in [SHEETS.md § Yjs Sync](../SHEETS.md#yjs-sync); the parts that matter here:

1. A local edit runs inside an immer recipe (`setContextWithProduce`, `packages/sheet/src/components/Workbook/index.tsx`). The patches become ops (`patchToOp`, `state/utils/patch.ts`) and are pushed as one batch onto `doc.getArray('ops')` (`handleOp`, `apps/sheets/src/components/sheets/hooks/use-sheet.ts`).
2. The client marks the push with `isLocalOpRef` and **skips its own batch** when the `Y.Array` observer fires. A peer's batch is applied through `workbook.applyOp` → `opToPatch` → `applyPatches`.
3. On `beforeunload`/unmount the client encodes the whole workbook into `state.snapshot` and clears the array. A joiner decodes the snapshot and replays whatever is still in the array (`replaySheetsOps`, shared with the BE reader).

Every client therefore holds a workbook that is *its own edits in local order, with peer edits spliced in at arrival time*. Yjs guarantees that the array's contents and order converge on every client. It says nothing about the workbook, because no client ever rebuilds the workbook from the converged array.

### What still diverges after N1 and N2

N1 removed the whole-config clobber (`ctx.config` mirror) and materialized every config collection so first writes are granular. N2 keyed `borderInfo` by cell. Both close the **different-key** column: two clients touching different cells, rows or borders now converge, pinned by `src/test/state/events/concurrent-config.test.ts` and `src/test/state/modules/border-convergence.test.ts`.

The **same-key** column is untouched. Probed while building N2, with `borderInfo` already a map:

```
base:     A1 has no border
client A: border A1 blue      → op  add ['config','borderInfo','0_0'] {…blue}
client B: border A1 red       → op  add ['config','borderInfo','0_0'] {…red}
A applies own (blue), receives B's → A ends red
B applies own (red),  receives A's → B ends blue
```

The Y.Array holds `[A-batch, B-batch]` on both clients (say), so a fresh joiner replays and ends **red**. Client A also shows red. Client B shows blue, forever, until someone edits the cell again. The same shape holds for a cell value: A types `1`, B types `2` in the same cell at the same moment; each client shows the other's number.

The same family, smaller: `conditionalFormatRules` and `alternateFormatRules` are arrays whose order is genuine priority. Two clients appending a rule at the same moment each insert the peer's rule before their own, so the two clients can disagree about priority order — visible only where rules overlap. Design A's slot-conflict rule covers this too (the key is the array itself); a reshape would be wrong there, order is the data.

Frequency: two people bordering the same cell at the same moment is rare. Two people typing in the same cell, or one person's stale tab and their fresh tab, is not. This is the ordinary "last write wins, and both sides agree who was last" property every collaborative editor has and sheets does not.

### What "Yjs structures for config" would and would not fix

If `config.merge`, `config.rowlen`, `config.borderInfo` and friends were `Y.Map`s keyed `"r_c"`, a same-key write would be a Yjs map set, and Yjs would pick one winner on every client. That closes the same-key column **for config**. It leaves cell values on the op log with the exact same defect, and it splits the workbook across two sync models: half the state in Yjs structures with Yjs undo semantics, half in an op log with the engine's own undo stack (`ctx.undoList`/`redoList`, `state/types.ts`). Every writer that touches both a cell and its config in one recipe (merge, paste, row insert) would then commit to two systems that cannot share a transaction. That is worse than today.

So the question is not "config: op log or Yjs". It is "same-key conflicts: resolve them in the op log, or move the whole workbook into Yjs".

## Design A — resolve conflicts by the array's order (recommended next)

**Principle.** Yjs already gives every client the same final order of op batches. Define the workbook as *the snapshot plus the ops replayed in that order*. A client that applied its own batch early (optimistically) has to correct itself when a peer batch lands **before** its own in the array and touches a key its own batch wrote.

**Mechanism.**

1. Give every op a key: `sheetId` + the first two or three path segments (`['data', r, c]` → `data/r/c`; `['config','borderInfo','r_c']` → `config/borderInfo/r_c`; `['config','rowlen','7']` → `config/rowlen/7`). `patchToOp` already normalizes paths; the key is a pure function of an `Op`.
2. When the client pushes a batch it records, for every key the batch wrote, the batch's index in the `Y.Array` (`opsArray.length - 1` at push time; Yjs keeps local pushes at the end until a remote insert lands before them).
3. When a peer batch arrives, the `Y.Array` event carries its position. For each op in it:
   - if a **local** batch at a **later** array index wrote the same key, the local write wins in the total order: skip this op (or apply it and re-apply the local one; skipping is simpler and equivalent);
   - otherwise apply it as today.
4. A flush clears the array, and the per-key index table with it. A joiner replays the array in order and needs no table.

**What it costs.** One `Map<key, index>` per client, filled on push, consulted on receive, cleared on flush. `Workbook.applyOp` needs a filter step; `use-sheet.ts` needs the index bookkeeping. `replaySheetsOps` is already order-correct and unchanged. About a hundred lines plus tests. No stored-shape change, no migration, the BE reader is unchanged.

**What it does not cover.**

- Row/column insert and delete ship the whole `config` and every sheet metadata field authoritatively (`sheetMetadataOps`). Two clients inserting rows concurrently already converge in the sense that the later batch's authoritative fields win everywhere, which is what the array order gives. Keyed conflict resolution treats each of those replace ops as a write to its top-level key; fine.
- Two batches that write the same key where the *earlier* one in array order is the local one need no correction: the peer's later write already overwrote it on arrival, which is the converged result.
- Undo. The engine's undo stack holds the inverse of the local edit. After a same-key correction the inverse may no longer match the live value; today that is already true whenever a peer edited the cell in between, so this changes nothing.

**Tests that pin it.** The two existing convergence fixtures get a same-key case each (`test.failing` today, the way N2's specification was written): two clients set the same cell value / the same cell border; after exchange both hold the value of whichever batch is later in the array; a joiner replaying the array agrees with both.

## Design B — the workbook as Yjs structures (later)

The stickies, slides and docs editors keep their document *in* Yjs: `Y.Map`s and `Y.Array`s that Yjs converges, an `UndoManager` over them, version restore via `restoreYjsDoc`, and BE readers that walk the same structures. Sheets is the one editor that does not, and the reasons were engine-shaped: the formula engine wants a dense `data` matrix and a calc chain, and fortune-sheet's state layer mutates a plain object under immer.

Doing it properly means:

- **Data model.** `cells: Y.Map<"r_c", Cell>` per sheet (cells as plain JSON values, not nested Yjs types, so a cell edit is one map set), `config` collections as `Y.Map`s keyed as today, sheet order and metadata in a `Y.Map` per sheet. The dense `data` matrix becomes a derived, per-client cache rebuilt from `cells` on load and patched from Yjs events, which is roughly what `withMaterializedData` does for the BE today.
- **Write path.** The immer patches that `patchToOp` produces map onto Yjs operations almost one-to-one: an `add`/`replace`/`remove` at `['data', r, c]` is a `cells.set/delete`, at `['config', coll, key]` a map set on that collection. `patchToOp` becomes "patches → Yjs transaction"; `applyOp` becomes "Yjs event → immer patches", which `opToPatch` already is. Row/column insert stays a special case: it re-keys every cell, and a re-key is a delete plus a set per cell, so a 130k-row insert is 130k map operations in one transaction. Yjs handles that size, but the update is proportional to the sheet, which is exactly what `sheetMetadataOps` avoids today by shipping the *op* and letting each side re-derive the shift. Keep that: ship an `insertRowCol` marker in a small `Y.Array` and let clients re-key locally, the way the op log does now.
- **Undo.** Either keep the engine's own stack (it holds inverse recipes, which still work if the write path is the same) or move to `Y.UndoManager` like the other editors. Keeping the engine's stack is the smaller step.
- **Snapshot and BE reads.** `state.snapshot` goes away; the BE reader walks the maps. `encode/decodeSheetsSnapshot` and `replaySheetsOps` are deleted. The style/border interning that made v2 4.5× smaller becomes irrelevant, because Yjs stores each cell once and compaction is the DbProvider's snapshot.
- **Formula recalc.** Today a local edit recalculates dependents inside the same immer recipe and ships the results as ops, so peers never recalc. With Yjs structures a peer receives the edited cell *and* its recomputed dependents as map sets in one transaction; the same shape, so nothing changes there. A joiner needs the calc chain seeded from `f` cells, which `seedCalcChain` does.
- **Migration.** Every existing `.eigensheets` container has to be converted once from `state.snapshot` + `ops` into the new roots. Yjs roots cannot be removed, so `state` and `ops` stay as dead roots or the doc is rebuilt; this is precisely the squash-to-snapshot machinery [PROPOSAL_CRDT_MIGRATION.md](PROPOSAL_CRDT_MIGRATION.md) designs, and it is a prerequisite. Reinder ruled (2026-08-23) that only stickies is frozen, so the stored shape may change; what is not optional is that live documents keep opening.

**Effort.** Its own cycle. Roughly: the write/read bridge (M), row/column re-keying (M), BE readers and export (M), migration on top of the CRDT proposal (L), plus the whole verification program over real workbooks. Not something to start for a same-key bug that Design A closes in an afternoon.

## Recommendation

1. **Build Design A** as the next sheets sync step. It removes the last known divergence class for the cost of a key table, and it makes the sentence "the workbook is the snapshot plus the ops in array order" true on every client, not only on joiners.
2. **Do not** build Yjs structures for `config` alone. It closes nothing Design A doesn't and splits the workbook across two sync models.
3. **Reconsider Design B** when one of these becomes true: the CRDT migration machinery exists; sheets needs `Y.UndoManager` semantics (undo across clients, or undo that survives a reload); or the snapshot string becomes the bottleneck it was before the v2 codec. Until then the op log, now granular and keyed, is fine.

## Evidence

- Same-key divergence with a keyed map: probed 2026-08-28 while writing N2's specification (`border-convergence.test.ts` header comment records the result; the probe itself was not committed because it fails by design).
- Transport-only use of Yjs: `apps/sheets/src/components/sheets/hooks/use-sheet.ts` (`handleOp`, `handleOps`, `isLocalOpRef`, `flushSnapshot`); `packages/sheet/src/state/utils/patch.ts` (`patchToOp`, `opToPatch`, `sheetMetadataOps`, `filterPatch`); `packages/sheet/src/engine/replay-ops.ts` (`replaySheetsOps`, shared with `apps/api/src/lib/document/sheets.ts`).
- Root schema: `EIGEN_DOC_TYPE_INFO.sheets.yjsRoots = { state: 'map', ops: 'array' }` (`packages/lib/src/types/drive.ts`).
- Different-key convergence pinned: `packages/sheet/src/test/state/events/concurrent-config.test.ts`, `packages/sheet/src/test/state/modules/border-convergence.test.ts`.
