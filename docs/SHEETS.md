# Sheets

> **TLDR:** Sheets is Eigen's spreadsheet: a workbook of tabs that several people edit at once, with formulas, number formats, validation and xlsx import and export. The grid, its state and the formula engine are `packages/sheet` (`@workspace/sheet`), our own fork of the open-source fortune-sheet, itself based on luckysheet. `apps/sheets/` is the app around it. A workbook is stored as a snapshot plus a log of edits.

A workbook is a `.eigensheets` file. It holds one or more sheets, the tabs. A sheet is a grid of cells. A cell holds its value (`v`), the string the grid shows (`m`), its formula (`f`), its number format and its style. What belongs to a grid position rather than to the cell, such as borders, merges, validation rules and hyperlinks, sits in maps beside the grid, keyed `"r_c"` (row and column, counted from 0). Row heights and column widths are keyed by the row or column index alone. The maps under a sheet's `config` (merges, borders, row and column sizes, hidden rows and columns) are its config collections. Conditional-format rules, floating images and charts hang off the sheet too.

In the browser the fork keeps the whole workbook as one plain object, the context, and changes it only through immer. An edit is a recipe, a function that changes a draft of the context, and immer reports the change as patches: small records of a path and a value.

A workbook is a collab document ([COLLAB.md](COLLAB.md)), but its Yjs document holds no Yjs grid. It has two roots: `state.snapshot`, the whole workbook encoded as one value, and `ops`, a Yjs array of op batches. An op is an immer patch in a form a peer can apply, and a batch holds the ops of one edit. So an edit travels like this. The recipe runs on the local context, its patches become one batch, the batch is pushed onto `ops`, Yjs carries it to the other browsers, and each applies it to its own context. A browser that opens the workbook decodes the snapshot and replays the batches on top. An editor that closes with edits pending writes a fresh snapshot and empties the log.

The op log is the idea the design rests on. Writing the whole snapshot on every edit would make the last writer win for the whole workbook, while two ops on different cells merge cleanly.

The server reads workbooks for export, the Drive preview and the search index. `packages/sheet/src/engine/` is the half without the DOM, and the API imports it: the formula parser and evaluator, the op replay and recalc, the pass that recomputes formula values. So the browser and the server read a workbook and compute a formula with the same code.

The sections run from storage (ops, config collections, borders, the snapshot codec, undo) through the engine and formulas to the painted glyphs, comments and export. Four things in them surprise people:

