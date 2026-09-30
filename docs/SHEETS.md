# Sheets

> **TLDR:** `apps/sheets/` is a collaborative spreadsheet over `packages/sheet` (`@workspace/sheet`), our own fork of fortune-sheet/luckysheet. A workbook is a `.eigensheets` Drive folder whose Yjs doc holds a snapshot and an op log. Not obvious from the code: every edit is an immer-patch op pushed to a Y.Array, not a Yjs structure; a sheet's config collections always exist, because creating one ships it whole; the snapshot is only ever read and written through one codec; and undo is per tab and blind to peers. Formulas: [SHEETS-FORMULAS.md](SHEETS-FORMULAS.md). Cell glyphs: [SHEETS-CELL-GLYPHS.md](SHEETS-CELL-GLYPHS.md). Export: [SHEETS-EXPORT.md](SHEETS-EXPORT.md).

## `packages/sheet` is a fork we own

The whole upstream library (UI components, state runtime, formula parser) lives in `packages/sheet/`, with no external fortune-sheet dependency. `src/engine/` is the DOM-free half the server imports, `src/state/` the workbook context and its immer reducers, `src/components/` the React UI. How the canvas and the DOM overlays stack is in [RENDERING.md](../packages/sheet/RENDERING.md).

`engine/` has had its standards audit. `state/` is audited a directory at a time, when a feature touches it, with [SHEETS-TODO.md](SHEETS-TODO.md) as the ledger. A full pass now would be spent twice, because [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md) rewrites the model `state/` is built on.

## An edit is an op in a Y.Array

The Yjs doc has two roots. `state` is a Y.Map whose `snapshot` holds the encoded workbook. `ops` is a Y.Array of op batches. A local edit is an immer recipe; its patches become one op batch, which `use-sheet.ts` pushes to `ops`. A peer applies it with `applyOp()` (`components/Workbook/api.ts`), which patches the context without remounting the grid.

