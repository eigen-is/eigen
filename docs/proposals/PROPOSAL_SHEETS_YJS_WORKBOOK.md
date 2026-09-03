# Proposal: sheets as a real Yjs document

> **TLDR**: Sheets is the one Eigen editor whose document does not live in Yjs. It stores one JSON string plus a log of operations, and it has its own undo stack. Reinder asked whether sheets could work the way docs, slides, stickies and vector do, with Yjs structures as the truth and undo from `Y.UndoManager`. The answer is **yes, it is possible, but not with cells keyed by row and column**. A spreadsheet cell has no identity of its own. It is "the cell at row 5, column 2", and inserting a row renames every cell below it. Yjs is built for things with a stable identity. So the real Yjs version of sheets needs stable row and column ids, cells keyed by those ids, and formulas stored against ids. That is an engine-level change. Undo alone is not a reason to do it: `Y.UndoManager` and the engine's own stack are both in-memory per-tab stacks, and the two things Yjs undo does better can be added to the current stack for a fraction of the cost. **Recommendation: fix the operation log in place first** (agreed order for conflicts, server-side compaction, two undo fixes, and for concurrent row inserts a rebase that makes live clients match what a joiner sees, not operational transform). Keep the stable-id Yjs design as the direction for when the engine gets id-based addressing. **No backwards compatibility is required for sheets** (Reinder, 2026-09-03), so whichever route is taken needs no migration machinery.

## The question

Sheets stores its state as one serialized JSON snapshot in a `Y.Map` and a list of ops in a `Y.Array`. Every other editor keeps the document itself in Yjs and gets undo from `Y.UndoManager`. Is it possible to bring sheets in line, and would we get undo and redo from Yjs for free?

## How sheets works today

