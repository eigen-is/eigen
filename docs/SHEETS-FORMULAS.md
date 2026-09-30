# Sheets Formulas

> **TLDR:** `packages/sheet/src/engine/` is the DOM-free half of the sheet package: parser and evaluator, dependency graph, recalc, row and column shifts, the op replay and the conditional-format evaluator. The editor and the server run the same code. Not obvious from the code: the editor computes values on write and ships them as ops, so the server recalculates only a workbook nobody computed; recalc never trades a good cached value for an engine error; and a conditional-format formula is anchored at its first range's corner. The workbook model: [SHEETS.md](SHEETS.md).

## The engine is the half the server imports

`engine/` imports nothing from `state/` and nothing from the DOM. It evaluates through a `CellResolver`: the editor's resolver reads the workbook context, the server's (`createArrayResolver`) reads a replayed `Sheet[]`. Orchestration that needs the context, such as `execFunctionGroup` and `groupValuesRefresh`, lives in `state/modules/formula-exec.ts`.

`apps/api` imports only the `@workspace/sheet/engine` subpath. The export map points at the sources, so the API's own type check covers the engine under its stricter options: no DOM lib, `verbatimModuleSyntax`, `noUnusedParameters`. A DOM or state import in the engine fails the API build.

The functions come from `@formulajs/formulajs`, behind a parser inherited from the fortune-sheet fork. A function this build lacks (XLOOKUP, TEXTJOIN, LET, FILTER) evaluates to `#NAME?`. The engine overrides `TEXT`, which formulajs leaves unimplemented, so it formats through the same numfmt masks the grid renders with.

## Values follow Excel's grid and calendar

