# {{ours}} compared with HyperFormula, IronCalc, Univer and formulajs

This folder compares {{ours}}, Eigen's formula engine (`@workspace/formula`), with four other formula engines that run in JavaScript: [HyperFormula](https://hyperformula.handsontable.com/), [IronCalc](https://www.ironcalc.com/), [Univer](https://univer.ai/) and [formulajs](https://formulajs.info). IronCalc is written in Rust and runs as WebAssembly. Univer is a toolkit for office documents, and its formula engine is one of its parts. It measures three things, in this order of importance: speed, correctness and coverage. The numbers below come from one run on {{generated}}. A script wrote them into `results.json`, and a second script wrote this README from that file and from `notes.md`. No number here is typed by hand.

```sh
cd packages/formula/benchmark
bun install            # installs the other engines into this folder only, at the versions in its package.json
bun run quick          # a first look in a few minutes at reduced sizes; prints its tables, changes no file here
bun run.ts && bun readme.ts   # the full run, {{full-minutes}} minutes last time: writes results.json, then this README
```

`bun run.ts --help` lists the options. A quick run divides every count by 10 (100,000 rows become 10,000), takes 3 rounds of one run each on Bun only, so no run warms the runtime up first, and judges every 100th recorded row. Its numbers are for a first look and are not the ones below; ratios at a tenth of the size can differ from the full ones, since index and setup costs do not grow in a straight line with the size.

`bun rows.ts <oracle folder>` rebuilds `excel-rows.jsonl`, the file of Excel's recorded answers, from the local recording files. It reuses the oracle's own reader in `scripts/oracle-rows.ts`. To regenerate everything after a change to the engine or to the recordings, run `bun rows.ts <oracle folder> && bun run.ts && bun readme.ts`.

## The results in three lines

- {{summary-speed-bun}}
- {{summary-correctness}}
- {{summary-coverage}}

## Words used in this README

- A **formula** is a cell's text that starts with `=` and computes a value, such as `=A1*2`.
- A **cell reference** is the name of a cell inside a formula, such as `A1`. A **range** is a block of cells, such as `A1:A100`.
- A **dependency** is a link from a formula to a cell it reads. When `B1` holds `=A1*2`, `B1` depends on `A1`, and `B1` is a **dependent** of `A1`.
- **Recalculation** is computing formulas again after a cell changes. A good engine computes only the dependents of the changed cell.
- A **lookup** searches a column for a value and returns something about the row where it found it, as `VLOOKUP`, `MATCH` and `XLOOKUP` do. An exact lookup wants the same value. An approximate lookup wants the largest value that is not above the key, in sorted data.
- A **volatile function** gives a new value every time it is computed, such as `NOW()` or `RAND()`.
- A formula **spills** when it gives a whole array of values and the values fill the cells below and to the right of it.
- **WebAssembly** is a compact program format that JavaScript runtimes run at close to the speed of native code. A call from JavaScript into it, or a value passed across, has a small cost of its own.

## How to read the tables

Each speed row is one workload. A workload is a workbook built in code, so anyone can run it again with nothing but the repo. A cell shows two times in milliseconds: the fastest round and the median round, as `fastest / median`. Lower is better. Five engines do not fit in one readable table, so each runtime has two tables with the same rows: {{ours}} with HyperFormula and formulajs, and {{ours}} with IronCalc and Univer. The {{ours}} column is the same in both. The ratio columns divide the other engine's median by ours. A ratio of 5× means the other engine took five times as long as {{ours}}. A ratio below 1× means the other engine was faster. The memory row shows megabytes instead of times, and its ratio works the same way.

"not supported" means the engine cannot run that workload. "wrong values" means the engine ran it, but its values were not the same as ours, so its time does not count. "too slow" means one run of the engine took more than two minutes. Its time is then not taken again in later rounds, and the workload comes back in a row of its own at a tenth of the size, marked "a tenth of the size for" that engine, run only by that engine and {{ours}}. Times at the two sizes are never compared or scaled to each other.