Why ops and not whole snapshots: a snapshot write is last-writer-wins for the whole workbook, while two ops on different cells merge cleanly. Two clients editing the *same* cell still diverge, because each applies its own op optimistically. Applying batches in array order would close that ([the proposal](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md#what-to-do-first)).

A joiner decodes the snapshot and replays the pending ops through `replaySheetsOps` (`engine/replay-ops.ts`). The API's document reader calls the same function, so every consumer agrees on what snapshot plus ops means. A batch that can't apply is rolled back and skipped, so one bad op never makes the doc unreadable. `applyOp` is not atomic: a failing patch keeps what already applied, so a live client and a joiner can disagree until reload ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## Creating a collection ships it whole, so every collection exists

immer records the creation of a key as one `add` carrying the whole new value. So the first write to a config collection that doesn't exist yet ships the entire collection, and it overwrites a peer's. And a granular patch against a base that lacks the collection fails to resolve, so `replaySheetsOps` rolls back the whole batch and the edit is lost.

`normalizeSheetConfig` (`engine/sheet-config.ts`) therefore materializes every config collection where a sheet enters a consumer: `initSheetData`, the replay base, `addSheet` ops, `createDefaultSheets` and the Workbook's seeding effect. Its `SHEET_CONFIG_COLLECTIONS` list has an exhaustiveness assert, so a new collection fails the build instead of reopening the hole. `withNormalizedSheet` does the same for `calcChain` and `images`, which live outside `config`: the first formula a user types emits `add ['calcChain', 0]` in the same batch as the cell.

There is no `ctx.config` shortcut. Read a sheet's config with `getSheetConfig` (`state/context.ts`) and write through `ctx.sheets[i].config`. immer names a patch after the path its draft was reached through, so a second route to the config emits patches at a root `filterPatch` drops, and assigning it back replaces the whole config.

A write on a path that then rejects the operation still ships an op and costs the user an undo entry. `packages/sheet/src/test/state/rejected-writes.test.ts` is the table-driven gate; add a row to it when you add a writer.

## `borderInfo` holds each cell's own sides

`config.borderInfo` maps an `"r_c"` key to that cell's sides. `applyBorder` (`state/modules/border.ts`) expands a toolbar layout per cell at write time, and `border-none` and every carry tombstone delete the key. Order carries nothing, so two clients bordering different cells converge (`packages/sheet/src/test/state/modules/border-convergence.test.ts`).

A shared edge never creates the neighbor's key, because that would be the whole-object `add` above. A neighbor entry that already exists gets its facing side overridden, so the edge just drawn wins on screen. When two neighbors disagree on a shared edge, as after many xlsx imports, the higher-index one wins (B1's left over A1's right), so the color can't flip with the viewport's walk order.

A header click selects a whole axis, so it is clipped to the used extent first (`clipToUsedExtent`); one click must not write a key for every row. Cells filled in later rows show no border, an accepted divergence from Excel and Google. Merges are a read-time filter: `mergeEdgeSides` (`packages/lib/src/sheets/borders.ts`) is the one predicate the canvas, the xlsx export and the HTML export share, and storage stays raw so an unmerge shows the sides again.

## Position-bound properties live beside the cell

Everything that is the cell (value, formula, number format, colors, font, rotation, rich-text runs) lives on the `Cell` in the matrix, and overwriting the cell overwrites all of it in one op. What is bound to the grid position lives in a map beside the matrix:

| Property | Home | Why not on the cell |
|---|---|---|
| Borders | `config.borderInfo` | A border outlives deleted content, and a separate key keeps "A types, B draws a border" from clobbering |
| Merges | `config.merge` | A merge spans cells |
| Data validation | `sheet.dataVerification` | The rule outlives the value it validates |
| Hyperlinks | `sheet.hyperlink` | The link outlives edits to its text |
| Row and column geometry | `config.rowlen`, `columnlen`, `rowhidden`, `colhidden` | Keyed by axis, not by cell |

`parseCellKey` is the one `"r_c"` parser. Insert and delete re-key borders, validation and hyperlinks through `shiftCellKeyedForInsert`/`Delete` (`engine/rowcol.ts`); merges have their own shifter. A track nobody resized stores no size and falls back to `SHEET_DEFAULT_COL_WIDTH` and `SHEET_DEFAULT_ROW_HEIGHT` (`packages/lib/src/sheets/defaults.ts`), which the editor, the importer and the export all read, so screen and export share one pitch.

`conditionalFormatRules` and `alternateFormatRules` stay arrays, because order is rule priority (Excel's model, exported as xlsx priorities). Two clients appending a rule at once can disagree on that order, visible only where rules overlap ([the proposal](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md#what-diverges-today)).

## The snapshot is interned and written only through the codec

`encodeSheetsSnapshot` and `decodeSheetsSnapshot` (`packages/lib/src/sheets/snapshot-codec.ts`) are the only way in or out of `state.snapshot`. A real 340k-cell workbook was 56 MB as plain JSON, because 224 style combinations and about 110 border payloads repeated per cell. The v2 envelope interns both into workbook-global dictionaries and is about 4.5 times smaller. The codec sits at the serialization seam only: the in-memory `Sheet[]`, the ops and the replay don't know it exists.

- The dense `data` matrix folds into the cell list at encode and is never stored. `selections`, a per-client cursor, is stripped.
- `calcChain` is never stored. The envelope's `computed` flag tells the decoder to seed it, which is the signal the server's recalc gate reads ([SHEETS-FORMULAS.md](SHEETS-FORMULAS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)).
- `images` ride verbatim, since there is nothing to intern.

The editor flushes a snapshot and clears the op log on unmount, and on `beforeunload` only while connected. A flush with no pending ops is skipped, because every edit is an op and rewriting the snapshot would send the whole workbook to every peer on each close. A tab closed offline flushes nothing, so the log grows until a connected tab flushes ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## An undecodable snapshot locks the editor and never overwrites

Anything that is not a v2 envelope throws, and so does a dictionary index past its table. How `use-sheet.ts` reacts depends on when. On the initial load it opens read-only on blank defaults, and the `loadedRef` gate keeps it from ever flushing them over the stored snapshot. On a peer's flush it can't read mid-session, it keeps the workbook already on screen and arms the same lock, because local state may now diverge from the wire. Either way a persistent banner in `editor.tsx` says so. A toast was dismissed on click and left a blank read-only sheet that looked like data loss.

## Undo is per tab and blind to peers

Undo is the engine's own stack of inverse immer patches (`handleUndo`/`handleRedo` in `components/Workbook/index.tsx`). An undo is broadcast as an ordinary op batch, so peers see an edit. A peer's batch applies with `noHistory` and is never undoable locally.

The stack's paths are absolute and nothing corrects them for a peer's changes. So an undo after a peer's row insert lands one row off, and one after a peer's sheet deletion can land on the wrong sheet. Undoing your own row insert applies the whole-sheet inverse locally but ships a `deleteRowCol` marker, so a peer's later edits on that sheet vanish on your side only. All three are in [SHEETS-TODO.md](SHEETS-TODO.md#bugs). Whether to move to Yjs structures and `Y.UndoManager` is answered in [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md): only with stable row and column ids, and not first.

## Every sheet switch goes through `changeSheet`

Tab clicks, the sheet list, search, hyperlinks, the API and the current sheet going away all call `changeSheet` (`state/modules/sheet.ts`). When the current sheet is hidden or deleted, here, by a peer or by an undo, `leaveCurrentSheet` lands on the first visible sheet in tab order, with `force` skipping the `beforeActivateSheet` veto. A hidden target is refused, and so is hiding your last visible sheet.

A switch closes the cell editor and any formula range selection, so Enter can never commit into a sheet a peer switched you to. It also derives everything the grid paints (`applySheetView`) inside the same recipe. The first frame after the commit paints before any effect runs, so anything left to an effect would draw the new sheet on the old sheet's geometry for one frame.

## Comments are Eigen comment cards

A cell anchors comments through `commentCardIds` on the `Cell`. The upstream comment system is gone; the context menu, the panel and the card dialogs are the shared components from [COMMENTS.md](COMMENTS.md). Only adding and deleting a cell's anchor stay sheet-specific hooks.

On mobile the comments pane takes the whole width, so `editor.tsx` hides the workbook instead of unmounting it. `Sheet` keeps a `ResizeObserver` on its container and skips 0×0 boxes, so the canvas re-measures when the workbook shows again. App code may rely on that.

## See also

- [SHEETS-FORMULAS.md](SHEETS-FORMULAS.md): the engine, recalc, number display, conditional formats
- [SHEETS-CELL-GLYPHS.md](SHEETS-CELL-GLYPHS.md): tick boxes, list chevrons, corner marks
- [SHEETS-EXPORT.md](SHEETS-EXPORT.md): HTML, PDF and the xlsx round trip
- [EXPORT.md](EXPORT.md#sheets-import): the xlsx importer and its invariants
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): `readSheetsFromDoc`
- [COLLAB.md](COLLAB.md): the socket and the loading gate
- [SHEETS-TODO.md](SHEETS-TODO.md) and [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md): open work and the op-log future
