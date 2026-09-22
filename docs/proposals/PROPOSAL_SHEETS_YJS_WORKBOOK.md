# Proposal: sheets as a real Yjs document

> **TLDR**: Sheets is the one Eigen editor whose document does not live in Yjs. It stores one JSON string plus a log of operations, and it has its own undo stack. Reinder asked whether sheets could work the way docs, slides, stickies and vector do, with Yjs structures as the truth and undo from `Y.UndoManager`. The answer is **yes, it is possible, but not with cells keyed by row and column**. A spreadsheet cell has no identity of its own. It is "the cell at row 5, column 2", and inserting a row renames every cell below it. Yjs is built for things with a stable identity. So the real Yjs version of sheets needs stable row and column ids, cells keyed by those ids, and formulas stored against ids. That is an engine-level change. Undo alone is not a reason to do it: `Y.UndoManager` and the engine's own stack are both in-memory per-tab stacks, and the two things Yjs undo does better can be added to the current stack for a fraction of the cost. **Recommendation: fix the operation log in place first**: live clients apply batches in the array's agreed order, rolling back and reapplying when a batch lands earlier than batches they already applied (this closes same-cell divergence and makes concurrent row inserts match what a joiner sees, without operational transform); a batch applies whole or not at all, on live clients as in the replay; the server compacts the log and becomes the only snapshot writer besides import and restore, so the tab flush goes; and the undo stack gets a value check, a shift on a peer's markers and a structural undo that applies its own ops. About three weeks of agent time. Yjs structures for `config` alone are not worth building. Keep the stable-id Yjs design as the direction for when the engine gets id-based addressing. **No backwards compatibility is required for sheets** (Reinder, 2026-09-03), so whichever route is taken needs no migration machinery.

## The question

Sheets stores its state as one serialized JSON snapshot in a `Y.Map` and a list of ops in a `Y.Array`. Every other editor keeps the document itself in Yjs and gets undo from `Y.UndoManager`. Is it possible to bring sheets in line, and would we get undo and redo from Yjs for free?

## How sheets works today

