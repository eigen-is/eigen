# Proposal: sheets as a real Yjs document

This is a research answer more than a build plan. It asks whether sheets can keep its workbook in Yjs structures, the shared data types every other Eigen editor stores its document in. How sheets works today is in [SHEETS.md](../SHEETS.md).

**Status:** two things are open: compacting while editors are connected ([§ Later, on a trigger](#later-on-a-trigger-compact-while-editors-are-connected), a row in [SHEETS-TODO.md](../SHEETS-TODO.md#sync-and-undo)), and Shape 2, the Yjs workbook with stable row and column ids, which waits in [ROADMAP-POST-1.md](../ROADMAP-POST-1.md). The in-place fixes this proposal recommended first are described in [SHEETS.md](../SHEETS.md).

> **TLDR**: Sheets is the one Eigen editor whose document does not live in Yjs. It stores one JSON string plus a log of operations, and it has its own undo stack. Reinder asked whether sheets could work the way docs, slides, stickies and vector do, with Yjs structures as the truth and undo from `Y.UndoManager`. The answer is **yes, it is possible, but not with cells keyed by row and column**. A spreadsheet cell has no identity of its own. It is "the cell at row 5, column 2", and inserting a row renames every cell below it. Yjs is built for things with a stable identity. So the real Yjs version of sheets needs stable row and column ids, cells keyed by those ids, and formulas stored against ids. That is an engine-level change. Undo alone is not a reason to do it: `Y.UndoManager` and the engine's own stack are both in-memory per-tab stacks, and the two things Yjs undo does better are built into the current stack. Yjs structures for `config` alone are not worth building. Keep the stable-id Yjs design as the direction for when the engine gets id-based addressing. **No backwards compatibility is required for sheets** (Reinder, 2026-09-03), so whichever route is taken needs no migration machinery.

## The question

Sheets stores its state as one serialized JSON snapshot in a `Y.Map` and a list of ops in a `Y.Array`. Every other editor keeps the document itself in Yjs and gets undo from `Y.UndoManager`. Is it possible to bring sheets in line, and would we get undo and redo from Yjs for free?

## Why not Yjs structures for `config` alone

If `merge`, `rowlen`, `borderInfo` and the other collections were `Y.Map`s, Yjs would pick one winner per key, but only for config. Cell values would stay on the op log. The workbook would be split across two sync models: half in Yjs with Yjs undo semantics, half in the op log with the engine's stack. Every writer that touches a cell and its config in one recipe (merge, paste, row insert) would commit to two systems that cannot share a transaction. And the op log, applied in one agreed order, already settles a same-key race for cells and config alike.

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

**Shape 1: a `Y.Map` keyed `"row_col"`.** It is the obvious first sketch. Concurrent edits to the same cell converge (Yjs picks a winner), a cell edit is a tiny update, and `Y.UndoManager` works for cell edits. But a row insert renames every cell below it. Done honestly, that is a delete and a set for every key, and the update is the size of the whole sheet (measured below). Done cheaply, the insert is shipped as a marker and every client re-keys its own copy, and then the map is no longer the truth: the truth is "map plus the markers replayed in order", which is the op log again with Yjs bolted on. Two peers inserting rows at the same time re-key the same map twice and corrupt it. And undo after a peer's insert silently does nothing, because the peer's re-key counts as a remote change to every key. **This shape is a trap.** It looks like the small step and it is not.

**Shape 2: stable ids.** Each sheet gets `rows` and `cols` as `Y.Array`s of ids, and `cells` as a `Y.Map` keyed `"rowId:colId"`. Row heights, hidden flags, merges, validation and hyperlinks are keyed by id too. A row insert is one array insert and touches no cell. A row move is a delete plus an insert of the id, because Yjs 13 has no move primitive; two peers moving the same row at once can leave its id twice or nowhere, so the reader dedupes the array and appends any id it holds cells for but does not list. A row delete leaves its cells in the map until a sweep removes them, and a concurrent edit to a cell in a row being deleted lands in an orphan; both are read-time filters, not conflicts. Two peers inserting rows converge because Yjs orders the array. Undo of a cell edit stays attached to the right cell forever. This is the identity model the other editors use, applied to a grid: things with ids, ordered by an array.

The price is formulas. A formula is A1 text (`=SUM(A1:A5)`), and Excel's rule is that references shift when rows move. With stable ids the stored formula has to point at ids, and get translated to A1 at the engine boundary: id text to A1 on the way in, A1 to id text on the way out. The engine's own formula walker (`functionStrChange`, the thing that shifts references on insert today) is the seed of that translator. Deleting a row that a formula points at still needs a rewrite of those formulas, but only those, done by the client that deletes. Inserts need no rewrites at all.

The engine itself stays positional. It keeps its dense matrix, calc chain and dependency index in row and column numbers. A translation table per sheet (`rowIds[]`, `colIds[]`, and the reverse maps) sits between the engine and Yjs. On a local patch at `['data', r, c]` the bridge writes `cells.set(rowIds[r] + ':' + colIds[c], cell)`. On a remote map event it looks the key up and produces the same immer patch the op log produces today. That bridge is `patchToOp` and `opToPatch` with a key translation in the middle. It is not a rewrite of the engine.

**Shape 3: keep the op log, and make it honest.** An ordered log with one agreed order is a legitimate model for a positional grid. It is how Google Sheets works too, and it is what sheets runs: every tab applies the log's order and the server writes the snapshot ([SHEETS.md](../SHEETS.md#every-tab-applies-the-batches-in-the-logs-order)). What it lacks is transforming concurrent inserts against each other, so a batch recorded before a peer's row insert that lands after it writes at the rows it recorded. That is not worth building on a positional log ([§ Rulings](#rulings)).

## What undo from Yjs would really give

This was the motivating question, so here is the honest comparison. Both stacks are in memory and per tab. Neither survives a reload. Both broadcast the undo to peers as an ordinary change. In both, a peer's edit is not undoable by you.

| | Engine stack today | `Y.UndoManager` over `"row_col"` keys | `Y.UndoManager` over stable ids |
|---|---|---|---|
| Undo your edit after a peer changed the same cell | Skips the cell (a value check) | Leaves the peer's value (verified: default `ignoreRemoteMapChanges=false` never overwrites a remote change) | Same |
| Undo your edit after a peer inserted a row above it | Correct cell (the stacks shift on a peer's row op) | Silently does nothing (every key became a remote change) | Correct cell |
| Undo a row insert | Applies the ops it sends, keeping a peer's edits since | Undoes a whole-sheet re-key, or is impossible if inserts are markers | One array delete |
| Grouping of quick edits into one step | One step per recipe | 500 ms capture window plus `stopCapturing()` | Same |
| Code | The engine's own, in the workbook component and `state/modules/history*.ts` | Shared with the other editors | Shared |

So `Y.UndoManager` is only clearly better with stable ids. The two properties people notice, "never clobber a peer" and "stay on the right cell after a peer's insert", are built into the engine stack ([SHEETS.md](../SHEETS.md#undo-skips-a-cell-a-peer-changed-since)).

## What it costs, measured

Bench on Yjs 13.6.30, one `Y.Map` keyed `"row_col"`, small plain cell values, 130 columns. The stable-id shape has the same numbers; the key string is a little longer. Scripts are throwaway, the numbers are the point.

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
- **A map remembers every write.** Each set on a key leaves a permanent item skeleton of about 10 bytes, with the key string, once the key is written again. Writes to one key merge away to nothing; writes spread over many keys never merge. One million writes over 100 keys left 9.8 MB behind, and a reload does not reclaim it. Only a fresh document does (1.7 KB). Today's array items merge, so the op log does not pay this. It matters for formulas: a hub edit in the big workbook recomputes 8,700 dependents, so shipping computed values as map sets leaves about 90 KB per edit behind forever, until a squash. The alternative is to not store computed values and let every reader recalculate, which the preview and search readers deliberately do not do ([SHEETS.md](../SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)).
- **Undo is cheap.** 0.4 ms for one cell, 97 ms to undo a 130k-key transaction.

## What we would gain

If Shape 2 is built, sheets gets everything the other editors have, by construction:

- Concurrent edits converge by construction, and concurrent row inserts keep what each author meant, where the op log writes a late batch at the rows it recorded.
- No whole-workbook snapshot writes. Updates are the size of the edit. The `SNAPSHOT_BYTES` trigger in the collab store, which exists for the one fat update a sheets snapshot write makes, becomes moot. No snapshot writer to keep correct, no compaction broadcast, and no read-only-on-undecodable-snapshot path.
- One undo model, shared code, correct across peers.
- Version restore and the API readers read the same roots as the editor. The snapshot codec, the replay function and the compaction are deleted.
- Row and column moves stop touching cells: a delete and an insert of one id.

## Later, on a trigger: compact while editors are connected

The server compacts a workbook's log only when the workbook closes, so a sheet some tab always has open grows its log, and every joiner and every server reader replays all of it. Build this when joiners of a long-open sheet load measurably slower; measure at 100, 1,000 and 5,000 batches on the reference workbook. The server then also compacts past a threshold while tabs are connected, and those tabs keep their view.

A tab already keeps its grid through a compaction of the base it holds, through the base chain `state.base = { id, compactedFrom }` ([SHEETS.md](../SHEETS.md#a-tab-keeps-its-grid-through-a-compaction-of-the-base-it-holds)), and the swap already drops a result that anything changed under. What is left:

- **A trigger while sockets are connected.** `CollabDocument` compacts only at the end of its linger (`closeAfterLinger` in `apps/api/src/lib/collab/collab-document.ts`). A threshold run needs its own trigger, and its swap must not drop on every keystroke a connected tab sends meanwhile.
- **Threshold compaction costs a broadcast.** The swap sets the whole snapshot string, and every live client receives it: 12.6 MB for the big workbook each time the array crosses the threshold, where a close sends it to nobody. Accepted at a threshold of a few hundred batches; if it bites, the threshold counts bytes instead, and a large sheet on a slow link needs the ROADMAP row "Collab: large documents on slow connections".

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
- **Operational transform over the op log is not to be built.** Every tab applies batches in the log's order instead, which is built. Intent preservation for concurrent inserts is what Shape 2 is for.
- **Shape 1 is not to be built.** A `"row_col"` map without stable ids reintroduces the op log through the back door and adds the corruption risk of concurrent re-keys.
- **Yjs structures for `config` alone are not to be built.** They leave cell values on the op log, split the workbook across two sync models that cannot share a transaction, and close nothing the log's order does not.

## Evidence

- Sheets sync and undo today: [SHEETS.md](../SHEETS.md), `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, `packages/sheet/src/components/Workbook/api.ts` (`applyOp`, `replayOps`), `packages/sheet/src/state/utils/patch.ts` (`patchToOp`, `opToPatch`), `packages/sheet/src/engine/replay-ops.ts` (`replaySheetsOps`), `packages/sheet/src/engine/formula-shift.ts` (`functionStrChange`).
- The Yjs way: `packages/lib/src/core/collab/hooks/use-collab-doc.ts`, `packages/lib/src/core/collab/hooks/use-yjs-undo-hotkeys.ts`, `packages/lib/src/core/collab/yjs-utils.ts`, `packages/ui/src/components/vector/hooks/use-canvas-doc.ts`, `apps/stickies/src/components/stickies/hooks/use-board.ts`, `apps/api/src/lib/collab/db-provider.ts` (`SNAPSHOT_INTERVAL`, `SNAPSHOT_BYTES`).
- Undo semantics: Yjs 13.6.30 `src/utils/UndoManager.js` (tracked origins, capture timeout, undo runs as one transaction with the manager as origin) and `src/structs/Item.js` `redoItem` (the "never overwrite a remote map change" guard). Confirmed with two docs exchanging updates.
- Scale: bench over one `Y.Map` at 30k, 130k and 340k keys, 2026-09-03; the dead-weight figure reproduced with a second script (writes over 100 keys keep ~10 B each, writes to one key merge to 46 B total, a fresh document squashes to 1.7 KB).