A third table per runtime shows where the time goes. For each engine that holds cells, it shows the median time of the load (or of the edit) on its own, then the median time of the whole run, as `step of whole`. The rest is the engine's own recalculation call. HyperFormula computes during its load, so for it the step is nearly the whole time. IronCalc computes only when it is asked to, so for it the step is the cost of putting the cells in, across the WebAssembly boundary, and the rest is its computing.

In the correctness tables, a row is one formula that a person typed into Excel for the web, with the answer Excel showed.

## Speed

Every engine runs each workload in a fresh process of its own, and never two processes at the same time. In each process the engine runs the workload up to three times, each time on a fresh engine, and the fastest run counts. The first run warms up the runtime. A process stops repeating after 20 seconds of runs, so a slow engine is timed fewer times in a process. There are several rounds, and each round starts all engines again, in a changing order, so a slower moment of the machine hits every engine alike. Before each run the benchmark waits until the 1-minute load of the machine is low, and a run during which the load rose above that limit is thrown away and taken again. A run longer than a minute is kept, since by then the load mostly shows the run itself.

A workload without an edit measures the load: the engine gets the cells, reads the formulas and computes them all. HyperFormula computes every formula while it loads, so the load and the first full computation cannot be measured apart; the time is the two together for every engine. A workload with an edit loads first without the clock running, then measures the edit and the recalculation after it.

Before a time counts, the run checks the values. Each engine reports the values of a sample of cells after the workload, and they must match ours at 10 significant digits. We use 10 digits because HyperFormula rounds the numbers it gives out to 10 digits by default.

IronCalc gets every cell through its `setUserInput` call, one cell at a time, with its automatic evaluation paused, and then computes the whole workbook with one `evaluate` call. Univer gets the whole workbook as one snapshot, a single object that holds every sheet and cell. It computes its formulas on its own schedule after a change, not inside the call that made the change, so the run waits for its documented signal that the results are in place (`onCalculationResultApplied`), and the time includes that wait.

formulajs is a library of functions. It has no cells, no formula text and no recalculation. So it takes part only where the same answers come from plain function calls: the run gives it the columns as JavaScript arrays, built without the clock running, and times the calls. This is less work than an engine does, since nothing is parsed, stored or tracked.

The workloads:

{{workloads}}

### On Bun

{{setup-bun}}

{{speed-bun}}

Where the time goes on Bun:

{{steps-bun}}

### On Node

{{setup-node}}

{{speed-node}}

Where the time goes on Node:

{{steps-node}}

{{summary-speed-node}}

### Where another engine was as fast or faster

{{losses}}

## Correctness

The answers were recorded by hand in Excel for the web in November 2026, in the family and batch files of the formula engine's oracle. `excel-rows.jsonl` holds {{correctness-rows}} of them: for each, the formula as it was typed in Excel, the cells it reads, and Excel's answer with its kind. The oracle already left out the rows Excel refused at entry and the rows with volatile functions. {{correctness-unjudged}} more rows gave an array whose values Excel did not show in full, so there is nothing to compare, and they are left out too.

Each row runs in a fresh engine. The formula goes into cell U21 of a sheet that holds the cells it reads. Its value is compared with Excel's by the oracle's own rule: numbers equal at 15 significant digits, and texts, true or false values and errors exactly. An array answer is judged by its size and by each of its values, each read through `INDEX` in a fresh engine.

A row gets one of four verdicts. **equal**: the engine gave Excel's answer. **differs**: it gave another answer. **not supported**: it answered `#NAME?` (an unknown function), `#ERROR!` (a formula it cannot read) or `#N/IMPL!` (IronCalc's answer for a function it knows but has not built) where Excel did not. **crashed**: it threw an error, or it did not answer within 20 seconds.

Our own deliberate differences from Excel count as "differs" for us too. Examples are the dates in January and February 1900 and an empty text in arithmetic. [FUNCTIONS.md](../FUNCTIONS.md) lists every one of them with Excel's answer and ours.

formulajs is judged only on the rows that are one call of a function with plain values as arguments, such as `=ROUND(2.5,0)`: {{formulajs-rows}} rows, {{formulajs-share}} of all. They need no cells.