The full description is in [SHEETS.md § Yjs Sync](../SHEETS.md#yjs-sync). The short version:

- A local edit runs inside an immer recipe. The patches immer produces become ops. One recipe is one batch, and one batch is pushed as one element on the `ops` array. Row and column inserts are not shipped as cell patches but as one small marker op plus the sheet's metadata; every client re-derives the cell shift itself.
- A peer's batch is applied as patches. Peers never recalculate formulas. The client that made the edit recomputes the dependents and ships their new values in the same batch.
- Each client applies its own batch straight away and skips it when it comes back from the array. A peer's batch is applied when it arrives. Yjs guarantees that every client ends up with the same array. It does not rebuild any client's workbook from that array, so the workbook itself is not guaranteed to converge.
- On `beforeunload` (only while the socket is connected) and on unmount, the client encodes the whole workbook into `state.snapshot` and clears the array. A joiner decodes the snapshot and replays what is left in the array. The API reads the document the same way.
- Undo is the engine's own stack of inverse immer patches, per tab, no depth limit. An undo is broadcast to peers as an ordinary batch. A peer's batch is not undoable. The paths in the stack are absolute row and column numbers.

Four things found while grounding this proposal, all recorded in [SHEETS.md § Yjs Sync](../SHEETS.md#yjs-sync) and [SHEETS-TODO.md](../SHEETS-TODO.md):

1. **Undo after a peer inserts a row hits the wrong cell.** The stack is never corrected for a peer's changes: not for row or column shifts, and not for sheet deletions either, because `reduceUndoList`, written for the latter, never runs. So after a peer inserts a row above your edit, your undo lands one row off.
2. **Undoing your own row insert diverges from peers.** The undo applies the whole-sheet inverse locally, which wipes every peer edit on that sheet since the insert, but ships a delete marker, so the peers keep those edits.
3. **A remote batch can apply halfway.** `applyOp` keeps what it applied before a patch failed; the replay skips the whole batch. The live client and a joiner then disagree until the next reload.
4. **The unload flush is skipped while offline**, so a tab that closes during a blip writes no snapshot. The op log then grows until some connected tab flushes. Nothing guarantees that a snapshot is ever written.

## What diverges today

Every client holds its own edits in local order, with peer edits spliced in at arrival time. No client rebuilds its workbook from the converged array; only a joiner does.

Two clients editing **different** keys converge. `config` has no whole-object mirror, every config collection is materialized so first writes are granular, and `borderInfo` is keyed by cell. That is pinned by `packages/sheet/src/test/state/events/concurrent-config.test.ts` and `packages/sheet/src/test/state/modules/border-convergence.test.ts`.

Two clients editing the **same** key do not. Probed with `borderInfo` already a map:

```
base:     A1 has no border
client A: border A1 blue      → op  add ['config','borderInfo','0_0'] {…blue}
client B: border A1 red       → op  add ['config','borderInfo','0_0'] {…red}
A applies own (blue), receives B's → A ends red
B applies own (red),  receives A's → B ends blue
```

Say the array holds `[A-batch, B-batch]` on both clients. A joiner replays it and ends red. Client A also shows red. Client B shows blue until someone edits the cell again. Cell values behave the same way: A types `1` and B types `2` in the same cell at the same moment, and each client shows the other's number. That case is far more common than a border, because one person's stale tab and fresh tab is enough.

A smaller member of the same family: `conditionalFormatRules` and `alternateFormatRules` are arrays whose order is the rule priority. Two clients appending a rule at the same moment each insert the peer's rule before their own, so they disagree about priority order. It is visible only where rules overlap. Reshaping these arrays would be wrong, because order is the data; the key is the array itself.

This is not a `config` problem. It is the ordinary "last write wins, and everyone agrees who was last" property, and the op log lacks it for every key.

**Why not Yjs structures for `config` alone.** If `merge`, `rowlen`, `borderInfo` and the other collections were `Y.Map`s, Yjs would pick one winner per key, but only for config. Cell values would keep the same defect on the op log. The workbook would be split across two sync models: half in Yjs with Yjs undo semantics, half in the op log with the engine's stack. Every writer that touches a cell and its config in one recipe (merge, paste, row insert) would commit to two systems that cannot share a transaction. That is worse than today, and step 1 below closes the same-key case for cells and config alike.

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

**Shape 3: keep the op log, and make it honest.** An ordered log with one agreed order is a legitimate model for a positional grid. It is how Google Sheets works too. Its defects in Eigen are that the order is not applied (each client applies its own batch first), that concurrent inserts are not transformed against each other, and that the snapshot depends on a browser tab. The first and third can be fixed in place. The second is not worth it, and it is where a positional log costs the most. See § What to do first.

## What undo from Yjs would really give

This was the motivating question, so here is the honest comparison. Both stacks are in memory and per tab. Neither survives a reload. Both broadcast the undo to peers as an ordinary change. In both, a peer's edit is not undoable by you.

| | Engine stack today | `Y.UndoManager` over `"row_col"` keys | `Y.UndoManager` over stable ids |
|---|---|---|---|
| Undo your edit after a peer changed the same cell | Overwrites the peer's value | Leaves the peer's value (verified: default `ignoreRemoteMapChanges=false` never overwrites a remote change) | Same |
| Undo your edit after a peer inserted a row above it | Hits the wrong row (absolute paths) | Silently does nothing (every key became a remote change) | Correct cell |
| Undo a row insert | Works alone; after a peer's edit on the sheet, wipes it locally only (diverges) | Undoes a whole-sheet re-key, or is impossible if inserts are markers | One array delete |
| Grouping of quick edits into one step | One step per recipe | 500 ms capture window plus `stopCapturing()` | Same |
| Code | ~150 lines in the workbook component | Shared with the other editors | Shared |

So `Y.UndoManager` is only clearly better with stable ids. The two properties people would notice, "never clobber a peer" and "stay on the right cell after a peer's insert", can both be added to the engine stack: check that the cell still holds the value the entry expects before applying an undo or a redo, and shift the entries' positions when a peer's insert, delete or sheet-deletion marker arrives. Positions sit in paths, keys and values, so that is an M (step 3 below), not a rewrite.

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
- **A map remembers every write.** Each set on a key leaves a permanent item skeleton of about 10 bytes, with the key string, once the key is written again. Writes to one key merge away to nothing; writes spread over many keys never merge. One million writes over 100 keys left 9.8 MB behind, and a reload does not reclaim it. Only a fresh document does (1.7 KB). Today's array items merge, so the op log does not pay this. It matters for formulas: a hub edit in the big workbook recomputes 8,700 dependents, so shipping computed values as map sets leaves about 90 KB per edit behind forever, until a squash. The alternative is to not store computed values and let every reader recalculate, which the preview and search readers deliberately do not do ([SHEETS.md § Server-side recalc](../SHEETS.md#server-side-recalc)).
- **Undo is cheap.** 0.4 ms for one cell, 97 ms to undo a 130k-key transaction.

## What we would gain

If Shape 2 is built, sheets gets everything the other editors have, by construction:

- Concurrent edits converge: same cell, same border, concurrent row inserts, rule order.
- No whole-workbook snapshot writes. Updates are the size of the edit. The `SNAPSHOT_BYTES` trigger in the collab store, which exists for the one fat update a sheets snapshot write makes, becomes moot. No snapshot writer to keep correct, no compaction broadcast, and no read-only-on-undecodable-snapshot path.
- One undo model, shared code, correct across peers.
- Version restore and the API readers read the same roots as the editor. The snapshot codec, the replay function and the compaction are deleted.
- Row and column moves stop touching cells: a delete and an insert of one id.

## What to do first

Three steps, in this order. Step 2 bakes the array into the snapshot, so step 1's rule that a batch applies whole or not at all has to hold first. Step 3's stack shift runs inside step 1's integration, because only there is it known which undo entries a peer's marker precedes.

1. **Live clients apply batches in array order** (L). The workbook is the snapshot plus the batches in array order. A joiner already gets exactly that. A live client does not, because it applies batches in arrival order: its own at once, a peer's when it arrives. Arrival order and array order differ in two ways. A peer batch can land before a local batch that is not yet flushed. And a late peer batch, from an offline peer reconnecting say, can land before peer batches that were already applied. With array order R1 < L < R2, where R2 arrived first and R1 arrives last, applying R1 on arrival overwrites R2's value for any key both wrote, and this client now disagrees with a joiner. So every batch the client has applied and the array still holds, local or remote, goes on a pending list beside the undo stack:
   - **Its position is its index in the array.** `Y.Array` stores pushed values as `ContentAny`, which keeps the pushed JavaScript values by reference, also when items split or merge (`splice` slices the element array, `mergeWith` concatenates it). So `toArray()` returns the very `Op[]` a client pushed, and one stable object per remote batch, for the life of the doc. A batch's position is the index of that reference in `toArray()`, read fresh each time; an index recorded at push time would go stale when remote items land earlier, and no Yjs item or observer delta is needed. New batches are references not yet on the list; committed batches are references no longer in the array. Compaction (step 2) keeps the array short, so a linear scan per transaction is fine.
   - **Its exact inverse.** The undo stack is not that inverse. A `noUndo` edit pushes no entry. An undo and a redo are batches of their own whose inverse is not the top entry, and `handleUndo`/`handleRedo` apply with plain `applyPatches`, so they produce no inverse at all today. A `deleteSheet` entry holds a synthetic inverse (`add ['sheets', 0]` plus order fixups built at undo time), not the inverse of what the recipe did. So every emit site records the filtered inverse of what it applied (`handleUndo`/`handleRedo` move to `produceWithPatches`), the peer path records the same, and the undo stack stays as it is.
   - **Batches replayed at load have no inverse.** `loadSnapshot` replays the array before the Workbook mounts, so those batches go on the list without one, and a rollback that reaches one falls back to a reload: decode, replay and remount, the path a peer's snapshot takes today. Only a late batch older than the tab's load triggers it. The list is seeded once per mount, not on every sync: `onSync` runs `loadSnapshot` on every reconnect (`apps/sheets/src/components/sheets/hooks/use-sheet.ts:146-150`), and reseeding there would turn the next late batch after any reconnect into a reload that drops the undo stack. The mount also integrates the array once, because batches that arrive before the workbook ref is set are dropped today (`use-sheet.ts:101-102`).

   When a batch lands before applied batches on the list, roll those back newest-first with their inverses, then apply the new batch and the rolled-back ones in array order. The reapply goes through each batch's ops, the path peers and joiners take, not through the recipe that first produced it, so the author ends in the same state as everyone else; a reapplied local batch gets a fresh inverse and forward patch on its undo entry. The rollback and reapply write no undo entry and push nothing to the array. Same-key conflicts, concurrent row inserts and rule priority order then all resolve the way a joiner resolves them.

   A batch applies whole or not at all. `replaySheetsOps` already works that way: a batch that throws is rolled back and skipped. `applyOp` does not: it catches a failing `applyPatches` and keeps the partial draft, plus any row, column or sheet op it already ran (`packages/sheet/src/components/Workbook/api.ts:44-99`). Today that is a live client disagreeing with a joiner until the next reload. Once step 2 compacts the array into the snapshot it is permanent, so the live path takes the replay's rule.

   Two consequences are accepted. Peers never recalculate, and a batch carries the dependents its author computed without the late batch, so after a reorder a dependent can be stale against its formula until the next edit touches it. Every client and every joiner hold the same stale value, which is what a joiner gets today; recomputing on reapply would diverge from joiners unless it shipped a new batch. And a row or column batch's inverse is a whole-sheet replace (`insertRowCol` writes every sheet back, `packages/sheet/src/state/modules/rowcol.ts:458-464`), so rolling one back also reverts a local write that never ships and came after it, such as the mount's config seeding. Seeding runs on sheets without data, so this is pinned by a test, not designed around.

   A per-key table is an optional fast path. An op's key is its `sheetId` plus the first path segments: `data/r/c`, `config/borderInfo/r_c`, `config/rowlen/7`, `config` for a whole-config replace; two keys conflict when one is a prefix of the other. `patchToOp` already normalizes paths, so the key is a pure function of an `Op`. If the late batch's keys conflict with no key of a later-applied batch, and neither it nor any later-applied batch holds an insert or delete marker, apply it directly without a rollback. A rollback is usually one or two unacknowledged local batches with structurally shared inverses, so the fast path is built only if a rollback over a row insert, or over a 130k-cell paste, on the 340k-cell workbook costs more than a frame.

   The cost is that a concurrent insert can land one row off from what its author meant. It lands there on every client and on reload alike, which is what Google Sheets users already accept, and two people inserting rows in the same sheet in the same second is rare. No new replayer: `replaySheetsOps` is already order-correct and the API reader is unchanged.

   Tests pin it before it is built, over real `Y.Doc`s with update delivery under test control: a same-key case in `concurrent-config.test.ts` (same cell value) and in `border-convergence.test.ts` (same cell border), a late-arrival case with three clients, two appended conditional-format rules, a row insert against a concurrent cell edit, and a batch that fails halfway, each written as `test.failing` first. After exchange every client holds the value of whichever batch is later in the array, and a joiner replaying the array agrees.

   The large version is operational transform, and it is not recommended. It preserves each author's intent, and it comes on top of this step, not instead of it. A flat array cannot tell a concurrent batch from a later one, so every batch would have to carry the id of the last batch its author had applied, and `replaySheetsOps` would become a transforming replayer. Every positional op needs shifting, not only markers against markers: cell paths, the `"r_c"` keys in `borderInfo`, `merge` and `hyperlink`, row and column size keys, and the ranges in conditional formats, validation and filters. And a marker batch today ships the author's whole `config`, `hyperlink`, `dataVerification` and every other sheet field as authoritative replaces (`sheetMetadataOps`); those are a snapshot of the author's state, cannot be transformed, and a concurrent marker's replace clobbers the other's shift, so receivers would have to derive the config shift themselves. That is one to two more weeks building a second sync model that Shape 2 would throw away, for intent preservation in a rare case. Intent-preserving convergence is a Shape 2 property, where it comes for free.

2. **Server-side compaction, and no tab flush** (L). The API already has everything it needs: it holds the document, and it can decode the snapshot, replay the ops and encode a new snapshot. It does that in a transform worker when the last subscriber leaves and when the array passes a threshold, one run in flight per document. The Y.Doc stays on the main thread. The worker takes the snapshot string plus the op batches and returns the new string, encoded with the `computed` flag the old snapshot carried (`decodeSheetsSnapshot` returns only `Sheet[]` today, so the codec exposes the flag; a document without a snapshot counts as computed, because its ops come from the editor, which ships computed values). The main thread swaps it in and deletes the replayed batches in one transaction. What makes that swap safe:
   - **It aborts when the replayed span changed.** Deleting "exactly the replayed items" is not enough: an offline peer's batch can integrate between two replayed items while the worker runs, and deleting only the replayed ones would move it after all of them in the new snapshot, where every live client applied it before some. So at swap time the captured references must still be the first n elements of the array and the snapshot string must be unchanged (a restore or an import in the meantime changes it); otherwise the result is dropped and the next trigger retries. With n = 0 there is nothing to swap and nothing is written. A batch that integrates after the swap, next to the deleted run, lands before every survivor, which is the same place for live clients and joiners.
   - **It is not an edit.** The collab `'update'` handler touches the file's `updatedAt` on every update (`apps/api/src/lib/collab/collabDocument.ts:246`), which would churn previews and search reindexing. The swap runs under its own origin and skips the touch.
   - **Close cancels it.** `destruct` (`collabDocument.ts:287`) is reached from trash, version restore and shutdown, and none of them should wait out a worker deadline, so close cancels an in-flight compaction instead of awaiting it. The 60 s linger after the last unsubscribe is extended while a compaction runs, so a slow one at last-leave still lands.
   - **Clients tell a compaction from a restore or an import.** A client that sees the snapshot change has to decide whether its view still holds, and it does not always: a client that reconnects, gets the provider's 5 s resync, or hears a sibling tab over BroadcastChannel can receive batches that were inserted and compacted in one update, so it never saw them as array inserts. A restore and an import also change the snapshot and delete batches, and are not compactions. So the snapshot carries a base-id chain, `state.base = { id, compactedFrom }`, which is a stored-format change. A compaction writes a fresh id and the id it compacted from; import writes a fresh id with no `compactedFrom`; a restore brings back an old base, and restoring an open document stamps a fresh one as well. A client keeps its view, and advances its base id, only when the transaction is a compaction of its own base and introduced no structs from any client but the writer. Anything else is a reload. Conservative, and public Yjs API only.
   - **Threshold compaction costs a broadcast.** The swap sets the whole snapshot string, and every live client receives it: 12.6 MB for the big workbook each time the array crosses the threshold, where today that happens once, on unload. Accepted at a threshold of a few hundred batches; if it bites, the threshold counts bytes instead.

   The tab flush then goes, `beforeunload` listener and unmount flush alike. A tab flush encodes the tab's in-memory state, which equals the array replay only if everything in step 1 is perfect, so it would bake any divergence into the truth; it uploads megabytes on unload, and it races the server's compaction. The server becomes the only snapshot writer besides import and restore, the log is bounded, a tab killed or closed offline loses nothing, and the grid stops remounting on a peer's snapshot.

3. **Undo fixes** (M). Three changes to the engine stack:
   - **A value check on undo and on redo.** A patch is skipped when its target no longer holds the value the entry expects, so an undo never overwrites a peer's later write; redo reapplies forward patches and needs the same check. It applies to leaf patches only, deeper than `['sheets', i]`, and entries carrying a row or column operation are exempt: their inverse is a whole-sheet replace, which after any peer edit on that sheet never matches, so the check would skip every structural undo and compare every cell of the sheet to find out.
   - **The stacks shift on a peer's markers.** An entry holds absolute positions in its paths (`data/r/c`, the `"r_c"` keys of `merge`, `borderInfo`, `hyperlink` and `dataVerification`, the numeric keys of `rowlen`, `columnlen`, `rowhidden`, `colhidden`, `customHeight` and `customWidth`) and in its values (`mc`, merge entries, formula text, conditional-format, validation and filter ranges, whole-config and whole-sheet replaces). On a peer's `insertRowCol` or `deleteRowCol` the undo and redo stacks shift paths, `mc` and merge values and same-sheet formula text (`functionStrChange`), and drop any entry on that sheet that holds a range-valued or whole-object patch or a patch inside deleted rows or columns. Formula text on other sheets inside an entry's values may drift; that is accepted. Only peer markers shift the stack, because the client's own markers are consistent with its own last-in-first-out stack, and only entries whose batch precedes the marker in array order. A peer marker that step 1 rolls back unshifts what it shifted. A peer's `deleteSheet` shifts `['sheets', i]` the same way and drops the deleted sheet's entries. Nothing does that today: `reduceUndoList` is written for it but only runs when a recipe produced no patches, which a sheet deletion never does (`packages/sheet/src/components/Workbook/index.tsx:284-288`).
   - **Structural undo applies its own ops.** Undoing a local row insert applies the whole-sheet inverse locally but ships a `deleteRowCol` marker plus the sheet's metadata (`inverseRowColOptions`, `sheetMetadataOps`). Locally that wipes every peer cell edit on the sheet made since the insert, and the peers keep theirs, so the clients diverge, and step 1 does not close it. The fix derives the local state by applying the emitted ops through the op path; the whole-sheet inverse only supplies the metadata. What remains is that the metadata is the sheet as it was before the insert, shipped as authoritative replaces (`packages/sheet/src/state/utils/patch.ts:163-174`), so a peer's `config`, `hyperlink` or validation edit on that sheet since the insert is undone too, on every client alike. Convergent but lossy, and accepted: every row or column marker ships the same kind of replace today.

Together the three are about three weeks of agent time. After them, every client and every joiner agree on the workbook in every case a user can see, with the code we have. What the op log then still lacks against Shape 2 is intent preservation for concurrent inserts and the whole-metadata replace of a row or column operation, and that is the whole gap.

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
- **Operational transform over the op log is not to be built.** Apply batches in array order instead (step 1 above). Intent preservation for concurrent inserts is what Shape 2 is for.
- **Shape 1 is not to be built.** A `"row_col"` map without stable ids reintroduces the op log through the back door and adds the corruption risk of concurrent re-keys.
- **Yjs structures for `config` alone are not to be built.** They leave cell values on the op log, split the workbook across two sync models that cannot share a transaction, and close nothing step 1 does not.

## Evidence

- Sheets sync and undo today: `apps/sheets/src/components/sheets/hooks/use-sheet.ts` (`handleOp`, `handleOps`, `flushSnapshot`, the `wsconnected` gate), `packages/sheet/src/components/Workbook/index.tsx` (`setContextWithProduce`, `handleUndo`, `handleRedo`, and `reduceUndoList`, which runs only for a recipe with no patches), `packages/sheet/src/state/modules/rowcol.ts` (`insertRowCol`, `deleteRowCol`: the per-sheet write-back that makes a structural inverse a whole-sheet replace), `packages/sheet/src/state/utils/patch.ts` (`patchToOp`, `opToPatch`, `sheetMetadataOps`), `packages/sheet/src/components/Workbook/api.ts` (`applyOp`, the receive path: engine re-derives the shift, then the authoritative metadata replaces apply), `packages/sheet/src/engine/replay-ops.ts` (`replaySheetsOps`), `packages/sheet/src/engine/rowcol.ts` (`shiftCellKeyedForInsert`, `shiftFormulasAcrossSheets`), `packages/sheet/src/engine/formula-shift.ts` (`functionStrChange`), `apps/api/src/lib/document/sheets.ts` (`readSheetsFromDoc`, `writeSheetsSnapshotToYjs`), `packages/lib/src/sheets/snapshot-codec.ts` (`decodeSheetsSnapshot` returns `Sheet[]` only).
- Server compaction: `apps/api/src/lib/collab/collabDocument.ts` (the `'update'` handler and `throttledTouchUpdatedAt`, `unsubscribe` and `scheduleClose`, `destruct`, `applySnapshotState`), `apps/api/src/lib/drive/trash.ts` and `apps/api/src/lib/versioning/restore.ts` (the close paths), `apps/api/src/lib/document/transform/runner.ts` (`TRANSFORM_LIMITS`), [DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md), `packages/lib/src/core/collab/hooks/use-collab-doc.ts` (`resyncInterval: 5000`).
- Position by reference: Yjs 13.6.32 `src/structs/ContentAny.js` (`splice` and `mergeWith` keep the element references).
- Same-key divergence with a keyed map: probed 2026-08-28 (`border-convergence.test.ts` header comment records the result; the probe was not committed because it fails by design). Different-key convergence: `packages/sheet/src/test/state/events/concurrent-config.test.ts`, `packages/sheet/src/test/state/modules/border-convergence.test.ts`.
- The Yjs way: `packages/lib/src/core/collab/hooks/use-collab-doc.ts`, `packages/lib/src/core/collab/hooks/use-yjs-undo-hotkeys.ts`, `packages/lib/src/core/collab/yjs-utils.ts`, `packages/ui/src/components/vector/hooks/use-canvas-doc.ts`, `apps/stickies/src/components/stickies/hooks/use-board.ts`, `apps/api/src/lib/collab/collabDocument.ts` (`SNAPSHOT_INTERVAL`, `SNAPSHOT_BYTES`).
- Undo semantics: Yjs 13.6.30 `src/utils/UndoManager.js` (tracked origins, capture timeout, undo runs as one transaction with the manager as origin) and `src/structs/Item.js` `redoItem` (the "never overwrite a remote map change" guard). Confirmed with two docs exchanging updates.
- Scale: bench over one `Y.Map` at 30k, 130k and 340k keys, 2026-09-03; the dead-weight figure reproduced with a second script (writes over 100 keys keep ~10 B each, writes to one key merge to 46 B total, a fresh document squashes to 1.7 KB).
