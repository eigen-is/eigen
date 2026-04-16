# Sheets Package Refactoring

Refactoring plan for `packages/fortune-sheet/` to extract a headless formula engine and number formatting
system, improve code quality, and enable server-side formula recalculation for the Document Content Layer.

## TODO: Complete Engine Extraction

The `engine/` directory (Steps 1-5) is done, but several pure calculation functions still live in                                                                                                                                               
`formula-ui.ts` and take `Context` instead of `CellResolver`. Until these are migrated, the server-side                                                                                                                                         
engine cannot handle array formulas, batch recalculation, or formula range rewriting.                                                                                                                                                           
                                                                                                                                                                                                                                                
Functions to migrate to `engine/` (all pure — zero DOM, just Context-coupled):                                                                                                                                                                  
                                                                                                                                                                                                                                                
- **`isFunctionRange`** — rewrites formulas with array operations (e.g. `luckysheet_getarraydata`)                                                                                                                                              
- **`getcellrange`** — parses cell reference text (e.g. "A1:B3") to row/col range objects                                                                                                                                                       
- **`execFunctionGroup`** — orchestrates batch recalculation using dependency graph                                                                                                                                                             
- **`groupValuesRefresh`** — applies computed formula values back to cell data                                                                                                                                                                  
- **`insertUpdateFunctionGroup`** — registers formula cells in the calculation chain                                                                                                                                                            
- **`getAllFunctionGroup`** — collects all formula cells across sheets                                                                                                                                                                          
                                                                                                                                                                                                                                                
The transformation is the same pattern used for parser event handlers: replace `Context` / `getFlowdata(ctx)`                                                                                                                                   
parameters with `CellResolver`. This was proven in Step 4 and is mechanical — no logic changes needed.                                                                                                                                          
                                                                                                                                                                                                                                                
**Until this is done, `FormulaEngine.evaluate()` handles individual formulas but cannot do full-sheet
recalculation or array formula evaluation on the server.** 

## Verification Status

All critical assumptions have been verified by reading source code:

- **`execfunction()` has zero DOM dependencies** — all 16 DOM references in `formula.ts` are in UI-only
  functions. The calculation path (`execfunction` → `parser.parse` → `callCellValue`/`callRangeValue` →
  `execFunctionGroup` → `groupValuesRefresh`) reads/writes data arrays only
- **FormulaCache splits cleanly** — calculation properties (parser, dependency graph, execution cache) vs
  UI properties (range selection, drag state) are distinct groups with no cross-references
- **Yjs snapshot contains all cell fields** — `v`, `f`, `m`, `ct`, styles, sheet config are all stored
  as JSON in `ydoc.getMap('state').get('snapshot')`. Pending ops in `ydoc.getArray('ops')` need replay
- **The function-level split is clean** — no function mixes pure calculation with DOM access. Extraction
  means moving functions between files, not rewriting them

## Motivation

Three independent goals converge on the same refactoring:

1. **Server-side formula recalculation** — the Document Content Layer (`readSheetContent()`) needs accurate
   formula values for scripting, export, and search indexing. Currently fortune-sheet only evaluates formulas
   client-side, so the server reads stale last-saved values from the Yjs snapshot
2. **Code quality** — `formula.ts` is 3,550 lines mixing pure calculation logic with DOM manipulation,
   selection UI, and event handling. Multiple modules have 100+ `any` annotations. Test coverage of core
   logic is ~5%
3. **Reusability** — number formatting (`SSF.format()`) and A1 notation parsing are general utilities that
   belong in a headless module, not buried in a UI-coupled spreadsheet package

## Current Architecture

