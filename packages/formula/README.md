# @workspace/formula

`@workspace/formula` is a headless spreadsheet formula engine: it reads and prints formula text, stores a workbook's cells, evaluates formulas, recalculates what an edit reaches, rewrites formulas when rows, columns, blocks or sheets move, and shows numbers as Excel's number formats do. Its source, `src/`, has no React, no DOM and no Bun or Node API, imports no other workspace package, and has one npm dependency, numfmt, used only for number display. So it runs the same in a browser, on Bun and on Node. The bench and oracle scripts in `scripts/` run on Bun and Node and use their APIs. The oracle is `scripts/oracle.ts`, with its rows mode in `scripts/oracle-rows.ts`, and runs as one script (`bun scripts/oracle.ts --help`).

Excel is the reference: every function it computes is listed in [FUNCTIONS.md](FUNCTIONS.md) with how its answers compare to Excel's.

## Status

The engine is built and proven on its own: its tests, Excel's recorded answers and timing gates against today's engine. The product does not run it yet. Three parts are in use: number display through `@workspace/formula/format` (cells, charts, the xlsx importer and exporter), Excel's function inventory through `@workspace/formula/names`, and the row and column index maps of `@workspace/formula/text` (`mapIndex`, `mapSpan`, `GONE`), which today's sheet engine shifts its ranges with.

It computes 219 of Excel's 524 functions. Not built yet: spilled results and the dynamic-array functions (`FILTER`, `SORT`, `SEQUENCE` and their kin), evaluating `LET` and `LAMBDA`, defined names, tables as a live feature (a file's table references are read as the plain ranges they name), 3-D references such as `Sheet1:Sheet3!A1`, hidden rows, and iterative calculation of circular references.

## Entries

| Import | What it exports |
| --- | --- |
| `@workspace/formula` | `Engine`; the function registry `FUNCTIONS`; the error values `NULL`, `DIV0`, `VALUE`, `REF`, `NAME`, `NUM`, `NA`, `SPILL`, `CALC`, `ERROR` and `errorOf`; the types `SheetSource`, `CellSink`, `Literal`, `FormulaError`, `EditResult`, `RecalcResult`, `Rewrite`, `LineEdit`, `Move` |
| `@workspace/formula/text` | Formula text without an engine. Reading: `parseA1`, `parseA1Range`, `parseStored`, `parseXlsx`, `tokens`, `resolveTables`, `intersect`, `isLegacy`, `xlsxTree`. Printing: `printA1`, `printStored`, `printXlsx`, `storedKey`, `storedText`, `typedText`. Edits: `mapIndex`, `mapSpan`, `GONE`, `transformLines`, `hostClasses`, `transformMove`, `bindSheet`, `remapSheets`, `offGrid`, and the types `Edit`, `Span`, `LineEdit`, `Move`. Tables: the types `Table` and `TableFinder` that `resolveTables` takes. Labels and sheet names: `toA1`, `rangeToA1`, `columnIndex`, `columnLabel`, `GRID_ROWS`, `GRID_COLUMNS`, `quoteSheetName`, `sheetNameKey`, `sheetFinder`, `findSheetByName`. The tree: `FormulaNode`, `NodeKind`, `RefKind`, `RefFlag`, `SheetKind`, `Token`, `ERROR_LITERALS`. Limits: `MAX_STORED_LENGTH`, `MAX_NESTING`, `MAX_ARGUMENTS` |
| `@workspace/formula/format` | `numberDisplay`, `isDateFormat`, `numberFormatError` |
| `@workspace/formula/names` | `isExcelFunction`, `EXCEL_FUTURE_FUNCTIONS` |

The package is a workspace package and is not published. A workspace that needs it lists `"@workspace/formula": "workspace:*"` in its `package.json`.

## Using it

A host gives the engine its sheets, writes cells, runs a recalc and reads values back. A sheet is named by its id, and a cell by its row and column from 0. A formula is handed over in its stored text, which `@workspace/formula/text` makes from what a person types. This example ran with Bun, and the output under it is that run's:

