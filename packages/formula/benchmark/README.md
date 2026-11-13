# eigen|formula⟩ compared with HyperFormula and formulajs

This folder compares eigen|formula⟩, Eigen's formula engine (`@workspace/formula`), with two other JavaScript formula engines: [HyperFormula](https://hyperformula.handsontable.com/) and [formulajs](https://formulajs.info). It measures three things, in this order of importance: speed, correctness and coverage. The numbers below come from one run on 2026-11-13. A script wrote them into `results.json`, and a second script wrote this README from that file and from `notes.md`. No number here is typed by hand.

```sh
cd packages/formula/benchmark
bun install            # installs hyperformula 3.5.0 and @formulajs/formulajs 4.6.1 into this folder only
bun run.ts             # measures everything and writes results.json (bun run.ts --help for options)
bun readme.ts          # writes this README.md from results.json and notes.md
```

`bun rows.ts <oracle folder>` rebuilds `excel-rows.jsonl`, the file of Excel's recorded answers, from the local recording files. It reuses the oracle's own reader in `scripts/oracle-rows.ts`. To regenerate everything after a change to the engine or to the recordings, run `bun rows.ts <oracle folder> && bun run.ts && bun readme.ts`.

## The results in three lines

- Speed on Bun: eigen|formula⟩ was faster than HyperFormula in 15 of the 17 workloads both ran, where HyperFormula took from 0.48× to 890× of our time; HyperFormula was as fast or faster in: edit a cell with 3 dependents; running total down 20,000 rows. eigen|formula⟩ was faster than formulajs in 8 of the 9 workloads both ran, where formulajs took from 0.07× to 54× of our time; formulajs was as fast or faster in: text functions on 100,000 rows.
- Correctness: of 17,584 answers recorded in Excel, eigen|formula⟩ gave Excel's answer on 92.0% and HyperFormula on 55.2%; formulajs, judged only on the 5,129 rows that are one function call, on 61.2% of those.
- Coverage: of Excel's 524 functions, eigen|formula⟩ has 219, HyperFormula 384 and formulajs 406.

## Words used in this README

- A **formula** is a cell's text that starts with `=` and computes a value, such as `=A1*2`.
- A **cell reference** is the name of a cell inside a formula, such as `A1`. A **range** is a block of cells, such as `A1:A100`.
- A **dependency** is a link from a formula to a cell it reads. When `B1` holds `=A1*2`, `B1` depends on `A1`, and `B1` is a **dependent** of `A1`.
- **Recalculation** is computing formulas again after a cell changes. A good engine computes only the dependents of the changed cell.
- A **lookup** searches a column for a value and returns something about the row where it found it, as `VLOOKUP`, `MATCH` and `XLOOKUP` do. An exact lookup wants the same value. An approximate lookup wants the largest value that is not above the key, in sorted data.
- A **volatile function** gives a new value every time it is computed, such as `NOW()` or `RAND()`.
- A formula **spills** when it gives a whole array of values and the values fill the cells below and to the right of it.

## How to read the tables

Each speed row is one workload. A workload is a workbook built in code, so anyone can run it again with nothing but the repo. A cell shows two times in milliseconds: the fastest round and the median round, as `fastest / median`. Lower is better. The ratio columns divide the other engine's median by ours. A ratio of 5× means the other engine took five times as long as eigen|formula⟩. A ratio below 1× means the other engine was faster. The memory row shows megabytes instead of times, and its ratio works the same way.

"not supported" means the engine cannot run that workload. "wrong values" means the engine ran it, but its values were not the same as ours, so its time does not count.

In the correctness tables, a row is one formula that a person typed into Excel for the web, with the answer Excel showed.

## Speed

Every engine runs each workload in a fresh process of its own, and never two processes at the same time. In each process the engine runs the workload up to three times, each time on a fresh engine, and the fastest run counts. The first run warms up the runtime. A process stops repeating after 20 seconds of runs, so a slow engine is timed fewer times in a process. There are several rounds, and each round starts all engines again, in a changing order, so a slower moment of the machine hits every engine alike. Before each run the benchmark waits until the 1-minute load of the machine is low, and a run during which the load rose above that limit is thrown away and taken again.