- A sheet's config collections always exist, because creating one ships it whole ([§ Creating a collection ships it whole](#creating-a-collection-ships-it-whole-so-every-collection-exists)).
- The snapshot moves only through one codec ([§ The snapshot is interned](#the-snapshot-is-interned-and-written-only-through-the-codec)).
- Undo is per tab and blind to peers ([§ Undo is per tab and blind to peers](#undo-is-per-tab-and-blind-to-peers)).
- The editor computes formula values as it writes, so the server recalculates only a workbook nobody computed ([§ The editor computes on write](#the-editor-computes-on-write-the-server-only-what-nobody-computed)).

## `packages/sheet` is a fork we own

The whole upstream library (UI components, state runtime, formula parser) lives in `packages/sheet/`, with no external fortune-sheet dependency. `src/engine/` is the DOM-free half the server imports, `src/state/` the workbook context and its immer reducers, `src/components/` the React UI. How the canvas and the DOM overlays stack is in [RENDERING.md](../packages/sheet/RENDERING.md).

## An edit is an op in a Y.Array

`use-sheet.ts` (`apps/sheets/src/components/sheets/hooks/`) pushes each local batch to `ops`. A peer applies it with `applyOp()` (`components/Workbook/api.ts`), which patches the context without remounting the grid.

Two clients editing the *same* cell still diverge, because each applies its own op optimistically. Applying batches in array order would close that ([the proposal](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md#what-to-do-first)).

A joiner decodes the snapshot and replays the pending ops through `replaySheetsOps` (`engine/replay-ops.ts`). The API's document reader calls the same function, so every consumer agrees on what snapshot plus ops means. A batch that can't apply is rolled back and skipped, so one bad op never makes the doc unreadable. `applyOp` is not atomic: a failing patch keeps what already applied, so a live client and a joiner can disagree until reload ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## Creating a collection ships it whole, so every collection exists

immer records the creation of a key as one `add` carrying the whole new value. So the first write to a config collection that doesn't exist yet ships the entire collection, and it overwrites a peer's. And a granular patch against a base that lacks the collection fails to resolve, so `replaySheetsOps` rolls back the whole batch and the edit is lost.

`normalizeSheetConfig` (`engine/sheet-config.ts`) therefore materializes every config collection where a sheet enters a consumer: `initSheetData`, the replay base, `addSheet` ops, `createDefaultSheets` and the Workbook's seeding effect. Its `SHEET_CONFIG_COLLECTIONS` list has an exhaustiveness assert, so a new collection fails the build instead of reopening the hole. It also materializes `images` and `charts`, the two maps outside `config` written key by key. `withNormalizedSheet` does the same for `calcChain`, which also lives outside `config`: the first formula a user types emits `add ['calcChain', 0]` in the same batch as the cell.

There is no `ctx.config` shortcut. Read a sheet's config with `getSheetConfig` (`state/context.ts`) and write through `ctx.sheets[i].config`. immer names a patch after the path its draft was reached through, so a second route to the config emits patches at a root `filterPatch` drops, and assigning it back replaces the whole config. `packages/sheet/src/test/state/events/concurrent-config.test.ts` pins it through the real op pipeline: one client merges cells, another drags a row taller, and the drag must not undo the merge.

`filterPatch` and `sheetMetadataOps` (`state/utils/patch.ts`) decide what goes on the wire, and both read one list of per-client `Sheet` fields, `PER_CLIENT_SHEET_FIELDS`. With two lists, a row insert would broadcast state the op path drops.

A write on a path that then rejects the operation still ships an op and costs the user an undo entry. `packages/sheet/src/test/state/rejected-writes.test.ts` is the table-driven gate; add a row to it when you add a writer.

## `borderInfo` holds each cell's own sides

`config.borderInfo` maps an `"r_c"` key to that cell's sides. `applyBorder` (`state/modules/border.ts`) expands a toolbar layout per cell at write time. `border-none` deletes the key and clears the facing side of each outside neighbor, so the shared edges go blank. Paste, move, fill and the format painter carry borders through `carrySides`, which deletes the destination's key when the source cell has no border, the Excel and Google overwrite rule. Order carries nothing, so two clients bordering different cells converge (`packages/sheet/src/test/state/modules/border-convergence.test.ts`).

A border belongs to the cell it was drawn on. The painter draws each cell's own sides at coordinates that coincide with the neighbor's, so the pixels match without a mirror. A shared edge never creates the neighbor's key, because that would be the whole-object `add` of [§ Creating a collection ships it whole](#creating-a-collection-ships-it-whole-so-every-collection-exists). A neighbor entry that already exists gets its facing side overridden, so the edge just drawn wins on screen. One result a user can see: copying B1 alone does not pick up A1's right edge. When two neighbors disagree on a shared edge, as after many xlsx imports, the higher-index one wins (B1's left over A1's right), so the color can't flip with the viewport's walk order.

A header click selects a whole axis, so it is clipped to the used extent first (`clipToUsedExtent`); one click must not write a key for every row. Cells filled in later rows show no border, an accepted divergence from Excel and Google. Merges are a read-time filter. `mergeEdgeSides` (`packages/lib/src/sheets/borders.ts`) is the one predicate. The canvas calls it per cell, and the HTML export folds a merge's cells onto its top-left cell through `mergedBorderSides`, because the HTML has one `<td>`. When several cells of a merge write the same outer edge, the last one folded wins. The xlsx export writes each cell its own sides, as Excel stores them. Storage stays raw, so an unmerge shows the sides again.

Only the canvas border pass skips hidden rows and columns. Every carry path (cut, move, fill, the format painter, copy as HTML) reads the merge-filtered sides through `getBorderInfoCompute`, which keeps them, so a drag-fill from a hidden source keeps its border. A row or column insert clones the borders of the row or column at the insert index onto the new ones, as validation rules do (`shiftCellKeyedForInsert` in `engine/rowcol.ts`). So inserting above the top row of a bordered block repeats that row's top edge.

## Position-bound properties live beside the cell

Everything that is the cell (value, formula, number format, colors, font, rotation, rich-text runs) lives on the `Cell` in the matrix, and overwriting the cell overwrites all of it in one op. A rich-text cell keeps its text in its runs alone, with no `v` or `m`, and every reader takes it from there through `richText`, `cellValue` for a value that is the runs' text or `v`, or `cellDisplay` for the text the grid shows, the runs' text or `m` or `v` (`engine/format.ts`), except find and replace, which skips rich-text cells for now ([ROADMAP.md](ROADMAP.md), "Sheets: find and replace inside rich-text cells"). A writer that writes plain text over a rich cell drops its runs with `dropRuns`: they would otherwise outrank the value it wrote. What is bound to the grid position lives in a map beside the matrix:

| Property | Home | Why not on the cell |
|---|---|---|
| Borders | `config.borderInfo` | A border outlives deleted content, and a separate key keeps "A types, B draws a border" from clobbering |
| Merges | `config.merge` | A merge spans cells |
| Data validation | `sheet.dataVerification` | The rule outlives the value it validates |
| Hyperlinks | `sheet.hyperlink` | The link outlives edits to its text |
| Row and column geometry | `config.rowlen`, `columnlen`, `rowhidden`, `colhidden` | Keyed by axis, not by cell |

`parseCellKey` is the one `"r_c"` parser. Insert and delete re-key borders, validation and hyperlinks through `shiftCellKeyedForInsert`/`Delete` (`engine/rowcol.ts`); merges have their own shifter. A track nobody resized stores no size and falls back to its sheet's `defaultColWidth` and `defaultRowHeight`, or to `SHEET_DEFAULT_COL_WIDTH` and `SHEET_DEFAULT_ROW_HEIGHT` on a sheet without them. Only the xlsx import sets a sheet's own, so an Excel sheet keeps Excel's pitch. The editor, the importer and the export all read them through `sheetDefaultColWidth` and `sheetDefaultRowHeight` (`packages/lib/src/sheets/defaults.ts`), so screen and export share one pitch. The export and the xlsx import's chart anchors walk tracks to pixels through `sheetColumnsWidth` and `sheetRowsHeight` beside them, a hidden track counting none. A track's size counts its gridline, which the editor paints on the track's last pixel, as Excel counts it. So a column is as many pixels on screen as in Excel and the export, and a floating image, stored in pixels from A1, covers the same cells in all three.

`conditionalFormatRules` and `alternateFormatRules` stay arrays, because order is rule priority (Excel's model, exported as xlsx priorities). Two clients appending a rule at once can disagree on that order, visible only where rules overlap ([the proposal](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md#what-diverges-today)).

## The snapshot is interned and written only through the codec

`encodeSheetsSnapshot` and `decodeSheetsSnapshot` (`packages/lib/src/sheets/snapshot-codec.ts`) are the only way in or out of `state.snapshot`. A real 340k-cell workbook was 56 MB as plain JSON, because 224 style combinations and about 110 border payloads repeated per cell. The v2 envelope interns both into workbook-global dictionaries and is about 4.5 times smaller. The codec runs only where the snapshot is serialized: the in-memory `Sheet[]`, the ops and the replay don't know it exists.

- The dense `data` matrix folds into the cell list at encode and is never stored. `selections`, a per-client cursor, is stripped.
- `calcChain` is never stored. The envelope's `computed` flag tells the decoder to seed it, which is the signal the server's recalc gate reads ([§ The editor computes on write](#the-editor-computes-on-write-the-server-only-what-nobody-computed)).
- `images` and `charts` ride verbatim, since there is nothing to intern. An `images` array, the form before images became a map, decodes as no images: sheets keep no backward compatibility, and no per-image write could resolve on an array. `opToPatchOnSheets` drops the whole-array write a tab still open on that build sends, for the same reason.

The editor flushes a snapshot and clears the op log on unmount, and on `beforeunload` only while connected. A flush with no pending ops is skipped, because every edit is an op and rewriting the snapshot would send the whole workbook to every peer on each close. A tab closed offline flushes nothing, so the log grows until a connected tab flushes ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## An undecodable snapshot locks the editor and never overwrites

Anything that is not a v2 envelope throws, and so does a dictionary index past its table. How `use-sheet.ts` reacts depends on when. On the initial load it opens read-only on blank defaults, and the `loadedRef` gate keeps it from ever flushing them over the stored snapshot or sending an op built on them. On a peer's flush it can't read mid-session, it keeps the workbook already on screen and arms the same lock, because local state may now diverge from the wire. Either way a persistent banner in `editor.tsx` says so, because a blank read-only sheet with no lasting explanation looks like data loss.

Version history keeps snapshots in older encodings. Restoring one answers 409 and changes nothing (`apps/api/src/lib/versioning/restore.ts`), because every connected editor would lock.

## Undo is per tab and blind to peers

Undo is the engine's own stack of inverse immer patches (`handleUndo`/`handleRedo` in `components/Workbook/index.tsx`). An undo is broadcast as an ordinary op batch, so peers see an edit. A peer's batch applies with `noHistory` and is never undoable locally.

The stack's paths are absolute and nothing corrects them for a peer's changes. So an undo after a peer's row insert lands one row off, and one after a peer's sheet deletion can land on the wrong sheet. Undoing your own row insert applies the whole-sheet inverse locally but ships a `deleteRowCol` marker, so a peer's later edits on that sheet vanish on your side only. All three are open in [SHEETS-TODO.md](SHEETS-TODO.md). Whether to move to Yjs structures and `Y.UndoManager` is answered in [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md): only with stable row and column ids, and not first.

## Every sheet switch goes through `changeSheet`

Tab clicks, the sheet list, search, hyperlinks, the API and the current sheet going away all call `changeSheet` (`state/modules/sheet.ts`). When the current sheet is hidden or deleted, locally, by a peer or by an undo, `leaveCurrentSheet` lands on the first visible sheet in tab order, with `force` skipping the `beforeActivateSheet` veto. A hidden target is refused, and so is hiding your last visible sheet.

A switch closes the cell editor and any formula range selection, so Enter can never commit into a sheet a peer switched you to. It also derives everything the grid paints (`applySheetView`) inside the same recipe. The first frame after the commit paints before any effect runs, so anything left to an effect would draw the new sheet on the old sheet's geometry for one frame.

## The engine is the half the server imports

`packages/sheet/src/engine/` holds the parser and evaluator, the dependency graph, recalc, row and column shifts, the op replay and the conditional-format evaluator. The editor and the server run the same code. `engine/` imports nothing from `state/` and nothing from the DOM. It evaluates through a `CellResolver`: the editor's resolver reads the workbook context, the server's (`createArrayResolver`) reads a replayed `Sheet[]`. Orchestration that needs the context, such as `execFunctionGroup` and `groupValuesRefresh`, lives in `state/modules/formula-exec.ts`.

`apps/api` imports only the `@workspace/sheet/engine` subpath, and two of its leaf modules: `engine/a1-notation` and `engine/format`, which a docx or pptx chart reads its ranges and number formats through, since the barrel evaluates the whole formula engine, formulajs included (632 modules). The `./engine` entries in `packages/sheet/package.json` point at the TypeScript source, not a build, so the API's own type check covers the engine under its stricter options: no DOM lib, `verbatimModuleSyntax`, `noUnusedParameters`. A DOM or state import in the engine fails the API build.

The functions come from `@formulajs/formulajs`, behind a parser inherited from the fortune-sheet fork. A function this build lacks (XLOOKUP, TEXTJOIN, LET, FILTER) evaluates to `#NAME?`. The engine overrides `VALUE`, which rejects a number, and `TEXT`, which formulajs leaves unimplemented, so it formats through the same numfmt masks the grid renders with.

formulajs carries one patch, `patches/@formulajs%2Fformulajs@2.9.3.patch`, listed in `patchedDependencies` in the root `package.json`. Its `flattenShallow` (`lib/utils/common.js`, the only build the engine loads: `main` is `index.js`, which requires `lib/`) concatenated onto a `reduce` accumulator, copying it per row, so flattening a range was quadratic in its rows: 100,000 rows took 2.1 s, one `SUMIFS` over 208,681 rows 305 s. The patch is the same flatten as a loop, with the same output, and it no longer pushes into its input. 4.6.0 has the old code. Once a release fixes it, delete the file and the `patchedDependencies` entry and run `bun install`. Keep `src/test/engine/formulajs-flatten.test.ts`, which pins the output and the time. Both Dockerfiles copy `patches/` with the manifests, because the install applies it.

## Values follow Excel's grid and calendar

- A Date result (`DATE`, `EOMONTH`, `NOW`) is stored as its Excel serial, taken from the Date's local calendar fields, because formulajs builds its Dates at local midnight. `dateToSerial` in `engine/parser/helper/number.ts` is the engine's conversion, with the Lotus leap day from 1900-03-01. The cell keeps its format mask, so a mask-less cell shows the serial.
- Every range is clamped to the sheet grid, because an unclamped `A1:XFD1048576`, a shape real xlsx files carry, is 17 billion cells. So `ROWS(A1:A100)` on a two-row grid is 2 (`packages/sheet/src/test/engine/formula-engine.test.ts`), a range past the grid is empty, and an `INDEX` past the grid is `#REF!`.
- formulajs parses an ISO date string as UTC (`DATEVALUE("2026-01-05")`), so the result is off by the zone offset outside UTC. `DATE(...)` is built in local time and is right everywhere. The fix is open in [SHEETS-TODO.md](SHEETS-TODO.md#formula-engine).

The dependency graph has two limits:

- A reference cycle never errors: the visited set in `getCalculationOrder` breaks the walk, and the cycle's cells evaluate in visit order.
- `INDEX` produces references the dependency graph can't see statically. `isFunctionRange` special-cases it, together with `INDIRECT` and `OFFSET`; keep that logic when you touch the graph. formulajs 2.9.3 has no `INDIRECT` or `OFFSET`, so both evaluate to `#NAME?`.

## The editor computes on write, the server only what nobody computed

The editor's dependent recompute runs inside the recipe that emits the op, so recomputed `v` and `m` persist as ordinary ops. A doc edited in a browser is already fresh when the server reads it.

So `readSheetsFromDoc` recomputes only on the export read. Preview and the search extract pass `{ recalc: false }` and serve the replayed values, and a formula cell with no value stays blank. A legacy never-computed workbook costs an unbounded recalc (about 39 s measured), past the 30 s transform deadline of a preview, so every preview of such a doc would fail. An export recomputes under its 120 s deadline, because a deliverable with blank formula cells is wrong output.

Even on export, `recalcSheets` runs only when `sheetsNeedRecalc` finds a sheet with formula cells and an empty `calcChain`. The decoder leaves the chain empty unless the envelope says `computed: true`, which every editor flush writes ([the codec](#the-snapshot-is-interned-and-written-only-through-the-codec)). The xlsx importer runs `recalcSheets` once in its transform and writes `computed: true`, or `false` when its recalc failed, so that export recomputes. Any recalc failure falls back to the replayed values: an export never fails because recalc did.

The server's recalc, at import and at export, runs under a budget, `SERVER_RECALC_BUDGET` (`document/sheets.ts`). The dependency index lists a range in every 64 × 16 block it meets, cut to the cells its sheet holds: only a formula cell is ever looked up, so `SUM(A1:XFD1048576)` on a small sheet costs the few blocks the sheet spans. Past the budget `recalcSheets` throws before it evaluates, a recalc failure like any other. Evaluation is charged each cell a range read covers, cut to its sheet (`maxCellsRead`), and stops at the formula after the one that passed it. Nothing bounds the parent edges, one per formula cell and formula reading it ([ROADMAP.md](ROADMAP.md)).

## Recalc keeps what it can't improve

`recalcSheets` (`engine/recalc.ts`) materializes each sheet's `data`, finds formula cells by scanning it rather than trusting `calcChain`, orders them through the dependency graph and evaluates them with the shared `FormulaEngine`. Its graph builder is a port of the state layer's `setFormulaCellInfo` and `isFunctionRange`, because the engine can't import `state/` ([SHEETS-TODO.md](SHEETS-TODO.md#code-debt) tracks removing the copy).

Two rules keep a passive export honest:

- Volatiles (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`) keep their cached value, the way Excel reads a closed file, so an export is deterministic.
- An engine error never overwrites a cached value that is not an error. A function this build lacks would otherwise turn Excel's correct result into `#NAME?` at import. Downstream cells then read the cached value too.

Every cell is guarded, so one poisoned formula never aborts the pass.

## The editor builds its formula map when idle

At mount the Workbook materializes each sheet's `data` and `seedCalcChain` records the formula cells without evaluating them. Displayed values come straight from the stored workbook, and an edit recomputes only the affected sub-graph (`execFunctionGroup`), so recalc cost follows the edit, not the workbook.

The dependency map (`ctx.formulaCache.formulaCellInfoMap` and its reverse `dependencyIndex`) is built from an idle callback, so the first edit on a large workbook doesn't pay a multi-second rebuild. It is all or nothing: whichever comes first, the idle build, an edit or a paste, builds the whole map, from a plain `current()` snapshot, because reading every formula through an immer draft is slow.

Once built, the map is kept current cell by cell. Local writers register what they write through `setFormulaCellInfo`. Undo, redo and a peer's ops go through `updateFormulaCache`, which reads only `data` patches, because every formula change carries one. A structural patch or a row or column insert or delete sets the map to `null` for a lazy rebuild. The `calcChain` patch that rides along is ignored, because re-registering from it cost a whole sheet per edit. The known gap, a copied sheet's formulas, is in [SHEETS-TODO.md](SHEETS-TODO.md#bugs).

## Number display strings go through `numberDisplay`

`numberDisplay(value, fa)` (`engine/format.ts`) turns a number into its `m`. Typed entry, paste, sort, autofill, the toolbar format change, the format painter, `setCellFormat`, recalc and the xlsx importer all call it. A mask renders the exact value. General is Excel's General at default width, so float noise hides (`0.1+0.2` shows `0.3`), long values cut to 11 characters and large or tiny values go scientific. A malformed format, which an xlsx file can carry, falls back to General. The input parser (`parseCellInput`) and autofill's date series still format on their own.

A typed number is stored as a number in `v`, unless the cell is text-formatted. Pasted plain text goes through the same `setCellValue` parse as typing. A formula's text result stays text (`=TEXT(5,"000")` is `"005"`). Copying a General number writes 15 significant digits (`copiedNumberText`), not the 11-character display, so a paste elsewhere keeps the precision.

## A copy puts the cells on text/plain as TSV

A range copy writes three flavors: the HTML table with the cells' styles, the Eigen clipboard payload, and TSV on `text/plain` with tabs between cells and newlines between rows. `rangeValueToClipboard` (`state/modules/selection.ts`) builds the table and the TSV in one pass over the same cells, each cell's display text with General numbers at 15 digits. A cell holding a tab, a line break or a leading quote is quoted and its quotes doubled, as Google writes it, through `cellsToTsv` in `@workspace/lib/clipboard`; a quote inside text stays as it is, so `12" pizza` pastes as typed. The Eigen text item carries the same cells unquoted, tabs and newlines between them, because Docs reads it as text rather than as TSV. The HTML table writes a cell's font size in pt, the unit every font size on the clipboard is in ([CLIPBOARD.md](CLIPBOARD.md#a-font-size-crosses-in-pt)), and the table paste reads a size in pt as pt and in px at 96 dpi. The plain text is what a paste into a text field, a chart's Edit data grid or another app without an HTML reader gets, so it has to keep the grid's shape. The plain-text paste in Sheets itself splits on tabs and newlines and doesn't unquote, so a quoted multi-line cell pasted as plain text lands split ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## Enter and Tab commit an edit and move on

While a cell is open, Enter commits it and moves down, and Tab commits and moves right, Shift+Tab left, as in Google Sheets. Both go through `commitEdit` (`state/events/keyboard.ts`), which writes the cell and collapses the selection to it before the move. A visible formula suggestion takes Tab first and stops it, so Tab picks the function instead of committing.

## Conditional formats evaluate headless

`evaluateConditionalFormat(rules, data, options?)` (`engine/conditional-format.ts`) returns the `"r_c"`-keyed style map the canvas paints, and the HTML export calls it too ([§ The export paints conditional formats with the grid's evaluator](#the-export-paints-conditional-formats-with-the-grids-evaluator)). Without an evaluator, formula rules are skipped. Both callers pass the same one, `createCfFormulaEvaluator`.

Every rule scans only the materialized matrix, because Excel writes a whole-column rule as `A1:A1048576`. Overlapping rules layer per style property in rule order, so a later rule's fill never erases an earlier rule's text color. `textContains` ignores case and `duplicateValue` skips blank cells, both as in Excel.

## A formula rule is anchored at its first range's corner

That is Excel's anchor: every cell of every range evaluates the formula at its offset from the top-left of the first range. `createCfFormulaEvaluator` compiles each formula once and evaluates it at that offset. It shares `offsetCoordinate` and `offsetRange` with `functionCopy`, the text shifter paste and autofill use, so shifted text and a compiled offset read the same cells. The xlsx importer keeps a rule with all its ranges, and the exporter writes one multi-range `sqref`.

Every rewrite of a rule's ranges (cut, copy, paste format, drag-move, row or column delete, the preview's clip) goes through `withCfRanges`. When the first range starts somewhere new, it re-expresses the formula from the new corner, so every cell keeps the relative formula it had. Autofill only appends a range and an insert moves corner and references together, so neither re-anchors.

One edge stays. A formula that reads above or left of its corner (`=A4>0` on `A5:A10`) can't be re-expressed from a corner nearer the sheet edge than it reaches, because A1 text has no row 0. `functionCopy` writes `#REF!` and the rule stops matching.

## Row and column shifts rewrite every sheet's formulas

`applySheetsInsertRowCol` and `applySheetsDeleteRowCol` (`engine/rowcol.ts`) shift the cells, geometry, merges, borders and conditional-format rules of the changed sheet, and formula text and chart refs in every sheet. Only references that resolve to the changed sheet move: unqualified ones on it, `Sheet!`-qualified ones anywhere. A reference wholly inside a deleted band becomes `#REF!`, and a whole-row or whole-column range keeps both legs. The functions are generic over the sheet type, so the editor's wider sheet flows through with its extras. `state/modules/rowcol.ts` then shifts the editor-only fields: filter, frozen panes, validation, hyperlinks, `calcChain`.

## Images and charts are floating records in one paint order

`Sheet.images` and `Sheet.charts` map an id to a `SheetImage` or a `SheetChart`, both a `SheetFloatingObject`: a box in grid pixels from A1, an `angle` in degrees clockwise about its center (absent reads as 0), and an `index`, a fractional key that orders images and charts together for painting, ties broken by id. Two maps rather than one with a kind field, so the chart-only paths (ref shifts, the row and column write-back) stay chart-only. `floatingItems` (`packages/lib/src/sheets/floating.ts`) is the one answer to which objects a sheet holds and in what order; the editor's overlay, the export and a z-order move read it. `nextFloatingIndex` puts an insert above both kinds, and a z-order move goes through `zOrderKeys` over both, so neither throws on the tied keys two peers inserting at once leave behind. Both repair a tied or malformed key on the record and write the repair with their own write, because a malformed key such as `zz` sorts above any key an insert could take. An image's id is a uuid, because two peers must never write one key.

A file or a peer can store any box, a string included, and a side in the billions overflows the painter's stack, so `sheetFloatingBox` clamps every box wherever one is written or drawn: the xlsx import, insert, paste, move, resize and rotate, `renderSheetChartSvg` and the export. A side is at most `CHART_MAX_SIDE`, the 2112 px Docs caps a chart at, the corner lies on Excel's grid at the default track sizes, and an angle that is no finite number is 0. An inserted image larger than that is scaled down whole, so it keeps its aspect. Copying a sheet gives its images and charts fresh ids.

Each writer writes one object of the current sheet under its own key, field by field: the shared ones in `state/modules/floating.ts`, a chart's spec, range and look in `chart.ts`, an image's insert and media name in `image.ts`. A move writes `x` and `y`, a first rotate adds `angle`, a spec edit is one replace of `spec`, a look edit writes only the look fields it changes, and none ever replaces a whole existing object. So two people editing different objects merge, and a batch on an object a peer deleted fails whole on every client and in the replay instead of bringing it back. Undo and redo drop such an entry (`editsDeletedFloatingObject`), because immer throws on a path into a missing object. What writes a whole object does bring back one a peer deleted, on every client, last writer wins: redoing its insert, undoing its delete, undoing or redoing a row or column op that shifted a chart, and any row or column batch on a sheet whose formulas it moved too. `packages/sheet/src/test/state/modules/floating.test.ts` pins both kinds on the author, a peer and a joiner.

The selected object is `ctx.activeObject`, an image or a chart and whether a chart's editor is open, per client, so `filterPatch` drops it.

## A pending upload's name is swapped on every sheet and in the undo stack

An image inserted from an upload carries a `pending:` name until the upload settles ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)). `replaceImageMediaName` and `removeImageByMediaName` walk every sheet, because the user may have switched tabs since the insert, and the zombie sweep collects pending names from every sheet too. The swap records no undo step, so the entry that inserted the image still holds the pending name, and a redo, or the undo of a delete, would bring back an image that never resolves. `replaceMediaNameInHistory` renames it in the undo and redo stacks as well (`packages/sheet/src/test/components/Workbook/image-undo.test.tsx`).

## A chart is a floating record whose refs name sheets by id

A chart's `spec` is the stored chart JSON that only `parseChartSpec` (`packages/lib/src/charts/`) reads. A range ref in the spec names its sheet by id, so renaming a sheet moves nothing. Copying a sheet points its charts' refs to the copied sheet at the copy, as Excel and Google do. An xlsx import brings a chart Excel anchors on a worksheet in as one of these records over the same cells, and a chart sheet as a sheet holding its chart ([EXPORT.md](EXPORT.md#an-xlsx-chart-comes-in-over-the-cells-excel-draws-it-over)). The import reads an anchor's box only, so an imported chart stores angle 0.

## Chart refs shift with rows and columns, and an undone delete ships them

A row or column insert or delete shifts every ref to the edited sheet, on every sheet's charts, inside the engine, so the editor, a peer and the replay all run it. The rule is Excel's, and conditional formats and alternate formats share it through `shiftRangeForInsert` and `shiftRangeForDelete` (`engine/rowcol.ts`): an insert at or before a ref moves it, inside grows it, right after leaves it, and a delete shrinks it. Deleting all of a values or categories ref makes it null, and a deleted name cell leaves the series unnamed. An insert stops a ref at the grid's last row or column, because `parseChartSpec` refuses a ref past it and the chart would never read again.

The edited sheet's whole `charts` and `images` maps ride the row or column op as an authoritative replace, like the rest of its metadata (`sheetMetadataOps` in `state/utils/patch.ts`). A peer's chart or image edit on that sheet at the same moment can be lost ([the proposal](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md#what-diverges-today)).

A sheet that changed only through its charts is written back one chart at a time (`writeBackSheets` in `state/modules/rowcol.ts`), so the op, its undo and its redo each carry one replace per shifted chart. A receiver runs the engine shift first and then the replace. The undo entry then restores those charts and not the whole sheet, which would overwrite a peer's later edits there on the undoing client only. This matters most for an undone delete: it ships as an insert, and an insert never grows a shrunk or nulled ref back.

A sheet whose formulas the op moved too is still written back whole, and its whole-sheet replace stays off the wire ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)). So every row or column batch, the op, its undo and its redo, ships each of that sheet's charts by hand in `patchToOp`, last writer wins, since a receiver's shift can differ from the author's write-back: an undone delete never grows a ref back, an undone insert never shrinks a ref the insert stopped at the grid's edge, and an undo or redo reverts a peer's later move of the chart on the author alone. An undone delete ships the edited sheet's `calcChain` for the same reason. `packages/sheet/src/test/state/modules/chart.test.ts` pins these on the author, a peer and a joiner.

## A range chart reads the grid's own values and labels

`resolveRangeChartData` (`engine/chart-data.ts`) turns a range chart into the categories and series the layout draws, through a `CellResolver`, so the editor and the server read the same cells. A value is the cell's computed `v` when it is a finite number and a gap otherwise. A label or series name is the cell's display text `m`, the string the grid shows, or a rich-text cell's runs joined, since one made in the editor has neither `m` nor `v`. A name ref reads its first cell. A chart with no categories counts them 1, 2, … up to its longest series.

A series whose values ref is null, deleted with its rows or columns, is left out and the rest draw, as Google does; it keeps its color in the spec, so an undo brings it back as it was. An automatic color resolves by the series' index in the spec before that, so the series after a deleted one keep the colors the editor shows them in. No series left, or a ref that names a missing sheet or spans several rows and several columns at once, is a `'ref'` error, which the chart shows as Excel's #REF. More points than `MAX_CHART_POINTS` is `'too-many-points'`. Both are decided from the refs before a cell is read, so selecting a whole column costs nothing. Hidden rows and columns are read like visible ones, while Excel and Google skip them by default ([ROADMAP](ROADMAP.md)).

`renderSheetChartSvg` (same file) is the chart the editor's overlay and the export both draw: the box, the look the record stores, the resolved data, and value ticks through `numberDisplay` in the axis's own format or else the first value cell's, Google's "From source data", so a percent column gets percent ticks.

## A chart's Setup is a block of cells, derived to refs and read back from them

The spec stores a ref per series, so a row insert can shift each one the way Excel shifts a chart's series. Google's Setup instead describes one block of cells: series down its columns or along its rows, and whether its first row and first column hold names. That block is a `ChartRange` (`engine/chart-range.ts`). `chartRangeData` derives the refs from it, and `chartRangeOf` reads it back by deriving both orientations and comparing with the stored refs. Refs no block derives, an imported chart's or one a deleted row nulled, have no Setup to show until a range is typed. The flags name the block's own first row and column, so Switch rows/columns keeps them: a text first row names the series down columns and the categories along rows.

Insert → Chart and a typed data range set a block up the same way (`suggestChartRange`): text in the first row or first column makes it names, the corner cell counting for neither, and series run down the columns unless the block has more data columns than rows. Insert also charts the table around a single selected cell (Excel's current region, `currentRegion`), titles the chart after its series ("North, South and East"), names the horizontal axis after the corner cell when that heads the categories, and places a 600 × 371 column chart below the block, selected, so its panel shows. `setUpChartRange` refuses a block of more than `MAX_CHART_SERIES` series, which `parseChartSpec` would read back as null, and one of more values than `MAX_CHART_POINTS`, which the chart would only draw as too much data. The values are counted from the refs, the fewest a block can hold before its cells set it up, so a typed whole column reads nothing. `currentRegion` grows each edge as far as it goes before trying the next and stops past `MAX_CHART_POINTS`, so a cell in a 10,000-row table reads a few thousand cells and is refused. Insert says why in an alert and the panel under the field, one message per reason (`CHART_RANGE_REFUSALS`).

## Images and charts share one frame on the grid

`FloatingObjects` (`components/FloatingObjects/`) draws the current sheet's images and charts in `floatingItems` order, so the DOM order is the paint order, each in one `FloatingObjectFrame` at its `sheetFloatingBox`. The kind supplies only its content, an `<img>` or the chart's drawing, so both kinds select, move, resize, rotate and open their menu through the same code and cannot drift apart. The frame is an unrotated positioned box and the content turns inside it, so a hit follows the turned shape.

A click selects the object and focuses its frame, so the workbook's keydown sees Delete, which goes through `clearSelectedContents`. Escape is the frame's own keydown. A drag moves it, and the `ObjectTransform` grips resize and rotate it, each gesture one write of the fields it changed. The preview clears on `onGestureEnd`, because a gesture cancelled by Escape or one that never moved commits nothing. Clicking a cell, a header or another sheet's tab deselects through `deselectFloatingObject`, and `changeSheet` drops the selection too, because the object belongs to the sheet left behind.

Touch follows Google Sheets on a phone: only the selected object is `touch-none`, so a finger on any other one pans the grid, the tap that follows selects it, and a drag on it then moves it. A `pointercancel`, the browser taking a touch for a pan, ends a move without writing it. `packages/sheet/src/test/components/FloatingObjects/floating-objects.test.tsx` runs every case for both kinds.

## A floating object's menu, keys and aspect lock are Vector's

Right-click, and a long press on touch, select the object and open the shared `ObjectContextMenu` ([LAYOUT.md](LAYOUT.md#menus-draw-their-rows-in-one-order)), so its rows read as a canvas object's do: Cut, Copy, Duplicate, Order, the download, Delete. A chart adds Download image, and a viewer gets the download row only. Like a canvas chart's, the menu has no Edit chart row, since selecting the chart already shows everything that edits it. Sheets objects take no comments, which hang off cells, so the menu has no Add comment. ⌘[ and ⌘] step the selected object down and up, with Shift to the back and front, through Vector's `useZOrderHotkeys`.

Keep aspect ratio is the app's `useAspectLock`, on by default for an image, whose photo distorts when stretched, and off for a chart, which redraws to any box. The app passes it to the workbook as `aspectLocked`, so the corner grips and the panel's checkbox follow one setting, and Shift inverts it while dragging. The app's panel (`apps/sheets/src/components/sheets/floating-object-panel.tsx`) shows X, Y, W, H and the angle, then Arrange, for both kinds, and a chart's own sections between them ([§ A selected chart's panel](#a-selected-charts-panel-is-a-canvas-charts-and-a-typed-edit-is-one-undo-step)). Delete is the menu's, the Delete key's and Edit › Delete's, as in Vector and Slides, so the panel has no Delete button.

## A chart on the grid redraws only when a cell matrix it reads changes

Every component under the workbook context re-renders on every context change, a selection or a drag included, so `sheetChartSvg` (`state/modules/chart.ts`) keeps one drawing per chart record and the `data` matrices of the sheets its refs name. immer replaces the matrix whose cells an edit touched, so an edit feeding a chart redraws it on the next render and nothing else does. The key is the matrix, not the sheet: the API's `setSelection` and a sheet switch write the per-client `selections` onto the sheet object. A rotate or a move keeps the drawing, and a resize redraws at the preview's size. `packages/sheet/src/test/components/FloatingObjects/chart-content.test.tsx` counts the redraws.

Download image draws the chart as a copy carries it, through the canvas image writer: its ranges read into inline data and its look carried (`sheetChartClipboardItem`), on white, with the faces its labels use embedded ([EXPORT.md](EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers)). A chart that draws #REF! or too much data has no inline data, so its menu has no Download image. The value ticks draw as plain numbers, as in every app but Sheets ([CHARTS.md](CHARTS.md#a-chart-copies-between-apps-with-its-numbers-inline)).

## A selected chart copies itself, not the cells behind it

Selecting a chart or an image leaves the cell selection as it was, and the object takes the focus, so ⌘C and ⌘X reach the workbook's keydown with the cells still selected. The keydown skips the cell copy while a chart or an image is selected, so the cells get no copy border and no stale `copyState`, and the Workbook's `copy` listener writes the chart instead: one chart item ([CLIPBOARD.md](CLIPBOARD.md#a-chart-travels-as-its-spec-with-the-numbers-inline)) carrying the chart's look, whose spec is the chart with its ranges read into inline data (`inlineChartSpec`, `engine/chart-data.ts`), since no other app can read a range. `sheetChartClipboardItem` (`state/modules/chart.ts`) builds it, for the copy and Download image alike. Ticks drawn "From source data" take the first value cell's format onto the axis, so they keep it. An automatic color stays automatic unless a deleted series before it would shift its index. A chart that draws `#REF!` or too much data copies nothing. ⌘X writes the same item and deletes the chart, one undo step, as Google's does, and an image the same way; a viewer's ⌘X only copies. The object menu's Cut and Copy and Edit › Cut and Copy reach the same listener through the clipboard event `execCommand` fires (`copyActiveObject`, `state/modules/clipboard.ts`), so a menu writes what the keys write. The listener reads the chart from `ctx.sheets`, not through the editable current sheet, so a viewer can copy. It stands down while the focus is in a text field, such as the chart panel's title, which copies its own text; a selected image's copy does the same.

⌘V works with a chart or an image focused, since the paste gate takes a focused object of this workbook as well as the cell input. A pasted chart lands on the selected cell at its copied size, selected. The workbook keeps the chart it last copied beside the inline copy it wrote (`copiedChart` on the global cache), so a paste of that same item here stores the chart's own spec and the duplicate stays linked to its cells, as Google's does. Anywhere else, another workbook or another tab of this one, it stores the inline copy. `packages/sheet/src/test/components/Workbook/chart-clipboard.test.tsx` pins each case.

## A selected chart's panel is a canvas chart's, and a typed edit is one undo step

Selecting a chart shows one panel, in the order Vector and Slides show a chart's: Transform, the shared chart and look sections (`ChartSections`, [CHARTS.md](CHARTS.md#one-chart-editor-edits-a-spec-and-the-host-writes-it)), then Arrange. There is no Edit chart step, so a chart's rows are one click away in every app. Google's Setup, the data range and its three boxes (`ChartPanelSections`), sits at the end of the Chart section, where an inline chart has Edit data, because the range is how a sheet chart edits its data. The Workbook reports the selected chart through `onChartPanelChange`, as it reports the selected object through `onActiveObjectChange`, and the app mounts `ChartPanelSections` inside the object's panel. A viewer gets the Transform read-out only. Both states are memoized: the app passes a fresh `hooks` object on every render, which re-fires the reporting effect, and a fresh state each time would re-render the app without end. The panel writes through the Workbook API: `setChartSpec`, `setChartLook` for the paint rows, and `setChartDataRange` for a typed range, which needs the cells to set the block up.

The shared editor writes a typed title on every keystroke inside a gesture ([CHARTS.md](CHARTS.md#one-chart-editor-edits-a-spec-and-the-host-writes-it)). The Workbook's `beginGesture` opens `undoGesture`, and `setContextWithProduce` merges every write made under it into the last undo entry, so one ⌘Z takes the whole title back while peers still see it as it is typed. A write that replaces the field the entry's last write replaced overwrites that patch and adds no inverse, so the entry holds the first old spec and the latest new one, not one spec per keystroke.

## A tick box is a validation rule, and the value is its state

Tick boxes, list chevrons and the three corner marks are canvas paint, not DOM. Their model and geometry live in `state/modules/data-verification.ts` and `cell-glyph.ts`, the paint in `state/render/cells.ts`.

`Insert → Tick box` and the cell context menu both call `insertCheckbox`, which writes a `checkbox` rule with the values `TRUE` and `FALSE`. That is Google's model: a tick box is data validation, not a cell format. The context-menu entry exists because the common intent is converting an existing TRUE/FALSE column.

There is no checked flag on the rule. `isCheckboxChecked` compares the cell's display value with the rule's checked value, ignoring case. So an imported, pasted, typed or formula-produced `TRUE` renders ticked. Applying a rule seeds the unchecked value into empty cells only, so a tick box over an existing column loses nothing. A formula cell is a read-only tick, because a toggle would replace the formula with a literal. The rule dialog (`confirmMessage`) refuses a tick box with either value empty, and a list with no options, so the editor never writes a rule the painter can't draw.

A default rule draws the box alone, the way Google does. A rule with custom values also draws its label, the only way to tell "Yes" from "No". So does a cell holding a value the rule names neither of (`showsCheckboxLabel`), so a tick box laid over a column of prose never paints the data away. Empty cells in the range draw the plain unchecked box, so the range reads as one column.

A header click is clipped to the used extent, as for borders (`clipToUsedExtent` in `state/utils/index.ts`). A dragged range applies exactly as selected, which is how a checklist over empty rows gets its boxes.

## A list chevron is painted on every cell its rule covers

A `dropdown` rule paints a chevron on every cell it covers, empty ones included (`renderDropdownChevron`, called from `cellRender` and `nullCellRender`). Most list-validated cells are empty, and without the chevron a blank validated cell looks like a free-text one. Keyboard users and read-only viewers see it too.

It overlays the cell text rather than reserving width, because reserving would reflow every validated column. Its color is the cell's own `fc` at 55% alpha, since real workbooks put list rules on dark fills that a fixed gray would vanish into.

Clicking the chevron opens the list, and a click anywhere else in the cell selects. A viewer sees the chevron but gets no list. The `#sheet-dataVerification-dropdown-btn` element is only an invisible anchor for the portaled menu.

## Text spills into empty neighbours

A text cell overflows into the cells beside it as in Google Sheets and Excel: by default, unless its wrapping is Clip (`tb: '0'`) or Wrap (`tb: '2'`). No `tb` means overflow, so imported and typed cells spill without a setting. Left-aligned text spills right, right-aligned left, centred both ways. It runs over any neighbour without a value, whatever that neighbour's style, and stops at the first one with a value, a space or a formula included, or at a merge. Numbers, tick-box cells and text that fits never spill (`rowOverflowSpans` in `state/render/overflow.ts`, recomputed for the visible rows on every draw).

A source scrolled off-screen still spills into view. Past each edge of the view only the first cell with a value can reach in, since it blocks everything behind it, so each row walks out at most `OVERFLOW_REACH_COLUMNS` (256) empty columns per side to find it. Text from a source further away clips at the edge of the view. The HTML, PDF and preview render doesn't overflow at all: every cell clips ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## Painter and hit test read one rect

Each glyph has one geometry function that both the painter and the mousedown hit test call: `checkboxRect`, `dropdownChevronRect` and `cellIndicatorRect`. It is the same split as the filter button's `FILTER_BUTTON_WIDTH`/`HEIGHT`, and it means a glyph and its click target cannot drift apart. The tick box gets its bounds from `cellTextBox` on both sides. Only the box toggles; Space or Enter toggles the focused cell. The chevron's click strip is wider than the glyph but built from the same rect, and both drop out below a minimum column width.

## Nothing toggles while a cell edit is open

Clicking a tick box while composing `=IF(` inserts the cell's reference and nothing else. A toggle would write the cell and kick a recalc behind the half-typed formula. The chevron is gated the same way, since its list would open over the formula, and so is the keyboard path (`state/events/mouse-cell.ts`, `keyboard.ts`).

## Three corner marks share one painter

A comment (top-right), an invalid value and a forced string (top-left) are all drawn by `drawCellIndicator` at `cellIndicatorRect`. The size is `CELL_INDICATOR_SIZE` in `packages/lib/src/constants/comment-indicator.ts`, which the canvas apps' `CommentIndicator` reads too, so a comment mark looks the same in every app. Filled and empty cells reach the same painter. A comment triangle takes its card's color, and red when the card has none.

The grid's colors are light-only CSS variables in ui's `globals.css`, read by the canvas and by the chart Edit data grid; the canvas's other colors are hardcoded light, because the grid is paper and doesn't re-theme ([RENDERING.md](../packages/sheet/RENDERING.md#theming-the-light-pinned-surface)).

## A glyph outranks the selection handles

The selection carries two invisible DOM hit targets over the canvas: the move band on its border and the fill handle at its corner. Without a precedence rule, a press on a chevron at the fill corner starts a fill drag. `cellGlyphAt` (`state/modules/cell-glyph.ts`) says which glyph sits under a point, from the painter's rects. Both handles ask it first, and on a hit they start no drag, so the press reaches the cell area, which opens the list, toggles the box or selects. `packages/sheet/src/test/state/events/mouse-cell.test.ts` pins the chevron at the fill corner and a mark under the band.

The hover path writes the same answer to `context.cellGlyphHover`, which shows a pointer over a chevron or tick box and stands the handles' own cursors down. Row and column resize never compete, because those handles live in the headers.

## The validation card follows the focus cell

One React card, `components/DataVerification/HintCard.tsx`, shows a validated cell's prompt or, when its value fails the rule, why. `getValidationHint` derives it from the focus cell on every render. So it follows keyboard navigation, never strands over the previous cell, and renders a collaborator's or an xlsx file's prompt as text, never as markup.

A rejection outranks a prompt, since it is the more urgent message. The card stands down while the list is open, because both hang over the same corner. The copy is assembled by `describeValidationRule`, which also words the `prohibitInput` dialog, so both ways a rejected value is reported say the same thing.

## Comments are Eigen comment cards

A cell anchors comments through `commentCardIds` on the `Cell`. The context menu, the panel and the card dialogs are the shared components from [COMMENTS.md](COMMENTS.md). Only adding and deleting a cell's anchor stay sheet-specific hooks.

On mobile the comments pane takes the whole width, so `editor.tsx` hides the workbook instead of unmounting it. `Sheet` keeps a `ResizeObserver` on its container and skips 0×0 boxes, so the canvas re-measures when the workbook shows again. App code may rely on that.

## The full export styles cells by class

The server renders a workbook to HTML, PDF and xlsx in `apps/api/src/lib/export/sheets/`, from the `Sheet[]` that `readSheetsFromDoc` returns. The transform, the route and the xlsx writer are in [EXPORT.md](EXPORT.md#a-sheet-export-recalcs-and-xlsx-carries-cells-and-charts).

`renderSheetsHtml` interns every style it emits (cell, row height, column width, data bar, rotation, image) into a workbook-global registry of classes and returns `{ html, css }`. The document builders put the rules in a body `<style>` element, which goes through `sanitizeExportHtml` with the markup.

A real workbook repeats a few hundred styles across hundreds of thousands of cells. DOMPurify on jsdom CSS-parses every inline `style` attribute it sanitizes, but passes class attributes and style-element text through as strings. With inline styles a real workbook's export was 82 MB and took 104 s, mostly CSS parsing.

The preview (`renderSheetsPreviewHtml`) keeps inline styles, because its body fragment embeds without a `<head>` ([PREVIEWS.md](PREVIEWS.md)). Its bytes are golden-pinned in `apps/api/src/test/preview/sheets-preview.test.ts`.

The table sets an unsized cell's font size to `SHEET_DEFAULT_FONT_SIZE` pt, the grid's own default, so a cell without a size prints at the size the grid draws it.

## The stylesheet is guarded in two places

Cell values are schemaless CRDT strings, and stylesheet text is a different escaping context from a style attribute. Two guards keep it inert, each where every field passes through rather than per field:

- `serializeStyleRules` strips what is structural in CSS text from every declaration. `<` and `>` would end the `<style>` element, and DOMPurify keeps what follows, so an `<svg><image href>` becomes a fetch in the HTML download. `{` and `}` open rule blocks. `\` starts a CSS escape, which spells `url(` or `@import` invisibly to the sanitizer. `/*` opens a comment that would swallow every later rule, so one odd cell would unstyle the rest of the workbook.
- Numeric fields are coerced, not escaped. Row heights and column widths go through the `Number()` guard in `sheetColumnsWidth` and `sheetRowsHeight`, and an image's or chart's box through `sheetFloatingBox`, which `getSheetContentSize` reads for the `@page` rule too.

Colors are checked, not escaped. A cell's `fc` and `bg`, a rule's colors, a border's and a data bar's reach the CSS, in the export and the preview alike, only as a hex, `rgb()` or transparent value `document/colors.ts` reads, or as a bare keyword such as `red`, which can't add a declaration. Any other string, such as `red;position:fixed;inset:0`, would add declarations of its own and fetch nothing, so the sanitizer would let it through. `cssColor` (`export/sheets/render.ts`) drops it, and a border or a bar draws transparent.

Other values are still `escapeHtml`'d on the way in, except the font family: entity encoding would corrupt a real name like `Bell MT & Co`, so its quotes and backslashes are dropped instead. The sanitizer's data-URI rule and `@import` strip cover style-element text too ([EXPORT.md](EXPORT.md#the-sanitizer-keeps-only-data-references-because-a-browser-fetches)).

## The export paints conditional formats with the grid's evaluator

`render.ts` calls `evaluateConditionalFormat` per sheet and merges its colors into each cell's style, so an export shows what the canvas shows. For formula rules it builds one `FormulaEngine` and one `createArrayResolver` over all loaded sheets, so a cross-sheet rule like `=Sheet2!A1>10` resolves. The pass reads `cell.v` and never recomputes the sheet's own formulas. Those values are already fresh, because `readSheetsFromDoc` ran the [gated recalc](#the-editor-computes-on-write-the-server-only-what-nobody-computed).

A data bar is an absolutely positioned `<div>` inside a `position:relative` cell, with geometry mirrored from the canvas painter. Negative bars are red, as on the canvas.

## Floating images and charts are an overlay on the table

A sheet with images or charts wraps its table in a `position:relative` box, and `renderFloatingObjects` (`export/sheets/render.ts`) draws them over it in their one paint order: each at its clamped box, rotated about its center. That is the box and the order the editor lays out, because both read the same fields.

The stored coordinates are grid pixels from A1, while the table starts at the used range. So the overlay subtracts the rows and columns above and left of that window. An object above or left of the used range pulls the window back to where it starts, so the offset never goes negative and the page covers it. The page size, the window's origin and the preview's clip all count the box an object covers as it turns (`getElementBounds`), so a rotated object stays on the page. One that turns past A1 tucks under the editor's headers, but a page has none, so the export moves it right or down until it starts on the page. The overlay's box reaches the farthest one, so the next sheet and the preview's truncated notice start below them, and the preview clips the box to its budget window. `apps/api/src/test/export/sheets-pdf.test.ts` reads a rotated chart off WeasyPrint's pixels; it skips where WeasyPrint or a rasterizer is missing, as on CI.

An image's name is a media reference ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)), looked up in a map the transform prepared: `data:` URIs for an export, preview URLs for a preview. A name that resolves to nothing renders nothing. The xlsx export writes charts as chart parts ([CHARTS.md](CHARTS.md#a-chart-goes-to-office-as-a-cchartspace-that-reads-back-as-the-same-spec)) and drops images, an open [ROADMAP](ROADMAP.md) row.

## Charts draw in the overlay as inline SVG

A chart is `renderSheetChartSvg`, the editor's own drawing, in a white box, so the gridlines stop at it as they do on screen. Its ranges read through the render's resolver over every loaded sheet, so a chart on one tab can chart another. The export reads them after the gated recalc and the preview from the stored values. The SVG is plain shapes and text, which the sanitizer keeps and WeasyPrint draws ([CHARTS.md](CHARTS.md#the-painter-draws-each-shape-with-its-own-kind-and-the-labels-as-svg-text)).

## An imported tab arrives as an addSheet op, renamed as Duplicate names a copy

File › Import… can add an xlsx's sheets as new tabs ([EXPORT.md § A replace saves a version first](EXPORT.md#a-replace-saves-a-version-first)). `appendSheetsToYjs` (`apps/api/src/lib/document/sheets.ts`) pushes them as one batch of `addSheet` ops after the workbook's own, never as a new snapshot. An open tab applies the batch as it applies a peer's new tab, so it keeps its view and its unflushed ops, where a snapshot write would remount every tab and clear them ([§ An edit is an op in a Y.Array](#an-edit-is-an-op-in-a-yarray)).

Every imported sheet takes a fresh id: the importer numbers its sheets `sheet-0` and on, which a workbook's own ids can match. A sheet whose name the workbook holds is renamed by `copySheetName` (`engine/sheet-name.ts`), the rule the tab menu's Duplicate uses, so `Data` comes in as `Data(Copy)`. The names are compared exactly, as a rename in the tab bar compares them. What the file says about its own sheets follows the new names and ids, so its formulas still read the cells they read in Excel:

| Reference | Names a sheet by | Rewritten through |
|---|---|---|
| A formula, a formula conditional format, a list validation's source, a `cellrange` link | Name, `'Data(Copy)'!A1` | `renameSheetRefs` (`engine/formula-shift.ts`) |
| A `sheet` link | Name | The rename map |
| A chart's series and categories | Id ([§ A chart is a floating record](#a-chart-is-a-floating-record-whose-refs-name-sheets-by-id)) | `mapChartRefs` |
| A link cell's `hl` and the calc chain | Id | The new id |

Defined names need nothing: the reader drops them ([SHEETS-TODO.md](SHEETS-TODO.md)). A range written with its sheet on both ends (`'Data'!A1:'Data'!B2`) gets the new name on its first end only, as the formula walker hands the second end's prefix back untouched; Excel writes a range's sheet once.

## Some xlsx round-trip drifts are decisions

These are deliberate. Where a test pins one, it is in `apps/api/src/test/export/sheets-export.test.ts`. Hyperlinks:

- A `sheet` link re-imports as a `cellrange` link at `'Name'!A1`, because the location names a cell. A `sheet` link to a name no sheet holds is a defined name's, as the import reads a location without a cell, and keeps its location. A bare ref gains its own sheet's quoted prefix.
- Imported link cells keep Excel's font, while the link dialog sets blue and underline. Forcing the dialog style at import would clobber theme-styled link cells.

Column widths and row heights:

- A width counts the file's default font's widest digit ([TYPOGRAPHY.md](TYPOGRAPHY.md#the-xlsx-export-makes-inter-the-workbooks-default-font)), so a column imports at the pixels Excel for Windows draws it at: a Calibri 11 column stored as 9.140625 is 64 px. `maxDigitWidth` (`apps/api/src/lib/document/spreadsheetml.ts`) holds Excel's digit for the Office defaults by face and size, because Excel draws GDI's hinted digit, not the outline's: Calibri 11 and Arial 10 are 7 px, Arial 11 and Cambria 11 are 8. A face it doesn't list counts 7. `columnWidthToPx` and `pxToColumnWidth` are ECMA-376's conversion both ways. The writer truncates to a 256th of a digit and the reader rounds half a 256th up, so every pixel width survives the round trip.
- An unsized column takes the sheet's default width, read by the same digit. `sheetFormatPr`'s `defaultColWidth` counts its padding already. Without it Excel pads `baseColWidth` (8 when absent) by 5 px and rounds up to a multiple of 8 px, so Excel's default is 64 px. The default row height is points to pixels, and Excel's 15 pt when the file names none.

Rules and comments:

- `duplicateValue` exports as a COUNTIF formula and re-imports as a `formula` rule, which renders the same. `occurrenceDate` is editor-only and is not exported.
- `encodeCfOperand` quotes exotic numeric literals (`1e5`, `+5`) as text. The engine compares with `Number()`, so rendering is unaffected.
- The data-validation exporter always writes `allowBlank: true`, Excel's UI default.
- Tick boxes are editor-only. The cells export their values and the rule is dropped: OOXML has no cell tick box, and a `"TRUE,FALSE"` list would re-import as a dropdown, a different feature.
- Excel comments and notes are not imported, because Eigen has its own comment cards.

## See also

- [EXPORT.md](EXPORT.md): the export pipeline, the sanitizer and the xlsx importer ([an imported sheet is stored as computed](EXPORT.md#an-imported-sheet-is-stored-as-computed))
- [PREVIEWS.md](PREVIEWS.md): the sheets preview
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): `readSheetsFromDoc` and the other readers
- [COLLAB.md](COLLAB.md): the socket and the loading gate
- [COMMENTS.md](COMMENTS.md): the comment cards behind the corner triangle
- [RENDERING.md](../packages/sheet/RENDERING.md): the canvas and DOM overlay layers
- [SHEETS-TODO.md](SHEETS-TODO.md) and [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md): open work and the op-log future
