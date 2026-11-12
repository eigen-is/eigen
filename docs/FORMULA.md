# Formula engine

> **TLDR:** The formula engine computes a workbook's formulas with no grid, no browser and no clock of its own. It holds the cells, parses each distinct formula once, recomputes what a write reaches and rewrites references when rows, columns or cells move. It is `@workspace/formula` (`packages/formula/`), a leaf beside `@workspace/math`: it imports no workspace package, and numfmt is its one dependency. The idea it rests on: a formula is stored as text relative to its own cell, so a formula filled down ten thousand rows is one text, parsed once. Today the product uses it for number display, Excel's function names and the row and column map (`mapIndex`, `mapSpan`, `GONE`); step 1b of [PROPOSAL_FORMULA_ENGINE.md](proposals/PROPOSAL_FORMULA_ENGINE.md) switches Sheets to it.

A host holds one `Engine` (`src/recalc/engine.ts`) per workbook. It loads the sheets from a description of their cells, then writes values and formulas, makes structural edits and calls `recalc`, which computes what changed and says which cells did. A host is the program around the engine: today only the package's tests, in step 1b the Sheets adapter in the editor and on the server. A sheet is named by its id and a cell by its row and column from 0. A call the engine refuses, such as a cell off the grid, throws before anything changed.

The host's cells are the truth. The engine holds nothing a second load would not rebuild, so it is a computed copy of the workbook, never a second store. Inside it a cell is a slot in a column's typed arrays: its value, and for a formula the id of its shape. A shape is one distinct stored formula text with its parsed tree. The stored text writes a reference as an offset from its cell and a sheet by its id. A text is held once in the workbook's string table, and a cell holds its id.

These terms come back in every section. A pass is one `recalc` call. A seed is a cell written since the last pass, the start of what the pass computes. A row is one function as the registry declares it, and a word is the declaration of one of its parameters. The host also hands each pass the time and a seed for random draws.