```
packages/fortune-sheet/src/
├── formula-parser/              # Pure formula parser (JISON grammar + @formulajs/formulajs)
│   ├── parser.ts                # Parser class — event-based cell resolution, zero DOM deps
│   ├── grammar-parser/          # Generated JISON grammar
│   ├── evaluate-by-operator/    # 13 operators + formula function dispatch
│   └── helper/                  # Cell coordinate helpers (pure)
├── core/
│   ├── modules/
│   │   ├── formula.ts           # 3,550 lines — calculation + DOM + UI ← MAIN PROBLEM
│   │   ├── formulaHelper.ts     # 324 lines — dependency graph (mostly pure)
│   │   ├── ssf.ts               # 1,969 lines — number formatting (pure)
│   │   ├── format.ts            # 365 lines — format inference (pure)
│   │   ├── cell.ts              # 1,639 lines — cell value/style getters
│   │   ├── selection.ts         # 2,332 lines — selection state + UI rendering
│   │   ├── dropCell.ts          # 3,036 lines — drag-drop (DOM-heavy)
│   │   ├── text.ts              # 1,828 lines — text rendering (DOM-heavy)
│   │   ├── rowcol.ts            # 2,298 lines — row/column operations
│   │   └── ...                  # 28 more modules
│   ├── context.ts               # 600 lines — global state (200+ properties)
│   └── types.ts                 # Cell, Sheet, FormulaCache types
├── components/                  # React components
└── index.ts
```

### What's Already Headless

These modules have **zero browser dependencies** and can run in Bun/Node today:

| Module | Lines | What it does |
|--------|-------|-------------|
| `formula-parser/parser.ts` | 300 | JISON-based formula parser with event emitters for cell resolution |
| `formula-parser/evaluate-by-operator/` | 400 | Arithmetic, comparison, string operators + `@formulajs/formulajs` dispatch |
| `formula-parser/helper/` | 200 | Cell coordinate conversions (A1 ↔ row/col) |
| `core/modules/ssf.ts` | 1,969 | Excel SSF number/date/time formatting engine |
| `core/modules/format.ts` | 365 | Format type inference from raw values |
| `core/modules/formulaHelper.ts` | 324 | Dependency graph building + topological sort |

**Total: ~3,558 lines of pure, extractable code.**

### What's Entangled — But Separable

`formula.ts` (3,550 lines) contains both pure calculation and DOM/UI code, but **they are not interleaved
at the function level**. Verified by tracing every DOM reference (16 total, all listed below):

**Pure calculation functions** (zero DOM access):
- `execfunction()` — core evaluator, delegates to `parser.parse()`, returns `[success, value, formula]`
- `execFunctionGroup()` — executes calculation chain, reads/writes `flowdata` arrays only
- `groupValuesRefresh()` — batch-applies computed values to cell matrix
- `insertUpdateFunctionGroup()` — updates `calcChain` data structure
- `isFunctionRange()`, `getcellrange()`, `iscelldata()`, `isFormula()` — parsing helpers
- Parser event handlers (`callCellValue`, `callRangeValue`) — resolve from `flowdata[row][col]` only

**DOM/UI functions** (all 16 DOM references are confined to these):
- `setCaretPosition()` — `document.createRange()`, `window.getSelection()` (lines 1586-1587)
- `functionRange()` — `window.getSelection()` (lines 1605-1618)
- `searchFunction()` — `window.getSelection()` (line 1693)
- `rangeHightlightselected()` — `document.getElementsByClassName()` (line 2890)
- `handleFormulaInput()` — `window.getSelection()`, `$editor.innerHTML` (lines 2183-2213)
- `israngeseleciton()` — `document.activeElement` (line 2738)
- `parseElement()` — `new DOMParser()` (line 237)
- Range drag handlers — `container.querySelector()` (line 2956)

**Key finding:** The split is at the function boundary, not within functions. Extraction means moving
functions between files, not rewriting them.

### Context Properties Used by Calculation Path

The calculation path accesses these Context properties (verified by tracing `execfunction()` and all
functions it calls):

| Property | Type | Used for |
|---|---|---|
| `ctx.currentSheetId` | string | Active sheet ID |
| `ctx.calculateSheetId` | string | Sheet being calculated (written by execfunction) |
| `ctx.luckysheetfile` | Sheet[] | All sheets with cell data |
| `ctx.formulaCache.parser` | Parser | Formula parser instance |
| `ctx.formulaCache.execFunctionGlobalData` | Record | Temporary values during batch calc |
| `ctx.formulaCache.execFunctionExist` | any[] | Cells modified in current calc |
| `ctx.formulaCache.formulaCellInfoMap` | Map | Dependency graph cache |
| `ctx.groupValuesRefreshData` | array | Queue of cells to update |