A workload without an edit measures the load: the engine gets the cells, reads the formulas and computes them all. HyperFormula computes every formula while it loads, so the load and the first full computation cannot be measured apart; the time is the two together for every engine. A workload with an edit loads first without the clock running, then measures the edit and the recalculation after it.

Before a time counts, the run checks the values. Each engine reports the values of a sample of cells after the workload, and they must match ours at 10 significant digits. We use 10 digits because HyperFormula rounds the numbers it gives out to 10 digits by default.

formulajs is a library of functions. It has no cells, no formula text and no recalculation. So it takes part only where the same answers come from plain function calls: the run gives it the columns as JavaScript arrays, built without the clock running, and times the calls. This is less work than an engine does, since nothing is parsed, stored or tracked.

The workloads:

- **load and compute 300,000 formulas.** 100,000 rows, each with two numbers and three formulas (arithmetic, IF, ROUND), loaded and computed.
- **edit a cell with 3 dependents.** In that workbook, one number in row 50,001 changes, and the three formulas on its row recompute.
- **edit a cell read by 100,000 formulas.** Cell A1 is read by 100,000 formulas (=B1*$A$1+1 and so on); A1 changes and every formula recomputes. This is a full recalculation.
- **load a chain of 100,000 formulas.** A1 is 1 and each cell below adds 1 to the cell above it (=A1+1, =A2+1, ...), 100,000 cells deep.
- **edit the start of a chain of 100,000.** In that chain, A1 changes, so all 100,000 cells below it recompute in order.
- **200 sums of 90,000 cells each.** 200 formulas =SUM(A1:A90000), =SUM(A2:A90001) and so on, over 100,000 numbers.
- **running total down 20,000 rows.** Each of 20,000 rows sums everything above it and itself: =SUM($A$1:A1), =SUM($A$1:A2) and so on.
- **exact VLOOKUP, 2,000 over 100,000 rows.** 2,000 formulas =VLOOKUP(E1,$A$1:$B$100000,2,FALSE) over 100,000 keys in no order.
- **approximate VLOOKUP, 2,000 over 100,000 rows.** 2,000 formulas =VLOOKUP(E1,$A$1:$B$100000,2,TRUE) over 100,000 sorted keys; each key falls between two.
- **exact MATCH, 2,000 over 100,000 rows.** 2,000 formulas =MATCH(E1,$A$1:$A$100000,0) over 100,000 keys in no order.
- **approximate MATCH, 2,000 over 100,000 rows.** 2,000 formulas =MATCH(E1,$A$1:$A$100000,1) over 100,000 sorted keys.
- **exact XLOOKUP, 2,000 over 100,000 rows.** 2,000 formulas =XLOOKUP(E1,$A$1:$A$100000,$B$1:$B$100000) over 100,000 keys in no order.
- **SUMIFS, 200 over 100,000 rows.** 200 formulas =SUMIFS($A$1:$A$100000,$B$1:$B$100000,E1,$C$1:$C$100000,F1), each with its own pair of criteria such as "k3" and ">37".
- **COUNTIFS, 200 over 100,000 rows.** 200 formulas =COUNTIFS($B$1:$B$100000,E1,$C$1:$C$100000,F1) on the same data.
- **text functions on 100,000 rows.** 100,000 formulas =UPPER(LEFT(A1,6))&"-"&LEN(TRIM(A1))&"-"&SUBSTITUTE(A1,"a","o") over short texts.
- **insert a row near the top.** In the workbook of 300,000 formulas, one row is inserted above row 2, so every formula below it moves and its references change.
- **memory after loading 300,000 formulas.** The memory the engine holds after the load and first compute of that workbook, in MB.

### On Bun