{{correctness-totals}}

The share of equal answers per family of functions:

{{correctness-families}}

Rows that did not answer within 20 seconds, counted as crashed:

{{hung}}

## Coverage

Excel has {{excel-functions}} functions. The list is the one {{ours}} keeps of them (`EXCEL_2007_FUNCTIONS` and `EXCEL_FUTURE_FUNCTIONS`). For each engine we count the function names it registers that are on that list. For {{ours}} that is its function registry `FUNCTIONS`; for HyperFormula, `HyperFormula.getRegisteredFunctionNames('enGB')`; for formulajs, the functions it exports; for Univer, its exported list `ALL_IMPLEMENTED_FUNCTIONS`. IronCalc has no list of its functions in its API, so each of Excel's names is typed into an IronCalc cell as `=NAME()`, and the name counts when the answer is anything but `#NAME?` or `#N/IMPL!`. A known function called with no arguments answers an error such as `#ERROR!`, which still counts. This way finds only names on Excel's list, so IronCalc's other names are not known. "Other names" are names Excel does not have, such as Google Sheets functions or older spellings.

{{coverage-functions}}

{{ours}} has fewer functions than every other engine today. Per engine, the number of Excel's functions it has that we lack, and the other way round:

{{coverage-gaps}}

The functions we lack are mostly statistical distributions, engineering and complex-number functions, financial functions, the database functions (`DSUM` and its kin) and the dynamic-array functions (`FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`). Some are common, such as `PMT`, `NPV`, `IRR` and `NORM.DIST`. They are planned for a later step of the engine. Missing functions matter most when a workbook from Excel uses one: such a formula shows `#NAME?` until the function exists. The correctness table above shows the effect on the recorded rows: a missing function makes a row "not supported".

Language features, each tested by running a probe formula and reading the answer (the answer is in brackets). The same probe runs through every engine's adapter. formulajs has no formula language, so it has none of them.

{{coverage-features}}

## Why it is fast

Each point is a design choice described in [FORMULA.md](../../../docs/FORMULA.md) and checked in the code.

- **One parsed tree per formula shape.** A formula is stored relative to its own cell, so `=A1*2` in row 1 and `=A2*2` in row 2 are the same text, and the engine parses it once. A column of 100,000 such formulas is one tree. This helps the load rows. In this benchmark the formulas arrive as typed text, so our adapter still reads each typed text once to turn it into the stored text; a document saved by Eigen holds the stored text already.
- **Typed column storage.** A column is a few typed arrays: one for the kind of value, one for numbers, one for text ids and one for the formula shape. Most arithmetic allocates no objects. This shows in the memory row.
- **A column index for lookups.** For exact lookups and equal criteria, a column keeps, per value, the rows that hold it, built on the first need and reused while the column does not change. This shows in the exact `VLOOKUP`, `MATCH` and `XLOOKUP` rows.
- **Recalculation computes only what a write reaches.** The reverse index knows which formulas read a cell, and a pass computes only those, in the order their reads need. This shows in "edit a cell with 3 dependents".
- **The reverse index has one entry per block of one shape, not one per cell.** A column of 100,000 formulas that read one cell is one entry, so marking what to compute is cheap. This shows in "edit a cell read by 100,000 formulas".
- **Long chains do not overflow the stack.** A pass keeps a budget for nested computing and falls back to a list of cells in progress, so a chain of 100,000 formulas computes without deep recursion. This shows in the two chain rows.
- **References are offsets, so a row insert rewrites few texts.** A formula that moves with its row keeps its text. An insert works out the new text once per stretch of rows with one outcome, not once per cell. This shows in "insert a row near the top".

## Why it is correct