No UI state (`selection`, `rangeHighlight`, `scrollLeft`, etc.) is touched by calculation.

### FormulaCache Splits Cleanly

The `FormulaCache` class has two distinct property groups:

**Calculation** (needed for headless): `parser`, `execFunctionGlobalData`, `formulaCellInfoMap`,
`execFunctionExist`, `cellTextToIndexList`, `data_parm_index`, `functionlistMap`

**UI** (all optional `?`, unused in calculation): `func_selectedrange`, `selectingRangeIndex`,
`rangeResizeObj/Index/xy/WinH/WinW/To`, `rangeSetValueTo`, `rangeIndex`, `rangestart`, `rangetosheet`,
`rangedrag_column_start`, `rangedrag_row_start`, `functionRangeIndex`

## Target Architecture

```
packages/fortune-sheet/
├── src/
│   ├── engine/                          # NEW — headless calculation engine (zero DOM)
│   │   ├── formula-engine.ts            # FormulaEngine class (parse + evaluate + recalculate)
│   │   ├── dependency-graph.ts          # Dependency tracking + topological sort
│   │   ├── cell-resolver.ts             # CellResolver interface + in-memory implementation
│   │   ├── ssf.ts                       # Number formatting (moved from core/modules/)
│   │   ├── format.ts                    # Format inference (moved from core/modules/)
│   │   ├── a1-notation.ts              # A1 ↔ row/col parsing
│   │   └── index.ts                     # Public API
│   ├── formula-parser/                  # Unchanged — already clean
│   │   ├── parser.ts
│   │   ├── grammar-parser/
│   │   ├── evaluate-by-operator/
│   │   └── helper/
│   ├── core/
│   │   ├── modules/
│   │   │   ├── formula-ui.ts            # RENAMED — only DOM/UI parts of old formula.ts
│   │   │   ├── formulaHelper.ts         # Thin wrapper, delegates to engine/dependency-graph.ts
│   │   │   ├── cell.ts                  # Unchanged
│   │   │   ├── selection.ts             # Unchanged (UI-coupled, not in scope)
│   │   │   └── ...
│   │   ├── context.ts                   # Unchanged
│   │   └── types.ts                     # Unchanged
│   ├── components/                      # Unchanged
│   └── index.ts                         # Adds engine/ exports
```

### Key Design: FormulaEngine

```typescript
// packages/fortune-sheet/src/engine/formula-engine.ts

type CellResolver = {
    getCell(sheetId: string, row: number, col: number): Cell | null;
    getRange(sheetId: string, startRow: number, startCol: number,
             endRow: number, endCol: number): (Cell | null)[][];
    getSheetIdByName(name: string): string | null;
};

type EvaluationResult = {
    value: unknown;
    display: string;
    type: 'number' | 'string' | 'boolean' | 'date' | 'error';
};

class FormulaEngine {
    evaluate(formula: string, sheetId: string, row: number, col: number,
             resolver: CellResolver): EvaluationResult;

    evaluateAll(cells: FormulaCell[], resolver: CellResolver): Map<string, EvaluationResult>;

    getDependencies(formula: string, sheetId: string): FormulaDependency[];

    format(value: unknown, pattern: string): string;
}
```

**`CellResolver` is the abstraction boundary.** The engine never touches Yjs, SQLite, or Context — it
asks for cell values through the resolver. For the UI, the resolver reads from Context's flowdata. For the
server, it reads from the Yjs snapshot. Same engine, different data source.

### Yjs Storage Structure (Verified)

Sheets use a snapshot + ops model in Yjs:

- **`ydoc.getMap('state').get('snapshot')`** — JSON string of the full `Sheet[]` array. Contains all
  cell fields: `v` (value), `f` (formula), `m` (display), `ct` (type/format), styles, and `SheetConfig`
  (merges, hidden rows/cols, borders). Snapshots are created every 100 updates and on `beforeunload`