Bun 1.4.4: 5 rounds, at most 3 runs in each process. The load averages over 1, 5 and 15 minutes were 39.53 13.52 8.80 when the run started, before it waited for a quiet machine, and 3.00 4.45 9.66 at its end; the highest 1-minute load seen after a kept run was 5.96, and 13 runs were taken again because the machine got busy during them. The run took 3,725 seconds.

| workload | eigen\|formula⟩ | HyperFormula | HyperFormula ÷ eigen\|formula⟩ | formulajs | formulajs ÷ eigen\|formula⟩ |
|---|---|---|---|---|---|
| load and compute 300,000 formulas | 298.8 / 305.4 | 1,757 / 1,784 | 5.8× | not supported |  |
| edit a cell with 3 dependents | 0.30 / 0.30 | 0.22 / 0.25 | 0.84× | not supported |  |
| edit a cell read by 100,000 formulas | 10.8 / 11.2 | 158.7 / 179.0 | 16× | not supported |  |
| load a chain of 100,000 formulas | 49.1 / 51.5 | 292.3 / 301.8 | 5.9× | not supported |  |
| edit the start of a chain of 100,000 | 11.0 / 11.1 | 136.8 / 147.3 | 13× | not supported |  |
| 200 sums of 90,000 cells each | 36.7 / 37.2 | 3,033 / 3,143 | 85× | 284.5 / 289.7 | 7.8× |
| running total down 20,000 rows | 296.4 / 303.5 | 133.1 / 145.2 | 0.48× | 1,558 / 1,583 | 5.2× |
| exact VLOOKUP, 2,000 over 100,000 rows | 18.9 / 22.6 | 14,704 / 15,070 | 666× | 169.4 / 177.1 | 7.8× |
| approximate VLOOKUP, 2,000 over 100,000 rows | 18.8 / 21.3 | 14,061 / 14,165 | 666× | 168.3 / 175.4 | 8.2× |
| exact MATCH, 2,000 over 100,000 rows | 19.4 / 23.4 | 7,753 / 7,797 | 333× | 735.2 / 738.2 | 32× |
| approximate MATCH, 2,000 over 100,000 rows | 17.3 / 19.8 | 7,556 / 8,048 | 407× | 785.8 / 786.8 | 40× |
| exact XLOOKUP, 2,000 over 100,000 rows | 21.2 / 25.4 | 22,312 / 22,574 | 890× | not supported |  |
| SUMIFS, 200 over 100,000 rows | 61.7 / 64.3 | 7,006 / 7,100 | 110× | 3,373 / 3,453 | 54× |
| COUNTIFS, 200 over 100,000 rows | 50.9 / 52.9 | 5,690 / 5,910 | 112× | 1,492 / 1,521 | 29× |
| text functions on 100,000 rows | 408.5 / 412.7 | 1,216 / 1,298 | 3.1× | 30.8 / 30.9 | 0.07× |
| insert a row near the top | 1.18 / 1.35 | 10.2 / 10.3 | 7.6× | not supported |  |
| memory after loading 300,000 formulas | 9.7 MB | 152.6 MB | 16× | not supported |  |

### On Node

Node v24.15.0: 5 rounds, at most 3 runs in each process. The load averages over 1, 5 and 15 minutes were 3.00 4.45 9.66 when the run started, before it waited for a quiet machine, and 3.11 3.17 4.12 at its end; the highest 1-minute load seen after a kept run was 5.38, and 2 runs were taken again because the machine got busy during them. The run took 1,694 seconds.