- **Tests are pinned to answers recorded in real Excel.** The function tests carry Excel's recorded answers, and this benchmark replays every recorded row. An answer is never decided from memory.
- **Numbers compare and round at Excel's 15 digits.** Comparisons, sums near zero and rounding functions work on the 15 digits Excel keeps, so `0.1+0.2` equals `0.3`, as in Excel.
- **One coercion rule for operators and arguments.** Turning a text into a number, or a value into true or false, is one function each, used by operators and by function arguments alike, so the two cannot drift apart.
- **One call wrapper for every function.** A function declares each parameter with a word, such as a number, a text or a range of numbers. The wrapper reads, converts and checks every argument before the function body runs, in Excel's order. So the order of errors is the same in every function, and a body cannot forget a check.
- **Law tests compare recalculation with a fresh load.** Generated edits, writes and structural changes must give the same values as loading the final cells from scratch.
- **Text order is the engine's own.** Sorting and comparing text do not use the language settings of the machine, so a lookup finds the same row in every browser and on the server.
- **Deliberate differences are written down.** Where the engine answers differently from Excel on purpose, FUNCTIONS.md says so with both answers, and those rows count as "differs" here.

## Where the others are better

- **Functions.** HyperFormula and formulajs both have many more of Excel's functions today. This is the largest gap.
- **Spilling and dynamic arrays.** HyperFormula spills an array answer into the cells below and has `FILTER`, `SORT` and similar functions. {{ours}} keeps only the first value of an array in the cell.
- **Growing range sums.** In the running-total workload, where each formula sums a range that grows by one row, HyperFormula is faster than us: we read every cell of every range again, so the work grows with the square of the rows, and HyperFormula does not.
- **Small edits.** When one cell with only a few dependents changes, HyperFormula is a little faster than us. Both take well under a millisecond.
- **Plain text calls.** formulajs computes the text workload's calls much faster than our engine computes the same formulas. Part of that is that it parses, stores and tracks nothing, but our text formulas also cost clearly more per formula than the arithmetic formulas of the load workload, so there is room to improve.
- **A finished product.** HyperFormula has undo and redo, named expressions, custom functions, translations of function names, and a clipboard API. {{ours}} has none of these yet; its host is meant to give some of them.
- **formulajs is tiny to use.** It is just functions. For a program that only needs to call `PMT` or `NORM.DIST` on its own numbers, it is the simplest choice.

## Fairness and limits of this benchmark