The sections run from the package's place, through the three spellings of a formula, the store, values, evaluation, functions, recalc, edits, number display and the xlsx dialect, to the rules the build wrote down, the differences from Excel and the tests. A few things surprise people: [the day line is Google's](#the-day-line-is-googles-not-excels), so a date in January or February 1900 is one day earlier than in Excel; [empty text is 0 in arithmetic](#empty-text-is-0-in-arithmetic); [a cell on a loop holds `#REF!`](#a-loop-is-found-by-computing-it-and-every-cell-on-it-holds-ref); [a clock formula does not move by itself](#the-clock-and-the-draw-come-from-the-host); and [a table reference is gone after import](#a-table-reference-is-one-leaf-and-the-importer-resolves-it-to-a-range).

## It is a leaf, reached through four entries

The engine runs unchanged in the browser, in Bun and in Node, and answers the same on every machine. So it imports no workspace package and no runtime API, and reads no clock and no locale. Biome enforces each part: the package imports nothing outside itself, numfmt only under `src/format/`, and `Date`, `Intl` and `performance` are refused globals; `scripts/check-standards.ts` also fails module-level state and `Math.random` there. Its tsconfig has `lib: ["ESNext"]` and no `types`, as `packages/math` does ([ARCHITECTURE.md § Dependency direction](ARCHITECTURE.md#dependency-direction)).

| Entry | What it holds | Who imports it today |
|---|---|---|
| `@workspace/formula` | `Engine`, the error values and the host's types | the package's tests |
| `@workspace/formula/text` | the parser and printers, A1 labels and sheet names, `mapIndex` and `mapSpan`, the transforms, the xlsx dialect, `resolveTables`, `tokens` | `packages/sheet`, for the row and column map |
| `@workspace/formula/format` | `numberDisplay` and `isDateFormat`, the one place numfmt is called | `packages/sheet`, `packages/lib`'s charts, the API's xlsx import, chart export and demo seed |
| `@workspace/formula/names` | `isExcelFunction`, `EXCEL_FUTURE_FUNCTIONS` | the sheet engine's `#NAME?` rule, the API's xlsx writer |

lib imports only `/format`, which a biome rule enforces, so lib, which every app and the server load, carries number display and not the engine. `/format` holds no engine for the same reason.

## A formula has three spellings and one tree

One lexer and one Pratt parser (`src/text/`) read every spelling into one immutable tree, and one printer per spelling writes it back.

| Spelling | Reader, printer | What it is |
|---|---|---|
| Typed | `parseA1`, `printA1` | A1 as a person types it at a cell; a sheet name is looked up and becomes an id |
| Stored | `parseStored`, `printStored` | What a cell holds: offsets in R1C1 and sheets by id, so `=SUM(A1:A3)*2` at D5 is `=SUM(R[-4]C[-3]:R[-2]C[-3])*2` and `=Data!$B$2` is `=[id]!R2C2` |
| File | `parseXlsx`, `printXlsx` | An xlsx `<f>`: A1 without the `=`, with Excel's prefixes ([§ The xlsx dialect](#the-xlsx-dialect-is-one-grammar-with-a-rule-for-implicit-intersection)) |

The stored text is canonical: equal formulas print equal text, and that text is the key of the shape table. So a fill writes one shape into every cell, and a tab rename rewrites nothing, since no formula holds a name. A sheet a formula names before any sheet has that name is stored by its quoted name and bound when such a sheet appears (`bindSheet`). Text that does not parse is a result, never a throw: `storedText` keeps it behind a second `=`, which no grammar reads as a formula, so it shows again exactly as typed and evaluates to `#ERROR!` (`src/text/typed.ts`). The parser keeps Excel's limits on length, nesting and arguments (`MAX_FORMULA_LENGTH`, `MAX_NESTING`, `MAX_ARGUMENTS`).

## Equal stored text is one shape

The shape table (`src/text/shapes.ts`) gives each distinct stored text a small id, which a cell holds in its `shape` plane, 0 meaning no formula. A shape keeps its text, its tree, its references and its facts: what the tree says about every cell that holds it, worked out once from the tree and the function list (`shapeFacts` in `src/eval/facts.ts`). The facts say whether the build can evaluate it at all (`Kept`, for a reference into another workbook or across sheets: the cell keeps the value it came with), whether it reads cells its references do not name (`ReadsUnnamed`), whether it is volatile, whether an edit can change its answer through a place or a size, and how deep it nests.

A shape no cell holds is forgotten when the reverse index is rebuilt, which happens once a formula came or went (`Recalc.reach`), and its id is given out again. So an id means one shape only while a cell holds it, and the table stays as long as the most shapes it ever held.

## A cell is a slot in four typed column planes

A column (`src/store/column.ts`) is four parallel typed arrays over its rows: `kind` (the value's kind, with the recalc's flags in its high bits), `num` (a number), `ref` (a text's id, an error's code, or 1 for TRUE) and `shape`. Most arithmetic allocates nothing, and a loop over a column skips per-cell checks with the column's counts of errors, pending formulas and loops. A column ends at its last cell and grows by doubling, and a sheet has no column past the last one written, so a sheet costs what it holds. One exception follows from it: a column costs its last row, 17 bytes a row, so a single cell on the grid's last row costs its column about 18 MB.

The string table (`src/store/strings.ts`) holds every distinct text once under an id, with the id of its upper-cased key beside it, so two texts that differ only by case compare as two integers. It forgets texts no cell holds in a sweep at the start of a pass (`Workbook.sweep`), when the table weighs more than `SWEEP_FLOOR` (2^22 characters) and twice what it weighed after its last sweep or load, or when a sheet was removed; a text counts its characters plus 16. A freed id goes to the next new text. A sweep was chosen over counting references per id: a count has no slow pass and less memory, but one miscount at any of the nine places that drop a cell shows a wrong value. The cost is an uneven pass on a sheet where one cell feeds a very large block of text formulas.

A column also keeps an index for exact lookups and equality criteria (`src/store/column-index.ts`): for each value, its rows in order. It is true for one version of the column, and the first ask at a version only notes it, so a column read once pays nothing.

## Values are plain JavaScript, errors are frozen objects

A number, a text and a boolean are the JavaScript types and a blank is `null` (`src/values/value.ts`). An error is one frozen object per kind, told apart by identity (`src/values/errors.ts`); an error only a file knows is carried as an object of its own. A reference stays a reference, unread, until something needs its value, and an array keeps its written size apart from what it stores, so a whole column costs its cells and not the grid.

Each coercion is one function for operators and arguments alike (`src/values/coerce.ts`): a text is a number when a person could have typed it into a cell as one (`parseNumber`), and a failed coercion is `#VALUE!`. The one order of values (`src/values/compare.ts`) puts a number below a text, a text below FALSE and FALSE below TRUE; a blank takes the other side's kind, numbers compare at 15 digits and texts by their keys. Excel's 15 significant digits apply where a number is compared, where a sum lands next to zero and where a rounding function cuts (`src/values/precision.ts`), so `0.1+0.2` equals `0.3`; arithmetic itself keeps every bit.

## One evaluator, and arrays are always on

The evaluator (`src/eval/evaluator.ts`) is one recursive switch over a shape's tree, given the cell the formula sits in, since the tree belongs to every cell of its shape. Reading a cell goes through the recalc, which computes a formula still to be computed first, so the order of a pass comes from these reads and nothing works it out ahead.

There is no array-formula mode. An operator on a range gives an array, element by element, and so does a function where one value is read and an array comes: the call is lifted, run once per element (`src/eval/lift.ts`). An array stores one element for a run of equal ones, so the body runs once per stored element. Two arrays are lined up by where they were written (`src/eval/bands.ts`). A cell holds the top-left value of an array result, since this step has no spill, and an array of references reaching the cell is `#CALC!`. One array stores at most 2^24 elements and one formula does at most 2^27 units of work (`MOST_STORED`, `MOST_WORK` in `src/recalc/recalc.ts`); past either the formula is `#CALC!`, alone. `@` in front of a range takes the cell on the formula's row or column, as Excel's implicit intersection does.

## A function is one row of words

A function is one line in its family's file under `src/functions/`: `fn('NAME', [parameters], body)` (`src/functions/registry.ts`). A parameter is a word that says how its argument is prepared, read, defaulted and repeated, and the call wrapper (`src/eval/call.ts`) does all of it before the body runs. So a body only computes: it gets one plain typed value or reader per parameter, does not coerce, read a cell or test for an error, and returns a value or an error for an input outside its domain. A biome rule refuses an import of `eval/`, `store/`, `recalc/` or `values/coerce` in a family file. A NaN or an infinity becomes `#NUM!`, and a text past 32,767 characters `#VALUE!`, without the body's help. `src/functions/library.ts` collects the families into `FUNCTIONS`, the one list a call is looked up in, and a name not there is `#NAME?`.

The order a call is worked in is also the rule for which error it answers: the count of arguments, every argument evaluated left to right but the lazy ones, every argument read by its word left to right, the insides of the ranges a family takes, in argument order and row by row, then the body, then the lazy argument the body picked.

| Words | What the body gets |
|---|---|
| `NUMBER`, `INTEGER` (cut toward zero), `NEARLY` (a hair under a whole number is that number), `SERIAL` (a date), `TEXT`, `BOOLEAN` | One value read as that kind; an array lifts the call |
| `PLAIN`, `ANY`, `CORNER` | One value as it is: no error, any value, or the first cell of a range |
| `LAZY`, `LAZY_VALUE` | A token; the wrapper evaluates the argument only if the body answers with it |
| `NUMBERS`, `COUNTED`, `FILLED`, `TRUTHS`, `NUMBERS_A`, `FACTORS`, `MODES`, `WHOLES` | Every value of the arguments, as that family counts a typed value, a cell and an array element (`src/eval/families.ts`) |
| `TEXTS`, `PAIRS`, `PRODUCTS` | Every value as text; two ranges side by side; ranges multiplied place by place |
| `WHERE`, `MATCHED`, `BLANKS` | The cells a criterion accepts, the numbers beside them, the cells that show nothing |
| `TABLE`, `ANYTHING` | A range or an array whole, to search, pick from or measure |
| `REFERENCE`, `HERE` | A place, never read; `HERE` left out is the formula's own cell |
| `NOW`, `RANDOM`, `ROOM`, `ENGINE` | No argument: the pass's time, a draw, room for an array, a question about the workbook |

Modifiers change a word: `optional`, `skippable` and `defaulted` say what a left-out or empty argument is; `rest` and `each` repeat a parameter, `each` trying groups in turn as `IFS` does; `strict` and `addin` refuse a boolean, `addin` with the other two answers of Excel's add-in functions; `areas`, `refusing`, `referring`, `cells`, `apiece`, `expecting` and `placed` say what a union, a reference or an array of references does. `chosen` makes a row that picks another by its first argument, as `SUBTOTAL` does, and the marks `PART` and `ANYWHERE` let a row answer a part of its table or a reference it worked out. The signature records the words become are in `src/eval/signature.ts`.

To pick a word, type the function in Excel first: what Excel answers for a text, a boolean, an empty argument, a fraction and a range at that place decides it, and nothing else does. The law tests prove the wrapper does what a row says, never that the row says what Excel does, so a row also gets tests with Excel's recorded answers. A word the vocabulary lacks is added to the registry, never written inside a body.

## A pass computes what the writes reach, and can stop

The reverse index (`src/recalc/reverse-index.ts`) answers which formulas read a cell. It is built from rectangles of cells that hold one shape, with about one entry per reference of the shape, listed by the blocks of columns the reference reads and sorted by row. It is rebuilt whole when a formula came or went, never patched, so it cannot drift from the cells it describes. A pass marks: it flags every formula that reads a seed or a flagged formula, and every formula that reads cells it does not name ([§ ReadsUnnamed](#a-row-that-reads-cells-no-reference-names-is-computed-in-every-pass-with-a-write)). Then it walks the flagged cells in sheet, column and row order and computes each, reading what it needs first.

`recalc(cap, now, seed)` stops after `cap` formulas, before it stores the next, and the next pass goes on from there: a host can keep a frame free on a large recompute. A pass never stops before its first store, so a formula that alone costs more than the cap cannot hold every pass up. The nesting of the cells in progress has one budget (`BUDGET` in `src/recalc/recalc.ts`, half the smallest stack the engine runs on): past it the calls in progress are dropped by a throw and computed again from the list of cells in progress, so a chain of a hundred thousand formulas never overflows the stack. The result lists the cells on loops, whether the pass stopped, and the runs of cells whose value changed.

## A loop is found by computing it, and every cell on it holds `#REF!`

A cell read while it is being computed is on a loop with every cell reading towards it. Each of them holds `#REF!`, as Google Sheets shows a circular reference, and the pass lists them. An `IFERROR` on the loop does not catch it, and one outside does. A loop is found by computing, never by a graph walk, since what a formula reads can hang on values: `=IF(B1,A1,2)` is a loop only while B1 is TRUE. So the loops of a workbook loaded with values show once one of their cells is computed. `src/test/recalc/recalc.test.ts` pins the cases.

## A row that reads cells no reference names is computed in every pass with a write

Every cell a shape reads is known to the index, or the shape carries `ReadsUnnamed` and every marking flags it. Four things set it: a row that takes `ENGINE` (`CELL`, `FORMULATEXT`, `INDIRECT`, `ISFORMULA`, `SHEET`, `SHEETS`), a row marked `ANYWHERE` (`OFFSET`, `INDIRECT`), a colon between two references or calls, whose box holds cells neither names, and a `MATCHED` range whose size differs from its criteria range. An `ENGINE` row asks the workbook itself, such as whether a cell holds a formula, which can change with no value changing. `src/test/functions/gates.test.ts` pins the six names, so a new `ENGINE` row fails it until someone looks.

## The clock and the draw come from the host

A row that takes `NOW` or `RANDOM` gets the pass's `now` and a draw from its `seed`, never the machine's clock (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`, and `DATEVALUE` and `TIMEVALUE`, since a date without a year takes the current one). Its shape is flagged volatile, but no pass computes it by itself: it computes when it is written or reads something written, as any formula does. Its value is its author's, by the proposal's design: a clock that every edit refreshed would make every batch write the `NOW()` cell, and one every reader read for itself would put two numbers on two screens ([PROPOSAL_FORMULA_ENGINE.md](proposals/PROPOSAL_FORMULA_ENGINE.md#formulas-under-collaboration)).

## A structural edit is one transform of stored text

An insert or delete of rows or columns (`Engine.editLines`), a move of a block (`moveCells`) and a new sheet (`addSheet`) each rewrite stored text by one rule (`src/edit/`). Every reference keeps naming the cells it named: an absolute index goes through the edit's map, and an offset becomes the distance between the mapped target and the mapped host. `mapIndex` and `mapSpan` (`src/edit/map.ts`) are that map, the one rule for everything that holds a row or column index; the sheet's merges, rules, charts and filter already call it today. A formula depends on its host only through the host's line, so `hostClasses` cuts a filled column into stretches with one outcome each and transforms it once per stretch. The edit plan (`src/recalc/edit-plan.ts`) works the classes out before a cell moves: the blocks whose text changes get their new shape, the blocks whose old text undo cannot derive back are reported with it in `EditResult.rewrites`, and the blocks whose value can change seed the next pass. A rename or a removed sheet rewrites nothing: a reference to a removed sheet reads `#REF!` and reads the sheet again when its id comes back.

## Number display is numfmt behind its own entry

`numberDisplay(value, format)` (`src/format/number-display.ts`) is a value as an Excel number format shows it, and the package's one use of numfmt: the sheet writes every cell's display string through it, a chart draws its value ticks through it, and the engine's `TEXT` answers through `valueAsText` beside it. A number shows as the 15-digit decimal Excel holds, a half rounded away from zero, so `1.005` under `0.00` is `1.01`. A malformed format falls back to General. The day line is passed as numfmt's `leap1900: false` ([§ The day line](#the-day-line-is-googles-not-excels)). numfmt 4.1.3 carries one patch for the weekday of a day before day 0, described with its removal in [SHEETS.md § Number display](SHEETS.md#number-display-strings-go-through-numberdisplay).

## The xlsx dialect is one grammar with a rule for implicit intersection

`src/text/xlsx.ts` reads a file's formula with the A1 parser and a walk that takes the file's spellings out, such as `_xlfn.` prefixes and `_xlfn.SINGLE(x)` for `@x`, and writes it back by the reverse walk and `printXlsx`. A prefix is stripped only for a name Excel's inventory holds (`src/functions/excel-names.ts`), so a function Microsoft adds later survives a round trip.

An Excel without dynamic arrays read one cell of a range wherever one value was wanted, and a plain `<f>` still means that. So `intersect` puts the `@` where such an Excel read one cell, and an importer calls it for a plain cell only. Each place in a tree is read as one of three contexts: a value, a reference, or an array. An operator passes its context to its operands, a lazy argument passes it through, and a call that picks an argument, as `IF` does, makes its test a value again. Excel's recorded rows decide two function facts the registry carries: `placed()` marks the table of `MATCH`, `VLOOKUP` and `HLOOKUP`, which old Excel read as a reference, where `LOOKUP`'s table made an array; and `INDEX` is one cell when every index is a number other than 0 or a call of one value, `XLOOKUP` when it looks along a plain range and returns from one line.

`isLegacy` says how to write a cell back. True: a plain `<f>` gives the cell in Excel the value it has in Eigen. False: write it as an array formula with the dynamic-array mark, which is also the answer when the function list cannot tell, since Excel then shows the value Eigen showed, at worst in braces. Step 1b writes every `t="array"` with `cm` and the metadata part, or typed `INDEX`, `OFFSET` and `XLOOKUP` would open in Excel as old braces formulas. The one loss: an `@` frozen at import in front of a function the engine lacks that day stays when that function is built.

## A table reference is one leaf, and the importer resolves it to a range

`Sales[[#This Row],[Qty]]` parses as one leaf, `NodeKind.Table`, with its brackets as written. `resolveTables` (`src/text/tables.ts`) is what an importer calls with its file's tables: each reference becomes the plain range it names, with the marks Excel's own Convert to Range writes (column absolute and row relative for this row, all absolute otherwise). A this-row reference reads the table's row of the same number from any sheet, as Excel does. One whose table, column or rows the file lacks stays, evaluates to `#REF!` and is written back as read. Step 1b calls it after `parseXlsx` and before `intersect`. Tables are no live feature: after import a formula holds the range, and a table that grows does not grow it.

## Excel's limits and bugs are not copied

The owner's standing rule: no code whose only purpose is to copy an Excel limit or bug. The engine accepts more than Excel wherever the meaning is unambiguous, and refuses only where accepting would make one formula text mean two things, or cost code of its own. Every place it accepts more is a listed difference ([§ Known differences](#known-differences-from-excel)), since it can produce a file Excel refuses. Precedents: no 255-character limit on a criterion, a lookup key or the text of `CODE`, `UNICODE` and `REPT`, and no 255-character limit on a number format. Where Excel's answer is the meaning, as in a function's arithmetic, the engine follows Excel's recorded rows, and the tests pin them.

## The day line is Google's, not Excel's

A serial is the days since 30 December 1899 in the one real calendar, negative before it (`src/values/dates.ts`). So 1900 has no 29 February, as in Google Sheets; from 1 March 1900 on a serial is Excel's, and before it one day less. `DATE(1900,1,1)` is 2 where Excel says 1, `DAY(60)` is 28, and a negative number is a date, where Excel has none. Dates run from 1 January of the year 1 to 31 December 9999 (`FIRST_SERIAL`, `LAST_SERIAL`). Excel's 29 February 1900 is Lotus's bug, and copying it would be code for a bug in every date function, the display and the reading of typed dates. Number display holds the same line, which today's cells already show ([SHEETS.md § Number display](SHEETS.md#number-display-strings-go-through-numberdisplay)).

## Empty text is 0 in arithmetic

`=""+1` is 1 and `=B1*2` over a `=""` is 0, where Excel says `#VALUE!`; empty text is also FALSE as a condition and 0 in `VALUE` and `ABS`. It is the owner's pick from Google, since sheets are full of `=IF(x,"",…)` feeding arithmetic, and one coercion function holds it (`src/values/coerce.ts`). A blank result of a formula is 0 in a cell, as in Excel.

## A character is a UTF-16 code unit

`LEN`, `LEFT`, `MID`, `FIND` and every function that counts, cuts or finds by position count UTF-16 code units, so an emoji is 2 and `LEFT` can cut one in half, where Excel for the web counts it as 1. The choice lives in `src/values/characters.ts` alone. Desktop Excel, which wrote the cached values of imported files, is taken to count code units; switching to code points is a change in that one file.

## A 1×1 array is a single value

The store does not tell a one-element array from its element: `TYPE({"a"})` is 2 where Excel says 64. Telling them apart would be a member on every table for one function's answer.

## The approximate searches halve and assume sorted data

`MATCH` type 1, `LOOKUP` and an approximate `VLOOKUP` or `HLOOKUP` halve the list, moving a probe that lands on a value of another kind to the next value of the key's kind, and stop at the last of a run of equal values. `MATCH` type -1 halves too, for the key or else the last value above it. Excel documents that these need sorted data, and on sorted data they answer as Excel. On unsorted data Excel walks cell by cell in places, so two picks of the owner differ there: `MATCH(2,{1,2,2,2,2,2,2,2,2,2,2,2,3,2,2,4},1)` is 15 where Excel says 12, and `MATCH("a",{1,"a",2,"a",3,"a"},1)` is 6 where Excel says 4. The walk made a lookup on a column of long runs read every cell of the run, and a descending `MATCH` read the whole column. `XMATCH` and `XLOOKUP` in search modes 2 and -2 are a plain bisection in the one order of all values, so a next-smaller value can be one of another kind. A key matches only values of its own kind, text in any case, and a blank never matches (`src/eval/search.ts`). The 47 recorded rows that differ are the `PICKED` table of `src/test/functions/search-order.test.ts`.

## Text has the engine's own order

Text compares on its key, the upper-cased form, so case never matters and `"straße"` equals `"STRASSE"` (`src/values/text-order.ts`). Keys order by character: hyphens and apostrophes are passed over, then the space, the other marks, the digits and the letters, an accented Latin letter right after its base letter. Two texts equal without their hyphens and apostrophes are ordered by them, the one without first, so `"co-op"` sorts right after `"coop"`. Excel's 200 recorded rows set this order. It is the engine's own because the host's collation follows the language data of whichever browser or server runs it, and a sorted lookup must find the same row on every tab and on the server.

## Snapping to a whole number is per function

Excel reads a count or an index a hair under a whole number in one of four ways, and its rows show which function does which:

| Reading | Functions |
|---|---|
| Snaps to the whole number (`NEARLY`) | `FACT`, `LEFT`'s count, `INDEX`'s row and column, `ROUND`'s digits |
| Cuts it as it is | `MID`'s start, `REPT`'s count, `CHOOSE`'s index |
| Cuts it at 15 digits | `INT`, `TRUNC`, `ROUNDDOWN` |
| Takes the double as it is | `QUOTIENT`, `MOD`, `MROUND` |

So `LEFT("abcdef",2.9999999999)` is `abc` and `MID("abcdef",1,2.9999999999)` is `ab`. `NEARLY` does not cut, so a row that takes it tests the sign and cuts in its body: `LEFT("abc",-0.9)` is `#VALUE!`.

## Three kernels follow Excel's rows over the textbook

- `RSQ` squares the sample correlation, each variance with its own root, where `CORREL` and `PEARSON` stay on the population; their squares differ in the last digit, and only this order answers all six recorded sets (`src/functions/statistical.ts`).
- `DATE` reads each part as a 16-bit number: a day outside -32768 to 32767 counts as 32767 on either side, and a month from 32767 on or under -32767 is `#NUM!` (`dateOf` in `src/values/dates.ts`).
- `TIME` refuses a part above 32767 and wraps one below -32768 as a 16-bit number: -32769 minutes are 32767 (`timeOf`).

## A lifted call hands values, and only OFFSET and INDIRECT keep references

When a call is lifted over an array, each element's answer becomes a value: of an array the first element, of a reference the value of its first cell, and a cell that holds nothing stays that cell, so it is passed over as a blank cell of a range is. So `INDEX(A1:B3,{1,2},1)` is an array of values, as Excel records. Only a row marked `ANYWHERE`, which works a reference out (`OFFSET`, `INDIRECT`), keeps one reference per element, and that array of references is `#CALC!` when it reaches the cell.

## `room` bounds bytes, not elements

A body that builds an array asks `ROOM` first, and the recalc refuses past `MOST_STORED` elements. A reference is an object of about 137 bytes where a number is 8, so an array of references is charged 17 slots an element (`REFERENCE_ROOM` in `src/eval/views.ts`). So `ISFORMULA` or `FORMULATEXT` over more than 986,895 held cells is `#CALC!`, as Excel answers `FORMULATEXT(A:A)`, where a single formula could otherwise take gigabytes and get the server killed.

## A sheet id must not hold a quote or a bracket

Stored text writes a sheet as its id in brackets, `[id]!`, and reads a bracket by the table reference rule, so an id that holds `'`, `[` or `]` does not parse back. The editor's ids are UUIDs. A host hands the engine no other id: one from a file or a peer is checked or remapped where it enters.

## A source of cells never calls back into the engine

`Engine` and `addSheet` read a sheet through its `SheetSource`, whose `cells` callback is called twice, once to size the columns and once to fill them, so a host walks its own cells and builds no list (`src/store/workbook.ts`). The callback must not call the engine: while it runs, its sheet is not the workbook's yet, so a recalc from inside it would sweep the texts and shapes the half-loaded sheet holds. The host is our own typed code, so the contract is stated, not guarded.

## Known differences from Excel

Each line is a decided choice; the function-by-function list is `packages/formula/FUNCTIONS.md`.

- The day line is Google's: a serial under 61 is a day earlier, and a negative serial is a date.
- Empty text is 0 and FALSE in arithmetic, conditions, `VALUE` and `ABS`; `SUMPRODUCT` of one blank cell is 0.
- No 255-character limit on criteria, lookup keys, `CODE`, `UNICODE`, `REPT` and number formats.
- A formula that does not parse is stored and shows `#ERROR!`, where Excel refuses the entry.
- Text lengths count UTF-16 code units.
- A 1×1 array is a single value.
- An approximate search on data not sorted as it assumes can land elsewhere (47 recorded rows).
- `LOOKUP` with a result range shorter than its lookup range is `#N/A`, where Excel reads past the range.
- A lifted lazy argument no element picks does not widen the result.
- A cell on a loop holds `#REF!`, where Excel shows 0 with a warning.
- `NOW`, `TODAY`, `RAND` and `RANDBETWEEN` do not change after an unrelated write.
- `ISFORMULA` and `FORMULATEXT` over more than 986,895 held cells are `#CALC!`.
- `SUBTOTAL` 101 to 111 count hidden rows, since the engine knows of none.
- A table reference is resolved to a range at import; a this-row reference outside the data rows is `#REF!`, and forms Excel refuses but whose meaning is plain (`T[ Qty ]`) are accepted.
- Through an xlsx round trip, an unknown function name loses its letter case, a shared formula past the grid's edge is `#REF!` where Excel wraps it, a formula the dialect is unsure of is written as an array formula, and `TYPE` of a range after import is 64 where Excel shows 16.

## Tests mirror the source, and laws check what examples cannot

Tests live in `src/test/`, one folder per source folder (`edit`, `eval`, `format`, `functions`, `recalc`, `store`, `text`, `values`). Three kinds carry the suite:

- **Laws with generators.** Incremental recalc equals a fresh load of the same inputs, after any writes and stopped passes (`recalc/law.test.ts`), and after any structural edits (`recalc/edit-law.test.ts`); the string table's sweep never frees a held text (`recalc/strings-law.test.ts`); the stored key reads back as the same tree (`text/xlsx-laws.test.ts`); the wrapper does what every row's words say (`functions/laws.test.ts`).
- **Excel's recorded rows.** Function tests carry Excel's answers as recorded in Excel for the web, and a row that differs by a decided pick sits in a pick table with both answers, such as `PICKED` in `functions/search-order.test.ts` and the 255-character table in `functions/text.test.ts`.
- **Timing bounds.** A few tests hold a cost to a bound, such as `functions/products.test.ts`, so a quadratic shape fails the suite.

```sh
cd packages/formula
bun run test                       # the whole suite, each file isolated
bun run typecheck                  # source and tests
bun test ./src/test/functions/lookup.test.ts
EDIT_LAW_SEED=7 EDIT_LAW_COUNT=5000 bun test ./src/test/recalc/edit-law.test.ts   # a long law run
```

## See also

- [PROPOSAL_FORMULA_ENGINE.md](proposals/PROPOSAL_FORMULA_ENGINE.md), the signed design and its four steps.
- [SHEETS.md](SHEETS.md), the Sheets app and the engine that still computes it.
- [EXPORT.md](EXPORT.md), the xlsx import and export around the dialect.
- `packages/formula/README.md` and `packages/formula/FUNCTIONS.md`, the package's own guide and every function it computes.
- [SHEETS-TODO.md § The new formula engine](SHEETS-TODO.md#the-new-formula-engine), the engine's open rows.