| workload | eigen\|formula⟩ | HyperFormula | HyperFormula ÷ eigen\|formula⟩ | formulajs | formulajs ÷ eigen\|formula⟩ |
|---|---|---|---|---|---|
| load and compute 300,000 formulas | 420.8 / 426.0 | 2,434 / 2,455 | 5.8× | not supported |  |
| edit a cell with 3 dependents | 0.37 / 0.39 | 0.20 / 0.25 | 0.64× | not supported |  |
| edit a cell read by 100,000 formulas | 13.2 / 13.6 | 124.1 / 129.1 | 9.5× | not supported |  |
| load a chain of 100,000 formulas | 51.1 / 51.9 | 366.9 / 368.7 | 7.1× | not supported |  |
| edit the start of a chain of 100,000 | 16.0 / 16.1 | 92.0 / 92.7 | 5.8× | not supported |  |
| 200 sums of 90,000 cells each | 41.9 / 43.0 | 2,879 / 2,902 | 68× | 422.5 / 427.4 | 9.9× |
| running total down 20,000 rows | 365.1 / 369.7 | 180.9 / 184.7 | 0.50× | 1,598 / 1,605 | 4.3× |
| exact VLOOKUP, 2,000 over 100,000 rows | 25.0 / 26.1 | 17,283 / 17,541 | 671× | 122.9 / 123.4 | 4.7× |
| approximate VLOOKUP, 2,000 over 100,000 rows | 24.5 / 24.9 | 17,373 / 17,708 | 711× | 146.5 / 148.0 | 5.9× |
| exact MATCH, 2,000 over 100,000 rows | 24.4 / 28.0 | 8,844 / 8,889 | 318× | 1,066 / 1,090 | 39× |
| approximate MATCH, 2,000 over 100,000 rows | 19.5 / 24.0 | 8,880 / 8,890 | 370× | 1,653 / 1,684 | 70× |
| exact XLOOKUP, 2,000 over 100,000 rows | 25.9 / 26.1 | 34,860 / 35,039 | 1,343× | not supported |  |
| SUMIFS, 200 over 100,000 rows | 74.2 / 75.8 | 12,711 / 12,837 | 169× | 5,481 / 5,519 | 73× |
| COUNTIFS, 200 over 100,000 rows | 68.1 / 68.6 | 9,866 / 9,980 | 146× | 4,176 / 4,229 | 62× |
| text functions on 100,000 rows | 554.2 / 555.3 | 2,307 / 2,328 | 4.2× | 49.4 / 50.0 | 0.09× |
| insert a row near the top | 0.85 / 0.94 | 14.7 / 15.2 | 16× | not supported |  |
| memory after loading 300,000 formulas | 42.6 MB | 252.0 MB | 5.9× | not supported |  |

Speed on Node: eigen|formula⟩ was faster than HyperFormula in 15 of the 17 workloads both ran, where HyperFormula took from 0.50× to 1,343× of our time; HyperFormula was as fast or faster in: edit a cell with 3 dependents; running total down 20,000 rows. eigen|formula⟩ was faster than formulajs in 8 of the 9 workloads both ran, where formulajs took from 0.09× to 73× of our time; formulajs was as fast or faster in: text functions on 100,000 rows.

### Where another engine was as fast or faster

- Node, edit a cell with 3 dependents: HyperFormula took 0.64× of our time.
- Node, running total down 20,000 rows: HyperFormula took 0.50× of our time.
- Node, text functions on 100,000 rows: formulajs took 0.09× of our time.
- Bun, edit a cell with 3 dependents: HyperFormula took 0.84× of our time.
- Bun, running total down 20,000 rows: HyperFormula took 0.48× of our time.
- Bun, text functions on 100,000 rows: formulajs took 0.07× of our time.

## Correctness

The answers were recorded by hand in Excel for the web in November 2026, in the family and batch files of the formula engine's oracle. `excel-rows.jsonl` holds 17,584 of them: for each, the formula as it was typed in Excel, the cells it reads, and Excel's answer with its kind. The oracle already left out the rows Excel refused at entry and the rows with volatile functions. 4 more rows gave an array whose values Excel did not show in full, so there is nothing to compare, and they are left out too.

Each row runs in a fresh engine. The formula goes into cell U21 of a sheet that holds the cells it reads. Its value is compared with Excel's by the oracle's own rule: numbers equal at 15 significant digits, and texts, true or false values and errors exactly. An array answer is judged by its size and by each of its values, each read through `INDEX` in a fresh engine.

A row gets one of four verdicts. **equal**: the engine gave Excel's answer. **differs**: it gave another answer. **not supported**: it answered `#NAME?` (an unknown function) or `#ERROR!` (a formula it cannot read) where Excel did not. **crashed**: it threw an error, or it did not answer within 20 seconds.