- HyperFormula runs with the configuration from its own guide to compatibility with Microsoft Excel, with Excel's grid size added, since its default stops at 40,000 rows. It is built with `licenseKey: 'gpl-v3'`. The two names `TRUE` and `FALSE` are defined as its guide shows. The exact configuration is below.
- For the lookup workloads, HyperFormula also gets `useColumnIndex: true`, which its performance guide advises for `VLOOKUP` and `MATCH`: {{lookup-config}}. The other workloads use its default.
- HyperFormula loads through `buildFromSheets`, its bulk load, and computes during the load. Edits use `setCellContents` and `addRows`, one call each, which is how its documentation shows a single change.
- HyperFormula's time in the lookup, sum and criteria workloads grows with the number of formulas that name a long range, and we saw the same cost when the formula could not search at all. So most of its time there goes into setting up those formulas, not into searching. We found no setting in its documentation that changes this. So we gave those workloads fewer formulas than the others, as their descriptions say, so that a run ends in reasonable time.
- IronCalc runs from `@ironcalc/wasm`, its WebAssembly build, as `new Model('Book1', 'en', 'UTC', 'en')`: English names and number format, and UTC as its time zone, as its README shows. The WebAssembly file is compiled once per process, before any clock runs. Its own Node binding, `@ironcalc/nodejs`, is a native module and is not used here; the WebAssembly build loads in Bun and Node without a bundler.
- IronCalc's load pauses its automatic evaluation (`pauseEvaluation`) and gives every cell with `setUserInput`, one call per cell, so every cell crosses into WebAssembly on its own. Without the pause it computes the workbook after every cell, which takes far too long for these sizes. Its one bulk call, `pasteCsvText`, takes a whole block as tab-separated text in one call. In a trial it took about the same time as the single calls, so the boundary is not where its time goes, and it keeps the apostrophe that marks a text as part of the text. So the adapter uses `setUserInput`. The table "where the time goes" shows the load and the computing apart.
- IronCalc's recalculation is one `evaluate` call, which computes the whole workbook. Its API has no call that computes only what an edit reaches. An edit is `setUserInput`, and a row or column insert is `insertRows` or `insertColumns`, each followed by `evaluate`.
- IronCalc gives a value out only as the text a cell shows. So, after the timed part, the adapter sets the cell's number format to 15 significant digits (`0.00000000000000E+0`, through `updateRangeStyle`) and turns the text back into a number. 15 digits are all IronCalc shows, so a number at the edge of rounding can differ from Excel's in the last digit. A text is typed with a leading apostrophe, as in Excel, and `TRUE` and `FALSE` are typed as words. IronCalc counts rows and columns from 1; the adapter adds 1.
- IronCalc's WebAssembly memory grows and never shrinks. Both runtimes count it in the memory row, so its number there is the largest the load needed.
- Univer runs from `@univerjs/core`, `@univerjs/engine-formula`, `@univerjs/sheets` and `@univerjs/sheets-formula` with `rxjs`, the smallest set that computes a workbook without a screen. Its Node guide installs more packages, such as the render engine, documents and number formats; they are for showing a sheet, not for computing it, so they are not registered. It computes in the same process, the guide's default, not in a worker.
- Each Univer load makes a new `Univer` with the English locale texts of its sheets packages and registers three plugins: the formula engine, sheets and sheet formulas. The workbook goes in as one snapshot through `createWorkbook`, its bulk load, with Excel's grid of 1,048,576 rows and 16,384 columns, as HyperFormula gets. A number is a cell `{v, t: NUMBER}`, a text `{v, t: FORCE_STRING}`, true or false `{v: 1 or 0, t: BOOLEAN}`, and a formula `{f}`. Its default calculation mode computes every formula that has no stored value, which is every formula here. A grid of Excel's size makes a fresh workbook clearly slower to set up than Univer's default grid of 1,000 rows, but the workloads need more rows than that.
- Univer computes after a change on its own schedule. The run waits for `getFormula().onCalculationResultApplied()`, its documented way to wait until the results are in the cells, and that wait is part of the time. Edits use `getRange(row, column).setValue`, and inserts `insertRows` and `insertColumns`.
- Univer's own value of a cell is rounded to 12 digits; `getRawValue` gives every digit, so the adapter reads that. A value an array formula spilled into a cell has no raw value, so for such a cell the adapter reads the rounded one. An error comes out as text, such as `#N/A`, so the adapter reads a formula's text as an error when it is the name of one of Excel's errors.
- Our adapter turns each typed formula into stored text inside the timed load. HyperFormula, IronCalc and Univer also read typed text, so all four parse the same input.
- formulajs takes plain JavaScript arrays and does no parsing, storing or dependency tracking. Its times are therefore a lower bound of what an engine built on it would take.
- formulajs gives a date as a JavaScript `Date`. Before we compare it with Excel, we turn it into Excel's day number from its local date and time.
- The speed workloads are synthetic. Real workbooks mix many shapes, functions and sizes. The engine's own bench script, `scripts/bench.ts`, times real workbooks against design gates, but those files are not in the repo.
- The correctness rows were recorded to test the functions {{ours}} has, so they favour it: nearly every row calls a function we built, and few rows call one that only another engine has. A function an engine lacks makes its row "not supported". The column "equal where it answered" leaves those rows and the crashes out, which is a fairer view of the answers each engine does give.
- The correctness rows were chosen to find edge cases, not to sample real use. A share of equal answers here says how often an engine agrees with Excel on hard cases, not on a typical workbook.
- The machine is shared with other work. We waited for a low load before each round and recorded the load, but small times (under a millisecond) can still move between runs.
- Machine: {{machine}}. Versions: {{versions}}.
- We never read the source code of HyperFormula, IronCalc, Univer or formulajs. We used only their public documentation, READMEs and type declarations, and ran them as black boxes.

HyperFormula's configuration:

```json
{{hyperformula-config}}
```