- A Date result (`DATE`, `EOMONTH`, `NOW`) is stored as its Excel serial, taken from the Date's local calendar fields, because formulajs builds its Dates at local midnight. `dateToSerial` in `parser/helper/number.ts` is the engine's conversion, with the Lotus leap day from 1900-03-01. The cell keeps its format mask, so a mask-less cell shows the serial.
- Every range is clamped to the sheet grid, because an unclamped `A1:XFD1048576`, a shape real xlsx files carry, is 17 billion cells. So `ROWS(A1:A100)` on an 84-row grid is 84, a range past the grid is empty, and an `INDEX` past the grid is `#REF!`.
- formulajs parses an ISO date string as UTC (`DATEVALUE("2026-01-05")`), so the result is off by the zone offset outside UTC. `DATE(...)` is built in local time and is right everywhere. The fix is open in [SHEETS-TODO.md](SHEETS-TODO.md#formula-engine).

The dependency graph has two limits:

- A reference cycle never errors: the visited set in `getCalculationOrder` breaks the walk, and the cycle's cells evaluate in visit order.
- `INDIRECT`, `OFFSET` and `INDEX` produce references the dependency graph can't see statically. `isFunctionRange` special-cases them; keep that logic when you touch the graph.

## The editor computes on write, the server only what nobody computed

The editor's dependent recompute runs inside the recipe that emits the op, so recomputed `v` and `m` persist as ordinary ops. A doc edited in a browser is already fresh when the server reads it.

So `readSheetsFromDoc` recomputes only on the export read. Preview and the search extract pass `{ recalc: false }` and serve the replayed values, and a formula cell with no value stays blank. A legacy never-computed workbook costs an unbounded recalc (about 39 s measured), past the 30 s Worker deadline of a preview, so every preview of such a doc would fail. An export recomputes under its 120 s deadline, because a deliverable with blank formula cells is wrong output.

Even on export, `recalcSheets` runs only when `sheetsNeedRecalc` finds a sheet with formula cells and an empty `calcChain`. The snapshot never stores the chain. The decoder seeds it when the envelope says `computed: true`, which every editor flush writes ([SHEETS.md](SHEETS.md#the-snapshot-is-interned-and-written-only-through-the-codec)). The xlsx importer runs `recalcSheets` once in its Worker and writes `computed: true`, or `false` when its recalc failed, so that export recomputes. Any recalc failure falls back to the replayed values: an export never fails because recalc did.

## Recalc keeps what it can't improve

`recalcSheets` (`engine/recalc.ts`) materializes each sheet's `data`, finds formula cells by scanning it rather than trusting `calcChain`, orders them through the dependency graph and evaluates them with the shared `FormulaEngine`. Its graph builder is a port of the state layer's `setFormulaCellInfo` and `isFunctionRange`, because the engine can't import `state/` ([SHEETS-TODO.md](SHEETS-TODO.md#code-debt) tracks removing the copy).

Two rules keep a passive export honest:

- Volatiles (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`) keep their cached value, the way Excel reads a closed file, so an export is deterministic.
- An engine error never overwrites a cached value that is not an error. A function this build lacks would otherwise turn Excel's correct result into `#NAME?` at import. Downstream cells then read the cached value too.

Every cell is guarded, so one poisoned formula never aborts the pass.

## The editor builds its formula map when idle

At mount the Workbook materializes each sheet's `data` and `seedCalcChain` records the formula cells without evaluating them. Displayed values come straight from the stored workbook, and an edit recomputes only the affected sub-graph (`execFunctionGroup`), so recalc cost follows the edit, not the workbook.

The dependency map (`ctx.formulaCache.formulaCellInfoMap` and its reverse `dependencyIndex`) is built from an idle callback, so the first edit on a large workbook doesn't pay a multi-second rebuild. It is all or nothing: whichever comes first, the idle build, an edit or a paste, builds the whole map, from a plain `current()` snapshot, because reading every formula through an immer draft is slow.

Once built, the map is kept current cell by cell. Local writers register what they write through `setFormulaCellInfo`. Undo, redo and a peer's ops go through `updateFormulaCache`, which reads only `data` patches, because every formula change carries one. A structural patch or a row or column insert or delete sets the map to `null` for a lazy rebuild. The `calcChain` patch that rides along is ignored, because re-registering from it cost a whole sheet per edit. The known gaps are in [SHEETS-TODO.md](SHEETS-TODO.md#bugs).

## Number display strings go through `numberDisplay`

`numberDisplay(value, fa)` (`engine/format.ts`) turns a number into its `m`. Typed entry, paste, sort, autofill, the toolbar format change, the format painter, `setCellFormat`, recalc and the xlsx importer all call it. A mask renders the exact value. General is Excel's General at default width, so float noise hides (`0.1+0.2` shows `0.3`), long values cut to 11 characters and large or tiny values go scientific. A malformed format, which an xlsx file can carry, falls back to General. The input parser (`parseCellInput`) and autofill's date series still format on their own.

A typed number is stored as a number in `v`, unless the cell is text-formatted. Pasted plain text goes through the same `setCellValue` parse as typing. A formula's text result stays text (`=TEXT(5,"000")` is `"005"`). Copying a General number writes 15 significant digits (`copiedNumberText`), not the 11-character display, so a paste elsewhere keeps the precision.

## Conditional formats evaluate headless

`evaluateConditionalFormat(rules, data, options?)` (`engine/conditional-format.ts`) returns the `"r_c"`-keyed style map the canvas paints, and the server export calls it too ([SHEETS-EXPORT.md](SHEETS-EXPORT.md)). Formula rules need an evaluator, and both pass the same one, `createCfFormulaEvaluator`.

Every rule scans only the materialized matrix, because Excel writes a whole-column rule as `A1:A1048576`. Overlapping rules layer per style property in rule order, so a later rule's fill never erases an earlier rule's text color. `textContains` ignores case and `duplicateValue` skips blank cells, both as in Excel.

## A formula rule is anchored at its first range's corner

That is Excel's anchor: every cell of every range evaluates the formula at its offset from the top-left of the first range. `createCfFormulaEvaluator` compiles each formula once and evaluates it at that offset. It shares `offsetCoordinate` and `offsetRange` with `functionCopy`, the text shifter paste and autofill use, so shifted text and a compiled offset read the same cells. The xlsx importer keeps a rule with all its ranges, and the exporter writes one multi-range `sqref`.

Every rewrite of a rule's ranges (cut, copy, paste format, drag-move, row or column delete, the preview's clip) goes through `withCfRanges`. When the first range starts somewhere new, it re-expresses the formula from the new corner, so every cell keeps the relative formula it had. Autofill only appends a range and an insert moves corner and references together, so neither re-anchors.

One edge stays. A formula that reads above or left of its corner (`=A4>0` on `A5:A10`) can't be re-expressed from a corner nearer the sheet edge than it reaches, because A1 text has no row 0. `functionCopy` writes `#REF!` and the rule stops matching.

## Row and column shifts rewrite every sheet's formulas

`applySheetsInsertRowCol` and `applySheetsDeleteRowCol` (`engine/rowcol.ts`) shift the cells, geometry, merges, borders and conditional-format rules of the changed sheet, and formula text in every sheet. Only references that resolve to the changed sheet move: unqualified ones on it, `Sheet!`-qualified ones anywhere. A reference wholly inside a deleted band becomes `#REF!`, and a whole-row or whole-column range keeps both legs. The functions are generic over the sheet type, so the editor's wider sheet flows through with its extras. `state/modules/rowcol.ts` then shifts the editor-only fields: filter, frozen panes, validation, hyperlinks, `calcChain`.

## See also

- [SHEETS.md](SHEETS.md): the op log, the snapshot, the replay
- [SHEETS-EXPORT.md](SHEETS-EXPORT.md): conditional formats and recalc in the HTML export
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): `readSheetsFromDoc` and the other readers
- [SHEETS-TODO.md](SHEETS-TODO.md): open formula work