The full description is in [SHEETS.md § Yjs Sync](../SHEETS.md#yjs-sync). The short version:

- A local edit runs inside an immer recipe. The patches immer produces become ops. One recipe is one batch, and one batch is pushed as one element on the `ops` array. Row and column inserts are not shipped as cell patches but as one small marker op plus the sheet's metadata; every client re-derives the cell shift itself.
- A peer's batch is applied as patches. Peers never recalculate formulas. The client that made the edit recomputes the dependents and ships their new values in the same batch.
- Each client applies its own batch straight away and skips it when it comes back from the array. A peer's batch is applied when it arrives. Yjs guarantees that every client ends up with the same array. It does not rebuild any client's workbook from that array, so the workbook itself is not guaranteed to converge.
- On `beforeunload` (only while the socket is connected) and on unmount, the client encodes the whole workbook into `state.snapshot` and clears the array. A joiner decodes the snapshot and replays what is left in the array. The API reads the document the same way.
- Undo is the engine's own stack of inverse immer patches, per tab, no depth limit. An undo is broadcast to peers as an ordinary batch. A peer's batch is not undoable. The paths in the stack are absolute row and column numbers.

Two things found while grounding this proposal, both recorded in [SHEETS.md § Yjs Sync](../SHEETS.md#yjs-sync) and [SHEETS-TODO.md](../SHEETS-TODO.md):

1. **Undo after a peer inserts a row hits the wrong cell.** The stack is only corrected for sheet deletions, never for row or column shifts. So after a peer inserts a row above your edit, your undo lands one row off.
2. **The unload flush is skipped while offline**, so a tab that closes during a blip writes no snapshot. The op log then grows until some connected tab flushes. Nothing guarantees that a snapshot is ever written.


## What "the Yjs way" means in Eigen

The other three canvas editors share one pattern (details in [CANVAS.md](../CANVAS.md)):

- One nested `Y.Map` per object, with one map entry per field. A concurrent edit to the same field is last-writer-wins per field, and the code says so.
- Order is either a `Y.Array` of ids (slides, stickies) or a fractional index stored on each object (vector).
- Every gesture is one `doc.transact()`. Discrete actions are sealed with `stopCapturing()` so they do not merge into the previous undo step; typing and nudging are left unsealed and coalesce within the 500 ms capture window.
- `useCollabDoc` owns the doc, the socket provider and the `Y.UndoManager`. `useYjsUndoHotkeys` binds Mod+Z. Technical fixups write under a non-null origin so they are never an undo step.
- The React state is rebuilt from the whole document on every Yjs event. That is fine for a few hundred objects. It would not be fine for a hundred thousand cells; sheets would keep its patch-based bridge.
- The API reads the same roots with the same helpers, and version restore replaces the roots in one transaction.

Docs is the same model one level up: Tiptap's collaboration extension keeps the ProseMirror document in a `Y.XmlFragment`, and y-prosemirror's history plugin wraps a `Y.UndoManager` of its own, so `useCollabDoc` hands it no undo scope.

Sheets already uses `useCollabDoc` for the socket and the loading, offline and unsynced-edits state. It just does not hand it an undo scope.

## Can cells live in a Y.Map? The identity problem

There are three shapes to choose from. Only one of them is a real Yjs document.

**Shape 1: a `Y.Map` keyed `"row_col"`.** This is what [PROPOSAL_SHEETS_YJS_CONFIG.md](PROPOSAL_SHEETS_YJS_CONFIG.md) § Design B sketched. Concurrent edits to the same cell converge (Yjs picks a winner), a cell edit is a tiny update, and `Y.UndoManager` works for cell edits. But a row insert renames every cell below it. Done honestly, that is a delete and a set for every key, and the update is the size of the whole sheet (measured below). Done cheaply, the insert is shipped as a marker and every client re-keys its own copy, and then the map is no longer the truth: the truth is "map plus the markers replayed in order", which is the op log again with Yjs bolted on. Two peers inserting rows at the same time re-key the same map twice and corrupt it. And undo after a peer's insert silently does nothing, because the peer's re-key counts as a remote change to every key. **This shape is a trap.** It looks like the small step and it is not.

**Shape 2: stable ids.** Each sheet gets `rows` and `cols` as `Y.Array`s of ids, and `cells` as a `Y.Map` keyed `"rowId:colId"`. Row heights, hidden flags, merges, validation and hyperlinks are keyed by id too. A row insert is one array insert and touches no cell. A row move is a delete plus an insert of the id, because Yjs 13 has no move primitive; two peers moving the same row at once can leave its id twice or nowhere, so the reader dedupes the array and appends any id it holds cells for but does not list. A row delete leaves its cells in the map until a sweep removes them, and a concurrent edit to a cell in a row being deleted lands in an orphan; both are read-time filters, not conflicts. Two peers inserting rows converge because Yjs orders the array. Undo of a cell edit stays attached to the right cell forever. This is the identity model the other editors use, applied to a grid: things with ids, ordered by an array.

The price is formulas. A formula is A1 text (`=SUM(A1:A5)`), and Excel's rule is that references shift when rows move. With stable ids the stored formula has to point at ids, and get translated to A1 at the engine boundary: id text to A1 on the way in, A1 to id text on the way out. The engine's own formula walker (`functionStrChange`, the thing that shifts references on insert today) is the seed of that translator. Deleting a row that a formula points at still needs a rewrite of those formulas, but only those, done by the client that deletes. Inserts need no rewrites at all.

The engine itself stays positional. It keeps its dense matrix, calc chain and dependency index in row and column numbers. A translation table per sheet (`rowIds[]`, `colIds[]`, and the reverse maps) sits between the engine and Yjs. On a local patch at `['data', r, c]` the bridge writes `cells.set(rowIds[r] + ':' + colIds[c], cell)`. On a remote map event it looks the key up and produces the same immer patch the op log produces today. That bridge is `patchToOp` and `opToPatch` with a key translation in the middle. It is not a rewrite of the engine.

**Shape 3: keep the op log, and make it honest.** An ordered log with one agreed order is a legitimate model for a positional grid. It is how Google Sheets works too. Its defects in Eigen are that the order is not applied (each client applies its own batch first), that concurrent inserts are not transformed against each other, and that the snapshot depends on a browser tab. The first and third are cheap to fix in place. The second is not, and it is where a positional log costs the most. See § What to do first.

## What undo from Yjs would really give

This was the motivating question, so here is the honest comparison. Both stacks are in memory and per tab. Neither survives a reload. Both broadcast the undo to peers as an ordinary change. In both, a peer's edit is not undoable by you.

| | Engine stack today | `Y.UndoManager` over `"row_col"` keys | `Y.UndoManager` over stable ids |
|---|---|---|---|
| Undo your edit after a peer changed the same cell | Overwrites the peer's value | Leaves the peer's value (verified: default `ignoreRemoteMapChanges=false` never overwrites a remote change) | Same |
| Undo your edit after a peer inserted a row above it | Hits the wrong row (absolute paths) | Silently does nothing (every key became a remote change) | Correct cell |
| Undo a row insert | Works (marker op has an inverse) | Undoes a whole-sheet re-key, or is impossible if inserts are markers | One array delete |
| Grouping of quick edits into one step | One step per recipe | 500 ms capture window plus `stopCapturing()` | Same |
| Code | ~150 lines in the workbook component | Shared with the other editors | Shared |

So `Y.UndoManager` is only clearly better with stable ids. The two properties people would notice, "never clobber a peer" and "stay on the right cell after a peer's insert", can both be added to the engine stack: check that the cell still holds the value the entry expects before applying the inverse, and shift the entries' row and column numbers when a peer's insert or delete marker arrives, the way the stack is already shifted for sheet deletions. That is a day of work, not a rewrite.

## What it costs, measured

Bench on the installed Yjs (13.6.30), one `Y.Map` keyed `"row_col"`, small plain cell values, 130 columns. The stable-id shape has the same numbers; the key string is a little longer. Scripts are throwaway, the numbers are the point.

| Cells | Yjs state | Load into a fresh doc | RAM for the live doc | One cell edit |
|---|---|---|---|---|
| 30,000 | 1.9 MB | 65 ms | | 85 B |
| 130,000 | 8.5 MB | 245 ms | ~120 MB | 85 B |
| 340,000 | 22.5 MB | 666 ms | ~200 MB | 85 B |

For scale: the real 340k-cell workbook is a 12.6 MB v2 snapshot today, and was 56 MB as plain JSON before the style interning. The bench values carry no styles. A real Yjs layout would need the same interning, a `styles` map of distinct style objects that cells point into, or the numbers go back to the 56 MB class.

Things the bench settled:

- **Load time is fine.** Under a second for the biggest workbook we have. The editor's own grid setup is the slow part today and stays the same.
- **Per-edit traffic is fine.** 85 bytes per cell, independent of size. That is the same class as one op today.
- **Memory is the real cost.** About 0.6 to 0.9 KB per cell for the live document, and the API keeps every open document in memory. The big workbook is 200 MB on the server per open document, against roughly 13 MB for the string today.
- **Re-keying is out.** A naive row insert on the 130k map ships 8.2 MB and scales with the sheet. This is why Shape 1 is a trap and Shape 2 needs ids.
- **A map remembers every write.** Each set on a key leaves a permanent item skeleton of about 10 bytes, with the key string, once the key is written again. Writes to one key merge away to nothing; writes spread over many keys never merge. One million writes over 100 keys left 9.8 MB behind, and a reload does not reclaim it. Only a fresh document does (1.7 KB). Today's array items merge, so the op log does not pay this. It matters for formulas: a hub edit in the big workbook recomputes 8,700 dependents, so shipping computed values as map sets leaves about 90 KB per edit behind forever, until a squash. The alternative is to not store computed values and let every reader recalculate, which the preview and search readers deliberately do not do ([SHEETS.md § Server-side recalc](../SHEETS.md#server-side-recalc)).
- **Undo is cheap.** 0.4 ms for one cell, 97 ms to undo a 130k-key transaction.

## What we would gain

If Shape 2 is built, sheets gets everything the other editors have, by construction:

- Concurrent edits converge: same cell, same border, concurrent row inserts, rule order.
- No whole-workbook flush. Updates are the size of the edit. The `SNAPSHOT_BYTES` trigger in the collab store, which exists because of the sheets flush, becomes moot. No dependence on a browser tab writing a snapshot at the right moment, and no read-only-on-undecodable-snapshot path.
- One undo model, shared code, correct across peers.
- Version restore and the API readers read the same roots as the editor. The snapshot codec, the replay function and the flush code are deleted.
- Row and column moves stop touching cells: a delete and an insert of one id.

## What to do first

Each item is independent, and each one is a property the user notices. Three are small. The second has a small and a large version, and the large one is not worth building.

1. **Agreed order for conflicting keys** (S). Design A from [PROPOSAL_SHEETS_YJS_CONFIG.md](PROPOSAL_SHEETS_YJS_CONFIG.md): when a peer's batch lands earlier in the array than a local batch that wrote the same key, the local write wins everywhere. About a hundred lines and no format change.
2. **Concurrent inserts and deletes: rebase, do not transform** (M). Two peers inserting rows at the same time, or one editing a cell while the other inserts a row above it, diverge live today: each client applies its own batch first, and the other's batch arrives in coordinates that no longer hold. They reconverge on reload, because every joiner replays the array in order. The cheap fix makes live clients match that: when a peer batch lands in the array before local batches that are not yet flushed, undo the local batches with the inverse patches the engine's undo stack already holds, apply the peer batch, and reapply the local batches. It is Design A's principle applied to whole batches instead of one key. No format change, no new replayer; the undo stack entries need to be kept for unflushed batches even after a `noUndo` edit, which they are not today. The cost is that a concurrent insert can land one row off from what its author meant. It lands there on every client and on reload alike, which is what Google Sheets users already accept, and two people inserting rows in the same sheet in the same second is rare.

   The large version is operational transform, and it is not recommended. It preserves each author's intent, and three things make it an L rather than an M. A flat array cannot tell a concurrent batch from a later one, so every batch would have to carry the id of the last batch its author had applied, and `replaySheetsOps` would become a transforming replayer. Every positional op needs shifting, not only markers against markers: cell paths, the `"r_c"` keys in `borderInfo`, `merge` and `hyperlink`, row and column size keys, and the ranges in conditional formats, validation and filters. And a marker batch today ships the author's whole `config`, `hyperlink`, `dataVerification` and every other sheet field as authoritative replaces (`sheetMetadataOps`); those are a snapshot of the author's state, cannot be transformed, and a concurrent marker's replace clobbers the other's shift, so receivers would have to derive the config shift themselves. That is one to two weeks building a second sync model that Shape 2 would throw away, for intent preservation in a rare case. Intent-preserving convergence is a Shape 2 property, where it comes for free.

3. **Server-side compaction** (M). The API already has everything it needs: it holds the document, it can decode the snapshot, replay the ops and encode a new snapshot. Do that in a transform worker when the last subscriber leaves and when the array passes a threshold, and delete exactly the items that were replayed so concurrent pushes survive. The Y.Doc stays on the main thread: the worker takes the snapshot string plus the op batches and returns the new string, encoded with the `computed` flag the old snapshot carried, and the main thread swaps it in and deletes the replayed items in one transaction. Then the tab flush becomes a nicety, the log is bounded, and a killed tab loses nothing. Stop remounting the grid on a peer's snapshot while loaded; the client already holds snapshot-plus-ops.
4. **Two undo fixes** (S). Shift the stack's row and column numbers on incoming markers, and skip an inverse patch whose cell no longer holds the expected value.

Together the four are about one and a half weeks of agent time. After them, every client and every joiner agree on the workbook in every case a user can see, with the code we have. What the op log then still lacks against Shape 2 is intent preservation for concurrent inserts, and that is the whole gap.

## When to build the real thing

Build Shape 2 when one of these becomes true:

- The engine needs stable row and column ids for another reason. Row moves, tables with structured references, or a redesign of the calc chain would each make ids the natural next step, and the Yjs bridge then becomes the small part.
- The API can recalculate large workbooks fast enough that computed values need not be stored, which removes the dead-weight cost of shipping dependents.
- Uniformity is worth more than the memory. If every editor sharing one collab model becomes a product goal, the 200 MB per big workbook is a decision, not a blocker.

If it is built, the order is:

1. **Ids in the engine** (L). `rowIds` and `colIds` on the sheet, maintained through every insert, delete and move; formula translation between id text and A1 at the boundary, seeded from `functionStrChange`; tests over the fidelity workbooks.
2. **Yjs roots and the bridge** (M). Per sheet: `rows`, `cols`, `cells`, `config` maps, a `styles` map; `patchToOp` and `opToPatch` become key-translating transactions and event handlers; `useCollabDoc` gets the undo scope; the engine's stack goes.
3. **API readers, export and import** (M). The readers walk the maps into the dense shape; the import writes the maps; version restore needs nothing.
4. **One-off conversion and verification** (M). No backwards compatibility is required for sheets (Reinder, 2026-09-03), so existing documents are converted once on open by the first writer, from the old two roots into the new ones, and the old roots stay as dead roots. No stamp, no handshake, no sweep. Then the real-workbook verification program.

That is a cycle of its own, in the L to XL range. It is not the answer to "we want undo from Yjs", and it is not the answer to the convergence bugs. It is the answer to "we want one document model for every editor", and it should be started for that reason or not at all.

## Rulings

- **No backwards compatibility for sheets.** Reinder, 2026-09-03, confirming the 2026-08-28 and 2026-08-30 rulings. Stored shape, wire shape and roots are free to change; existing documents may be converted in place by the app or dropped.
- **Operational transform over the op log is not to be built.** Rebase to array order instead (step 2 above). Intent preservation for concurrent inserts is what Shape 2 is for.
- **Shape 1 is not to be built.** A `"row_col"` map without stable ids reintroduces the op log through the back door and adds the corruption risk of concurrent re-keys.

## Evidence

- Sheets sync and undo today: `apps/sheets/src/components/sheets/hooks/use-sheet.ts` (`handleOp`, `handleOps`, `flushSnapshot`, the `wsconnected` gate), `packages/sheet/src/components/Workbook/index.tsx` (`setContextWithProduce`, `handleUndo`, `handleRedo`, `reduceUndoList`), `packages/sheet/src/state/utils/patch.ts` (`patchToOp`, `opToPatch`, `sheetMetadataOps`), `packages/sheet/src/components/Workbook/api.ts` (`applyOp`, the receive path: engine re-derives the shift, then the authoritative metadata replaces apply), `packages/sheet/src/engine/replay-ops.ts` (`replaySheetsOps`), `packages/sheet/src/engine/rowcol.ts` (`shiftCellKeyedForInsert`, `shiftFormulasAcrossSheets`), `packages/sheet/src/engine/formula-shift.ts` (`functionStrChange`), `apps/api/src/lib/document/sheets.ts` (`readSheetsFromDoc`, `writeSheetsSnapshotToYjs`).
- The Yjs way: `packages/lib/src/core/collab/hooks/use-collab-doc.ts`, `packages/lib/src/core/collab/hooks/use-yjs-undo-hotkeys.ts`, `packages/lib/src/core/collab/yjs-utils.ts`, `packages/ui/src/components/vector/hooks/use-vector-doc.ts`, `apps/slides/src/components/slides/hooks/use-deck.ts`, `apps/stickies/src/components/stickies/hooks/use-board.ts`, `apps/api/src/lib/collab/collabDocument.ts` (`SNAPSHOT_INTERVAL`, `SNAPSHOT_BYTES`).
- Undo semantics: Yjs 13.6.30 `src/utils/UndoManager.js` (tracked origins, capture timeout, undo runs as one transaction with the manager as origin) and `src/structs/Item.js` `redoItem` (the "never overwrite a remote map change" guard). Confirmed with two docs exchanging updates.
- Scale: bench over one `Y.Map` at 30k, 130k and 340k keys, 2026-09-03; the dead-weight figure reproduced with a second script (writes over 100 keys keep ~10 B each, writes to one key merge to 46 B total, a fresh document squashes to 1.7 KB).
