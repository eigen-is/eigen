# Sheets

> **TLDR:** Sheets is Eigen's spreadsheet: a workbook of tabs that several people edit at once, with formulas, number formats, validation and xlsx import and export. The grid, its state and the formula engine are `packages/sheet` (`@workspace/sheet`), our own fork of the open-source fortune-sheet, itself based on luckysheet. `apps/sheets/` is the app around it. A workbook is stored as a snapshot plus a log of edits.

A workbook is a `.eigensheets` file. It holds one or more sheets, the tabs. A sheet is a grid of cells. A cell holds its value (`v`), the string the grid shows (`m`), its formula (`f`), its number format and its style. What belongs to a grid position rather than to the cell, such as borders, merges, row heights, validation rules and hyperlinks, sits in maps beside the grid, keyed `"r_c"` (row and column, counted from 0). The maps under a sheet's `config` (merges, borders, row and column sizes, hidden rows and columns) are its config collections. Conditional-format rules and floating images hang off the sheet too.

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

`normalizeSheetConfig` (`engine/sheet-config.ts`) therefore materializes every config collection where a sheet enters a consumer: `initSheetData`, the replay base, `addSheet` ops, `createDefaultSheets` and the Workbook's seeding effect. Its `SHEET_CONFIG_COLLECTIONS` list has an exhaustiveness assert, so a new collection fails the build instead of reopening the hole. `withNormalizedSheet` does the same for `calcChain` and `images`, which live outside `config`: the first formula a user types emits `add ['calcChain', 0]` in the same batch as the cell.

There is no `ctx.config` shortcut. Read a sheet's config with `getSheetConfig` (`state/context.ts`) and write through `ctx.sheets[i].config`. immer names a patch after the path its draft was reached through, so a second route to the config emits patches at a root `filterPatch` drops, and assigning it back replaces the whole config. `packages/sheet/src/test/state/events/concurrent-config.test.ts` pins it through the real op pipeline: one client merges cells, another drags a row taller, and the drag must not undo the merge.

`filterPatch` and `sheetMetadataOps` (`state/utils/patch.ts`) decide what goes on the wire, and both read one list of per-client `Sheet` fields, `PER_CLIENT_SHEET_FIELDS`. With two lists, a row insert would broadcast state the op path drops.

A write on a path that then rejects the operation still ships an op and costs the user an undo entry. `packages/sheet/src/test/state/rejected-writes.test.ts` is the table-driven gate; add a row to it when you add a writer.

## `borderInfo` holds each cell's own sides

`config.borderInfo` maps an `"r_c"` key to that cell's sides. `applyBorder` (`state/modules/border.ts`) expands a toolbar layout per cell at write time. `border-none` deletes the key and clears the facing side of each outside neighbor, so the shared edges go blank. Paste, move, fill and the format painter carry borders through `carrySides`, which deletes the destination's key when the source cell has no border, the Excel and Google overwrite rule. Order carries nothing, so two clients bordering different cells converge (`packages/sheet/src/test/state/modules/border-convergence.test.ts`).

A border belongs to the cell it was drawn on. The painter draws each cell's own sides at coordinates that coincide with the neighbor's, so the pixels match without a mirror. A shared edge never creates the neighbor's key, because that would be the whole-object `add` of [§ Creating a collection ships it whole](#creating-a-collection-ships-it-whole-so-every-collection-exists). A neighbor entry that already exists gets its facing side overridden, so the edge just drawn wins on screen. One result a user can see: copying B1 alone does not pick up A1's right edge. When two neighbors disagree on a shared edge, as after many xlsx imports, the higher-index one wins (B1's left over A1's right), so the color can't flip with the viewport's walk order.

A header click selects a whole axis, so it is clipped to the used extent first (`clipToUsedExtent`); one click must not write a key for every row. Cells filled in later rows show no border, an accepted divergence from Excel and Google. Merges are a read-time filter. `mergeEdgeSides` (`packages/lib/src/sheets/borders.ts`) is the one predicate. The canvas calls it per cell, and the xlsx and HTML exports fold a merge's cells onto its top-left cell through `mergedBorderSides`, because ExcelJS shares one style across a merge and the HTML has one `<td>`. When several cells of a merge write the same outer edge, the last one folded wins. Storage stays raw, so an unmerge shows the sides again.