```ts
import { Engine } from '@workspace/formula';
import { numberDisplay } from '@workspace/formula/format';
import { parseA1, parseStored, printA1, printStored } from '@workspace/formula/text';

// A sheet is an id, a name and a walk over its cells: row and column from 0, a value or a formula in stored text.
const find = (name: string) => (name === 'Sales' ? { id: 's1' } : undefined);
const stored = (typed: string, row: number, column: number) => {
    const tree = parseA1(typed, row, column, find);
    if ('reason' in tree) throw new Error(tree.reason);
    return printStored(tree);
};
const engine = new Engine([
    {
        id: 's1',
        name: 'Sales',
        cells: (cell) => {
            cell(0, 0, 120, null);
            cell(1, 0, 80, null);
            cell(2, 0, null, stored('=SUM(A1:A2)*1.21', 2, 0));
        },
    },
]);

engine.recalc(Number.POSITIVE_INFINITY);
console.log(engine.formulaOf('s1', 2, 0), engine.valueOf('s1', 2, 0));

engine.setValue('s1', 0, 0, 100);
engine.editLines({ insert: true, index: 0, count: 1, sheet: 's1', rows: true });
const { changed } = engine.recalc(Number.POSITIVE_INFINITY);
console.log(changed, engine.valueOf('s1', 3, 0));

const text = engine.formulaOf('s1', 3, 0) ?? '';
const tree = parseStored(text);
if (!('reason' in tree)) console.log(printA1(tree, 3, 0, () => 'Sales'));
const total = engine.valueOf('s1', 3, 0);
if (typeof total === 'number') console.log(numberDisplay(total, '#,##0.00'));
```

```text
=SUM(R[-2]C:R[-1]C)*1.21 242
[ 0, 0, 3, 3 ] 217.79999999999998
=SUM(A2:A3)*1.21
217.80
```

The stored text holds offsets from the formula's own cell, so inserting a row above moved the formula to row 3 without changing its text. `changed` lists the cells the pass changed as runs down a column: the sheet's place, the column, the first and the last row. The first argument of `recalc` caps how many formulas one pass computes; a later pass goes on where a capped one stopped. The clock and the random draw come in as its other two arguments, so a recalc never reads the machine.

## The design in ten lines

- A formula is stored as its shape: the canonical text with relative references as offsets and sheets by id. That text is the one key, so equal formulas are one shape, parsed once into an immutable tree (`text/shapes.ts`).
- A sheet's cells are typed column planes: parallel typed arrays of values and shape ids, and texts as ids into one string table per workbook (`store/`).
- One recursive evaluator walks a shape's tree with the formula's cell as an argument (`eval/evaluator.ts`).
- Recalc is on demand: reading a cell that is still to be computed computes it first, so the order and the loops come from the reads (`recalc/recalc.ts`).
- Arrays are always on: an operator or a scalar parameter given an array runs once per element, and an array stores one element for a run of equal ones, so a whole column costs its cells (`eval/lift.ts`, `values/value.ts`).
- The reverse index, which formulas read a cell, has entries per block of cells of one shape, not per cell, and is rebuilt whole when a formula comes or goes (`recalc/reverse-index.ts`).
- A structural edit is one transform of stored text, worked out once per stretch of hosts with one outcome, on top of `mapIndex` and `mapSpan`, the one rule for where an index goes (`edit/`).
- A function is one row: a name, a list of parameter words and a body. The call wrapper reads, coerces and checks every argument, so the body only computes (`functions/registry.ts`, `eval/call.ts`).
- Numbers compare and round on the 15 digits Excel holds, and text orders by the engine's own rule, so neither depends on the machine (`values/precision.ts`, `values/text-order.ts`). The trigonometric, logarithmic and hyperbolic functions use the runtime's `Math` and can differ in the last digit between runtimes.
- No clock, no locale, no module-level state: the time and the draw of a pass are arguments of `recalc`.

## Tests and type check

```bash
cd packages/formula
bun test --isolate ./src/test/<folder>/     # one folder: edit, eval, format, functions, recalc, store, text, values
bun run test                                # the whole package
bun run typecheck
```

Tests live in `src/test/`, one folder per source folder. `src/test/functions/functions-list.test.ts` fails when FUNCTIONS.md and the functions the engine computes disagree.