- **`ydoc.getArray('ops')`** — incremental operations since the last snapshot. Each op has a type
  (`replace`, `add`, `remove`, `insertRowCol`, etc.) and a JSON path to the changed value

The server must replay pending ops on top of the parsed snapshot to get fully current data. The ops
format is structured with JSON paths, so replay is mechanical.

### Server-Side Integration

```typescript
// apps/api/src/lib/document/sheets-reader.ts

async function readSheetContent(ownerId: string, mountId: string, pathId: string): Promise<SheetContent> {
    const home = await getHome(ownerId);
    const mount = home.drive.getMount(mountId);
    const dataDbPath = await mount.getChildByName(pathId, 'data.db');
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc: ydoc } = loadYjsState(managedDb);

    // 1. Parse snapshot (JSON string of Sheet[])
    const stateMap = ydoc.getMap('state');
    const snapshot = stateMap.get('snapshot') as string;
    const sheets: Sheet[] = JSON.parse(snapshot);

    // 2. Replay pending ops (changes since last snapshot)
    const ops = ydoc.getArray('ops').toArray();
    for (const opBatch of ops) applyOps(sheets, opBatch);

    // 3. Build resolver from complete sheet data
    const resolver: CellResolver = {
        getCell: (sheetId, row, col) => {
            const sheet = sheets.find(s => s.id === sheetId);
            return sheet?.data?.[row]?.[col] ?? null;
        },
        getRange: (sheetId, sr, sc, er, ec) => /* slice from sheet data */,
        getSheetIdByName: (name) => sheets.find(s => s.name === name)?.id ?? null,
    };

    // 4. Recalculate all formulas (optional — skip if stale values are acceptable)
    const engine = new FormulaEngine();
    const formulaCells = extractFormulaCells(sheets);
    const results = engine.evaluateAll(formulaCells, resolver);

    // 5. Apply recalculated values
    for (const [key, result] of results) {
        const cell = getCellByKey(sheets, key);
        cell.v = result.value;
        cell.m = result.display;
    }

    return mapToSheetContent(sheets);
}
```

## Refactoring Plan

### Step 1: Extract SSF + Format (low risk, high value)

Move `ssf.ts` and `format.ts` into `engine/`. Update imports in `core/modules/` to point to the new
location. No logic changes — pure file moves.

These are already pure functions with zero DOM dependencies. Moving them establishes the `engine/` directory
and the pattern for subsequent extractions.

**Tests to add:** SSF formatting edge cases (dates, currencies, conditional formats, fractions). Currently
untested.

### Step 2: Extract A1 Notation Parser

Create `engine/a1-notation.ts` from the cell coordinate helpers in `formula-parser/helper/cell.ts` plus
new A1 range parsing:

```typescript
function parseA1(ref: string): { col: number; row: number };
function parseA1Range(range: string): { sheet?: string; start: CellRef; end: CellRef };
function toA1(row: number, col: number): string;
```

This serves both the formula engine and the scripting SDK (`sheets.getCell("A1")`).

### Step 3: Extract Dependency Graph

Move the pure parts of `formulaHelper.ts` into `engine/dependency-graph.ts`:

- `setFormulaCellInfo()` → `buildDependencyGraph()`
- `getFormulaRunList()` → `getCalculationOrder()` (topological sort)

Remove Context coupling — the dependency graph builder should take cell data as input, not read from
global state.

**Add: cycle detection.** The current code has no circular reference detection. Server-side evaluation needs
this to avoid infinite loops.

### Step 4: Build FormulaEngine (verified — cleaner than expected)

The split is at the function boundary, not within functions. No function mixes pure calculation with DOM
code — extraction means moving functions between files, not rewriting them.