Our own deliberate differences from Excel count as "differs" for us too. Examples are the dates in January and February 1900 and an empty text in arithmetic. [FUNCTIONS.md](../FUNCTIONS.md) lists every one of them with Excel's answer and ours.

formulajs is judged only on the rows that are one call of a function with plain values as arguments, such as `=ROUND(2.5,0)`: 5,129 rows, 29.2% of all. They need no cells.

| engine | rows judged | equal | differs | not supported | crashed | equal where it answered |
|---|---|---|---|---|---|---|
| eigen\|formula⟩ | 17,584 | 16,171 (92.0%) | 1,350 (7.7%) | 63 (0.4%) | 0 (0.0%) | 92.3% |
| HyperFormula | 17,584 | 9,703 (55.2%) | 3,555 (20.2%) | 4,138 (23.5%) | 188 (1.1%) | 73.2% |
| formulajs | 5,129 | 3,137 (61.2%) | 1,458 (28.4%) | 421 (8.2%) | 113 (2.2%) | 68.3% |

The share of equal answers per family of functions:

| family | eigen\|formula⟩ equal | HyperFormula equal | formulajs equal |
|---|---|---|---|
| mixed checks | 1,872 of 2,018 (92.8%) | 756 of 2,018 (37.5%) | 157 of 372 (42.2%) |
| date and time | 2,692 of 3,215 (83.7%) | 2,302 of 3,215 (71.6%) | 1,182 of 1,810 (65.3%) |
| logical and information | 2,243 of 2,357 (95.2%) | 1,440 of 2,357 (61.1%) | 385 of 507 (75.9%) |
| math | 1,439 of 1,540 (93.4%) | 968 of 1,540 (62.9%) | 627 of 771 (81.3%) |
| lookup and reference | 2,159 of 2,382 (90.6%) | 988 of 2,382 (41.5%) | 12 of 247 (4.9%) |
| statistical | 3,129 of 3,201 (97.8%) | 1,717 of 3,201 (53.6%) | 263 of 490 (53.7%) |
| text | 2,637 of 2,871 (91.8%) | 1,532 of 2,871 (53.4%) | 511 of 932 (54.8%) |

Rows that did not answer within 20 seconds, counted as crashed:

- HyperFormula: `=WORKDAY(A1:A5,10,G1:G3)`
- HyperFormula: `=WORKDAY(45000,A1:A5,G1:G3)`
- HyperFormula: `=WORKDAY.INTL(A1:A5,10,1,G1:G3)`
- HyperFormula: `=WORKDAY.INTL(45000,A1:A5,1,G1:G3)`
- formulajs: `=WORKDAY(45000,1E+300)`
- formulajs: `=WORKDAY(45000,-1E+300)`
- formulajs: `=WORKDAY.INTL(45000,1E+300)`
- formulajs: `=WORKDAY.INTL(45000,-1E+300)`

## Coverage

Excel has 524 functions. The list is the one eigen|formula⟩ keeps of them (`EXCEL_2007_FUNCTIONS` and `EXCEL_FUTURE_FUNCTIONS`). For each engine we count the function names it registers that are on that list. For eigen|formula⟩ that is its function registry `FUNCTIONS`; for HyperFormula, `HyperFormula.getRegisteredFunctionNames('enGB')`; for formulajs, the functions it exports. "Other names" are names Excel does not have, such as Google Sheets functions or older spellings.

| engine | Excel's functions it has | share | other names it registers |
|---|---|---|---|
| eigen\|formula⟩ | 219 | 41.8% | 0 |
| HyperFormula | 384 | 73.3% | 39 |
| formulajs | 406 | 77.5% | 55 |