## Rules for contributors

- `src/` imports no workspace package, no React, DOM, Bun or Node API, and one npm package, numfmt, only in `src/format/`. A Biome rule refuses any other import. The scripts in `scripts/` may use Bun and Node.
- No module-level mutable state, no options object, no `Date`, `Intl`, `localeCompare` or `toLocale*`, no clock, no `eval`. It runs the same on Bun and Node.
- Performance is a goal: plain loops over typed arrays, a `switch` on an integer kind, no class per node kind, no callbacks into shared loops, no string-keyed stores.
- Tests come first and fail first, and pin behavior through the public path. A test that passes on its first run is proven by a deliberate mutation that makes it fail.
- Excel's recorded answer comes before a ruling on Excel's behavior. Where the engine answers differently on purpose, the case goes into FUNCTIONS.md with both answers. No code imitates an Excel limit or bug: the engine accepts more where the meaning is clear, and refuses only where one text would mean two things.

## Adding a function

- A function is one row in its family's file under `src/functions/`: `fn('NAME', [parameters], body)`. `functions/library.ts` gathers the families into the one list a call is looked up in.
- A parameter is a word from `functions/registry.ts`, and that file is the whole vocabulary. Scalar words say how one value is read: `NUMBER`, `INTEGER`, `SERIAL` for a date, `TEXT`, `BOOLEAN`, `ANY`, `LAZY` for an argument evaluated only when picked. Range words say what a body gets of a range: a family that counts every value (`NUMBERS`, `COUNTED`, `FILLED`, `TRUTHS`, `FACTORS`, `NUMBERS_A`, `MODES`), `TEXTS`, `PAIRS`, `TABLE`, `WHERE` and `MATCHED` for criteria, `REFERENCE`. Modifiers such as `optional`, `skippable`, `defaulted`, `rest`, `strict` and `addin` say how an argument may be left out, repeat or refuse a boolean.
- Before the body runs, the wrapper has checked the count, read every argument left to right, run the call once per element of an array, computed every cell of every range and found the first error. So a body never coerces, tests for an error or reads a cell: it returns a number, a text, a boolean, `null` for a blank, or an error constant for an input outside its domain.
- A NaN or an infinity becomes `#NUM!`, a negative zero 0, and a text past 32,767 characters `#VALUE!`, without the body's help.
- `NOW` and `RANDOM` hand a body the time and the draw of the pass. `ENGINE` hands it the few facts of the workbook no argument carries; its list is closed by a test (`src/test/functions/gates.test.ts`).
- A family file imports only the registry, the error values and the kernels of `src/values/` and `src/format/`; a Biome rule refuses `eval/`, `store/` and `recalc/`. A row that breaks a rule of its own, such as a required parameter after an optional one, throws when the module loads.
- First type the function in Excel with the inputs that tell the words apart: an empty argument, a boolean, a range, an error, an array. Its tests in `src/test/functions/` carry Excel's answers.
- Then add the name to FUNCTIONS.md with its status, or `functions-list.test.ts` fails.
- A function that needs a word the registry lacks is a design change: stop and ask before adding one.

## Where it differs from Excel

These choices are decided and apply to many functions. FUNCTIONS.md gives an example of each, with Excel's answer and ours, and the function-by-function differences.

- The day line: day 0 is 30 December 1899, there is no 29 February 1900, and dates run from the year 1 to 9999. Excel's dates in January and February 1900 are one day off from ours.
- An empty text in arithmetic is 0, where Excel answers `#VALUE!`.
- A formula whose result is blank leaves its cell blank, as in Google Sheets, where Excel shows 0.
- A date typed without a year is a number only to `DATEVALUE` and `TIMEVALUE`.
- Text length is counted in UTF-16 units, so an emoji is 2 characters.
- A one-cell array is a single value.
- No 255-character limit on texts that Excel refuses past 255.
- Approximate searches assume sorted data, as Excel's documentation requires.
- Volatile functions are computed when the document is, not after every unrelated edit.
- Number display is numfmt's, with a few known gaps in `TEXT`.