**Functions to move to `engine/formula-engine.ts` (pure, zero DOM):**
- `execfunction()` — core evaluator. Replace Context with CellResolver for cell data access
- `execFunctionGroup()` — calculation chain execution
- `groupValuesRefresh()` — batch-applies computed values
- `insertUpdateFunctionGroup()` — calcChain data structure management
- `isFormula()`, `iscelldata()`, `getcellrange()`, `isFunctionRange()` — parsing helpers
- `FormulaCache` calculation properties — `parser`, `execFunctionGlobalData`, `formulaCellInfoMap`,
  `execFunctionExist`, `cellTextToIndexList`
- Parser event handlers (`callCellValue`, `callRangeValue`) — rewire to use CellResolver instead of
  reading from `ctx.formulaCache.execFunctionGlobalData` and `getFlowdata(ctx)`

**Functions that stay in `formula-ui.ts` (DOM-coupled):**
- `handleFormulaInput()` — keystroke handling (uses `window.getSelection()`)
- `rangeHightlightselected()` — visual range highlighting (uses `getElementsByClassName()`)
- `setCaretPosition()` — editor caret manipulation (uses `document.createRange()`)
- `rangeDrag()`, `rangeDragColumn()`, `rangeDragRow()` — drag-drop (uses `querySelector()`)
- `functionStrChange()` — formula text sync with UI
- `searchFunction()` — function autocomplete (uses `window.getSelection()`)
- `parseElement()` — formula range HTML parsing (uses `DOMParser`)
- `FormulaCache` UI properties — all optional `?`, range selection state

**The split:** `formula-ui.ts` imports from `engine/formula-engine.ts` for calculation, adds DOM
interactions on top. The 3,550-line file becomes ~1,500 lines (engine) + ~2,000 lines (UI), each with
a clear responsibility.

**Main refactoring effort:** The parser event handlers currently read from `getFlowdata(ctx)` (a Context
helper). In the engine, these need to delegate to the `CellResolver` interface instead. This is the
primary API change — the calculation logic itself is unchanged.

### Step 5: CellResolver + Context Adapter

Create `engine/cell-resolver.ts` with the `CellResolver` interface. Then create a Context adapter in
`core/` that implements `CellResolver` by reading from Context's flowdata — this is what the UI layer uses.

The server creates its own resolver from Yjs snapshot data (see server-side integration above).

### Step 6: Wire into Document Content Layer

With `FormulaEngine` available, update `readSheetContent()` in the Document Content Layer to optionally
recalculate formulas before returning. This is transparent to all consumers — scripting, export, and
import all get accurate formula values.

## What This Enables

| Capability | Before | After |
|---|---|---|
| Server-side formula values | Stale (last-saved `cell.v`) | Freshly recalculated |
| Number formatting on server | Not available | `engine.format(42, "#,##0.00")` → `"42.00"` |
| Sheets export accuracy | Stale values | Correct formula results |
| Scripting SDK accuracy | Stale values | Correct formula results |
| `formula.ts` size | 3,550 lines (mixed) | ~1,500 (engine) + ~2,000 (UI) |
| Formula test coverage | ~5% | Target: 80%+ for engine |
| Code reuse | None — all tied to Context | CellResolver interface enables any data source |

## Constraints

- **Fortune-sheet's formula parser is derived from hot-formula-parser** (Handsontable's older parser).
  It covers 200+ functions via `@formulajs/formulajs`. This is sufficient for most spreadsheets but not
  the full 400+ that Excel/Google Sheets support
- **No server-side formula recalculation exists today.** Formulas with volatile functions (RAND, NOW,
  TODAY) will return new values on each server evaluation — this is correct behavior but differs from
  the cached client-side snapshot
- **Circular references** need cycle detection added to the dependency graph. The current client-side
  code doesn't handle this
- **INDIRECT/OFFSET/INDEX** create dynamic references that can't be statically analyzed for the dependency
  graph. The current code handles these specially in `isFunctionRange()` — this logic must be preserved
  in the extraction

## Not In Scope

- Replacing fortune-sheet with a different spreadsheet library
- Adding new formula functions beyond what `@formulajs/formulajs` provides
- Server-side rendering of the spreadsheet UI
- Collaborative formula editing improvements
- Real-time formula recalculation push (formulas are evaluated on read, not on write)
