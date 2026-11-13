# Proposal: the Sheets engine and data model

This proposal rebuilds Sheets around one data model. A cell lives in one store in memory, the op log holds what people typed and nothing computed, and one new formula engine, built clean room from our own fact documents, derives every value on every reader. It says where we end, the four steps that get there, what the owner ruled before the first step, and what each session reads and leaves behind. How Sheets works today is in [SHEETS.md](../SHEETS.md).

**Status:** signed by the owner on 11 Nov 2026. Step 1a is built: `packages/formula` computes 219 functions, tiers 1 and 2 complete ([FORMULA.md](../FORMULA.md)); steps 1b to 3 are not. The eleven decisions of [Part 3](#part-3-the-owners-rulings) are ruled: 1 to 4 and 9 to 11 as recommended; offsets, with every stored-format change at once in step 1b and no conversion of older documents (5); formulajs out, tiers 0 to 2 in step 1a and 3 to 5 in step 2 (6); all six Google picks (7); all seven product picks (8). Third version, revised once (v3.1) and once for the sign-off, 11 Nov 2026. The second version designed the engine on today's data model. Since then three things landed: a study of the data model and its falsifier, the measurements of unit 0, and the owner's end goal. What they changed is in [§ What changed since the second version](#what-changed-since-the-second-version). Written against branch `formula-engine` (from develop 3de38e63b) and `sheets-wave2` at 2f412a21f, 29 commits ahead of develop. Every claim about the code is a pointer: verify it before building on it. The measurements, research and oracle runs are local working files of the program; this document repeats every number it relies on. The signature is not the yes for a new package or for `numfmt` in a new manifest: those are asked again, each as its own question, in the prompt that starts step 1a.

> **TLDR**: Today a cell exists in eight forms with about twenty conversions between them, a formula's value is stored three times beside the formula that determines it, and about 150 of the 486 Sheets fixes since May patch that model and its sync. The end state has three forms: a record in the snapshot, a slot in typed columns, and an op. The typed columns are the engine's and the workbook's at once, so the grid paints what the engine computed and nothing is copied. The log holds inputs in a closed vocabulary of nine op kinds. Every tab and the server derive values with the same engine, which stores a formula as a **shape**: its text with relative references as offsets, so the owner's reference workbook has 1,001 shapes for 125,519 formulas. Measured on a prototype: full recalc 10.9 ms on Bun and 25.8 ms on Node against 1.49 s today, a hub edit 1.1 and 3.0 ms against 106 ms, open 6.4 and 10.2 ms. The engine is far inside its gates, and the host path around it is what is slow, so the plan moves the host onto the engine's model in four steps, one session each: (1a) the engine, headless; (1b) the closed op vocabulary and the flip, with the stored format changed once and no reader for the old one; (2) inputs only, every reader derives; (3) the grid reads the one store and fortune-sheet's `data` matrix goes. The price: 14,000 to 16,000 lines of our own for the engine, in place of 8,445 lines of formulajs nobody here can read; about 2,000 to 2,500 host lines written in one step and deleted in a later one; and a last session that touches about 800 places in the grid, which the owner decides on again when it has a list.

## Goals

The owner's, 11 Nov 2026.

1. **The data models match.** Cell values and the rest are not stored in N places. The base is clean, simple, robust and easy to understand. The engine rewrite serves this goal.
2. Clean code first: one grammar, one stored form, one evaluator, one transform, one store, one writer, typed values, functions as a signature plus a pure body.
3. Maybe fewer lines. Not met in lines we own for the engine: see [§ Code budget](#code-budget). Met in the host: each step deletes more host code than it adds.
4. Very fast: the gates in each step, on Bun and on Node, for the engine and from keypress to painted.
5. No backward compatibility. Clean room: implementers build only from our documents, never from upstream code.

## The problem, in numbers

All from one M1 Pro, bun 1.4.4 and Node 24.15.0, 11 Nov 2026. The reference workbook is the owner's `test.xlsx`: 125,519 formulas, 130,727 cells with a value or a formula, 736,695 with a style, 16 sheets.

| What | Today |
|---|---|
| Forms a cell has at once | 8, with about 20 named conversions ([§ Today against the end state](#today-against-the-end-state)) |
| Sheets fixes since 11 May that patch the data model and its sync | about 150 of 486 (31%); by keyword over all behaviour commits, 401 of 840 |
| Full recalc | 1.49 s, of which 34% is the parser, because nothing parsed is kept |
| Edit one cell with 11,444 dependents | 106 ms in the engine; 208 ms to the editor's committed state, nearly all of it inside the immer recipe |
| What that edit sends | up to 11,444 computed cells, about 1.9 MiB of ops |
| Insert one row near the top of MASTER DATA | 367 ms headless; 461 ms to the editor's committed state; the owner measured 1.4 s painted |
| Full recalc, gov.uk RTS, NFL, Apportion | 24 s, 396 s, 982 s |
| Two people edit two inputs of one total at once | the total is wrong for everyone until a third edit |
| Corpus oracle (1,097,024 formula cells with an Excel value) | 84.85% match, 0.67% mismatch, 14.48% not evaluated |
| Known engine defects | 60, of which this design fixes 48 |
| Size of the engine | 4,754 lines in the files step 1b deletes, `engine/parser/` and the ten files its § Deletes names (1,282 of them a hand-edited parse table nobody can regenerate), 201 of editor glue, 8,445 lines of formulajs and a 51-line patch on it |

Two roots explain nearly all of it.

1. **The formula's text is its only form.** Every evaluation, row insert and rewrite reads the text again, with two grammars that disagree, values without a type and range reads that copy. The engine design in [§ Reference: the engine](#reference-the-engine) answers this.
2. **The cell has no single home.** The wire is whatever immer wrote, a computed value travels as a cell write, and each form of the cell is kept in step with the others by a conversion that can disagree with the next one. Part 1 answers this.

## Part 1: the end state

Where Sheets is when step 3 has landed. Steps 1b and 2 each stop at a state of their own on the way, described in [Part 2](#part-2-four-steps).

### In ten lines

- A cell lives in **one store**: typed columns per sheet, owned by `packages/formula`. The engine computes on them and the grid paints from them. There is no second copy and no write-back.
- **One writer.** `applyOps(workbook, batch)` is the only function that changes a workbook, for a local edit, a peer's batch, an undo, a replay and the server alike. It returns the inverse ops.
- **The log holds inputs.** A batch is a list of ops from a closed vocabulary of nine kinds. An op names a cell, a range, a record by id or a sheet field, never a path. Nothing computed is sent.
- **Every reader derives values** with the same engine: after each batch on a live tab, once at the end of a replay, on the server when a read needs them.
- **The snapshot holds inputs and values.** Its values are state: the base every reader's recalc starts from. Only the server writes it.
- A formula is stored as its **shape text** ([§ Reference: the engine](#reference-the-engine)): offsets and sheet ids. A row insert ships a marker, and every reader runs one pure transform.
- **Undo is inverse ops**, per tab, shifted under a peer's row or column op by the functions the cells went through.
- **A value has one copy.** No display text `m` and no value type `ct.t` are stored. A reader formats when it reads (owner, 11 Nov 2026).
- The Yjs document stays what it is: an ordered log and a snapshot register. The log's order is the truth.
- formulajs, the old engine, fortune-sheet's `data` matrix, `celldata`, the patch translator and the anchors are gone.

### Where a cell lives

**One store, in typed columns.** Per sheet and column, parallel typed arrays. The first four are the engine's own design ([§ Cells and values](#cells-and-values)); the last two are ids the store moves and never reads.

| Plane | Type | Holds |
|---|---|---|
| `kind` | `Uint8Array` | empty, number, boolean, text, error; one bit for "no input here, the value comes from a spill anchor"; the recalc flags |
| `num` | `Float64Array` | the number |
| `ref` | `Int32Array` | text id in the workbook's string table, error code, or the boolean |
| `shape` | `Int32Array` | 0 for a literal cell, else the shape id of its formula |
| `style` | `Int32Array` | id into the workbook's style table: number format, font, colours, alignment, rotation, the cell's own border sides |
| `extra` | `Int32Array` | 0, or an id into the sheet's list of rare extras: rich-text runs, a link, comment card ids |

So a cell's input is its literal value, or its shape, or nothing. Its value is in the value planes whoever produced it, and a reader of values never asks whether a formula did. A row insert is one `copyWithin` per column, over all six planes at once, because one column has one length. That is why the two id planes live in the store and not beside it: two holders of one column's length would have to agree, which is the audit's second root.

**Everything that is not a cell is a record keyed by id, with ranges.** Merges, conditional formats and validations (Wave 2's F9 already stores these as records with an order key), images, charts, the filter, the frozen pane, row and column sizes and hidden flags. They live in `packages/sheet/src/engine/` beside the store, in one `Workbook` object per document. Each record's ranges move through `mapIndex` and `mapSpan`, the two functions the cells and the formulas move through.

**The grid reads through four accessors and writes by building ops.** `cellValue` and `cellDisplay` exist today in `engine/format.ts`; step 1b adds `cellInput` and routes every reader of display text through them, and step 3 adds `cellStyle` and moves all four from a `Cell` onto a place in the workbook. fortune-sheet's components, canvas painter, event handlers and view state (selection, the open editor, scroll, dialogs) stay, immer included for the view. What goes is `ctx.sheets[i].data` as the cell store and every writer's direct mutation of it.

**Display text is formatted at read.** A cell stores its value and its number format. The grid, copy as text, find and replace, the server's HTML, PDF and preview exports and chart labels format through `numberDisplay` when they read. A memo per value and format is added only if a measurement shows painting is slow (owner, 11 Nov 2026). Measured: formatting is 70% of writing a result today, and 11,444 results cost 6.6 to 9.7 ms with `m` and 2.0 to 2.7 ms without.

### What the Yjs document holds

Two roots, as today, under new names so that an old build's data can never be mistaken for new.

- **The log**: a `Y.Array` of batches under a new key. A batch is the ops of one edit. Every reader applies batches in the array's order, and that order is the only source of convergence. Yjs merges nothing inside a workbook.
- **The snapshot**: one JSON string, `eigensheets/3`. Cells as a list of closed cell records in column order ([§ Step 1b](#step-1b-the-wire-and-the-flip)), with styles, border payloads and formula texts interned (1,001 formula strings on the reference workbook where v2 stores 125,519). Each formula cell carries its value, and a spilled value carries a mark that says it is no input. No `m`, no `ct.t`, no `mc`. The `computed` flag stays, with the meaning it has today: false says the snapshot holds formulas nobody computed yet. The codec lives in lib and decodes to a neutral list; the workbook is loaded from that list in `packages/sheet/src/engine/`.

**The closed op vocabulary.** Each kind has one validator at the boundary and one applier. A peer's op is untrusted: the validator checks shape and caps, the applier never walks a path.

| Kind | Says | Replaces |
|---|---|---|
| `input` | one cell's content: a literal, a formula as shape text, rich-text runs, or nothing | immer writes to `data/r/c/v`, `f`, `ct.s` |
| `format` | a style change over ranges: the keys it names, set or cleared, borders among them | writes to a cell's style keys and to `config.borderInfo` |
| `cells` | a rectangle of whole cells landed at once: paste, fill, sort, an undo's restore | whole-cell writes; the audit's D10 block |
| `result` | a value its author computed for a formula cell. A reader that can derive the cell ignores it (see [§ Who computes values](#who-computes-values)) | computed `v`, `m` and `ct` travelling as cell writes |
| `record` | set fields of one record by id, or delete it: a merge, a rule, a validation, an image, a chart, a row or column size | writes below `config`, `conditionalFormats`, `dataValidations`, `images`, `charts` |
| `field` | a sheet scalar: name, order, hide, colour, frozen pane, filter range, gridlines | plain field writes and `renameSheet` |
| `lines` | insert or delete rows or columns | `insertRowCol`, `deleteRowCol` |
| `move` | a block of cells moved to another place: cut and paste, drag | cell writes plus `moveFormulaRefs` on the author |
| `sheet` | add a sheet with its content, or delete one | `addSheet`, `deleteSheet` |

Three rules hold for all nine. An op that names a cell always has a target, because every cell exists. An op that names a record sets it or deletes it by id, and a write to a record that is gone is skipped alone. A `lines`, `move` or `sheet` op the workbook refuses fails its whole batch, as today, because the batch's other ops were written for the rows it would have moved. So the deny list in `opToPatchOnSheets`, `normalizeSheetConfig` as a correctness rule, "creating a collection ships it whole" and the path walker of `applySheetWrites` have nothing left to do.

One behaviour changes and is accepted: a `record` op sets top-level fields of one record, so two people who change the same field of one chart at once get the later one, as today, and a write below a field no longer exists as a case.

The vocabulary is closed, not frozen. A new kind can be added later without converting a document. A kind's meaning cannot change, which is why `result` is defined once, for the step where every reader stores it and the step where most readers ignore it. The cell payload of `input`, `cells` and `sheet` is the same closed record the snapshot holds, with one validator.

### Who computes values

**Every reader, with the same engine, from the same inputs.** A live tab applies a batch and recalculates the cells it can affect. A replay applies the whole log and recalculates once at the end, which is valid because no later batch is a delta against a computed value. The server does the same when a read needs values and the log is not empty.

**A value is state in exactly two cases, and then its author's value is stored.** Both are formulas whose value the stored inputs do not determine.

- **This build cannot evaluate it** (another workbook, `GETPIVOTDATA`, a user-defined function, a 3-D reference, a function not shipped). The cell keeps the file's number, as the owner ruled. An import and a paste of such a cell carry that number.
- **It reads a clock or a random source** (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`, `RANDARRAY`). It is computed by the author of an edit that writes it or changes one of its precedents, and that value travels as a `result` op. Every reader stores it and derives the cells that read it. A reader's own recalc never calls a clock. So `=NOW()` shows the moment of its last touch, on every tab and in every export alike, as today.

Everything else is derived and never sent. That gives one sentence for the whole model: **a formula's value is sent only when no reader could compute it.**

**The snapshot's values are state too.** A reader loads them and recalculates only what the log's edits reach. A cell no edit reached keeps the number the snapshot holds: Excel's, for an imported file, which the owner ruled the import trusts. So the values cannot be dropped and rebuilt, and nobody but the server writes them. The server's fold is `applyOps` over the log, one recalc, one encode, whole or not at all. A fold whose recalc passes its counted cap does not swap, as today.

**What this fixes that no patch could.** Two people edit two inputs of one total at once: today the total keeps one author's number for everyone. Derived, it is right on every reader. A hub edit sends one op, not megabytes. Two edits to the inputs of one total commute, so fewer late batches force a replay. A spilled value never competes with a typed one: it is derived, never sent, and the snapshot marks it so that a load does not read it as typed. And two builds of the engine in one document can show two numbers but can no longer store them.

**What it costs.** Every open tab and the server pay the recalc of every edit. Measured per batch, worst edit found, Bun and Node: reference 1.1 and 3.0 ms, RTS 0.27 and 0.57 ms, NFL 58 and 96 ms, minibus 5.9 and 11.5 ms, Apportion 849 and 1,530 ms by scan. Apportion is why the column index is built ([§ The function library](#the-function-library)); step 2 does not land until that workbook's worst edit is under its gate. A recalc runs at most once per frame over the union of the batches that arrived, and a hidden tab only marks.

### Undo

Per tab, as ruled. An entry is the inverse ops of what the edit applied, in the same vocabulary as the log. `applyOps` returns them, since only the writer sees the old state. An undo applies its entry through `applyOps` and sends it as an ordinary batch. Before it writes, it checks that each target still holds what the edit left there and skips it otherwise (today's `stillWritten`), which is simple now: a cell holds only inputs.

A peer's `lines` op shifts the entries left on the stacks through one function, `shiftOps(ops, edit)`, built on `mapIndex`, `mapSpan` and the formula transform. A `cells` block a peer's insert runs through is split in two; rows a peer deleted are cut from its payload; an entry the op makes meaningless is dropped, as today. The owner's rule U2 stays: a peer's batch ends your structural steps.

### A late batch

A batch can land in the log before batches a tab already applied. If it commutes with them, it applies on top (`commutes`, now over ops: no structural op on either side, no two ops on one cell, range or record). If it does not, the tab rolls back: it applies the inverses of the batches it applied after that point, newest first, then applies the log's batches from there, and recalculates once. `applyOps` returns every inverse anyway, and a tab keeps them for its newest batches in a ring. That replaces the anchors, which today are kept copies of the sheets, at the same cost (the distance back) and with no copy. A batch older than the ring reloads the document in place: decode, apply the log, recalculate. Both undo stacks empty, as they do on a replay today. A wrong inverse would part a tab from the log in silence, so a property test holds "apply, then the inverse, gives the same bytes" for every kind.

What stays as it is: ops are not transformed against a concurrent row op, so a batch recorded before a peer's row insert that lands after it writes at the rows it recorded. That is a sync topic with its own parked row. With closed ops its fix would be `shiftOps` over nine kinds.

### Today against the end state

**The forms of a cell.**

| # | Today | End state |
|---|---|---|
| 1 | An interned record in the snapshot string | Stays: `eigensheets/3`, written only by the server |
| 2 | A `{r, c, v}` entry in `Sheet.celldata` | Gone |
| 3 | A `Cell` object in the dense matrix `Sheet.data[r][c]`, holding the value as `v`, `m` and `ct.t` | Gone. The value is one slot in the store |
| 4 | That object as an immer draft or a frozen object in `ctx.sheets` | Gone. immer keeps the view state only |
| 5 | An immer patch, and its inverse in an undo entry | Gone. An undo entry is ops, form 6 |
| 6 | An `Op` in the log, a raw immer patch with a path | Stays, as one of nine closed kinds, inputs only |
| 7 | An older copy in an anchor | Gone. A late batch that does not commute is rolled back by inverse ops |
| 8 | The engine's view: a keyed formula in `FormulaGraph`, a slot in `DependencyIndex`, a value in a local map | Becomes the one store: a slot in the typed columns |

Three forms where there were eight: the snapshot record, the slot, the op.

**The conversions.**

| Today | End state | Goes in |
|---|---|---|
| `encodeSheetsSnapshot`, `decodeSheetsSnapshot`, `decodeOrDefault` | Stay in lib: snapshot to a neutral cell list and back, the only serialization. `loadWorkbook` and its reverse sit above them | changed in 1b; the workbook loaded from the list in step 3 |
| `celldataToData`, `dataToCelldata`, `withMaterializedData`, `withSyncedCelldataIfData`, `initSheetData`, `storedCopy` | Gone: there is no matrix and no cell list | step 3 |
| `normalizeSheetConfig` | Gone as a correctness rule: no op creates a collection | 1b |
| `writeSheets` | Gone: nothing is copied into an immer context | step 3 |
| `filterPatch`, `recordEntry`, `patchToOp` | Gone: writers build ops, and `applyOps` returns the undo entry | entries become ops in 1b; all three gone in step 3 |
| `opToPatchOnSheets`, `applySheetWrites` | `applyOps`, one applier per kind | 1b |
| `shiftEntries` | `shiftOps` | 1b |
| `setFormulaCellInfo`, `followPatches`, `shift` | Gone: the index is derived from the store | 1b |
| `writeFormulaResult`, `holdsFormulaResult` | Gone: a result is written once, where it is computed | changed in 1b, gone in step 3 |
| `readSheetsFromDoc`, `compactSheetsSnapshot` | Stay: decode, `applyOps`, recalc, encode | simpler in step 2 |

Four conversions where there were about twenty: decode, encode, `applyOps`, and the xlsx import and export at the product's edge.

### What it overturns

The owner struck the first three on 11 Nov 2026, each as its own decision in [Part 3](#part-3-the-owners-rulings).

- **SHEETS.md § "The editor computes on write, the server only what nobody computed."** Right for an engine whose hub edit took 106 ms. It is the root of the second-largest fix cluster and of the stale total. Overturned in step 2 (decision 2).
- **PROPOSAL_SHEETS_YJS_WORKBOOK.md, "keep the stable-id Yjs design as the direction".** Closed, not deferred (decision 3). Offsets need one agreed order of structural edits, which a log gives and a Yjs map of cells does not; formulas stored against row ids would be one text per cell (125,519 on the reference workbook against 1,001) and end the sharing the engine is built on. Its second trigger ("the API can recalculate fast enough that computed values need not be stored") has arrived and is answered on the log. Its four rulings stand: no backward compatibility, no operational transform, no `"row_col"` map, no Yjs structures for `config` alone. Compacting while editors are connected stays parked with its trigger.
- **The audit's E2 as ruled** (drop the `computed` flag). The flag stays, because the snapshot's values are state (decision 4).
- **The audit's S5, superseded, not wrong.** `applySheetWrites` landed as the one applier. Its rules (what is skipped alone, the caps at the write) carry over; its body, a walker of immer paths, is replaced by an applier per kind.
- **The audit's S10, D10, D9 and U6** are built here: the closed vocabulary, the block of cells, merges recorded once, and one op transformer for undo entries. **S9** (the server orders the log) and **U7** (row ids) are not.
- **Decisions 5, 15, 16 and 18 of the second version** (the engine's own copy, values in the log, two landings, where a spill lives) are answered by the end state and are no longer questions.

## Part 2: four steps

Four sessions, in the worktree `eigen-formula` on branch `formula-engine`, each started in a clean context from a hand-off prompt ([Part 4](#part-4-the-session-hand-off)). The first version of this plan had three; step 1 was cut in two at the package boundary, because one session cannot hold a new engine and the flip of the product onto it. Each step ends green: `bun run check`, its gates on Bun and on Node, a browser pass where it changes the product, its docs. Steps 1b and 2 each end at a product that works and could stay as it is.

**Why this cut.** The stored format changes once, and the build that changes it reads nothing an older build wrote. So everything stored goes into step 1b: the formula's form, the op vocabulary, the log key, the snapshot, the closed cell record, the display text. The engine comes first and headless (1a), so that the stored form is fixed after its parser and functions have met the oracle, not in the session that first writes them. Who computes is not a format: a build that derives values ignores the `result` ops it can do without, so step 2 changes no format. And the in-memory model is stored nowhere, so step 3 comes last, when the wire and the engine have stopped moving.

**Why the falsifier's "do not sign" becomes an order, not a no.** It advised against signing the engine as the only store before the engine existed, because the grid change is about 800 touch points backed by few of the counted fixes. The owner's goal settles the direction. The falsifier's points settle how: the host's sheets stay the truth while the engine and the wire change, the stored formats name cells and records and never a memory layout, the columnar snapshot and the batch clock are not built, and step 3 opens with a list of every site, which the owner signs before a line of it is built. Step 2 is a whole product and the place to stop if step 3 is not taken.

| | 1a: the engine | 1b: the wire and the flip | 2: inputs only | 3: one store |
|---|---|---|---|---|
| The product | unchanged | on the new engine | derives values | one model |
| The truth in memory | the host's `Sheet[]` | the same; the engine's store is a cache | the same | the store |
| A formula's value | as today | computed by the author, sent as `result`, written outside immer | derived on every reader, mirrored into host cells, not sent | derived in place |
| The log | as today | closed ops, new key | the same, results ignored | the same |
| The snapshot | as today | `eigensheets/3` | the same | the same |
| Undo | as today | ops; structural inverses from `applyOps` | entries hold inputs only | all inverses from `applyOps` |
| Copies of a value in a tab | 1, as `v`, `m`, `ct.t` | 2 (host cell, store) | 2 | 1 |
| The stored format | as today | changes once; older documents are not read | the same | the same |

**How every step is run.** Package tests: `cd packages/formula && bun test --isolate ./src/test/<folder>/` (the package gets a `test` script, which `scripts/check-test-layout.ts` requires, and the root a `test:formula` beside `test:sheet`). Sheet tests: `cd packages/sheet && bun test --isolate ./src/test/<area>/<file>.test.ts`. API tests: `cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/<domain>/<file>.test.ts`. The date functions and the sheet engine's date suites also run under `TZ=Europe/Amsterdam`, as TESTING.md asks. "On Node" means the bench and the oracle, not the unit tests: the repo has no Node test harness, so step 1a adds `packages/formula/scripts/` (`bench.ts`, `oracle.ts`), each bundled with `bun build --target node` and run with `node`, and every gate table is filled from both runs. Only the main agent runs `bun run check`.

### Step 1a: the engine, headless

**End state.** `packages/formula` exists, complete for tiers 0 to 2, tested and benched, with nothing in the product calling it but the range holders on `mapIndex` and `mapSpan`, number display and Excel's function names. The product behaves as today but for number display, which moves to numfmt 4 and Google's day line. Nothing stored moves. It can merge to develop as an unused package.

**Units, in order.**

| # | Unit | Delivers | Tests | Risk seam |
|---|---|---|---|---|
| A0 | **Start.** Rebase onto develop with Wave 2 merged. Three measurements on today's code, on a quiet machine, Bun and Node: the row insert's recipe split (the applier, the copy into the context, immer's finalise and patches); every distinct patch shape the writers emit, from a logger in `patchToOp` under the `packages/sheet` suite; the snapshot decode. Today's painted baselines for the hub edit, the row insert and the open, with the verify-in-browser skill | Host gates set from a run, not a sum; the translator sized from a list | — | Unit 0 could not run a browser. The falsifier's probe found about 95 ms of the row insert around the applier |
| A1 | **Text.** The package; lexer, parser, three printers, shapes and interning, A1 and sheet-name helpers, `tokens`, `mapIndex`, `mapSpan`; number display in its one home ([§ The package and its boundary](#the-package-and-its-boundary)) | 1,001 shapes on the reference workbook | `src/test/text/`: parsing cases, the round-trip law, the span table | The round-trip law `parse(print(p)) = p`, which unit 0 did not test |
| A2 | **Holders on `mapSpan`.** In `engine/rowcol.ts`: `shiftRules`, `shiftCellKeyed`, `shiftKeyedMap` with `LINE_MAPS`, the merge, filter and frozen-pane shifters, `shiftChartsAcrossSheets` and `mapChartRefs` | One rule for every numeric range | `packages/sheet/src/test/engine/rowcol.test.ts`, `test/state/modules/rowcol-ops.test.ts`, the chart tests | The only product change of this step |
| A3 | **Store and evaluation.** Typed columns with exact allocation at load; values, coercion, comparison; operators with broadcast and lift, array constants, `@`; the call wrapper; recalc on demand with cycles and the depth budget | Full recalc inside its gate | `src/test/values/`, `src/test/recalc/`: value cases, shuffled asking order, the two chains | An abandoned run leaves no value behind |
| A4 | **Index and incremental recalc.** The reverse index of rectangles, one list per sheet; marking; seeds for dynamic shapes; the counted cap | Edits cost their cone | `src/test/recalc/`: held against a fresh load | Run arithmetic for mixed absolute and relative ends |
| A5 | **Edits.** The transform, classes, the move map, sheet binding, `remapSheets`, the two flags | A row insert in 346 transforms | `src/test/edit/`: the 219 structural cases, the host × target × sheet table, the slow version | The class finder: Calc's three-year bug |
| A6 | **The column index, then functions.** The index first, gated on Apportion, on the `INDIRECT` workbook and on a workbook whose key column is a formula. Then tiers 1 and 2, fanned out by family | The corpus mostly computes; the count for the blank-result pick | `src/test/functions/<family>/`; the corpus oracle in four columns | If Apportion misses 250 ms or the `INDIRECT` workbook 8 ms, the owner hears it before step 2 is planned |
| A7 | **Close.** The oracle's 100 hand checks and the snap experiment closed; bench and oracle scripts in `packages/formula/scripts/`; the results file; ARCHITECTURE.md for the new leaf; the hand-off | Done, by the gates below | — | The hand checks need the owner's Excel account |

After A1, unit A2 runs beside A3; after A3, units A4, A5 and A6 touch separate folders, and A6's families fan out once the index has passed.

**Gates.** Bun and Node, warm, on the M1 Pro of the baseline. "Measured" is unit 0's prototype, which had 62 functions and no call wrapper, so each gate leaves room.

| Engine, reference workbook | Today | Measured (Bun / Node) | Gate |
|---|---|---|---|
| Open: load, parse the shapes, build the index | 985 ms | 6.4 / 10.2 ms | 30 ms |
| Open from xlsx: key every formula | 514 ms | 34.9 / 54.2 ms | 100 ms |
| Full recalc | 1,485 ms | 10.9 / 25.8 ms | 60 ms |
| Edit one cell, 2 dependents | 0.38 ms | 0.023 / 0.063 ms | 0.1 ms |
| Edit one cell, 11,444 dependents | 106 ms | 1.1 / 3.0 ms | 8 ms |
| Type a formula: parse, intern, rebuild the index | not split out | index 0.8 / 1.2 ms | 3 ms |
| Insert one row near the top of MASTER DATA, engine side | 367 ms with the host | 2.6 / 2.8 ms | 8 ms |
| Engine memory after open | about 123 MB for the graph alone | 7.5 / 11.9 MB | 20 MB |

| Engine, corpus | Today | Measured (Bun / Node) | Gate |
|---|---|---|---|
| RTS, full recalc; worst edit found | 24 s | 18 / 32 ms; 0.27 / 0.57 ms | 100 ms; 5 ms |
| NFL, full recalc; worst edit found | 396 s, 5.1 GB | 155 / 237 ms; 58 / 96 ms | 500 ms; 150 ms |
| Apportion, full recalc; worst edit found | 982 s; 120 s | 778 / 1,519 ms; 849 / 1,530 ms, by scan | 250 ms for both, with the column index |
| minibus, full recalc; index rebuild; process memory | 2.6 s | 21 / 43 ms; 6.3 / 8.6 ms; 26 / 18 MB | 100 ms; 12 ms; 30 MB |
| The workbook with 3,744 `INDIRECT` cells, any edit | — | 28 / 42 ms by scan | 8 ms, with the column index |
| Every corpus workbook | Apportion fails the chained pass | all finish; slowest index rebuild 6.5 / 9.3 ms | all finish; 15 ms |

The `INDIRECT` gate is set from the claim, not from what the prototype already does: if the column index serves those lookups, an edit there is 3,744 map lookups and as many reference parses. The correctness gates are in [§ Correctness gates](#correctness-gates); for this step every value and structural case, the corpus oracle with tier 3 to 5 names counted as not shipped, and the same answer on Bun and on Node in every corpus cell or the cell listed with its function.

**Leaves for 1b.** An engine nothing calls. The count for the blank-result pick. The list of patch shapes. Host gates from a run.

### Step 1b: the wire and the flip

**End state.** The product runs on the new engine. The old engine, formulajs and its patch are deleted. Every batch in the log is closed ops under the new key. The snapshot is `eigensheets/3`. A stored cell is a closed record: no `m`, no `ct.t`, no `mc`, a mark on a spilled value. Every reader of display text goes through `cellDisplay`. The host's sheets are still the truth and the engine's store is a cache of them, held to "equals a fresh load" by a test. Values are computed by the author and sent, as today, but written into plain host cells outside the immer recipe. A document an older build wrote is not read ([§ The stored format](#the-stored-format)).

**The closed cell record,** used by the snapshot and by the `input`, `cells` and `sheet` ops, with one validator in `packages/lib/src/sheets/ops.ts`. It is today's `Cell` with three keys gone and one added.

| Key | Holds | Change |
|---|---|---|
| `v` | a number, a text or a boolean; an error's code with `e: 1` beside it | The kind is the JSON type, or error. It replaces `ct.t` as the value type, so a text that reads like an error stays text (defect 3) |
| `f` | the shape text | was A1 |
| `ct.fa`, `ct.s` | the number format; rich-text runs | `ct.t` is gone. A cell is rich when `ct.s` is not empty, which is what the 26 lines that test `ct.t === 'inlineStr'` test from now on. A cell is a date when its number format is a date format, for the 10 sites that test `ct.t === 'd'` |
| `spill` | 1 on a value that came from a spill anchor and holds no input | New. The importer sets it from a dynamic array's `ref`; from step 2 the fold sets it. Without it a snapshot could not tell a spilled value from a typed one, and the anchor would read `#SPILL!` after a load |
| the style keys of `CellStyle`, `bg`, `rt`, `qp` | as today | listed; a key the validator does not know is refused, not kept |
| `link`, `commentCardIds` | as today | — |
| `m`, `mc` | — | Gone. Display text is formatted at read. A merge is its record in `config.merge` and nothing else on the wire or in the snapshot; the host fills `cell.mc` in memory at decode and in the merge applier until step 2 removes its last reader |

Pick 8e's date result lives here as an input: when a formula typed into a General cell returns a date, the author's edit sets the cell's number format in the same batch, as Excel does at entry. Nothing is derived at display and no plane is needed.

**Units, in order.**

| # | Unit | Delivers | Tests | Risk seam |
|---|---|---|---|---|
| B1 | **The vocabulary.** `packages/lib/src/sheets/ops.ts`: the nine kinds, the cell record, their validators, and `opReferences`. `applyOps` per kind on `Sheet[]` in `engine/replay-ops.ts`, replacing `opToPatchOnSheets` and `applySheetWrites`; it returns the inverse for `lines`, `move`, `sheet`, `record` and `field`. `patchToOp` maps immer's patches onto the kinds by the shapes A0 listed. `commutes` over ops. Cell undo entries are the same translation of immer's inverse patches; `shiftOps` replaces the shifting in `history-shift.ts`. The new log key. `references.ts` on `opReferences` | One wire, validated per kind | `packages/lib/src/test/sheets/ops.test.ts`; `packages/sheet/src/test/engine/replay-ops.test.ts`, `state/modules/history.test.ts`; `apps/sheets/src/test/components/sheets/hooks/use-sheet-order.test.tsx`; `apps/api/src/test/document/references.test.ts` | The largest host seam. The audit rated S10 high risk. Runs from the session's start, beside nothing it depends on |
| B2 | **The flip.** The adapter, in two halves: load and recalc over `Sheet[]` in `engine/`, where the server uses it, and the write into the editor's `Context` in `state/modules/`. Shape text in `Cell.f` and in formula rules. `eigensheets/3`. `m` and `ct.t` out, with every reader below on `cellDisplay`. Results written outside the recipe. The editor's callers (formula bar, typing, fill, paste, sort, cut as a `move`, F4, highlighting). xlsx import and export with the name and table resolvers and `@` insertion. `addSheetsBatch`; the demo seeder. Delete the old engine and formulajs | The product on the new engine | `structural-recompute`, `writers-recompute`, `formula-results` in `packages/sheet/src/test/state/modules/`; `held-graph.test.ts` rewritten against the adapter; `apps/api/src/test/import/sheets/`, `export/sheets/`, `document/document-sheets.test.ts`; the xlsx round-trip gate | Cannot land in halves. Every row of [§ Every caller](#every-caller) |
| B3 | **Close.** Docs; the closing review; the hand-off | Done, by the gates below | the browser pass | — |

**The media and thread sweep reads ops, and must never guess.** `documentReferences` in `apps/api/src/lib/document/references.ts` deletes every media file and comment thread a document does not name, and today finds the names in the log by walking `op.path`. After this step no op has a path. Its new source is one function beside the validators, `opReferences(op)`: the media names and comment card ids an op names, from `record` ops on images, and from the cell records in `input`, `cells` and `sheet` ops. It is a `switch` over the nine kinds with no default, so a tenth kind does not compile until it says what it names. An op that fails its validator makes the sweep throw, and a throw deletes nothing, as today. It never skips an op it cannot read: that would delete an image only a pending op names.

**Display text has one reader, and the list of its callers is long.** `cellValue` and `cellDisplay` exist today in `engine/format.ts`. `cellDisplay(cell)` becomes: the rich text, else `numberDisplay` of the value in the cell's format. A new `cellInput` beside them gives what a person typed: the literal, or the formula printed as A1 at its cell. These three are the end state's accessors; step 3 changes their first argument from a `Cell` to a place in the workbook, at every call site, in one unit, and their names do not change. Every reader of `m` moves onto `cellDisplay` here, through it or through the two other seams, `getRealCellValue` (`state/modules/cell.ts`, the painter's `state/render/phases.ts` among its callers) and `getCellValue(…, 'm')` (`clipboard.ts`, `split-column.ts`): the grid, copy as text, find and replace, the filter menu (`filter.ts`), the dropdown match and the tick-box state (`data-validation.ts`), the sort dialog's header (`components/CustomSort/index.tsx`), auto-fit (`state/events/mouse-resize.ts`), text to columns (`split-column.ts`), the autofill series (`drop-cell.ts`, `lastNumber(cell.m)`), chart labels; in the API the HTML, PDF and preview exports, the search index (`search/extract-render.ts`), the import's text budget (`import/sheets/limits.ts`, `cells.ts`), the xlsx export's wrap and width (`export/sheets/xlsx/worksheet.ts`, `cells.ts`), the xlsx import's row heights (`from-xlsx.ts`) and `scripts/xlsx-audit.ts`. In all 37 lines in 9 files of `packages/sheet` and 9 in 6 API files read `.m` directly. A lint rule against `.m` and against `.f` outside the accessors lands with the unit.

**The xlsx writer's gate.** This step rewrites the xlsx export and import, so EXPORT.md's corpus round-trip gate applies: `bun apps/api/src/scripts/xlsx-audit.ts roundtrip <corpus dir...> --out /tmp/xlsx-roundtrip` must pass. Its `facetsOf` compares `m` and `ct.t` per cell today; in the same unit it compares `cellDisplay` and the value's kind.

**A patch the translator cannot map rolls its edit back.** `patchToOp` is an allow list on the author's side, so a miss happens after the recipe has changed the tab. The rule: the recipe's result is dropped, the tab stays as the log has it, and the person gets the editor's warning dialog. In tests it throws. A refused patch never stays applied locally.

**The adapter.** It loads the store from the sheets, stores every write `applyOps` applies, asks for a recalc after a local edit and after a structural batch (a received batch of cell ops recalculates nothing in this step, as today), and writes the changed results into the host cells: compare the value and its kind first, write a copy of the cell, make a `result` op. These writes go through the path a peer's batch takes (`applyBatch` in `state/modules/apply-ops.ts`), never through a recipe that drafts each cell. Measured for 11,444 results: 105 to 164 ms inside the immer recipe, 2.0 to 2.7 ms outside it without `m`. The store is loaded again at four named events: a new snapshot, a replay, a recalc stopped by the cap, and a table that has doubled since the last load. What `formula-cache.ts` and `formula-exec.ts` hold that is not the engine gets a home first: `snapshotContext` in `apply-ops.ts`, `formulaUIState` and its setters in `formula-editor.ts`, `getcellrange` in the package's text entry.

**Formula text on a row insert is written as copies until step 3.** The transform gives 73,167 cells a new text on the reference workbook's worst insert. In place that is 1.5 to 2.7 ms, but the host's cells are frozen and shared with the tab's anchors, so they are written as copies: 10.9 to 21.8 ms. The second version set a line for this (over 10 ms, the stored form goes back to the owner) and Node crossed it. The owner ruled to hold ([decision 5](#part-3-the-owners-rulings)): the hybrid would trade a cost that lasts two steps for 74,883 texts in place of 1,001 for good.

**Arrays work inside a formula; nothing spills yet.** A formula whose result is larger than one cell shows its top-left value in this step. An imported spill keeps the values the file held, each marked `spill`, so step 2 can take them over without a conversion.

**No conversion.** The owner ruled it on 11 Nov 2026: there is no backward compatibility, and eigen.is holds no real data. No script folds or converts a document, and no build reads two formats. What a person sees of a document an older build wrote is in [§ The stored format](#the-stored-format). A tab open across the deploy is stopped by the data epoch (`apps/api/src/lib/home/data-epoch.ts`); a tab that was offline pushes its old ops to the old key, where no new build reads.

**Gates.**

| Host, reference workbook | Today | Gate |
|---|---|---|
| Hub edit to the committed state, every result changed, the push of its ops into the log included | 208 ms | 30 ms, confirmed or reset by A0's run |
| Row insert near the top of MASTER DATA to the committed state | 461 ms | 180 ms: engine 3, host shift 42 to 67, text copies 11 to 22, and about 95 ms around the applier that this step does not remove. A0's split replaces this sum |
| The same two, keypress to painted | at least 208 and 461 ms; baseline from A0 | the state gate plus today's render and paint time, which no step may raise |
| Open to first paint | baseline from A0 | not slower than today |
| xlsx round trip over the corpus | passes | passes |
| A random log through the translator | — | no patch refused |

**Deletes.** All of `engine/parser/` (the 1,282-line parse table and its `.jison` copy), `formula-engine.ts`, `formula-graph.ts`, `dependency-index.ts`, `dependency-graph.ts`, `recalc.ts`, `cell-resolver.ts`, `formula-utils.ts` (`isFormula` moves to `engine/format.ts`), `formula-shift.ts`, `formula-reference-cycle.ts`, `a1-notation.ts` and its `./engine/a1-notation` subpath (three API importers re-pointed: `ooxml/ooxml-chart.ts`, `ooxml/ooxml-chart-writer.ts`, `export/sheets/xlsx/to-xlsx.ts`); `state/modules/formula-exec.ts` and `formula-cache.ts`; the path and formula shifting of `history-shift.ts` (its rule that a peer's batch ends your structural steps stays); the editor's own tokenizer; `opToPatchOnSheets` and `applySheetWrites` in `packages/lib/src/sheets/yjs-ops.ts`; `@formulajs/formulajs` and its patch (the Dockerfiles' copy of `patches/` stays: `ical.js` has one there); `packages/lib/src/sheets/excel-functions.ts` (moved); `renameFunctions` and the prefix helpers in `apps/api/src/lib/ooxml/spreadsheetml.ts`; the shared-formula expansion in the importer; every write and stored read of `m`, `ct.t` and a stored `mc`; `held-graph-budget.test.ts` and the tests that pin internals of what is deleted.

**Leaves for step 2.** Values still travel (megabytes for a hub edit when every result changes; 97 results changed in the edit unit 0 measured). The stale total after two concurrent edits. Two copies of every value. No spill, no tier 3, 4 or 5 function: a fresh `=PMT(…)` or `=FILTER(…)` is `#NAME?` where it computes today.

### Step 2: inputs only

**End state.** Nothing computed is sent, except the two cases where a value is state. Every tab and the server derive values after applying a batch. A hub edit is one op. Two concurrent edits to the inputs of one total give the right total everywhere. Spill works, and the function list is whole. The host's sheets are still the truth in memory and derived values are mirrored into them; the engine's store is still a cache. This is a product that can stay.

**Units, in order.**

| # | Unit | Delivers | Tests | Risk seam |
|---|---|---|---|---|
| 2.0 | **Start.** The per-batch recalc of a peer measured in Chrome and in Safari, and once on a phone, on the reference workbook, NFL, Apportion and the `INDIRECT` workbook | The peer gates below made firm before anything is switched | the bench in a browser page | Unit 0 measured Bun and Node on a laptop |
| 2.1 | **Derive.** The adapter recalculates after every batch, local or received, and mirrors the changed values into the host cells without making an op. Authors send `result` only for state values; a reader ignores a `result` it can do without. A replay recalculates once at its end. `commutes` no longer sees results | The overturn of "the editor computes on write" | `writers-recompute`, `formula-results`; a new `derive.test.ts` in `apps/sheets/src/test/components/sheets/hooks/` on real `Y.Doc`s, two tabs and a joiner | Every function must give the same answer on every reader now |
| 2.2 | **The scheduler.** Inputs apply at once; one recalc per frame over the union of the seeds; a hidden tab only marks and recalculates when shown; a pass stopped by the cap keeps its dirty flags, and the next pass goes on | A third tab keeps up with two typists | the same file | The second version's "an abandoned run leaves no trace" changes: values stay, flags stay |
| 2.3 | **Spill and tier 3.** A spilled value is derived: the anchor holds the formula, the cells of its rectangle hold no input, and any input in the rectangle makes the anchor `#SPILL!`, in either log order. `A1#`. `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, `LET`, `LAMBDA` and their kin. The `spill` mark, stored since 1b, is now also written by the fold | The owner's dynamic arrays | `packages/formula/src/test/arrays/`; the collaboration study's cases 7 to 9 in `derive.test.ts` | Spill against the index: a spilled cell's readers depend on its anchor |
| 2.4 | **Undo on inputs.** A cell entry holds inputs only; `stillWritten` compares inputs; `withoutComputedValues`, `seedsOf` and the recalc an undo sends go | Undo that sends what a person did | `state/modules/history.test.ts` | A structural undo's repair, re-read against the new rule |
| 2.5 | **The server.** A read with a non-empty log applies it and recalculates once under the counted cap; preview and search serve what they have past the cap, an export falls back as today. The fold is `applyOps`, one recalc, one encode, whole or not at all; its per-batch recompute and deadline checks go | One rule for every reader | `apps/api/src/test/document/document-sheets.test.ts`, `sheets-structural-recompute.test.ts`, `collab/collab-close-compaction.test.ts` | The fold builds on the snapshot's values, which are state |
| 2.6 | **Writers.** One block writer for paste, fill, sort, cut and the painter, which builds a `cells` op (the audit's D10). `cell.mc` leaves memory: its 62 lines read the merge record (D9's other half) | The writer side of step 3 made smaller, on today's model | the paste, fill and sort suites in `state/modules/` | Both are worth doing whatever step 3 becomes |
| 2.7 | **Functions, tiers 4 and 5,** as leaf files | 0.5.0's function list | `packages/formula/src/test/functions/<family>/`; Microsoft's examples | Tail accuracy; iterating functions must stop at the same step on V8 and JavaScriptCore |
| 2.8 | **Close.** Docs (SHEETS.md's overturned section first), the closing review, the hand-off | — | the browser pass on two tabs | — |

**Gates.**

| What | 1b | Gate |
|---|---|---|
| Hub edit: bytes sent | up to 1,938 KiB | 1 op, under 1 KiB |
| Hub edit on a peer: apply, recalc, mirror, in Chrome and Safari | 0 (the author's values arrive) | 16 ms on the laptop; the phone run reported, and over 50 ms goes to the owner before the merge |
| Worst edit found on a peer: NFL, Apportion, the `INDIRECT` workbook | 0 | 150 ms, 250 ms, 16 ms |
| A joiner of a 1,000-batch log of cell edits, reference workbook | replay, no recalc | open plus 100 ms |
| A fold of that log on the server | today's per-batch recompute | under 1 s |
| Two tabs edit two inputs of one total at once | wrong total | right on both tabs, a joiner and the server |
| A typed value and a spill that grows over it, in either log order | — | the typed value stays, the anchor is `#SPILL!` |
| A step 1b document, with `result` ops in its log and imported spills in its snapshot | — | opens with the same values, no conversion |
| Bun and Node on the corpus oracle, all tiers | — | the same value in every cell, or the cell is listed with its function |

**Deletes.** `result` ops for derived cells and the megabytes with them; "a recomputed value is a write" in `commutes`; `seedsOf`; `withoutComputedValues`; `holdsFormulaResult` as a filter for the wire; `SkippedRecompute` as a storage hazard; the fold's per-batch deadline checks; `cell.mc`; the paste, fill and sort writers' own landing code.

**Leaves for step 3.** Two copies of every value in a tab, the adapter and its mirror, the patch translator, the host's own shift of a row insert and the recipe around it (about 180 ms, now nearly all of the op), the anchors.

**Three rules this step adds, each small and each needed.**

- **A tab on an older build shows older numbers and stores nothing.** That is better than today, where it sends them. A deploy that changes what a formula computes bumps the data epoch, so open tabs reload. No new mechanism.
- **Floats.** `SIN`, `COS`, `TAN`, `ATAN`, `EXP`, `LN` and `LOG10` differ between JavaScriptCore and V8 by up to 3 ulp, on 2% to 34% of inputs (measured). So Safari, Chrome and the server can show a last digit apart at 17 digits and the same at 15. Accepted and written down. `POWER` and `SQRT` agree.
- **The snapshot's values are state.** One writer, never dropped, whole or not at all.

### Step 3: one store

**End state.** [Part 1](#part-1-the-end-state). The grid paints from the store and writers build ops. `ctx.sheets[i].data`, `celldata`, the adapter, the mirror, the translator and the anchors are gone. The owner decides on this step again at its start, with the list in hand.

**Units, in order.**

| # | Unit | Delivers | Tests | Risk seam |
|---|---|---|---|---|
| 3.0 | **Start: the list.** A script lists every read and write of the flow data, `celldata` and a cell's fields, by file and symbol. Counted on `sheets-wave2`, non-test: 597 lines in `packages/sheet` and `apps/sheets` (the flow data on 262 lines in 45 files; `.v` 106, `.f` 45, `.ct` 84, `.mc` 62, gone in step 2, `.m` 37, gone in 1b), 70 to 160 reads of style keys, 57 destructures, and about 100 lines in the API (`celldata` in 11 files). Measured beside it: the store with the two id planes on the reference workbook; a tab's heap today; a reload with a 10,000-batch log. The owner signs the list and this step's units before unit 3.1 | A plan from a list | the script itself | "About 800" is a spot check, not a list |
| 3.1 | **The workbook.** The `Workbook` object: the store with its `style` and `extra` planes, the style table, the records as they are. The appliers for `input`, `format`, `cells`, `result` and the cell half of `lines` and `move` rewritten onto the store, each returning its inverse; the other appliers carry over. `loadWorkbook` from the decoded snapshot and its reverse. Run headless beside the old path on random logs until both give the same snapshot | The one writer | a twin test on `packages/sheet/src/test/state/factories/workbook-fuzz.ts` | Every cell op against every record |
| 3.2 | **The server reads it.** Replay, fold, export, preview, search and the importer on the workbook | `celldata` gone from the API | `apps/api/src/test/document/`, `export/sheets/`, `import/sheets/`, `search/`; the xlsx round-trip gate | 11 files, 14 with the matrix readers |
| 3.3 | **The grid reads it.** `cellValue`, `cellDisplay`, `cellInput` and a new `cellStyle` take a place in the workbook; the painter, the formula bar, the toolbar, conditional formats, charts and the status bar follow | No reader of `data` left | the pixel gate of the verify-in-browser skill on the reference workbook | Paint speed |
| 3.4 | **Writers build ops.** Module by module in `state/modules/`: each writer returns ops and calls `applyOps`; its recipe goes. The translator goes with the last one | No writer of `data` left | each module's suite; `components/Workbook/api.test.ts` | The long unit. Each module lands alone behind the contract tests |
| 3.5 | **Delete.** The matrix, `celldata` and its six converters, the adapter, `writeSheets`, the anchors, immer for sheets | Three forms of a cell | `use-sheet.test.tsx`, `use-sheet-order.test.tsx` | A late batch rolls back by inverse ops: gated below |
| 3.6 | **Close.** Docs, ARCHITECTURE.md's Sheets rows, the closing review | — | the browser pass | — |

**The codec stays in lib and never sees the workbook.** `packages/lib/src/sheets/snapshot-codec.ts` decodes to, and encodes from, a neutral form: per sheet its records and a list of closed cell records in column order. `loadWorkbook` in `packages/sheet/src/engine/` turns that into the store, and its reverse gives the list back. So lib still imports nothing from `packages/sheet`, and the API's readers that want only names (`document/references.ts`, `versioning/restore.ts`) keep reading lib. The list is the snapshot record decoded, not a fourth form of a cell: nothing holds it after the load.

**Decided at the start of this step, from unit 3.0's numbers.**

- **A late batch.** Recommended: rollback by inverse ops for a batch inside the kept ring, a reload for one older. The size of the ring comes from the measured reload.
- **One length per column or two.** The reference workbook has 736,695 styled cells and 130,727 with content. One length is simpler and costs memory and scan time on styled empty rows. Recommended: one, unless the store passes 40 MB there.
- **The unit list itself.** If the list shows the step does not fit one session, units 3.3 and 3.4 are cut by module into two sessions, with the adapter kept until the second. Nothing stored depends on it.

**Gates.**

| What, reference workbook | Step 2 | Gate |
|---|---|---|
| Hub edit to the committed state | engine plus mirror | 8 ms: the engine alone |
| Row insert near the top of MASTER DATA to the committed state | about 180 ms | 20 ms |
| Both, keypress to painted | A0's baseline | not slower than step 2, and the paint of an unchanged screen pixel-equal |
| Copies of a value in a tab | 2 | 1 |
| A tab's heap with the workbook open | unit 3.0 measures it | at most half |
| A late batch 20 batches back: rollback and apply again | anchors, about a quarter second | 50 ms |
| A late batch older than the ring: reload, with a 10,000-batch log | — | 1 s |
| Apply a random batch, then its inverse | — | the same bytes in the store, for every kind |
| The headless twin: old path against `applyOps` on the store | — | the same snapshot on every random log, until the old path is deleted |

**Deletes.** The six `celldata` and matrix converters, `writeSheets`, `filterPatch`, `patchToOp`, the adapter and its load events, `holdsFormulaResult` and `writeFormulaResult`, `anchorsRef`, `keepAnchor`, `ANCHOR_EVERY` and `MAX_ANCHORS` in `use-sheet.ts`, the host's row and column shift of cells, immer drafts of sheets.

**Leaves, parked with their triggers.** Ops are not transformed against a concurrent row op. The server does not order the log. The fold does not run while editors are connected; under derived values its trigger is a joiner whose replay passes the open gate by more than 500 ms.

### What is built to be deleted

The order keeps the host's sheets as the truth for two steps, and that has a price: code written in one step and deleted or rewritten in a later one. Estimates in production lines, by today's file sizes.

| Built in | Piece | About | Ends in |
|---|---|---|---|
| 1b | The adapter, both halves, with its four reload events | 450 | 3.5 |
| 1b | `patchToOp` onto the nine kinds, with the roll-back of a refused patch | 250 | 3.4 |
| 1b | The cell appliers on `Sheet[]`: `input`, `format`, `cells`, `result`, the cell shift of `lines` and `move` | 300 | 3.1, rewritten on the store |
| 1b | Cell undo entries translated from immer's inverse patches | 150 | 2.4 changes them, 3.1 replaces them |
| 1b | `result` ops for every changed result, and `commutes` seeing them | 200 | 2.1 |
| 1b | The `eigensheets/3` codec's side that reads and writes `Sheet[]` | 150 | 3.1 |
| 1b | `holdsFormulaResult` and `writeFormulaResult`, changed; formula text written as copies | 150 | 3.5 |
| 1b | The xlsx importer and exporter and the HTML export, re-pointed on `celldata` | 300 changed | 3.2, changed again |
| 1b, 2 | The server's read rules | 150, twice | 2.5, then 3.2 |
| 2 | The mirror and the scheduler's write into host cells | 200 | 3.5 |
| 3 | The headless twin | test code | 3.5 |

About 2,000 to 2,500 lines, roughly a fifth of the host work. Two cuts already taken keep it there (the falsifier's count before them was 2,500 to 3,500): records keep their shape from 1b to the end, so the appliers for `record`, `field` and `sheet` are written once; and structural inverses come from `applyOps` from 1b, so the hardest undo is built once. Each step's closing report gives three numbers outside `packages/formula`: lines added, lines deleted, and lines added that a later step deletes.

## Part 3: the owner's rulings

The eleven questions that had to be answered before step 1a, and what the owner ruled on each on 11 Nov 2026. Two of them hold tables of picks, so it is 22 answers in all. Later choices are in the step they belong to, and listed at the end of this part. Ruled earlier that day and written in as such: no stored display text `m`.

**1. We build towards this end state.** Ruled 11 Nov 2026: yes. Steps 1a, 1b and 2 are built. Step 3, the grid on the one store, is the direction, and the owner decides on it again at its start, when there is a list of every place it touches and not a count. If step 3 goes badly the work stops at step 2, a product that ships: a value keeps two copies in a tab, and about 900 lines of adapter, mirror and translator stay.

**2. Step 2 overturns "the editor computes on write".** Ruled 11 Nov 2026: yes. From step 2 every tab and the server compute for themselves and only what was typed is sent. Every open tab then pays the recalc of every edit, which step 2 measures in Chrome, Safari and on a phone before it switches anything.

**3. The stable-id Yjs design is closed.** Ruled 11 Nov 2026: closed. PROPOSAL_SHEETS_YJS_WORKBOOK.md's status line and the ROADMAP-POST-1 row say so, and its four rulings stand. A later move to Yjs structures would need a new stored formula form.

**4. The `computed` flag stays.** Ruled 11 Nov 2026: it stays, with today's meaning. This replaces the ruling of 10 Nov (the audit's E2), because the snapshot's values are state and the snapshot must be able to say "these formulas were never computed".

**5. A stored formula is offsets, and the stored format changes once, in step 1b.** Ruled 11 Nov 2026: offsets, with every other stored change at the same moment: formula rules in the same form, the nine op kinds under a new log key, snapshot `eigensheets/3`, the closed cell record. The owner added: "we don't have to support backward compatibility, so it is fine if old documents can't open; do what is cleanest here". So nothing is converted, and a document an older build wrote is not read ([§ The stored format](#the-stored-format)). The ruling also holds the form past the second version's line ("if writing the new texts on a row insert costs over 10 ms, this goes back to you"): it costs 11 ms on Bun and 22 on Node until step 3, and 1 ms after.

**6. formulajs goes; tiers 0 to 2 come in step 1a, tiers 3 to 5 in step 2.** Ruled 11 Nov 2026: yes. formulajs, its patch, `jstat` and `bessel` are removed. Tiers 0 to 2 must all exist at the flip. About 285 names in all, each about 32 lines and a check against Excel; today 479 names are registered, and the corpus of 1.1 million formulas uses 122.

| Tier | What | Step |
|---|---|---|
| 0 | operators, references, `@`, array constants, broadcast | 1a |
| 1 | must be exact and fast: `SUM` `IF` `VLOOKUP` `INDEX` `MATCH` `XLOOKUP` `SUMIFS` `COUNTIFS` `SUMPRODUCT` `SUBTOTAL` `IFERROR` `TEXT` `CONCATENATE` `OFFSET` `INDIRECT` `ROW` `HYPERLINK` | 1a |
| 2 | ordinary business sheets: `IFS` `SWITCH` `CHOOSE`, rounding, `MEDIAN` `LARGE` `RANK`, text and date functions, `ADDRESS` `AGGREGATE` `CELL` | 1a |
| 3 | dynamic arrays and spill: `FILTER` `SORT` `SORTBY` `UNIQUE` `SEQUENCE` `LET` `LAMBDA` and its helpers, `TEXTSPLIT` `VSTACK` `HSTACK` `TAKE` `DROP` `CHOOSECOLS` `TRANSPOSE` `MMULT`, `#` | 2 |
| 4 | finance basics: `PMT` `PV` `FV` `NPER` `RATE` `NPV` `IRR` `XNPV` `XIRR` | 2 |
| 5 | statistics and database: `NORM.*` `T.*` `F.*` `CHISQ.*` `BINOM.*` `CORREL` `SLOPE` `FORECAST` `TREND` `LINEST`, `DSUM` and its family | 2 |

Not in 0.5.0, about 190 names: engineering (`BIN2DEC` and its family, `BESSEL*`, the complex `IM*` functions, `CONVERT`), bond and coupon functions, the long tail of statistics. A formula that uses a missing name shows `#NAME?` when typed fresh and keeps its value when imported. Accepted with the ruling: a build between step 1b and step 2 answers a fresh `=PMT(…)` or `=FILTER(…)` with `#NAME?`, where today it computes; after 0.5.0 a fresh `=BIN2DEC(…)` does, for good.

**7. Six cases follow Google, not Excel.** Ruled 11 Nov 2026: all six, yes. Excel stays the reference. The oracle found 225 cases where the two differ, and these six are the ones taken from Google. The tests of step 1a are written from them.

| # | Case | Excel | Google | Why Google |
|---|---|---|---|---|
| a | `=""*0`, `=""+1`, `=B1+1` where B1 is `=""` | `#VALUE!` | 0, 1, 1 | The owner's ruling of 11 Nov. Sheets are full of `=IF(x,"",…)` feeding arithmetic |
| b | `=ABS("")`, `=VALUE("")` | `#VALUE!` | 0 | The same rule in a function argument: one coercion function, not two |
| c | `=IF("",1,2)` | `#VALUE!` | 2 | Empty text is FALSE as a condition, as a blank is |
| d | `=SUMPRODUCT(A1:A1)` on an empty cell | `#VALUE!` | 0 | An Excel quirk nobody relies on |
| e | A criterion or lookup key longer than 255 characters | `#VALUE!` | 0, `#N/A` | Excel's limit is an old implementation limit; having none is less code |
| f | A formula that does not parse | refuses the entry | stores it, shows `#ERROR!` | As today. A collaborative editor cannot block on a dialog |

Kept as Excel, where Google differs and the difference could tempt: a blank result is 0 until the owner picks, at the start of 1b; `=2^3^2` is 64 (Google 512); `=0^0` is `#NUM!` (Google 1); the zero snap is off inside parentheses (Google snaps always); `=SUMPRODUCT(C1:C3="x",B1:B3)` is 0, because booleans in an array argument count as 0 (Google 10); a 16-digit text id matches another that agrees in 15 digits in `COUNTIF`; `=COUNTIF(range,"<>7")` counts blank cells; function names are upper-cased; `"1 1/2"` is a number and `"1 2"` is not. Dates take Google's day line instead of Excel's: 1900 has no 29 February, so a serial under 61 is one day earlier than Excel's and a negative serial is a date. A pick changed after step 1b needs a recalc of every document that hits it.

**8. Seven product picks.** Ruled 11 Nov 2026: all seven, as described.

| # | Question | Ruled | The option not taken, and the cost if wrong |
|---|---|---|---|
| a | A cell on a circular reference shows? | `#REF!` on every cell of the loop, labelled "circular reference" by the editor, as Google | 0 and a warning, as Excel: dependents silently compute with 0, and the number depends on history. Cost: one constant |
| b | Does `=NOW()` move by itself? | No. It keeps the moment of its last touch, the same on every tab and in every export | Refresh at the server's fold: the time moves once per session. Never per edit by anyone. Cost: a stale clock in a cell, as today |
| c | Iterative calculation (a loop that runs 100 times on purpose) | Not in 0.5.0 | Workbooks that rely on it show pick a's error after an edit |
| d | Names, table columns and 3-D references in an imported file | Names and table columns become plain cell references at import, as names do today; a 3-D reference keeps Excel's value. 2.0% and 6.4% of corpus formulas | Real names need a name manager and a place in the log and every structural edit. Cost: a workbook loses its names on its way through Eigen, as today |
| e | `=DATE(2026,1,5)` typed into an unformatted cell | The cell gets a date format at entry, as in Excel | Shows 46027, as today (defect 16) |
| f | How is text ordered in `MATCH`, `SORT`, `<` and the grid's Sort? | By our own rule, the same on every tab and the server: upper-case, then by character, with a small table so `é` sorts beside `e`. About 100 lines | The browser's order: two readers could derive different values. Cost: a language the table gets wrong sorts oddly until the table learns it |
| g | Two builds, or Chrome and Safari, in one document | Accepted: they can show a last digit apart and store nothing different | Our own `SIN`, `EXP` and kin: several hundred lines, slower |

**9. Wave 2 is merged before step 1a, and Sheets is frozen from step 1b.** Ruled 11 Nov 2026: yes. `sheets-wave2` merges into develop before 1a. From the start of 1b until step 3 has landed no other session touches `packages/sheet`, `apps/sheets`, `packages/lib/src/sheets` or the Sheets files of the API, and bug fixes go through this program's session.

**10. Each step merges to develop when it is green.** Ruled 11 Nov 2026: yes, each on the owner's go. Step 1a merges as a package nothing uses. This is about develop only: when production gets it is asked at the start of 1b.

**11. eigen.is may be looked at; it holds no real data.** Ruled 11 Nov 2026. The owner: "we don't have real data on eigen.is and we don't need conversion. You can have a look at it there (maybe the vacation sheets), but they don't add a lot of value as a corpus." Nothing in this plan depends on it.

### Decided here, with the reason

Choices unit 0, the studies and the two checks of this version handed over that are design, not product. Each has its line in the program's notes.

- **The index is rectangles in one list per sheet.** Every corpus workbook rebuilds in under 10 ms (slowest 6.5 and 9.3 ms) with 86,507 listings in all. Listed per column, marking is 2 to 3 times faster, but minibus misses its gate (12.8 and 15.3 ms) and a whole-row reference makes 4.5 million listings in one workbook. Marking is still far under a frame: 0.35 ms for the hub edit, about 4 ms a cone on NFL. One mechanism, no cliff.
- **The column index is built first in unit A6.** Apportion's worst edit is 0.85 and 1.5 s by scan, and under derived values every open tab would pay it. Building it reads its column, which evaluates the column's dirty formulas first, so a key column that is itself computed gets its index once per pass, not once per write.
- **Columns are allocated at their exact length at load**, and grow by doubling after. minibus is 26 and 18 MB that way and 39 and 55 MB by doubling during the load.
- **The depth bound is one budget of nested `evaluate` calls**, cells and tree nodes together, because that is what overflows: 39 cells nested 60 deep overflow V8's stack where 915 plain cells fit. Set at half the smallest overflow measured in Chrome and Safari.
- **`INDIRECT` and `OFFSET` stay seeds of every recalc.** Unit 0 crossed its 5 ms threshold in one workbook (28 and 42 ms). The index form saves nothing there: its 3,744 formulas are `INDIRECT` of a cell's text, which by that rule depends on every sheet. Their cost is exact `MATCH`es over the ranges they name, which the column index should serve. That is a claim, so the gate is 8 ms with the index, measured first in A6, and the workbook is in step 2's peer table. If it misses, the owner hears the cost before step 2.
- **Formula text is written as copies while the host's matrix lives, and in place after.** Ruled with decision 5.
- **Results are written outside the immer recipe**, from step 1b.
- **Number display has one home.** `numberDisplay` moves from `packages/lib/src/charts/number-display.ts` into the leaf, behind its own entry `@workspace/formula/format`, and `TEXT`, `FIXED` and `DOLLAR` call it. lib's charts, Docs and Slides import that entry, which holds no engine. `numfmt` is then in two manifests, not three: the sheet's input parser still formats with it.
- **A `result` is defined once:** a value its author computed; a reader that can derive the cell ignores it. In 1b a reader derives only after a structural op, from step 2 always.
- **Not built:** the columnar snapshot (a stored format drawn from a model nobody has built), the batch clock for `NOW` and `RAND` (one wrong clock would poison every reader), a build id in awareness (the data epoch does it).

### Decided later, in the step it belongs to

- **In the prompt that starts step 1a, each as its own question, as the rules require.** (1) A new package `packages/formula`: 14,000 to 16,000 lines of our own, a leaf beside `packages/math`, about 40 lines of config. The simpler alternative is a folder `packages/sheet/src/formula/` with a biome rule: the same code, the boundary kept by discipline. With the store becoming the workbook's cells, the package's case is stronger than it was. (2) `numfmt` in its manifest: 4.1.3 with one four-line patch, no dependencies, already in `packages/lib` and `packages/sheet`; with number display in the leaf it leaves lib, and the sheet's input parser keeps it. (3) Browser tooling: the verify-in-browser skill installs Playwright under `/tmp`, in no manifest; unit 0 held back from that. Is it inside the rule? A no costs the painted baselines, and the gates stay on the state path.
- **Start of step 1b.** (1) A formula whose result is blank stores 0 (Excel) or stays blank (Google). Your own workbook is a Google export, and this one rule is behind 32,949 of its cells; Google's rule changes numbers in workbooks made in Excel. Step 1a counts how many of the corpus's 1.1 million Excel values it would change. It is picked here, before the first step-1b document exists, and the reason holds without a conversion: the step-1b format stores computed values. The author's results go into the log and from there into the snapshot, and a snapshot value no edit reaches is never computed again, so a pick made later would leave both rules in one document. (2) When production gets it: after 1b, or after step 2. Either way that deploy is where older sheet documents stop opening. After 1b, eigen.is runs for one session with tiers 3 to 5 missing (a fresh `=PMT(…)` is `#NAME?`), an array result showing its first value, megabyte batches and the stale total as today. After step 2 it gets all of it in one deploy. Recommended: after step 2.
- **Start of step 2:** the phone run's result, if it is over its mark; Apportion or the `INDIRECT` workbook, if 1a missed their gates.
- **Start of step 3:** the list and the unit plan, signed; a late batch's rollback ring; one column length or two ([§ Step 3](#step-3-one-store)).

## Part 4: the session hand-off

Each step's session starts in a clean context. Its hand-off prompt names this proposal and the lists below, and nothing else from memory. "The owner does" lists what a session cannot do alone and may not wait for in silence.

### Before step 1a

The owner merges Wave 2 (decision 9).

### Step 1a

**Reads first.**

- This proposal: Parts 1 and 2 and the whole reference. `AGENTS.md`, CODE-STANDARDS.md, REVIEW-STANDARD.md, TESTING.md, the orchestrate skill.
- `.superpowers/formula-engine/STATE.md` and `proposal-notes.md` (§ v3 rulings, § v3.1 rulings and § Owner sign-off, 11 Nov last).
- The fact documents implementers build from, under `.superpowers/formula-engine/research/`: `parsing.md`, `references.md`, `recalc.md`, `storage.md`, `semantics.md`, `functions.md`, `collaboration.md`. Implementers read these and this proposal. They never open the upstream clones, and they do not read `unit0/lib/`, a prototype to be thrown away; `unit0/RESULTS.md` is theirs to read.
- The oracles: `oracle/cases.json`, `oracle/report-3way.md`, `oracle/structural/`, and the open hand checks (`oracle/paste/manual.md`, 60 cases; 40 structural cases; the snap experiment).
- `bench/` and `unit0/` for the gates' scripts; `baseline.md` for today's numbers.
- `packages/sheet/src/engine/rowcol.ts`, `state/utils/patch.ts`, `packages/lib/src/charts/number-display.ts`; the inherited parser tests in `packages/sheet/src/test/engine/parser/` (about 509 cases; the 396 under `integration/parsing/` are re-judged against Excel, not kept as truth).

**The owner does.** Answers the three start questions in the prompt. Has Excel on the web signed in for the 100 hand checks. Says go for the merge.

**Leaves behind.** The package with its gates in a results file beside unit 0's, same table shape. `packages/formula/scripts/` with the bench and the oracle. ARCHITECTURE.md: § Dependency direction (a second leaf; "imports no workspace package"; a leaf may list one npm package; `lib → formula/format`), § Backend imports (`@workspace/formula`, `/text`, `/format`), the concept table's engine row split in two, § One source of truth for number display; AGENTS.md's "`math` a leaf"; CODE-STANDARDS.md and REVIEW-STANDARD.md where they call math the only package owning its types; SHARED-PRIMITIVES.md and its generator's package list; a biome override that allows `numfmt`. For 1b: the count for the blank-result pick, the list of patch shapes, the row insert's split, the painted baselines, STATE.md with every ruling made on the owner's behalf, a hand-off prompt.

### Step 1b

**Reads first.** This proposal, Parts 1 and 2. STATE.md and 1a's results file. SHEETS.md, EXPORT.md and TESTING.md, whole. The package's exported names, not its insides. On Wave 2's code: `packages/lib/src/sheets/types.ts`, `yjs-ops.ts`, `yjs-state.ts`, `snapshot-codec.ts`, `range-rules.ts`; `packages/sheet/src/engine/replay-ops.ts`, `rowcol.ts`, `format.ts`, `sheet-name.ts`; `state/utils/patch.ts`, `commute.ts`; `state/modules/apply-ops.ts`, `history.ts`, `history-shift.ts`, `formula-cache.ts`, `formula-exec.ts`; `apps/sheets/src/components/sheets/hooks/use-sheet.ts`; `apps/api/src/lib/document/sheets.ts`, `references.ts`, `versioning/restore.ts`, `scripts/xlsx-audit.ts`.

**The owner does.** Answers the two questions of 1b's start (the blank result, when production gets it). Keeps other sessions off Sheets. Says go for the merge, and for the deploy if he chose it here.

**Leaves behind.** Develop-ready code with 1b's gates in the results file. SHEETS.md rewritten for the engine, the ops, the cell record and the snapshot; ARCHITECTURE.md's "Sheets ops" row; EXPORT.md; the help-center articles on formulas; CHANGELOG.md; the ROADMAP rows "Rewrite the Sheets formula engine in steps" and "formulajs 2.9.3 → 4.x" closed; the SHEETS-TODO.md rows that are fixed. For step 2: the list of every place a `result` op is made, STATE.md, a hand-off prompt.

### Step 2

**Reads first.** This proposal, Part 1 and step 2. STATE.md and the results file. SHEETS.md as 1b left it. `research/collaboration.md` (the test table) and `falsifier-data-model.md` findings 2 to 7, which are this step's risks. `semantics.md` and `functions.md` for spill and tiers 3 to 5. The adapter, `replay-ops.ts`, `commute.ts`, `history.ts`, `use-sheet.ts`, `apps/api/src/lib/document/sheets.ts` and `sheets-compaction.ts`.

**The owner does.** Runs the bench page once on his phone. Does the deploy, if production waits for this step. Says go for the merge.

**Leaves behind.** Code with step 2's gates in the results file, the phone run among them. SHEETS.md's § "The editor computes on write" replaced by "Every reader derives values", and the sections on commuting, undo, the fold and the server's reads brought in line; ARCHITECTURE.md's server read path; PROPOSAL_SHEETS_YJS_WORKBOOK.md's status line and the ROADMAP-POST-1 row for stable ids, closed (decision 3); the help center for spill and the new functions; CHANGELOG.md. For step 3: the block writer in place and `mc` gone from memory; a first run of unit 3.0's listing script; STATE.md; a hand-off prompt.

### Step 3

**Reads first.** This proposal, Part 1 and step 3. STATE.md, the results file and the list. SHEETS.md. `falsifier-data-model.md` findings 8 to 12. `packages/sheet/src/state/modules/` and `components/` by the list; the adapter; the API's readers of `celldata`.

**The owner does.** Signs the list and the unit plan after unit 3.0, or stops at step 2. Says go for the merge.

**Leaves behind.** Code with step 3's gates. SHEETS.md and ARCHITECTURE.md describing one store (a "Sheets workbook" row; § Dependency direction's sentence on what is left in `packages/lib/src/sheets/`: op types, validators, record types and the codec); SHEETS-SIMPLIFICATION-AUDIT.md's S10, D9, D10 and U6 marked done and its two roots closed; this proposal's status set to built, or folded into SHEETS.md and deleted; the program's local folder kept local. A count worth taking a few weeks later: data-model fixes per week against the 150 of this spring and autumn, which is the one measure of whether the goal was met.

## Reference: the engine

What `packages/formula` is. This is the second version's design, kept where it held and changed where unit 0 or the end state changed it. Step 1a builds it and step 1b puts the product on it; steps 2 and 3 change only what a part says they do. Each part names its reason and the measurement or upstream lesson behind it. Shas are upstream commits, cited as history only: implementers build from our fact documents and never read upstream code.

### The engine in ten lines

- A formula is stored as its **shape text**: canonical text with relative references as offsets and sheets by id. Equal texts are one shape, parsed once into an immutable tree.
- The engine is a leaf package, `packages/formula`. It owns typed columns of values and shape ids. In steps 1b and 2 they are a cache of the host's sheets; from step 3 they are the workbook's cells.
- Evaluation is a tree walk over the shared tree with the host cell as an argument. Values are JS natives plus four small types: error, reference, array, lambda.
- Dependencies are a reverse index derived from rectangles of equal shapes, rebuilt, never patched. Recalc marks dirty transitively and evaluates on demand, so order, cycles and lazy branches fall out of the reads.
- A structural edit is one pure transform per (shape, class of hosts), built on two functions, `mapIndex` and `mapSpan`, that every holder of a numeric range calls.
- Arrays are always on. Operators and scalar parameters broadcast. `@` is a node. A spill is derived, never stored.
- A function is a signature (parameter kinds: scalar, range, ref, lazy) and a pure body.
- Excel is the reference. Where we follow Google, the case is listed with both answers.
- What every reader computes is a pure function of the stored inputs and the build: no clock, no locale data, no deadline, no memory of earlier evaluations.
- The package has no module-level state, no options object, no undo, no clipboard and no serialization.

### The package and its boundary

**`packages/formula`, a leaf beside `packages/math`.** It imports no workspace package, no React, DOM, Bun or Node API, and one npm package, `numfmt`. Direction becomes `sheet → formula` and `api → formula`. lib imports one entry of it, `@workspace/formula/format`, and nothing else once `excel-functions.ts` is gone.

Why a package and not a folder in `packages/sheet`. It is a close call, and two of the gains first claimed for it do not hold: the API already imports the engine's React-free subpaths (`@workspace/sheet/engine/a1-notation`, `/engine/format`), and lib needs nothing from it. Two gains do hold. The exports map is the API: today the editor imports engine modules by relative path well past the barrel, and a relative import cannot reach into another package. And the tsconfig (`lib: ["ESNext"]`, no `types`) proves the engine touches no DOM, where a folder in `packages/sheet` compiles with the DOM lib. It costs about 40 lines of config and a rule change: the docs name `math` as the only leaf and define a leaf as importing no package at all, and `numfmt` breaks that wording (step 1a's closing unit).

The owner's three conditions, answered. It improves our code: an engine nobody can reach around, and `packages/sheet/src/engine/` shrinks to what needs `Sheet`, `Op` and chart types. It is not slower: same code, same speed as a folder. It adds no layer: the adapter of steps 1b and 2 (about 450 lines in `packages/sheet`) is caused by the host's matrix, not by the package, and goes in step 3.

What stays out of the package until a second user exists: an options object, locale and translated function names, custom-function registration, events, undo, clipboard, serialization, a `dist` build. The first options object is the sign to fold it back into a folder.

Four entries. `@workspace/formula/names` is Excel's function inventory (`isExcelFunction`, `EXCEL_FUTURE_FUNCTIONS`). `@workspace/formula/format` is number display: `numberDisplay` and `isDateFormat`, the one wrapper of `numfmt`, moved from `packages/lib/src/charts/number-display.ts`. The grid, the charts of Docs and Slides, the exports and the engine's `TEXT` all call it, so a value and a format become text in one module and `numfmt` sits in one manifest. `@workspace/formula` is the engine. `@workspace/formula/text` is the parser, printers, A1 and sheet-name helpers (`parseA1Range`, `toA1`, `rangeToA1`, quoting, `sheetNameKey`, `sheetFinder`, `findSheetByName`), `mapIndex`, `mapSpan` and the transform, with no store and no function library, for callers that only read or rewrite formula text. The surface is about 35 names on day one.


**From step 3 the package's store is the workbook's cell store.** It then carries two more planes, `style` and `extra`, as ids it moves with the cells and never reads. They are fixed fields, not something a host registers, so the rule about the first options object stands. The style table, the records and `applyOps` stay in `packages/sheet/src/engine/`; the op types, their validators and the snapshot codec in `packages/lib/src/sheets/`, which import nothing from the package.

### Cells and values

**The engine owns typed columns.** Per sheet, per column, four parallel typed arrays:

| Plane | Type | Holds |
|---|---|---|
| `kind` | `Uint8Array` | empty, number, boolean, text, error |
| `num` | `Float64Array` | the number; 0 for every other kind |
| `ref` | `Int32Array` | text id in the workbook's string table, error code, or the boolean |
| `shape` | `Int32Array` | 0 for a literal cell, else the shape id |

A formula's result is written into the value planes of its own cell, so a reader of values never sees whether a formula produced them. Each column keeps an error count and a version number that every write to it bumps.

Reasons. Reading the host's row-major cell objects costs 22 to 54 ns per random read against 1.4 to 3.8 ns for a column array, and a column `SUM` runs 4 to 19 times slower. Today's string-keyed overlay is the worst measured layout, 200 to 300 times slower than arrays. Layout decides speed: columns, column-loop aggregates and typed adjacency are each worth 4 to 60 times, while the choice of evaluator is worth 1.25 times. Typed columns behave the same on JavaScriptCore and V8. Calc's history adds what not to build: variable-length typed blocks (quadratic lookups and stale position hints for a decade, `b81004e95638`, `703fb7739a5e`), a second storage strategy (HyperFormula `d44bf8e2e`), a tree for row inserts (HyperFormula's B+ tree lived two months, `ba38879fd`), and "empty encoded as a number" (Calc's NaN-for-empty leaked into `SUM` twice, `4d67506dee34`).

**Each column has its own length.** `load` finds each column's last row in a first pass and allocates once; after that a column grows by doubling. Reads past the length are empty. A sheet costs its slots, not its cells: 24 bytes a held cell on the reference workbook (3.0 MB of planes for 130,727 cells) and 98 on the gov.uk minibus workbook (17.2 MB for 184,018), because a column is as long as its last row. Exact allocation matters: after a load minibus holds 26 and 18 MB of process memory that way and 39 and 55 MB when columns double during the load. No pages are needed. A row insert is `copyWithin` on each column of that sheet: 0.07 to 0.09 ms on the reference workbook's busiest sheet, 1.2 to 1.9 ms on minibus.

Text cells hold an id into one string table per workbook, with a second id for the upper-cased form, so text equality in lookups and criteria is an integer compare (measured: `COUNTIF` over 100,000 text cells in 0.05 to 0.07 ms against 1.5 to 1.8 ms lowering each cell).

**The store holds nothing the document does not determine.** In steps 1b and 2 the store is a cache of the host's sheets: values, shape ids and spill are read from the cells, the index and the tables are derived from those, and after any sequence of operations the store equals a fresh load of the sheets. A test holds it to that, with random batches and loads in the middle (`held-graph.test.ts`, rewritten against the adapter, since it tests a class step 1b deletes). In step 3 the store is the sheets, and the law becomes: after any sequence of batches the store equals a fresh decode of the snapshot with the log applied. No dynamic dependency, no remembered order and no flag that changes a value lives only in memory.

### The formula: one grammar, one stored form

**A hand-written lexer and a Pratt parser.** The lexer is a pure function of (text, position). The parser reads one table of binding powers. Three of four engines hand-write this grammar; HyperFormula dropped its generated parser in its first week for speed (`5144c2f35`). The table, tightest first: `:`, intersection (a space between two references, decided in the parser, where "both sides are operands" is known; Calc needed eight commits over ten years deciding it by neighbouring characters), union, prefix `-` `+` `@`, postfix `%`, `^` (left-associative, and `-2^2` is 4), `*` `/`, `+` `-`, `&`, comparisons. Postfix `#` binds tighter than every prefix.

**The tree is immutable and holds nothing that depends on the host cell.** One uniform node object with an integer kind, one `binary` kind with an operator field, and one generic child iterator that every walker uses. Measured: a class per kind with a virtual method is 1.6 to 1.9 times slower than a `switch` on one node shape, and HyperFormula twice forgot a new node kind in a walker (`7cd5443db`, `ca4ab51e6`). The tree keeps parentheses, unary plus and whitespace: Excel keeps them, they are needed to print the formula back as typed, and parentheses switch off the zero snap ([§ Values](#values-the-rules)). Recomputing parentheses from precedence lasted two days in HyperFormula (`614bf5080`) and is still wrong in IronCalc after four fixes.

A reference node holds, per axis, an absolute index or an offset from the host, a flag for which, the sheet (an id, or "the host's sheet", plus whether the sheet was written), and its kind: cell, range, whole column, whole row. Whole columns are their own kind with no row part; Calc shifted them like ranges and paid for it three times (`dc34bb9b05cf`, `cfecdd619971`, `866eb4a7f934`). Corner order of a range is decided when the reference is resolved at a host, never in the tree: HyperFormula normalised corners in the shared tree and gave `B$2:B1` at row 1 and `B$2:B4` at row 4 the same order (`93f0dd0c0`).

**The shape text is the stored form and the interning key.** It is the formula printed in a canonical notation: R1C1 offsets (`R[-1]C[2]`, `R5C3`, `C[1]:C[3]`), sheets by id (`[sheetId]!RC[1]`), English upper-case function names, `,` and `.` separators, whitespace and parentheses as typed, a leading `=`. Equal text means equal shape, by one printer from one representation. HyperFormula kept a token key and a tree key that had to agree character for character and fixed both twice (`131bc5a9f`, `69bc3ae72`); Univer hashed long keys to 32 bits and gave a cell another cell's formula (`9c57dcc4a`); Calc compared compiled code and merged formulas with different names (`d6b32653ad34`).

A shape is the text, the tree, and facts computed once: its references, whether it is volatile, whether it reads cells its references do not name, whether it can return an array, whether this build can evaluate it. The shape table maps text to an id; a cell's `shape` plane holds the id. There are no group objects. Calc's maintained formula groups are its longest bug tail (nine commits over three years for "split where members stop being equal", fifteen more for group listeners); a per-cell shape id has no group to split, join or leave dangling.

**The text is bound to its workbook, because it holds sheet ids.** Inside one workbook a copy keeps the stored text. Everything that crosses a workbook goes through names: a paste from another workbook and the clipboard to other apps print A1 and parse again; Import… as new tabs and a server-side insert of a file remap ids ([§ Structural edits](#structural-edits-one-transform)).

**A sheet that does not exist** is kept as its quoted name and evaluates to `#REF!`. When a sheet of that name is added or a sheet is renamed to it, the transform binds those references to the id on every reader, so afterwards only ids are left. Shapes with a by-name reference are flagged, so that pass visits only them. Today `seedsOf` heals such a formula; this keeps that.

**Printing.** Three printers over the one tree: the stored form; A1 at a host, for the formula bar, the clipboard, and `FORMULATEXT`; and the xlsx file form. Round trip is a law with a property test: `parse(print(p)) = p`.

**Unparsable text is kept.** A formula that does not parse is stored as typed and shows `#ERROR!`; xlsx export writes it as a text cell, since Excel would refuse the file. An unknown function parses and evaluates to `#NAME?`. A wrong number of arguments, which Excel refuses at entry, is `#VALUE!`.

**Limits.** 8,192 characters, 64 levels of nesting, 255 arguments, enforced by the parser.

### Evaluation

**One evaluator: a recursive `switch` over the shared tree, with the host's sheet, row and column as arguments.** Measured on 125,000 formulas of about 17 nodes: tree walk, bytecode and closures are within 1.25 times of each other, 10 to 18 ms warm. Generated code is 1.8 to 2.5 times faster warm, 2.5 to 3.5 times slower cold, and needs `unsafe-eval`: no. A flat RPN program makes printing and rewriting hard, which is what hurt Calc (`47f002cbbf95`, "probably others"). Calc deleted its second interpreter after it was "in practice never used" (`089a4f245325`). Unit 0 ran it on the reference workbook's real formulas: 10.9 ms on Bun and 25.8 ms on Node, with 2.8 nodes a formula on average. The tree walk stays, and we never keep two.

**Values.** number, string and boolean are the JS types. Blank is `null`. An omitted argument is its own constant. An error is one frozen object per kind, compared by identity. A reference is a small object (sheet, rectangle) that functions can receive without it being read. An array is rows, columns and one flat row-major list, with a `Float64Array` beside it when every element is a number. A lambda is parameters, body and environment. No JS `Date` exists on any path: dates are serial numbers and all date arithmetic is on integer civil dates.

**Ranges are views.** A range argument is a reference; an aggregate loops over the column planes, clamped to each column's length, so `SUM(A:A)` costs the used extent. Nothing copies a range into arrays of arrays. Measured: materialising a range costs 5 to 14 times a direct loop, and a generator or a shared callback kernel 2 to 10 times, so each aggregate is one plain loop per function. A column with no errors takes the loop that only adds `num`.

**The call wrapper.** One function prepares every call from the signature: arity, lazy parameters left unevaluated, references kept as references, scalar parameters coerced by kind and lifted over arrays, the first error in argument order returned, defaults and the empty-argument rule applied. The common call, where no argument is an array, takes a path with no allocation. Laziness is a property of a parameter, so `IF`, `IFERROR`, `CHOOSE`, `IFS`, `SWITCH`, `LET` and `XLOOKUP`'s not-found value need no special case, and `BRANCHES` and the two sentinel errors go away. `AND` and `OR` are not lazy: `=OR(TRUE,1/0)` is `#DIV/0!`.

**What this build cannot evaluate keeps its stored value, decided once per shape.** A shape that calls a function Excel has and we do not (`GETPIVOTDATA`, a user-defined function), reads another workbook, or holds a 3-D reference is marked at parse time. Its cells are never evaluated and readers read the stored value. This is the owner's ruling "don't destroy Excel's number with an error nobody computed", kept, without `cantEvaluate` re-deciding it from the text at every evaluation. 3-D references are two formulas in the corpus's 1,122,934; today they show `#REF!` and overwrite Excel's value, so keeping the value is already the fix, and a fifth reference kind stays out of the evaluator, the index and the transform.

### Dependencies and recalc

**Precedents are the formula.** A shape lists its references; nothing else stores precedents. Only the reverse direction is indexed.

**The reverse index is derived from rectangles of equal shapes, and rebuilt, never patched.** A rectangle is a block of cells that hold the same shape id: equal runs down neighbouring columns with the same first and last row. For each rectangle and each reference of its shape there is one entry: the area the whole rectangle reads, its hosts, and how each end moves with the host. A change at a cell finds the entries whose area holds it and computes the affected hosts by arithmetic: for `=B2*C2` filled down 10,000 rows, a change to B500 gives host row 500 with one entry, not 10,000. A whole column is one entry. Dirty input is spans of rows, not single cells. The entries live in flat typed arrays, **one list per target sheet**, sorted by first row with a running maximum of the last row, so a lookup bisects on the row and checks the column per candidate.

Measured three ways over the corpus, each held to the same cones. Runs down one column: 280,533 runs and 16 million listings, and minibus, whose formulas repeat along rows, takes 24 to 36 ms to rebuild with one list of 32,931. Rectangles listed in every column they read: 5.5 million listings, minibus 12.8 and 15.3 ms, and one workbook with whole-row references makes 4.5 million listings from 6,970 entries. Rectangles in one list per sheet: 86,507 listings in all, every workbook rebuilt in under 10 ms (reference 0.8 and 1.2 ms, minibus 6.3 and 8.6 ms), and marking 2 to 3 times slower than per column, which is 0.35 ms for the hub edit and about 4 ms a cone on NFL. The last is the design: no workbook has a cliff, and marking stays far under a frame.

The whole workbook's index is rebuilt in one pass over the shape planes whenever the set of formulas changes: a formula typed, a paste, a structural edit, a load. Value edits never touch it. The reason to rebuild is Calc: its group listeners cache a run's geometry and were wrong after a split, join, shift or partial overwrite fifteen times between 2015 and 2022, every time as "a cell that does not recalculate". Per-cell edges are out: the corpus has 584 million formula-to-formula edges, and one whole-column lookup read by 20,000 formulas is 400 million links, which is why today's index needs three budgets.

**Marking.** A recalc collects its seeds once, then one work list walks the index and flags every reached formula dirty, each once. Marking reads the index and writes only flags. Calc cut row insertion from 282 to 66 billion instructions by collecting the dirty set once per batch (`5c841052abdf`).

**Order comes from the reads.** `valueOf(cell)`: if the cell is a dirty formula, evaluate it first. So a formula always sees final values, an untaken `IF` branch is never read, and `INDIRECT` and `OFFSET` need no pre-pass. The dirty set is walked in sheet, column, row order, which is already the right order for a filled column. A static topological sort is rejected: HyperFormula and Univer sort statically and are the two engines with false cycles on `IF` and restricted dynamic functions; HyperFormula corrected its own sort three times in nine months (`eb634e3aa`, `cb2b9c884`, `c50938183`). A remembered order per formula, Excel's calculation chain, is left out until a profile asks: it would be state a load cannot reproduce.

**Depth is bounded by one budget of nested `evaluate` calls,** cells and tree nodes counted together, because that is what overflows a stack: on V8's default stack 915 nested plain cells fit, and 39 cells whose formulas are nested 60 deep do not. Past the budget the engine unwinds and continues from an explicit stack. Unwinding is cheap: a chain of 100,000 cells asked from its last cell takes 23 to 25 ms at any bound tried, against 7 to 16 ms in sheet order. That chain is the test, with a second one of deeply nested formulas. The budget is set at half the smallest overflow measured in Chrome and Safari.

**Cycles.** A cell met while it is in progress is on a loop. Every cell on the evaluation stack from that cell up is on the loop, and each gets the cycle result whatever its formula computed, so the result does not depend on which cell was asked first. A loop is a property of the cells actually read: `=IF(TRUE,1,A1)` in A1 is 1, as in Excel, Google and Calc. Recalc returns the cells on a loop so the editor can say "circular reference" on them. What they show is pick 8a.

**One cap, and it is counted, not timed.** Recalc takes a cap on cells read, on the server and in the editor, and it counts the same on every reader. In step 1b a pass past the cap is abandoned whole: nothing of it is stored and the store is loaded again. From step 2, where values are derived, a stopped pass keeps what it computed and keeps the dirty flags of what it did not, and the next pass goes on; nothing is sent either way, so a stop can no longer store two answers. The editor gets no deadline. The server keeps its process deadline, under which a fold stores nothing partial. The three dependency budgets go.

**Not built:** a cut-off when a recalculated value is unchanged, viewport-first evaluation, threads. Calc's threaded recalc has a nine-year bug tail from one cause: every cell a group may read must be known before it runs.

### Formulas under collaboration

**One idea sorts every rule here.** A computed value reaches a reader in one of two ways. Either its author computes it and it travels: one writer decides, and every reader stores what was sent. Or every reader computes it for itself, and then it must be a pure function of the stored inputs and the engine build. Step 1b has both, as today: a cell edit sends its author's results, and a row, column or sheet op recomputes on every reader. From step 2 only two kinds of value travel ([§ Who computes values](#who-computes-values)) and everything else is the second kind. So the rules below bind the whole engine from step 2, and the parts of it every reader runs from step 1b.

**1. A clock or random formula is never a seed, and its value is its author's.** `NOW`, `TODAY`, `RAND`, `RANDBETWEEN` and `RANDARRAY` are volatile, a flag on the shape (today a regex over raw text that also matches inside strings). Such a formula is computed when its own cell is written or a precedent of it changed in the author's edit, and in a recalc of a never-computed workbook. Its value travels as a `result` op, and a reader's own recalc keeps what is stored. If every edit by anyone refreshed it, every batch from every tab would write the `NOW()` cell and no two edits would commute. A clock every reader reads for itself would put different numbers on two screens and a third in the export. A clock carried by the log, largest wins, would let one wrong laptop move `TODAY()` for everyone, for good.

**2. `INDIRECT`, `OFFSET` and the resized three-argument `SUMIF` are seeds of every recalc, decided from the formula's text.** With the same cells they give the same answer; what they lack is a dependency the text lists. Excel's answer is to recompute them every time, and that is ours. Whether a formula is one is read from its shape, so a joiner, a tab after a reload and the server agree without having evaluated anything. No rectangle a formula once read is recorded: that record would exist only on the reader that evaluated it. The corpus has 10,176 `INDIRECT` and 337 `OFFSET` formulas in 10 and 3 workbooks. Measured in the worst (3,744 `INDIRECT` cells): 28 and 42 ms an edit by scan, all of it exact lookups over the ranges they name, which the column index should serve; the gate is 8 ms with it, and step 1a measures that first. The index form of this rule ("`INDIRECT` depends on every sheet") would save nothing in that workbook, so there is one rule.

**3. A spilled value is derived, and an input always wins.** [§ Arrays and spill](#arrays-and-spill). The second version sent spilled cells as writes and accepted one race, a typed value lost to a spill that lands second. Derived values close it by construction: a spilled value is never sent, and the snapshot only marks it.

**4. What every reader computes reads nothing but the stored inputs and the build.**

- **No clock.** Rule 1. And the cap of a recalc is counted, never timed. A clock may decide whether one writer's whole pass is stored, as the server's fold does; never how far a pass every reader runs got.
- **No host language data.** Text order is the engine's own comparator ([§ Values](#values-the-rules)). `Intl.Collator`, `localeCompare`, `toLocaleString` and the host's time zone stay out of the engine.
- **No memory of earlier evaluations.** Rule 2, and a store a load reproduces.
- **One thing is accepted and written down.** `SIN`, `COS`, `TAN`, `ATAN`, `EXP`, `LN` and `LOG10` come from the JS engine. Measured over 3 million inputs each, JavaScriptCore against V8: 1.2% to 5.6% of inputs differ by 1 or 2 ulp, and `TAN` on 34% by up to 3. `POWER` and `SQRT` agree. So Safari, Chrome and the server can differ in the last bits. It shows the same at 15 digits and could flip an exact comparison downstream. From step 2 such a difference is shown, never stored. Rounding results does not fix it, and our own versions of those functions would be several hundred lines and slower. Functions that iterate to a tolerance (`IRR`, `RATE`, the inverse distributions) stop on a fixed count of steps or a tolerance wide enough that the last bits cannot change the count.

The transform is a pure function of (stored formula, host, edit). So every reader derives the same text and, but for those last bits, the same values from one marker, on one condition: the same engine build.

**What travels.** A cell edit sends the cell's input, a formula as its shape text. A structural edit sends its marker only; every reader runs the transform. In step 1b the author's results also travel, as `result` ops; from step 2 only the two kinds of state value do. Shape ids, the store and the index never leave the process.

**Offsets do not make a late batch right.** Ops are not transformed against a concurrent row op (defect 32, a sync topic, unchanged). A formula written for B5 lands at row 5 whichever way it is spelled.

**Undo.** An entry is ops; a formula in it is its stored text. When a peer's row or column op lands, `shiftOps` moves cells and ranges with `mapIndex` and `mapSpan` and formula text with the transform, the same functions the cells went through.

### Structural edits: one transform

**The one idea: a reference names cells, not coordinates.** After an edit it names the same cells, wherever they went. `$` plays no part in a structural edit.

**Two functions carry every rule.** `mapIndex(edit, i)` gives the new index or "gone". `mapSpan(edit, start, end)` gives the new span or "gone", with the clamp for a delete: a start in the deleted band moves to the first survivor after it, an end to the last survivor before it. Both are blind to the axis. Formula references, conditional-format and validation ranges, merges, filters, the frozen pane, charts and undo paths all call them. Calc has two such functions and they drifted four times; IronCalc maps each end alone and prints `#REF!:K4`; Univer got the boundary predicate wrong four times. A table test covers every position of an edit against a range, first and last index of the grid included.

**One transform over a shape's reference leaves.** It is pure: (shape, host before, host after, edit) in; the same shape object out when nothing changed, else the new shape, plus two flags. "Lossy" means undo must keep the old text. "A value can change" means the formula is a seed of the recompute: a deleted target, a clamped end, `ROW()` or `COLUMN()` of a moved cell, cells shifting inside a whole column. A range that only gained an empty row is not a seed, so inserting a row above three 10,000-row running totals does not read 150 million cells. Calc had a bug for each way "text changed" and "value changed" differ. The rule, with `m` the edit's map on the edited sheet and the identity elsewhere: an absolute coordinate `t` becomes `m(t)` on the target's sheet; an offset `d` from host `h` becomes `m(h + d) − m(h)`, each `m` on its own sheet.

| Stored | Changes when |
|---|---|
| absolute, target on the edited sheet | the target is at or past the line |
| offset, host and target both on the edited sheet | they are on different sides of the line |
| offset, host on the edited sheet, target on another | the host is at or past the line |
| offset, host on another sheet, target on the edited one | the target is at or past the line |
| anything with its target in a deleted band | always: `#REF!`, or a clamped range end |
| the other axis; a whole column under a row edit; a literal | never |

That table is the test plan. HyperFormula and Univer both confused host sheet and target sheet for years, and IronCalc first shipped without moving absolute references at all.

**Per class of hosts, not per cell.** For one shape and one run, the outcome is the same for every host on one side of a few break rows. The transform runs once per class and the run's cells get the new shape id. On the reference workbook a row inserted near the top of MASTER DATA changes the stored form of 73,167 cells but only 346 distinct shapes; today it rewrites 39,685 distinct texts. Calc computes the same classes as "group split bounds" and got them wrong for three years, so the tests hold the fast path against a slow, obviously right version written in the test: resolve every reference to absolute cells, map each cell, print.

**A conditional-format formula has one text for many cells.** It is stored relative to the top-left of the rule's first range and transformed once, with that cell as host. This is Excel's behaviour, and it has Excel's edge: a relative reference to another sheet drifts for the rule's cells past the inserted line. Accepted.

**Copy, fill and sort need no transform.** The pasted cell takes the source's stored text as it is. Only an offset that resolves off the grid at the new host becomes `#REF!`, and that is a check. Sort is a copy per row, as Excel does it, with no option: Calc's "references follow the sorted rows" cost eight months of 2014.

**A move is its own map**, source block to destination. Every reference to a cell in the block follows it, on any sheet (today a formula elsewhere does not follow a cut: defect 25). A range follows only when the whole range is in the block. A reference to a cell the destination overwrote becomes `#REF!`, as in Excel.

**Sheets.** References in formulas hold ids, so a rename or a tab reorder rewrites no formula. A deleted sheet's references print and evaluate as `#REF!`; undo restores the sheet and they bind again with no rewrite. One more leaf walk, `remapSheets(text, ids)`, serves the two places a sheet gets a new id: `addSheetsBatch` (`apps/api/src/lib/document/sheets.ts`), which gives every imported tab a fresh id and today rewrites its texts through `renameSheetTexts`, and a duplicate of a tab. Without it an inserted tab's formulas would read whichever sheet happens to hold the importer's id.

**Undo of a lossy edit.** The transform reports "lossy" per formula: a single reference into a deleted band, a range that lost an end, a reference to an overwritten cell. The undo entry keeps the old text of those only, which is what `repairOps` ships for a delete today. `#REF!` forgets its coordinates. Calc keeps them under a flag that must survive every later transform, and needed two fixes three years apart.

### Arrays and spill

**Arrays are always on**, as in Excel 365. There is no array mode and no flag threaded through evaluation; Calc's "force array" family regressed three times and grew to eight parameter classes.

- **Element by element.** A binary operator on r1×c1 and r2×c2 gives max × max. A length of 1 repeats; a shorter length that is not 1 leaves `#N/A` (Excel: `=F5:F8*{1;2;3}` is `{2;8;21;#N/A}`). Each element gets its own coercion and its own error. One broadcast helper serves every operator and every lifted function, and 1×1 arrays become scalars at that one boundary. So `=SUMPRODUCT(--(B2:B4>15))` and `=SUMPRODUCT(ISNUMBER(A1:A3))` work.
- **Lifting.** An array at a scalar parameter runs the body once per element. An error in one element stays in that element.
- **Array constants.** `{1,2;3,4}`: constants only, equal row lengths.
- **`@`** is a prefix node: one cell → itself; one column → the cell in the formula's row; one row → the cell in the formula's column; otherwise `#VALUE!`; an array → its top-left. A formula from an xlsx cell without dynamic-array metadata is a legacy formula and gets `@` inserted at import, where old Excel would have intersected, by one pass over the tree that reads the function signatures. Export strips the ones Excel would add again and writes the rest as `_xlfn.SINGLE`. IronCalc needed 2,200 lines and four rounds for this; unit 0 counted 67,750 corpus formulas (6%) that would get one, 99% of them before `INDEX` and its kin, where export strips it again; a true range intersection is 590 formulas in 7 workbooks.
- **Spill**, from step 2. The anchor cell holds the formula. After it evaluates to an array of more than one cell, the engine, at a safe point after evaluation, checks the rectangle. Every other cell in it holds no input: the values are written into the value planes with the "from an anchor" bit, and those cells depend on the anchor. Any cell in it holds an input: the anchor shows `#SPILL!` and writes nothing. An empty array is `#CALC!`. Nothing about a spill is sent, and no size is stored. It is a pure function of the inputs, so a typed value and a spill that grows over it end the same in either log order, which no design that sends spilled cells can give. In step 1b an array result shows its top-left value.
- **`A1#`** is the rectangle A1 spilled into, `#REF!` when A1 is no anchor.
- **Size comes from the value.** HyperFormula predicts array sizes from the tree and cannot size `FILTER`, `UNIQUE` or `SEQUENCE(A1)`.
- **`LET` and `LAMBDA`** are scoping over one environment chain with names resolved to slots at parse time and an explicit depth counter. Calc wrote `LET` three times. Arguments reach a lambda whole.

A legacy Ctrl+Shift+Enter array from xlsx becomes an ordinary anchor; its fixed-rectangle rules are left out. The snapshot stores a spilled cell's value with its `spill` mark, so a reader of the snapshot alone sees it and a load does not take it for a typed value.

### Values: the rules

Excel is the reference. The three-way oracle (Excel on the web, Google Sheets, LibreOffice, 953 cases) settled what the research only remembered; where Excel contradicted the research, Excel wins.

- **Blank** is a value of its own, in scalars, in array elements and in lookups. It is 0 in arithmetic, `""` in `&`, FALSE as a condition, and takes the other side's type in a comparison. A formula whose result is blank stores 0, as Excel does (until the owner picks, at the start of step 1b).
- **Coercion to number** (operators and scalar numeric parameters): boolean → 1 or 0; text is parsed as a person could type it into a cell (`"1 1/2"` is 1.5, `"10%"`, `"$1,000"`, a date), else `#VALUE!`. One function, shared with criteria, in one fixed locale. Unary plus does not coerce.
- **Aggregates go by where a value came from.** Typed directly (`=SUM("1",TRUE,2)` is 4): text is parsed, booleans count. From a reference or array: text, booleans and blanks are skipped. No value carries a tag: the aggregate sees whether its argument is a scalar or a view.
- **Comparison.** Errors first, the left one. Across types: number < text < FALSE < TRUE, and `=` across types is FALSE (`=1="1"` is FALSE, where today it is TRUE). Text compares on its upper-cased form, so `="straße"="STRASSE"` is TRUE, as the oracle found in Excel.
- **Text order is the engine's own comparator.** Upper-case both strings, then compare by code unit, through one small fixed table that puts an accented Latin letter beside its base letter (`é` after `e`, before `f`). No `Intl.Collator`: it reads the language data of whichever browser or server runs it, so after a row insert two readers on the same build could order text differently in `MATCH`, `SORT` or `<`, and no deploy would fix it. The grid's sort calls the engine's comparator, so a list sorted in Eigen is sorted for `MATCH`. It is not Excel's order for every script; Excel's own order follows the Windows locale of the machine, so there is no single order to match ([pick 8f](#part-3-the-owners-rulings)).
- **Precision.** Arithmetic is plain IEEE doubles. Numbers compare after rounding both to 15 significant digits (`=0.1+0.2=0.3` is TRUE), with two cheap exits before any rounding. A literal keeps 15 digits. Number to text is 15 digits (`=LEN(1/3)` is 17).
- **The zero snap, as the oracle found it.** `=0.1+0.2-0.3` is 0. `=(0.1+0.2-0.3)` is 5.55E-17 and `=1*(0.5-0.4-0.1)` is −2.78E-17. `=SUM(0.1,0.2,-0.3)` is 0, which the research had wrong. So a `+` or `−` node, and the total of a sum, returns 0 when the result is tiny against its operands, and a parenthesis node evaluates a direct `+` or `−` child without the snap. Two readings fit these four answers (every unparenthesised `+` and `−` snaps, or only the formula's last operation), and the threshold is not documented. One Excel experiment of a few hundred cases settles both before these tests gate a build.
- **One summation.** `SUM`, `+`, `SUMPRODUCT`, `SUBTOTAL` and `SUMIFS` add left to right, in range order, with plain double addition. Compensated summation is rejected: it does not give Excel's 0 either, and Calc had to restore `SUM(0.1;0.2;-0.3)=0` after adding it (`730b8aba7235`).
- **Rounding functions** round the decimal value Excel shows: `ROUND(1.005,2)` is 1.01. `MOD(0.3,0.1)` is 0.09999999999999998, as Excel stores it.
- **Errors.** The seven classic ones plus `#SPILL!`, `#CALC!` and our `#ERROR!` for unparsable text; any other `#…!` in a file is carried as an opaque error. Leftmost operand or argument wins; a failed coercion counts as that operand's error (`="a"+#N/A` is `#VALUE!`). `0^0` is `#NUM!`, `0^-1` is `#DIV/0!`, overflow is `#NUM!`. A text result that reads like an error stays text, because the kind is stored, not guessed from the string (defect 3).
- **Dates.** Google's day line: day 0 is 30 December 1899 and 1900 has no 29 February, so `DATE(1900,2,29)` is 61, `DAY(60)` is 28 and `DAY(0)` is 30; from 1 March 1900 on a serial is Excel's. `TODAY` and `NOW` read the clock and zone of the tab whose edit computes them, as today; no reader's recompute ever calls them.

### The function library

**A function is one registry entry: name, parameter kinds, flags and a pure body.** The kinds are `scalar` (typed number, text, boolean or any; lifted over arrays), `range` (a view, never copied), `ref` (a reference, never read), `lazy` (unevaluated) and `any`. The flags: volatile, returns a reference, reads cells its arguments do not name, depends on its own position, returns a date. The two engines with a signature table (HyperFormula, Gnumeric) are the two with uniform argument handling; the engines where each function parses its own arguments have per-function coercion bugs for ever.

**Two lists, each with one job.** The registry is what we implement: it drives evaluation, `@` insertion and autocomplete. `state/modules/function-list.ts` (8,824 lines of autocomplete text) keeps only the registry's names, held by the test that pins the two together today. Excel's full inventory moves from `packages/lib/src/sheets/excel-functions.ts` into the package as data (about 550 lines): it tells "Excel has it, we don't" from a typo, and it gives xlsx export the `_xlfn.` prefix for a function we do not implement, which the registry alone would drop.

**formulajs is replaced, not wrapped.** Its convention (plain JS values, `Error` instances, local-time `Date`s, flatten everything first) rules out lazy parameters, reference parameters, source-dependent coercion and streaming ranges. Eigen already overrides or disables about 60 of its names, the ones that matter most, and 4.6.1 changes none of this. `ROW`, `COLUMN`, `OFFSET`, `INDIRECT`, `ADDRESS`, `INDEX` in reference form and `A1:INDEX(…)` exist because functions can receive and return references.

**Criteria** are one module. A criterion compiles once per call into a predicate over a typed value: an optional leading operator, an operand typed as cell entry, wildcards for text equality, case-insensitive, and the empty-string family. Excel's answers from the oracle: `"<>"` counts a cell holding `""`; a blank cell as criterion is the number 0; `"><"` is "greater than the text `<`"; numeric equality is the 15-digit compare. The eight `*IF(S)` functions and the D-functions use it, row by row with early exit, never a boolean array per criterion (Univer ran out of memory that way, `9ca7e2e92`).

**Lookups** are one search module: exact, wildcard, nearest, and bisection over the same-type, non-blank values, landing on the last of equal keys. `MATCH` types 1 and -1, `LOOKUP` and an approximate `VLOOKUP` or `HLOOKUP` halve and assume sorted data, so on unsorted data a position can differ from Excel's, which walks a run of equals cell by cell; the binary modes of `XMATCH` and `XLOOKUP` bisect in the one order of all values. `VLOOKUP`, `HLOOKUP`, `MATCH`, `XMATCH`, `XLOOKUP` and `LOOKUP` map their arguments onto it. A key matches only cells of its own type.

**A per-column index for exact lookups and equality criteria.** Unit 0 asked for it: Apportion's worst one-cell edit is 0.85 s on Bun and 1.5 s on Node by scan, all of it 26,738 `SUMIFS` with four equality criteria over the same four columns, and the workbook with 3,744 `INDIRECT` lookups pays 28 to 42 ms an edit in exact `MATCH`es. One structure: a map from a value's key to its ascending rows, for one column, built the second time an exact lookup or an equality criterion reads that column, valid for that column's version and dropped on any write to it. It is derived from the column alone, so a load loses nothing. It is never patched: HyperFormula's maintained index took 40 commits and is off by default; Calc's sorted cache has been disabled by a hard-coded return since 2023; Univer's needed twelve fixes. Its test compares lookups and criteria on random data, with duplicates, blanks and mixed types, against a plain scan written in the test.

**Numerics** are our own kernels from published algorithms (Cody for the normal CDF, Wichura AS 241 for its inverse, Lanczos, the incomplete gamma and beta by series and continued fraction), not ports. `TEXT`, `FIXED`, `DOLLAR` and number-to-text go through `numberDisplay` in the package's format entry, the one wrapper of `numfmt` that the grid, the charts and the exports call too, so the product has exactly one.

### Defined names, tables, 3-D references

None of the three is an Eigen feature, and all three get one rule: **import resolves them to cell references, as names are resolved today.** The first version kept names. But the editor gets no name manager in this program, so a kept name would be state a person reads in a formula and can neither see nor change; a workbook-wide name has no home in a model of `Sheet[]` and per-sheet ops, so the snapshot, the log, the fold and `addSheetsBatch` would all have to carry it; and a name is a reference that is not in the shape, so it reaches into the index and the transform. That is a feature, built for an import path. So `nameInliner` stays, re-pointed at the new parser, and a name that cannot be resolved marks its shape as one this build cannot evaluate. A structured reference (`Table1[Col]`, 6.4% of corpus formulas, most of today's 77,945 parse failures) is resolved the same way from the table ranges in the file: 71,413 corpus formulas, which the reader keeps as one node each and `resolveTables` turns into the plain range it names, a this-row reference by its row's number on any sheet. A 3-D reference keeps Excel's value. The cost: 2.0% of corpus formulas export with a range where they held a name, as today, and table formulas the same. The grammar parses a name and a 3-D reference as nodes, so the feature has a place to land.

### Every caller

Each point of the current contract maps to one call, stays, or goes away. The rows are step 1b's unless they say otherwise.

| Today | After |
|---|---|
| `computeFormula`, `FormulaEngine.evaluate` (evaluate a typed formula) | Gone as a separate path. The editor parses the typed A1 text at its cell into the stored form and writes the cell; recalc returns its value with the dependents' |
| `execFunctionGroup`, `evaluateFormulas`, `recomputeAfter`, `recalcSheets` | One `recalc(seeds, cap)`. Server recalc of never-computed cells is the same call seeded with the formulas that hold no value |
| `FormulaGraph.set`, `followPatches`, `shift`, `setFormulaCellInfo`, `warmFormulaGraphOnIdle`, `formulaCache.resetEngine` | In steps 1b and 2 the adapter: storing a write, the one edit call, and `load`. From step 3 nothing: `applyOps` writes the store. Nothing warms on idle |
| `applySheetsBatch`, `replaySheetsOps`, `replaySheetsSteps`, `seedsOf` | Stay in `packages/sheet/src/engine/replay-ops.ts` as the host. `seedsOf` goes: the transform's "a value can change" flag gives the seeds |
| `functionStrChange`, `mayShiftOffSheet`, `rewriteSheetFormulas`, `shiftFormulasAcrossSheets`, `shiftRefForRowCol` | The transform. No pre-filter is needed |
| `functionCopy` (paste, fill, sort, shared-formula import) | Gone: a copy keeps the stored text. One bounds check |
| `moveFormulaRefs` (cut, drag); `withCfRanges` (re-anchor; also the export's clipping in `export/sheets/window.ts` and the xlsx rules in `export/sheets/xlsx/rules.ts`) | The move map, sent as a `move` op. A conditional-format formula is stored relative to its range's top-left, so re-anchoring is not a rewrite (defect 28) and the two exports print it at the new top-left |
| `renameSheetRefs`, `breakSheetRefs`, `namesSheet` | Gone for formulas: references hold sheet ids |
| `renameSheetTexts`, called by `applySheetRename` (`sheet-name.ts`), `addSheetsBatch`, the xlsx export's renaming of sheets to names Excel accepts (`to-xlsx.ts`) and the import's repair of sheet names (`from-xlsx.ts`) | Stays for what it still serves: dropdown sources and cell-range links, which keep their A1 text and sheet names. Formulas and formula rules need nothing on a rename; in `addSheetsBatch` they go through `remapSheets`. A duplicate of a tab (`copySheet` in `state/api/sheet.ts`) remaps its formulas the same way, where today it rewrites only chart refs |
| `inlineNames`, `nameInliner` | Stay as the import's resolver, on the new parser, joined by the resolver for structured references |
| `shiftRules`, `shiftCellKeyed` (borders and other cell-keyed maps), `shiftKeyedMap` with `LINE_MAPS` (sizes and hidden flags), `shiftMerges`, `shiftFilter`, `shiftFrozen`, `shiftChartsAcrossSheets`, the path half of `shiftEntries` | Each holder keeps its own loop and calls `mapIndex` and `mapSpan` (step 1a for `rowcol.ts`, step 1b for `shiftOps`). A whole-column rule stays whole (defect 27) |
| `shiftRules` in `engine/rowcol.ts` over `sheet.conditionalFormats` and `sheet.dataValidations`, records by id with `ranges` and an order key, read through `orderedRules` (`packages/lib/src/sheets/range-rules.ts`) | Stays the rules' holder and calls `mapSpan` per range; a range that is gone is removed from its rule, and a rule with no range left is removed by its id. Nothing in the engine addresses a rule by index |
| `history-shift.ts` dropping the undo patch of a formula rule whose text names the row op's sheet, through `mayShiftOffSheet` | `shiftOps`: the rule's text in an undo entry goes through the transform, as a cell's does. No pre-filter and no drop |
| `mapChartRefs` | Stays the charts' holder: it maps each `CellRangeRef` with `mapSpan` and writes `specData` through `chartSpecWrites`, as Wave 2 (F4, merged) left it |
| `createCfFormulaEvaluator`, `evaluateConditionalFormat` (formula rules) | `evaluateAt(text, sheet, row, col)`. The rule's text is the stored form on the rule's record. The paint cache also keys on the engine's value version, so a cross-sheet edit repaints (defect 29) |
| The rule dialog building `=B2>A1` (`state/modules/condition-format.ts`), `apps/api/src/lib/import/sheets/rules.ts`, the demo seeder's `buildCell` (`apps/api/src/scripts/demo/sheet-build.ts`) | Each writes A1 today. Each parses it at its cell into the stored form, with sheet ids |
| `iscelldata`, `resolveCellRange`, `getcellrange`, `parseA1Range`, `toA1`, `rangeToA1`, `a1RangeRef`, `rowIndexToLabel`, `quoteSheetName`, `unquoteSheetName`, `misreadBare`, `sheetRefName`, `sheetNameKey`, `sheetFinder`, `findSheetByName` | The text entry of the package. Quoting is grammar, with an allow-list. `legalSheetNames` and `copySheetName` stay in `sheet-name.ts` |
| `cycleReferenceAtCaret`, `findRefSpans`, `functionHTML`, `formulaOperators`, `checkBracketNum` | One `tokens(text)` call: F4, highlighting and bracket checks read the real lexer's tokens |
| `holdsFormulaResult`, `writeFormulaResult` | Steps 1b and 2: stay in `engine/format.ts`, changed: compare the value and its kind first, take the kind from the engine, write no `m` and no `ct.t`. Step 3: gone |
| Every read of a cell's `m`, directly or through `cellDisplay`, `getRealCellValue` and `getCellValue(…, 'm')` | `cellDisplay`, which formats through `numberDisplay` at the read. The full list of callers is in [§ Step 1b](#step-1b-the-wire-and-the-flip) |
| `ct.t === 'inlineStr'` (26 lines in 7 files) and `ct.t === 'd'` (10 sites) | `ct.s` not empty; a date number format |
| `documentReferences` walking `op.path` (`apps/api/src/lib/document/references.ts`) | `opReferences(op)`, exhaustive over the nine kinds |
| `facetsOf` in `apps/api/src/scripts/xlsx-audit.ts` comparing `m` and `ct.t` | Compares `cellDisplay` and the value's kind |
| `opToPatchOnSheets`, `applySheetWrites`, `patchToOp`, `recordEntry`, `shiftEntries` | `applyOps` per kind, the translator onto the nine kinds (until step 3), entries as ops, `shiftOps` |
| `isRegisteredFunction`, `DOTTED_FUNCTIONS` | The registry |
| `isExcelFunction`, `EXCEL_FUTURE_FUNCTIONS`, `withFuturePrefixes`, `withoutFuturePrefixes`, `renameFunctions` | Excel's inventory in the package (`src/functions/excel-names.ts`, entry `@workspace/formula/names`), and the xlsx printer. The API's fifth walker over formula text goes |
| `CellResolver`, `createArrayResolver`, `withComputedValues`, `computedKey` | Gone from formulas. Charts keep a plain read of cells by sheet id |
| `FormulaEngine.cantEvaluate`, `UNSUPPORTED_FUNCTION`, `UNSUPPORTED_ARRAY_OPERATION`, `OMITTED`, `VOLATILE_RE` | Flags on the shape |
| `error`, `valueIsError`, `dateToSerial` | From the package |
| `MAX_SHARED_FORMULA_TEXT`, and the "recalc materializes" reason on `MAX_GRID_SLOTS` (`apps/api/src/lib/import/sheets/limits.ts`) | The first goes: no text is generated for a shared copy. The second is restated: the store costs 17 bytes a slot it holds (24 a held cell on the reference workbook), not a slot of the grid |

### xlsx

- **Import.** `<f>` is parsed in the file dialect at its cell and stored as the shape text. `t="shared"`: the master is parsed once and every cell with the same `si` on that sheet gets the same stored text. No text is generated or parsed for the copies; they are 49% of the corpus's formula cells. Membership is by `si` alone: Excel's `ref` is "incorrect about half the time" (Calc `d66ae92ade61`). `t="array"` becomes an anchor; `cm` metadata tells dynamic from legacy. Cached `<v>` values are kept, so a file opens without a recalc; the cached values inside a dynamic array's `ref` are kept too, each marked `spill`, since a spilled cell holds no input. `_xlfn.`, `_xlfn._xlws.` and `_xlpm.` prefixes are stripped; `_xlfn.SINGLE` and `_xlfn.ANCHORARRAY` become `@` and `#`.
- **Export.** One more printer over the same tree: prefixes from Excel's inventory, `@` and `#` in file spelling, redundant `@` dropped, a formula `isLegacy` cannot prove plain written as an array formula (the `@` rule reads each place as a value, a reference or an array, and the mark goes on when unsure), every `t="array"` with `cm` and the metadata part from step 1b on, anchors with `t="array"`, `ref` (from the cells that name the anchor) and the dynamic-array metadata, cached values. Calc first wrote `@` and `#` by patching the output string at remembered offsets and "kept breaking" (`1ac50fddc77c`); with a tree it is a small rewrite before printing. Every formula is written in full.
- **Other workbooks.** A reference to another workbook parses, is kept, and marks its shape as one this build cannot evaluate: the cell keeps Excel's value (1.3% of corpus formulas).

### The server

The API imports the same package and runs it headless. In step 1b it builds an engine only when a read needs one: a log with a structural batch, a snapshot marked not computed, or an HTML or PDF export of a sheet with formula rules. From step 2 every read of a document with a non-empty log applies the log and recalculates once, under the counted cap; a folded, computed document is read without an engine unless it has formula rules to paint. Affordable by measurement: an open is 6 to 77 ms on the five gated workbooks and a whole recalc 11 ms to 1.5 s, where today one recalc can be minutes. The package has no module-level state, so two documents in one process cannot touch each other (today the lexer keeps state in a module global).

### The stored format

**What changes, all of it, once, in step 1b.**

1. `Cell.f` holds the shape text, with the leading `=`: `=SUM(R[-3]C:R[-1]C)*[k3f9]!R2C1`. `isFormula` stays the one test, moved to `engine/format.ts`.
2. A conditional-format formula rule holds its formula in the same form, relative to the top-left of its first range.
3. A stored cell is a closed record with one validator ([§ Step 1b](#step-1b-the-wire-and-the-flip)). No display text `m` and no value type `ct.t`: a value's kind is the kind of what is stored, a number, a text, a boolean or an error, and a cell is rich when it holds runs. No `mc`: a merge is its record. A `spill` mark on a value that came from an anchor.
4. The snapshot becomes `eigensheets/3`: formula text interned as styles and borders are, one `formulas` list, a cell's `f` an index into it, cells in column order.
5. The op log moves to a new array key beside today's `ops` (`packages/lib/src/sheets/yjs-state.ts`), and holds the nine kinds of [§ What the Yjs document holds](#what-the-yjs-document-holds).

Dropdown sources and cell-range links keep their A1 text and sheet names, so `renameSheetTexts` stays for those two, called by the `field` applier on a rename.

**Why the log needs a new key.** Old-form text parses in the new grammar with another meaning: `=C1*2` is cell C1 in A1 and the whole of column 1 in R1C1. An A1 op that reached a new-format document would not fail; it would be a different formula. The data epoch stops a tab that is open across the deploy. It does not stop a tab that was offline: its queued Yjs updates merge into the document whatever it then fails to decode. Under a new key, an old build's ops land where no new build reads.

**Why offsets.** The baseline counted what one row inserted near the top of a sheet changes:

| | A1 | Offsets | Hybrid (own sheet as offsets, other sheets as A1) |
|---|---|---|---|
| Reference, MASTER DATA: cells changed | 39,700 | 73,167 | 28,030 |
| Reference, MASTER DATA: distinct texts changed | 39,685 | 346 | 5,894 |
| Reference, Incurred: cells changed | 47,385 | 66,775 | 43,891 |
| 65 gov.uk workbooks: cells changed | 353,665 | 196,672 | 48,944 |
| Corpus: distinct texts changed | 438,949 | 1,868 | 3,656 |
| Reference: distinct texts in the workbook | 123,292 | 1,001 | 74,883 |
| Corpus: distinct texts | 933,982 | 29,095 | 239,801 |

By cells, offsets are worse than A1 on the reference workbook, because 45,137 references on MASTER DATA read another sheet relatively. But a changed cell is not a cost. It sends nothing: a row op is a marker and every reader rewrites for itself. Undo does not see it. What costs is text work, and that goes by distinct texts: 346 transforms against 39,685, measured at 2.6 to 2.8 ms for the whole engine side of the insert, checked against a slow version on all 125,519 formulas with none wrong. The write of the new text is an id fill in the end state (0.9 ms) and a copy of each cell while the host's matrix lives (10.9 to 21.8 ms, [§ Step 1b](#step-1b-the-wire-and-the-flip)). The hybrid gives up the sharing that pays everywhere else (74,883 texts to parse at every open) and loses "a copy keeps the stored text" for every cross-sheet formula.

**What offsets cost.** The text is longer: 1.16 times the A1 text on the reference workbook with short sheet ids, up to 1.47 times with long ones. The snapshot interns it (the 1,001 shapes are 24.8 kB). The log does not: a fill, a paste and an added sheet carry formula text per cell. And nobody can read it raw, so a dev script prints any document's formulas as A1.

**What a person sees.** Never the stored form. The formula bar, the editor, `FORMULATEXT`, the clipboard and xlsx show A1, printed from the shape at its cell. Anything that showed `cell.f` directly must print it: between 36 and 61 reads in non-test files today.

**What breaks, plainly.** There is no backward compatibility and no conversion (owner, 11 Nov 2026). A build from step 1b on reads `eigensheets/3` and the new log key, and has no reader for anything older. A sheet document an older build wrote falls under the rule SHEETS.md already has (§ An undecodable snapshot locks the editor and never overwrites), with no new code. The decoder throws on any other format (`decodeSheetsWorkbook`), so the editor opens the document read-only on blank defaults, under the banner "This spreadsheet could not be loaded. It is shown read-only so nothing gets overwritten.", and sends no op (`handleOp` in `use-sheet.ts`). Its old log sits under a key the new build never reads. To use the document again a person replaces its content with an import, or deletes it. xlsx files are not affected. Steps 2 and 3 change no stored format, and a test in step 2 opens a 1b document to hold that.

**Nothing on the server crashes on such a document or writes over it.** Checked in the code on 11 Nov 2026. The fold skips a snapshot that is not current (`sheetsNeedCompaction`). An export, a preview, a search extract and Import… as new tabs decode first (`readSheetsFromDoc`, `addSheetsBatch`), so each fails as one job in the transform child and changes nothing. The media and thread sweep decodes the snapshot too (`documentReferences`), throws, and deletes nothing. A restore of a kept version in an older format answers 409 (`restore.ts`). A document that comes back from the trash or a backup is the same document, under the same rule. Step 1b keeps these four checks as they are.

**One case the lock does not cover, and it is accepted.** A workbook gets its first snapshot at its first fold, so one that never folded has only a log. Under the old key that log is not read and nothing marks the document as old: it opens as a new, empty, editable workbook, and the sweep removes the media and threads only the old log named. CODE-STANDARDS.md § Code Philosophy accepts this loss by name ("an unreplayed edit"), and a check of the old key would be the reader for an old shape that it rules out.

## Correctness gates

**Test first.** Every unit writes its failing tests from the fact documents before its code. The implementer never reads upstream source.

**Tests drive the public path.** No option, export or counter exists for a test. Where the first version asked for one, the test changed: the depth bound is tested by a 100,000-cell chain asked from its end, not by a bound set to 1; order independence by writing the same workbook through the adapter in shuffled order; the column index against a scan written in the test; over-marking of dirty cells by the bench's edit times, not by an evaluation counter.

**The oracles, and what each may decide.**

| Oracle | Size | Decides |
|---|---|---|
| The value cases, answered by Excel on the web, Google Sheets and LibreOffice | 1,051 cases, 953 answered by all three | Parsing, coercion, comparison, precision, errors, arrays, `@`, spill, criteria, lookups. Excel's column is the expected value, except the picks of decision 7 |
| The structural cases, run in Calc | 219 cases, 201 equal to the research | Row, column, cell, move, copy, sort and sheet edits, at the text boundary |
| The slow reference transform, in the test | property test, random formulas, hosts and edits | The fast transform, class by class |
| Held against a fresh load (steps 1b and 2); against a fresh decode and replay, and the headless twin (step 3) | random batches, loads in the middle | That memory holds nothing the document does not |
| Two tabs, a joiner and the server on real `Y.Doc`s | the cases of the collaboration study's table, and random logs | That every reader ends with the same inputs and, from step 2, the same values |
| LibreOffice's self-checking function documents | 509 files, about 51,000 formulas | Numeric results of the function library, with an allow-list per file where Calc differs from Excel on purpose. They need a converter nobody has built |
| The corpus's cached Excel values, isolated and chained | 1,097,024 formula cells | Everything at once, at scale |
| The existing contract tests | `structural-recompute` and `writers-recompute` and `formula-results` (`packages/sheet/src/test/state/modules/`), `held-graph` rewritten, `sheets-structural-recompute` and the import, export and replay suites of the API, `use-sheet.test.tsx` and `use-sheet-order.test.tsx` on real `Y.Doc`s | The editor and server boundaries. The inherited parser tests (`packages/sheet/src/test/engine/parser/`, about 509 cases, 396 of them under `integration/parsing/`) are re-judged against Excel, not kept as truth |
| The xlsx corpus round trip, `xlsx-audit.ts roundtrip` | the corpus | That a file survives import and export, from step 1b |

**Before these gate a build**, three things are still open: the 60 cases that need a hand in Excel, the 40 structural cases to check by hand in Excel (row and column moves were emulated in Calc and are weak evidence), and the snap experiment. Excel on the web seems to store `#SPILL!` and `#CALC!` as `#VALUE!` in the cached value; four cases turn on whether that reading is right.

**Done means:**

1. Every value and structural case passes with its expected answer: Excel's, or the listed pick.
2. Corpus oracle, isolated and chained, reported in four columns: match, differs by a listed pick, not evaluated, mismatch. Targets for the end of step 2, firm once step 1a's functions unit reports (steps 1a and 1b count tier 3 to 5 names as not shipped): match at least 97.5% (84.85% today; the ceiling is about 98.4%); not evaluated at most 2% (14.48% today), every one a named class: another workbook (1.3% of formulas), `GETPIVOTDATA`, a user-defined function, a 3-D reference, a function not shipped; unexplained mismatch under 0.05%, about 550 cells (0.67% today). A cell that differs by a pick is never counted as a match.
3. The function documents pass outside their allow-lists.
4. Every gate of the step holds, engine and host, on Bun and on Node.
5. Every row of the caller table that belongs to the step is done, what the step deletes is deleted, and `bun run check` passes.
6. Each of the 48 defects this design fixes has a test that shows it. The other twelve keep their rows or need none: six are editor, sync or host topics (the dead cross-sheet click, swallowed out-of-memory, a merge that reads itself, a formula under a validation rule, late batches, a renamed added sheet); three are kept on purpose in this proposal (`NOW()` does not move by itself, names are resolved at import, dropdown sources and links do not follow row edits); one is a ruling (empty text is 0), one a stale doc, one did not reproduce.

## Code budget

Estimates for the engine, in lines without tests. The first version said about 11,150. The falsifier's count is the honest one. Unit 0's prototype is no guide: it is 62 functions without a wrapper.

| Part | Lines |
|---|---|
| Text: lexer, parser, three printers, A1 and sheet-name helpers, `tokens` | 1,100 |
| xlsx dialect: prefixes, `@` and `#` spelling, `@` insertion for legacy formulas | 500 (`text/xlsx.ts`, about 500), and table references (`text/tables.ts`, about 160) |
| Excel's function inventory, as data (moved from lib) | 550 |
| Shapes, values (errors, coercion, comparison and snap, dates, number and text) | 850 |
| Arrays: broadcast, lift, spill | 450 |
| Store and load | 400 |
| Evaluator: tree walk, call wrapper, views, reference operators | 450 |
| Recalc and the reverse index | 550 |
| Edits: `mapIndex`, `mapSpan`, the transform, classes, move, sheet binding and remap | 900 |
| The engine's public surface | 250 |
| **Engine without functions** | **6,000** |
| Functions, about 285 names at 32 lines a name, kernels, criteria and search included | 9,100 |
| Adapter in `packages/sheet`, steps 1b and 2 only | 450 |
| **Total** | **about 15,500; expect 14,000 to 16,000** |

Why 32 a name: the best typed engine studied is HyperFormula at 12,031 lines for 371 functions. The first version's 21 a name had no precedent. The transform is 900 lines against 4,000 to 7,000 in every engine studied; one mechanism where they keep two explains part of that, and the estimate may still be low.

Against today: 4,955 lines of our own (4,754 engine, 201 glue) and 8,445 of formulajs, plus `jstat` and `bessel` behind it. So the lines we own go up about three times, and the total goes up a little. Goal 2 is not met by count. What the lines buy: every one is typed and ours; none is a hand-kept list patching another's library; and they hold arrays and spill, intersection, cycle detection, references as values and the functions that needed them (`ROW`, `OFFSET`, `INDIRECT`, `FILTER`, `LET`), which today's count does not. Leaving out names, 3-D references, dynamic dependency records, the remembered order and both table sweeps took about 500 lines back out of the first design.


**The host.** Not estimated to the line. Added: the op types, validators and nine appliers, `shiftOps`, the accessors, the `Workbook` object. Deleted, by measured size today: the old engine and its glue (5,512 lines), formulajs (8,445), the shifting in `history-shift.ts` (334 lines in all), `yjs-ops.ts` (168), then in step 3 `patch.ts`, `celldata.ts`, `apply-ops.ts`'s copy into the context, the adapter and every writer's recipe. Each step's closing report gives production lines added and deleted outside `packages/formula`, and each should delete more than it adds. What is written to be deleted later is listed in [§ What is built to be deleted](#what-is-built-to-be-deleted).

## What we leave out, and why

- **A worker, folding while editors are open, stable row ids.** The owner: not worth it now.
- **A memo of display text per value and format.** Added only if a measurement shows painting is slow (owner, 11 Nov 2026).
- **A columnar snapshot, a batch clock for `NOW` and `RAND`, a build id in awareness.** See [§ Decided here, with the reason](#decided-here-with-the-reason).
- **The server ordering the log (S9), folding while editors are connected.** Parked with their triggers.
- **Transforming ops against concurrent row ops** (defect 32). A sync topic.
- **Defined names, tables, 3-D references** as features (pick 8d). **A moving `NOW()`** (pick 8b). **Dropdown sources and links as stored references:** they keep their A1 text and sheet names, and their row stays in SHEETS-TODO.md (defect 57).
- **A remembered calculation order, recorded dynamic dependencies.** Each is state a load could not reproduce, or code a load already replaces. The shape and string tables are swept: a shape no cell holds is forgotten when the reverse index is rebuilt, and a text no cell holds when a pass starts with the table past twice its weight at the last sweep, or after a sheet was removed.
- **Closures or generated code per shape, column kernels, workers, SIMD.** At most 2.5 times on a recalc that already fits in a frame, for a second code path. Calc removed its AVX path ("nowhere near worth the trouble") and its second interpreter; HyperFormula removed gpu.js after three years.
- **A cut-off on unchanged values, viewport-first evaluation.** Excel has neither.
- **Caches of results or aggregates, a maintained lookup index, prefix-sum reuse for running totals.** Every engine's worst correctness bugs.
- **Iterative calculation, manual calculation mode, precision as displayed, the 1904 date system as a workbook setting.** No caller in Eigen.
- **Pivot tables, references into other workbooks, user-defined functions.** Their formulas keep Excel's value.
- **Locales.** One internal spelling, English names, `,` and `.`. IronCalc re-parsed its internal text in the user's language once (`35113127`).
- **Fixed-rectangle rules of legacy Ctrl+Shift+Enter arrays, and writing `t="shared"` on export.** Rare, and optional.
- **Function-argument tooltips from signatures, a click on `HYPERLINK`.** Editor features.
- **Lifting the 10,000-row and 1,000-column limits and the dense `CellMatrix`.** The engine has no such limit; the grid's storage is the fork's model.
- **Engineering, bond and long-tail statistical functions** (decision 6).

## Risks

- **Four sessions is still a guess.** Step 1 was cut at the package boundary because one session could not hold it. Step 1a is about 12,000 new lines in parallel units inside one package; step 1b is the flip, which cannot land in halves. Nothing of tiers 0 to 2 can slip past the flip: formulajs is deleted there, and a missing name would stop following its inputs in every document that uses it. Step 3 may become two sessions.
- **About 2,000 to 2,500 host lines are written to be deleted** ([§ What is built to be deleted](#what-is-built-to-be-deleted)). That is the price of keeping the host's sheets as the truth while the engine and the wire change.
- **A build between 1b and 2 has fewer functions than today** (tiers 3 to 5 missing) and shows an array's first value. That is why production is recommended to wait for step 2.
- **Step 3 is sized from counts, not from a list.** About 800 touch points in the grid. Its first unit makes the list and the owner signs the plan before it is built; if it does not fit one session it is cut in two by module, with nothing stored at stake.
- **Every reader pays every edit, from step 2.** Measured on a laptop on Bun and Node, not in a browser and not on a phone. Apportion needs the column index to pass at all. Step 2 measures in Chrome, Safari and on a phone before it switches anything.
- **Every function must agree on every reader at step 2, not later.** The oracle runs on both runtimes and a difference is listed by function. The last bits of seven math functions are accepted.
- **The snapshot's values are state.** A wrong value the server stored once stays until an edit reaches its cell, as today. One writer, whole or not at all.
- **The host gates are not yet from a run.** Unit 0 measured the editor's state path (208 and 461 ms), not a browser, and a probe found about 95 ms of the row insert around the applier, which steps 1b and 2 keep. So the row insert is gated at 180 ms until step 3, not at the 120 ms first written. Unit A0 measures the split and the painted baselines before anything is built.
- **Rollback by inverse ops must be exact.** A wrong inverse parts a tab from the log in silence, where today's anchor is a real copy. The property test "apply, then the inverse, gives the same bytes" runs for every kind, and a batch older than the ring reloads.
- **The patch translator lives for two steps.** Every writer still mutates an immer draft and `patchToOp` maps the patches onto nine kinds by path shape. A patch it cannot map rolls its edit back and tells the person; it is never dropped in silence and never left applied. Unit A0 lists every shape the writers emit before the mapping is designed.
- **A `record` op sets whole fields.** Two people changing one field of one chart at once get the later value, as today; a write below a field is no longer possible.
- **The class finder.** The place Calc was wrong for three years. Unit 0 checked one edit on two sheets against the slow version; the property test runs it for good.
- **Cycle membership by the evaluation stack** must not depend on which cell is asked first. A dozen overlaps tried by hand showed no order dependence; there is no proof for overlapping loops through lazy branches, and unwinding at the depth budget in the middle of a loop is not designed in detail. From step 2 an order dependence here would show different values on two readers, so step 1a's tests shuffle the asking order.
- **The oracle is not finished.** 100 hand checks in Excel and the snap experiment are open, and behaviour that ships cannot move later without a recalc of every document that hits it.
- **Every sheet document from before step 1b stops opening at that deploy.** Accepted by the owner: there is no backward compatibility and eigen.is holds no real data. A workbook that never folded opens empty, not locked ([§ The stored format](#the-stored-format)).
- **Sheets is frozen for other work for three sessions** (decision 9).
- **The line budget may still be low** in the transform and in `@` insertion (6% of corpus formulas would get an `@`, 99% of those before `INDEX` and its kin).

## What changed since the second version

The second version designed the engine on today's data model and left the model to a study. The study, its falsifier, unit 0 and the owner's end goal changed this:

- **The goal.** One data model, set by the owner. The engine's store becomes the workbook's cells; the second version's adapter, write-back and "second copy as a cache" are now a middle state that step 3 ends.
- **The wire.** A closed vocabulary of nine op kinds on the new log key, in step 1b. The falsifier of the study showed that about two thirds of the removable fixes go with this and with the engine as already designed.
- **Who computes.** Inputs only, from step 2, taken apart from the store as the falsifier asked. Snapshot values are called what they are, state. Clock and random values stay their author's. No batch clock, no columnar snapshot.
- **Spill** is derived and arrives with step 2. Nothing of it is sent, the snapshot only marks it, no race is left, and the second version's decision 18 is gone.
- **The display text `m`** is not stored (owner, 11 Nov 2026), and with it the value type.
- **From unit 0.** Rectangles in one list per sheet, not column runs. The column index is built. Exact column allocation. A depth budget in nested calls. Results written outside the immer recipe. Formula text written as copies until step 3. Every engine gate tightened to a measured number. 1,001 shapes, not 1,005; 130,727 held cells, not 736,695; `INDIRECT` in 10,176 formulas, not 6,281.
- **The plan.** Four steps in four sessions in place of eleven units and two landings. Eleven questions before the first, in place of eighteen.

And v3.1, after a falsifier's read of the plan and a pointer check against `sheets-wave2`:

- **Step 1 is two sessions,** cut at the package boundary: the engine headless, then the wire and the flip.
- **"The format changes once" is now true.** The 1b format carries a closed cell record, the `spill` mark and no `mc`; the blank-result pick moves to the start of 1b; `result` is defined once.
- **The throwaway is stated:** a table of every temporary piece, about 2,000 to 2,500 lines, after two cuts that write the record appliers and the structural inverses once.
- **Gates from measurement.** The row insert at 180 ms until step 3; `INDIRECT` at 8 ms with the column index; a late batch rolls back by inverse ops, and the reload is gated with a 10,000-batch log.
- **Callers the plan had missed:** the media and thread sweep (`references.ts`), the xlsx round-trip gate and its script, half of the readers of `m`, the rich-text and date roles of `ct.t`, the codec's place in step 3, the adapter's two halves, number display's one home.
- **Decisions.** The three overturned rulings are their own questions; merging and deploying are two questions; reading production data is one.

And the sign-off, 11 Nov 2026:

- **Part 3 is a record.** The owner ruled all eleven decisions, as recommended.
- **No conversion.** Unit B3, its two scripts, both dry runs on a copy of production and the question about kept versions are gone. A document an older build wrote is not read, and the rule for an undecodable snapshot covers it.

Every ruling, one line each with its reason, is in the program's notes.

## Related

- [SHEETS.md](../SHEETS.md): Sheets as it is: the op log, undo, the fold, the engine
- [SHEETS-SIMPLIFICATION-AUDIT.md](../SHEETS-SIMPLIFICATION-AUDIT.md): § Where the piles come from and § If we built it today, whose S10, D9, D10 and U6 this builds
- [SHEETS-TODO.md](../SHEETS-TODO.md#formula-engine): the open defects this replaces
- [ROADMAP.md](../ROADMAP.md): the row "Rewrite the Sheets formula engine in steps" and the owner's rulings
- [ARCHITECTURE.md](../ARCHITECTURE.md#package-boundaries): the package rules the new leaf changes, and one source of truth per fact
- [CODE-STANDARDS.md](../CODE-STANDARDS.md#code-philosophy): no backward compatibility for now, no placeholders, no code for tests in production
- [REVIEW-STANDARD.md](../REVIEW-STANDARD.md): a second copy and a retry are findings
- [PROPOSAL_SHEETS_YJS_WORKBOOK.md](PROPOSAL_SHEETS_YJS_WORKBOOK.md): why the workbook is a snapshot and an op log; its rulings stand, its stable-id direction is closed here
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md): a chart's sheet is a sheet document, so it takes the same stored form