eigen|formula⟩ has fewer functions than both other engines today. HyperFormula has 189 of Excel's functions that we do not have. We have a few that HyperFormula does not: `AGGREGATE`, `AREAS`, `AVERAGEIFS`, `CELL`, `CONCAT`, `DOLLAR`, `ERROR.TYPE`, `FIXED`, `FORECAST`, `FORECAST.LINEAR`, `INDIRECT`, `INFO`, `INTERCEPT`, `LOOKUP`, `MODE`, `MODE.SNGL`, `NUMBERVALUE`, `RANK`, `RANK.AVG`, `RANK.EQ`, `TEXTAFTER`, `TEXTBEFORE`, `TYPE`, `XMATCH`. The missing ones are mostly statistical distributions, engineering and complex-number functions, financial functions, the database functions (`DSUM` and its kin) and the dynamic-array functions (`FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`). Some are common, such as `PMT`, `NPV`, `IRR` and `NORM.DIST`. They are planned for a later step of the engine. Missing functions matter most when a workbook from Excel uses one: such a formula shows `#NAME?` until the function exists. The correctness table above shows the effect on the recorded rows: a missing function makes a row "not supported".

Language features, each tested by running a probe formula and reading the answer (the answer is in brackets). formulajs has no formula language, so it has none of them.