Only the canvas border pass skips hidden rows and columns. Every carry path (cut, move, fill, the format painter, copy as HTML) reads the merge-filtered sides through `getBorderInfoCompute`, which keeps them, so a drag-fill from a hidden source keeps its border. A row or column insert clones the borders of the row or column at the insert index onto the new ones, as validation rules do (`shiftCellKeyedForInsert` in `engine/rowcol.ts`). So inserting above the top row of a bordered block repeats that row's top edge.

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

`encodeSheetsSnapshot` and `decodeSheetsSnapshot` (`packages/lib/src/sheets/snapshot-codec.ts`) are the only way in or out of `state.snapshot`. A real 340k-cell workbook was 56 MB as plain JSON, because 224 style combinations and about 110 border payloads repeated per cell. The v2 envelope interns both into workbook-global dictionaries and is about 4.5 times smaller. The codec runs only where the snapshot is serialized: the in-memory `Sheet[]`, the ops and the replay don't know it exists.

- The dense `data` matrix folds into the cell list at encode and is never stored. `selections`, a per-client cursor, is stripped.
- `calcChain` is never stored. The envelope's `computed` flag tells the decoder to seed it, which is the signal the server's recalc gate reads ([§ The editor computes on write](#the-editor-computes-on-write-the-server-only-what-nobody-computed)).
- `images` ride verbatim, since there is nothing to intern.

The editor flushes a snapshot and clears the op log on unmount, and on `beforeunload` only while connected. A flush with no pending ops is skipped, because every edit is an op and rewriting the snapshot would send the whole workbook to every peer on each close. A tab closed offline flushes nothing, so the log grows until a connected tab flushes ([SHEETS-TODO.md](SHEETS-TODO.md#bugs)).

## An undecodable snapshot locks the editor and never overwrites

Anything that is not a v2 envelope throws, and so does a dictionary index past its table. How `use-sheet.ts` reacts depends on when. On the initial load it opens read-only on blank defaults, and the `loadedRef` gate keeps it from ever flushing them over the stored snapshot or sending an op built on them. On a peer's flush it can't read mid-session, it keeps the workbook already on screen and arms the same lock, because local state may now diverge from the wire. Either way a persistent banner in `editor.tsx` says so, because a blank read-only sheet with no lasting explanation looks like data loss.

Version history keeps snapshots in older encodings. Restoring one hands every connected client an undecodable snapshot, which trips the same lock, so that restore does not take.

## Undo is per tab and blind to peers

Undo is the engine's own stack of inverse immer patches (`handleUndo`/`handleRedo` in `components/Workbook/index.tsx`). An undo is broadcast as an ordinary op batch, so peers see an edit. A peer's batch applies with `noHistory` and is never undoable locally.

The stack's paths are absolute and nothing corrects them for a peer's changes. So an undo after a peer's row insert lands one row off, and one after a peer's sheet deletion can land on the wrong sheet. Undoing your own row insert applies the whole-sheet inverse locally but ships a `deleteRowCol` marker, so a peer's later edits on that sheet vanish on your side only. All three are open in [SHEETS-TODO.md](SHEETS-TODO.md). Whether to move to Yjs structures and `Y.UndoManager` is answered in [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md): only with stable row and column ids, and not first.

## Every sheet switch goes through `changeSheet`

Tab clicks, the sheet list, search, hyperlinks, the API and the current sheet going away all call `changeSheet` (`state/modules/sheet.ts`). When the current sheet is hidden or deleted, locally, by a peer or by an undo, `leaveCurrentSheet` lands on the first visible sheet in tab order, with `force` skipping the `beforeActivateSheet` veto. A hidden target is refused, and so is hiding your last visible sheet.

A switch closes the cell editor and any formula range selection, so Enter can never commit into a sheet a peer switched you to. It also derives everything the grid paints (`applySheetView`) inside the same recipe. The first frame after the commit paints before any effect runs, so anything left to an effect would draw the new sheet on the old sheet's geometry for one frame.

## The engine is the half the server imports

`packages/sheet/src/engine/` holds the parser and evaluator, the dependency graph, recalc, row and column shifts, the op replay and the conditional-format evaluator. The editor and the server run the same code. `engine/` imports nothing from `state/` and nothing from the DOM. It evaluates through a `CellResolver`: the editor's resolver reads the workbook context, the server's (`createArrayResolver`) reads a replayed `Sheet[]`. Orchestration that needs the context, such as `execFunctionGroup` and `groupValuesRefresh`, lives in `state/modules/formula-exec.ts`.

`apps/api` imports only the `@workspace/sheet/engine` subpath. The `./engine` entry in `packages/sheet/package.json` points at the TypeScript source, not a build, so the API's own type check covers the engine under its stricter options: no DOM lib, `verbatimModuleSyntax`, `noUnusedParameters`. A DOM or state import in the engine fails the API build.

The functions come from `@formulajs/formulajs`, behind a parser inherited from the fortune-sheet fork. A function this build lacks (XLOOKUP, TEXTJOIN, LET, FILTER) evaluates to `#NAME?`. The engine overrides `VALUE`, which rejects a number, and `TEXT`, which formulajs leaves unimplemented, so it formats through the same numfmt masks the grid renders with.

## Values follow Excel's grid and calendar

- A Date result (`DATE`, `EOMONTH`, `NOW`) is stored as its Excel serial, taken from the Date's local calendar fields, because formulajs builds its Dates at local midnight. `dateToSerial` in `engine/parser/helper/number.ts` is the engine's conversion, with the Lotus leap day from 1900-03-01. The cell keeps its format mask, so a mask-less cell shows the serial.
- Every range is clamped to the sheet grid, because an unclamped `A1:XFD1048576`, a shape real xlsx files carry, is 17 billion cells. So `ROWS(A1:A100)` on a two-row grid is 2 (`packages/sheet/src/test/engine/formula-engine.test.ts`), a range past the grid is empty, and an `INDEX` past the grid is `#REF!`.
- formulajs parses an ISO date string as UTC (`DATEVALUE("2026-01-05")`), so the result is off by the zone offset outside UTC. `DATE(...)` is built in local time and is right everywhere. The fix is open in [SHEETS-TODO.md](SHEETS-TODO.md#formula-engine).

The dependency graph has two limits:

- A reference cycle never errors: the visited set in `getCalculationOrder` breaks the walk, and the cycle's cells evaluate in visit order.
- `INDEX` produces references the dependency graph can't see statically. `isFunctionRange` special-cases it, together with `INDIRECT` and `OFFSET`; keep that logic when you touch the graph. formulajs 2.9.3 has no `INDIRECT` or `OFFSET`, so today both evaluate to `#NAME?`.

## The editor computes on write, the server only what nobody computed

The editor's dependent recompute runs inside the recipe that emits the op, so recomputed `v` and `m` persist as ordinary ops. A doc edited in a browser is already fresh when the server reads it.

So `readSheetsFromDoc` recomputes only on the export read. Preview and the search extract pass `{ recalc: false }` and serve the replayed values, and a formula cell with no value stays blank. A legacy never-computed workbook costs an unbounded recalc (about 39 s measured), past the 30 s Worker deadline of a preview, so every preview of such a doc would fail. An export recomputes under its 120 s deadline, because a deliverable with blank formula cells is wrong output.

Even on export, `recalcSheets` runs only when `sheetsNeedRecalc` finds a sheet with formula cells and an empty `calcChain`. The decoder leaves the chain empty unless the envelope says `computed: true`, which every editor flush writes ([the codec](#the-snapshot-is-interned-and-written-only-through-the-codec)). The xlsx importer runs `recalcSheets` once in its Worker and writes `computed: true`, or `false` when its recalc failed, so that export recomputes. Any recalc failure falls back to the replayed values: an export never fails because recalc did.

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

## Conditional formats evaluate headless

`evaluateConditionalFormat(rules, data, options?)` (`engine/conditional-format.ts`) returns the `"r_c"`-keyed style map the canvas paints, and the HTML export calls it too ([§ The export paints conditional formats with the grid's evaluator](#the-export-paints-conditional-formats-with-the-grids-evaluator)). Without an evaluator, formula rules are skipped. Both callers pass the same one, `createCfFormulaEvaluator`.

Every rule scans only the materialized matrix, because Excel writes a whole-column rule as `A1:A1048576`. Overlapping rules layer per style property in rule order, so a later rule's fill never erases an earlier rule's text color. `textContains` ignores case and `duplicateValue` skips blank cells, both as in Excel.

## A formula rule is anchored at its first range's corner

That is Excel's anchor: every cell of every range evaluates the formula at its offset from the top-left of the first range. `createCfFormulaEvaluator` compiles each formula once and evaluates it at that offset. It shares `offsetCoordinate` and `offsetRange` with `functionCopy`, the text shifter paste and autofill use, so shifted text and a compiled offset read the same cells. The xlsx importer keeps a rule with all its ranges, and the exporter writes one multi-range `sqref`.

Every rewrite of a rule's ranges (cut, copy, paste format, drag-move, row or column delete, the preview's clip) goes through `withCfRanges`. When the first range starts somewhere new, it re-expresses the formula from the new corner, so every cell keeps the relative formula it had. Autofill only appends a range and an insert moves corner and references together, so neither re-anchors.

One edge stays. A formula that reads above or left of its corner (`=A4>0` on `A5:A10`) can't be re-expressed from a corner nearer the sheet edge than it reaches, because A1 text has no row 0. `functionCopy` writes `#REF!` and the rule stops matching.

## Row and column shifts rewrite every sheet's formulas

`applySheetsInsertRowCol` and `applySheetsDeleteRowCol` (`engine/rowcol.ts`) shift the cells, geometry, merges, borders and conditional-format rules of the changed sheet, and formula text in every sheet. Only references that resolve to the changed sheet move: unqualified ones on it, `Sheet!`-qualified ones anywhere. A reference wholly inside a deleted band becomes `#REF!`, and a whole-row or whole-column range keeps both legs. The functions are generic over the sheet type, so the editor's wider sheet flows through with its extras. `state/modules/rowcol.ts` then shifts the editor-only fields: filter, frozen panes, validation, hyperlinks, `calcChain`.

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

## Painter and hit test read one rect

Each glyph has one geometry function that both the painter and the mousedown hit test call: `checkboxRect`, `dropdownChevronRect` and `cellIndicatorRect`. It is the same split as the filter button's `FILTER_BUTTON_WIDTH`/`HEIGHT`, and it means a glyph and its click target cannot drift apart. The tick box gets its bounds from `cellTextBox` on both sides. Only the box toggles; Space or Enter toggles the focused cell. The chevron's click strip is wider than the glyph but built from the same rect, and both drop out below a minimum column width.

## Nothing toggles while a cell edit is open

Clicking a tick box while composing `=IF(` inserts the cell's reference and nothing else. A toggle would write the cell and kick a recalc behind the half-typed formula. The chevron is gated the same way, since its list would open over the formula, and so is the keyboard path (`state/events/mouse-cell.ts`, `keyboard.ts`).

## Three corner marks share one painter

A comment (top-right), an invalid value and a forced string (top-left) are all drawn by `drawCellIndicator` at `cellIndicatorRect`. The size is `CELL_INDICATOR_SIZE` in `packages/lib/src/constants/comment-indicator.ts`, which the canvas apps' `CommentIndicator` reads too, so a comment mark looks the same in every app. Filled and empty cells reach the same painter. A comment triangle takes its card's color, and red when the card has none.

Canvas colors are hardcoded light, because the grid is paper and doesn't re-theme ([RENDERING.md](../packages/sheet/RENDERING.md#theming-the-light-pinned-surface)).

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

The server renders a workbook to HTML, PDF and xlsx in `apps/api/src/lib/export/sheets/`, from the `Sheet[]` that `readSheetsFromDoc` returns. The Worker, the route and the xlsx writer are in [EXPORT.md](EXPORT.md#a-sheet-export-recalcs-and-xlsx-carries-cells-only).

`renderSheetsHtml` interns every style it emits (cell, row height, column width, data bar, rotation, image) into a workbook-global registry of classes and returns `{ html, css }`. The document builders put the rules in a body `<style>` element, which goes through `sanitizeExportHtml` with the markup.

A real workbook repeats a few hundred styles across hundreds of thousands of cells. DOMPurify on jsdom CSS-parses every inline `style` attribute it sanitizes, but passes class attributes and style-element text through as strings. With inline styles a real workbook's export was 82 MB and took 104 s, mostly CSS parsing.

The preview (`renderSheetsPreviewHtml`) keeps inline styles, because its body fragment embeds without a `<head>` ([PREVIEWS.md](PREVIEWS.md)). Its bytes are golden-pinned in `apps/api/src/test/preview/sheets-preview.test.ts`.

## The stylesheet is guarded in two places

Cell values are schemaless CRDT strings, and stylesheet text is a different escaping context from a style attribute. Two guards keep it inert, each where every field passes through rather than per field:

- `serializeStyleRules` strips what is structural in CSS text from every declaration. `<` and `>` would end the `<style>` element, and DOMPurify keeps what follows, so an `<svg><image href>` becomes a server-side fetch under WeasyPrint. `{` and `}` open rule blocks. `\` starts a CSS escape, which spells `url(` or `@import` invisibly to the sanitizer. `/*` opens a comment that would swallow every later rule, so one odd cell would unstyle the rest of the workbook.
- Numeric fields are coerced, not escaped. Row heights and column widths go through `cssLength`, the same `Number()` guard `getSheetContentSize` applies for the `@page` rule.

Values are still `escapeHtml`'d on the way in, except the font family: entity encoding would corrupt a real name like `Bell MT & Co`, so its quotes and backslashes are dropped instead. The sanitizer's data-URI rule and `@import` strip cover style-element text too ([EXPORT.md](EXPORT.md#the-sanitizer-keeps-only-data-references-because-weasyprint-fetches)).

## The export paints conditional formats with the grid's evaluator

`render.ts` calls `evaluateConditionalFormat` per sheet and merges its colors into each cell's style, so an export shows what the canvas shows. For formula rules it builds one `FormulaEngine` and one `createArrayResolver` over all loaded sheets, so a cross-sheet rule like `=Sheet2!A1>10` resolves. The pass reads `cell.v` and never recomputes the sheet's own formulas. Those values are already fresh, because `readSheetsFromDoc` ran the [gated recalc](#the-editor-computes-on-write-the-server-only-what-nobody-computed).

A data bar is an absolutely positioned `<div>` inside a `position:relative` cell, with geometry mirrored from the canvas painter. Negative bars are red, as on the canvas.

## Floating images are an overlay on the table

A sheet with images wraps its table in a `position:relative` box and emits one absolutely positioned `<img>` per image it can resolve, at the stored position and size, rotated about its center. That is the same box the editor's `ImgBoxs` lays out, because both read the same fields.

The stored coordinates are grid pixels from A1, while the table starts at the used range. So the overlay subtracts the rows and columns above and left of that window. An image above or left of the used range pulls the window back to where the image starts, so the offset never goes negative and the page covers the image.

An image's name is a media reference ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)), looked up in a map the transform prepared: `data:` URIs for an export, preview URLs for a preview. A name that resolves to nothing renders nothing. The xlsx export drops images, an open [ROADMAP](ROADMAP.md) row.

## Some xlsx round-trip drifts are decisions

These are deliberate. Where a test pins one, it is in `apps/api/src/test/export/sheets-export.test.ts`. Hyperlinks:

- A `sheet` link re-imports as a `cellrange` link at `'Name'!A1`, and a range link keeps only its top-left cell, because ExcelJS's internal-link pattern needs a single trailing cell ref. A bare ref gains its own sheet's quoted prefix. A webpage URL with exactly one `!` and a cell-shaped tail is misread as internal by that pattern.
- Imported link cells keep Excel's font, while the link dialog sets blue and underline. Forcing the dialog style at import would clobber theme-styled link cells.
- A link to another workbook that carries a sheet anchor imports as an internal link: the `location` attribute wins over the relationship target.

Rules and comments:

- `duplicateValue` exports as a COUNTIF formula and re-imports as a `formula` rule, which renders the same. `occurrenceDate` is editor-only and is not exported.
- `encodeCfOperand` quotes exotic numeric literals (`1e5`, `+5`) as text. The engine compares with `Number()`, so rendering is unaffected.
- The data-validation exporter always writes `allowBlank: true`, Excel's UI default.
- Tick boxes are editor-only. The cells export their values and the rule is dropped: OOXML has no cell tick box ExcelJS can write, and a `"TRUE,FALSE"` list would re-import as a dropdown, a different feature.
- Excel comments and notes are not imported, because Eigen has its own comment cards.

## See also

- [EXPORT.md](EXPORT.md): the export pipeline, the sanitizer and the xlsx importer ([an imported sheet is stored as computed](EXPORT.md#an-imported-sheet-is-stored-as-computed))
- [PREVIEWS.md](PREVIEWS.md): the sheets preview
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): `readSheetsFromDoc` and the other readers
- [COLLAB.md](COLLAB.md): the socket and the loading gate
- [COMMENTS.md](COMMENTS.md): the comment cards behind the corner triangle
- [RENDERING.md](../packages/sheet/RENDERING.md): the canvas and DOM overlay layers
- [SHEETS-TODO.md](SHEETS-TODO.md) and [PROPOSAL_SHEETS_YJS_WORKBOOK.md](proposals/PROPOSAL_SHEETS_YJS_WORKBOOK.md): open work and the op-log future