| feature | probe | eigen\|formula⟩ | HyperFormula | formulajs |
|---|---|---|---|---|
| An array answer spills into the cells below | `=A1:A3*2 in C1, read C2` | no (blank) | yes (4) | no |
| Array arithmetic inside one formula | `=SUM(A1:A3*{1;2;3})` | yes (14) | yes (14) | no |
| A dynamic-array function (FILTER) | `=SUM(FILTER(A1:A3,A1:A3>1))` | no (#NAME?) | yes (5) | no |
| Implicit intersection with @ | `=@A1:A3 in row 2` | yes (2) | no (#ERROR!) | no |
| Structured table reference | `=SUM(Table1[Qty])` | no (#REF!) | no (#ERROR!) | no |
| LET | `=LET(x,2,x*3)` | no (#NAME?) | no (#NAME?) | no |
| LAMBDA called in place | `=LAMBDA(x,x+1)(2)` | no (#NAME?) | no (#ERROR!) | no |
| Whole-column reference | `=SUM(A:A)` | yes (6) | yes (6) | no |
| Reference to another sheet | `=Sheet2!A1*2` | yes (20) | yes (20) | no |
| 3-D reference across sheets | `=SUM(Sheet2:Sheet3!A1)` | no (blank) | no (#NAME?) | no |
| A circular reference is reported as an error | `=B1 in A1, =A1 in B1` | yes (#REF!) | yes (#CYCLE!) | no |
| A row insert rewrites the references | `=A1*2 in B5, insert a row above row 1, read B6` | yes (2) | yes (2) | no |
| A column insert rewrites the references | `=A1*3 in D1, insert a column before A, read E1` | yes (3) | yes (3) | no |

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
- **Spilling and dynamic arrays.** HyperFormula spills an array answer into the cells below and has `FILTER`, `SORT` and similar functions. eigen|formula⟩ keeps only the first value of an array in the cell.
- **Growing range sums.** In the running-total workload, where each formula sums a range that grows by one row, HyperFormula is faster than us: we read every cell of every range again, so the work grows with the square of the rows, and HyperFormula does not.
- **Small edits.** When one cell with only a few dependents changes, HyperFormula is a little faster than us. Both take well under a millisecond.
- **Plain text calls.** formulajs computes the text workload's calls much faster than our engine computes the same formulas. Part of that is that it parses, stores and tracks nothing, but our text formulas also cost clearly more per formula than the arithmetic formulas of the load workload, so there is room to improve.
- **A finished product.** HyperFormula has undo and redo, named expressions, custom functions, translations of function names, and a clipboard API. eigen|formula⟩ has none of these yet; its host is meant to give some of them.
- **formulajs is tiny to use.** It is just functions. For a program that only needs to call `PMT` or `NORM.DIST` on its own numbers, it is the simplest choice.

## Fairness and limits of this benchmark

- HyperFormula runs with the configuration from its own guide to compatibility with Microsoft Excel, with Excel's grid size added, since its default stops at 40,000 rows. It is built with `licenseKey: 'gpl-v3'`. The two names `TRUE` and `FALSE` are defined as its guide shows. The exact configuration is below.
- For the lookup workloads, HyperFormula also gets `useColumnIndex: true`, which its performance guide advises for `VLOOKUP` and `MATCH`: {"exact VLOOKUP, 2,000 over 100,000 rows":{"useColumnIndex":true},"approximate VLOOKUP, 2,000 over 100,000 rows":{"useColumnIndex":true},"exact MATCH, 2,000 over 100,000 rows":{"useColumnIndex":true},"approximate MATCH, 2,000 over 100,000 rows":{"useColumnIndex":true},"exact XLOOKUP, 2,000 over 100,000 rows":{"useColumnIndex":true}}. The other workloads use its default.
- HyperFormula loads through `buildFromSheets`, its bulk load, and computes during the load. Edits use `setCellContents` and `addRows`, one call each, which is how its documentation shows a single change.
- HyperFormula's time in the lookup, sum and criteria workloads grows with the number of formulas that name a long range, and we saw the same cost when the formula could not search at all. So most of its time there goes into setting up those formulas, not into searching. We found no setting in its documentation that changes this. So we gave those workloads fewer formulas than the others, as their descriptions say, so that a run ends in reasonable time.
- Our adapter turns each typed formula into stored text inside the timed load. HyperFormula also reads typed text, so both parse the same input.
- formulajs takes plain JavaScript arrays and does no parsing, storing or dependency tracking. Its times are therefore a lower bound of what an engine built on it would take.
- formulajs gives a date as a JavaScript `Date`. Before we compare it with Excel, we turn it into Excel's day number from its local date and time.
- The speed workloads are synthetic. Real workbooks mix many shapes, functions and sizes. The engine's own bench script, `scripts/bench.ts`, times real workbooks against design gates, but those files are not in the repo.
- The correctness rows were recorded to test the functions eigen|formula⟩ has, so they favour it: nearly every row calls a function we built, and few rows call one that only HyperFormula or formulajs has. A function an engine lacks makes its row "not supported". The column "equal where it answered" leaves those rows and the crashes out, which is a fairer view of the answers each engine does give.
- The correctness rows were chosen to find edge cases, not to sample real use. A share of equal answers here says how often an engine agrees with Excel on hard cases, not on a typical workbook.
- The machine is shared with other work. We waited for a low load before each round and recorded the load, but small times (under a millisecond) can still move between runs.
- Machine: Apple M1 Pro, 10 cores, 32 GB, Darwin 27.2.0 arm64. Versions: Bun 1.4.4, Node 24.15.0, HyperFormula 3.5.0, formulajs 4.6.1.
- We never read HyperFormula's or formulajs's source code. We used only their public documentation, READMEs and type declarations, and ran them as black boxes.

HyperFormula's configuration:

```json
{
  "licenseKey": "gpl-v3",
  "dateFormats": [
    "MM/DD/YYYY",
    "MM/DD/YY",
    "YYYY/MM/DD"
  ],
  "timeFormats": [
    "hh:mm",
    "hh:mm:ss.sss"
  ],
  "currencySymbol": [
    "$",
    "USD"
  ],
  "localeLang": "en-US",
  "functionArgSeparator": ",",
  "decimalSeparator": ".",
  "thousandSeparator": "",
  "arrayColumnSeparator": ",",
  "arrayRowSeparator": ";",
  "nullYear": 30,
  "caseSensitive": false,
  "accentSensitive": true,
  "ignorePunctuation": false,
  "useWildcards": true,
  "useRegularExpressions": false,
  "matchWholeCell": true,
  "useArrayArithmetic": true,
  "ignoreWhiteSpace": "any",
  "evaluateNullToZero": true,
  "leapYear1900": true,
  "nullDate": {
    "year": 1899,
    "month": 12,
    "day": 31
  },
  "smartRounding": true,
  "maxRows": 1048576,
  "maxColumns": 16384
}
```
