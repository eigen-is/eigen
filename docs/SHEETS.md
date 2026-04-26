# Sheets App

> **TLDR**: Collaborative spreadsheet using a fully forked fortune-sheet (`packages/fortune-sheet`, published as
> `@workspace/fortune-sheet`) + Yjs. Op-based sync: each edit produces a small op pushed to Y.Array; remote clients
> apply via `applyOp()`. Stored as `.eigensheets` Drive folders.

## Architecture

```
packages/fortune-sheet/     # Forked React UI + core engine + formula parser (full source control)
apps/sheets/src/components/sheets/
├── hooks/use-sheet.ts          # Yjs integration (op-based sync)
├── hooks/use-active-comments.ts # Scan cell matrix for comment IDs + anchor texts
├── editor.tsx                  # Workbook config + toolbar items + comment panel/dialog
└── toolbar.tsx                 # File menu + share/mode + comment toggle buttons
```

## Yjs Sync

| Key     | Type    | Purpose                                   |
|---------|---------|-------------------------------------------|
| `state` | Y.Map   | `snapshot` — full JSON for initialization |
| `ops`   | Y.Array | Incremental ops for real-time sync        |

**Why op-based**: Full JSON snapshots cause overwrite conflicts. Ops are granular — concurrent edits on different cells
merge cleanly.

**Flow**: Local edit → `onOp` callback → push to Y.Array → Yjs WebSocket → remote `applyOp()` (no React re-render).

**Snapshot**: Saved on `beforeunload` (flushes latest data to `state.snapshot` and clears the ops array). New joiners
load from the snapshot, then replay any pending ops that arrived during initial sync.

## Mount-time Bootstrap

On first mount, the Workbook (`packages/fortune-sheet/src/components/Workbook/index.tsx`) reconciles the
incoming `Sheet[]` before rendering:

1. **Materialize `data`** — expand sparse `celldata` into a 2D `data` matrix.
2. **Recompute formulas** — `api.calculateFormula(draftCtx)` walks each sheet's `data` matrix, evaluates
   every cell with `f`, and writes the result back. This refreshes displayed values (not stale cached
   results from xlsx import or a previous save) and populates `sheet.calcChain` as a side-effect via
   `insertUpdateFunctionGroup`. `ctx.formulaCache.formulaCellInfoMap` lazy-primes on the first edit via
   `execFunctionGroup`, so no eager priming is needed at mount.

This lets importers (xlsx, seed data, migrations) emit `Sheet[]` with just `celldata + f` fields — the
Workbook handles the rest. Two invariants importers still must uphold:
- **Pair `ct.fa` with `ct.t`**: whenever a cell has `ct.t` (type), set `ct.fa` (format assignment). Default
  to `'General'` when Excel reports no explicit format. Without an `fa`, `format(undefined, n)` falls through
  to the raw value — date serials display as numbers (e.g. `44927` instead of `1/1/2023`), percents lose
  their `%` sign, etc.
- **Formula cells carry `f` with leading `=`**: `isFormula()` checks `value[0] === '='`.

## Comments

Comments anchor to cells via `commentChatNames?: string[]` on the `Cell` type. The fortune-sheet built-in
comment system (ps field, NotationBoxes, comment module) has been fully removed and replaced with the shared
Eigen comment infrastructure.

- **Canvas indicator**: red triangle (top-right) drawn when `cell.commentChatNames?.length > 0`
- **Context menu**: "Add comment" (no comment) or "View comment" / "Delete comment" (has comment), wired via
  `hooks.onAddComment/onViewComment/onDeleteComment` from settings
- **Comment panel**: `CommentPanel` sidebar toggled via toolbar button
- **Thread viewing**: `NoteCardDialog` + `CommentThread` popup

See [COMMENTS.md](COMMENTS.md) for the full shared comment architecture.

## Headless Formula Engine

A DOM-free formula engine lives in `packages/fortune-sheet/src/engine/`. It evaluates formulas using a
`CellResolver` interface — the same engine powers both the UI (resolver reads from Context) and server-side
evaluation (resolver reads from Yjs snapshot).

```
engine/
├── formula-engine.ts       # FormulaEngine class (evaluate, evaluateAll, recalculateAll, getDependencies)
├── formula-utils.ts        # Pure utilities (iscelldata, checkBracketNum, calPostfixExpression)
├── dependency-graph.ts     # Topological sort + cycle detection
├── cell-resolver.ts        # CellResolver interface + createArrayResolver
├── format.ts               # Format type inference (uses numfmt for rendering)
├── conditional-format.ts   # Pure CF evaluator (evaluateConditionalFormat, cfSplitRange, getColorGradation)
├── a1-notation.ts          # A1 ↔ row/col parsing
├── validation.ts           # Data validation helpers
├── types.ts                # CellResolver, EvaluationResult, FormulaEngineState, SingleRange, Range
├── parser/                 # Pure formula parser (JISON + @formulajs/formulajs, zero DOM)
└── index.ts                # Barrel exports
```

**Key capabilities:**
- `evaluate(formula, sheetId, row, col, resolver)` — single formula evaluation
- `recalculateAll(resolver)` — batch recalculation of all formulas in dependency order (server-side)
- `getDependencies(formula, sheetId)` — extract cell references from a formula
- `format(value, pattern)` — numfmt-backed number/date formatting

**Architecture boundary:** Context-coupled orchestration functions (`execFunctionGroup`, `groupValuesRefresh`,
etc.) live in `state/modules/formula-exec.ts`. The `formula-ui.ts` barrel re-exports from both, so UI consumers
don't see the split.

### Remaining Work — Server-side recalc

The engine is extracted, but `readSheetContent()` (see [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md))
still returns the last-saved `cell.v` from the snapshot. To get fresh values, load the snapshot + replay
pending ops, build a `CellResolver` over the resulting `Sheet[]`, and call `engine.recalculateAll(resolver)`
before mapping to `SheetContent`. Consumers (export, search indexing, scripting) pick this up transparently.

## Headless Conditional Formatting

`engine/conditional-format.ts` exposes a pure `evaluateConditionalFormat(rules, data, options?)` that
returns a `ComputeMap` of `"r_c" → { textColor?, cellColor?, dataBar? }` style entries — the same map the
canvas painter uses on the client.

```ts
import { evaluateConditionalFormat } from '@workspace/fortune-sheet/engine';

const styles = evaluateConditionalFormat(
    sheet.luckysheet_conditionformat_save,
    sheet.data,
);
// styles["3_4"] === { cellColor: "#ff8888" }
```

Formula-based rules require an `evaluateFormula` callback (same shape as the state-side `getComputeMap`
wrapper); when omitted, formula rules are skipped. The remaining rule types — `dataBar`,
`colorGradation`, `greaterThan`/`lessThan`/`equal`, `between`, `textContains`, `occurrenceDate`,
`duplicateValue`, `top10`, `aboveAverage`, etc. — evaluate without any context.

State keeps the caching wrapper at `state/modules/conditionFormat.ts::getComputeMap`, which calls into
the engine and supplies the `evaluateFormula` callback wired to `functionCopy`/`execfunction`.

### HTML/PDF export

`apps/api/src/lib/export/sheets/html.ts` calls `evaluateConditionalFormat` per sheet and merges
`textColor`/`cellColor` into the cell's inline style. `dataBar` entries render as an
absolutely-positioned `<div>` inside a `position:relative` `<td>`, with geometry mirrored from
the canvas painter. Negative bars hardcode red (canvas legacy); positive bars use the
user-configured `format` colors.

**Not yet wired**: formula-based CF rules. They require building a `CellResolver` for the sheet
and passing `(formula, anchorR, anchorC, r, c) => formulaEngine.evaluate(...)` as the
`evaluateFormula` option to `evaluateConditionalFormat`. The engine API is ready; the wiring is
deferred until a sheet with a formula CF rule actually needs it server-side.

**Resolution quirk**: `apps/api/tsconfig.json` resolves `@workspace/fortune-sheet` to the
engine-only barrel via a `paths` mapping. Runtime (Bun) resolves to the package main. The
symbols apps/api imports exist on both. Replace with a `@workspace/fortune-sheet/engine`
subpath export once `fortune-sheet/package.json` `exports` is set up.

### Constraints

- **Parser origin**: fortune-sheet's parser is derived from hot-formula-parser (Handsontable's older
  parser); `@formulajs/formulajs` covers ~200 functions, not Excel's full ~400.
- **Volatile functions** (`RAND`, `NOW`, `TODAY`) return new values on each server evaluation — correct
  behavior, but differs from the cached snapshot.
- **Circular references** are detected by `detectCycle()` in `engine/dependency-graph.ts`.
- **INDIRECT/OFFSET/INDEX** produce dynamic references the dependency graph can't analyze statically;
  `isFunctionRange()` handles these specially — preserve that logic when touching the graph.

### Not in scope

Replacing fortune-sheet, adding formula functions beyond formulajs, server-side UI rendering, real-time
formula recalc push (formulas are evaluated on read, not on write).

## Fortune-Sheet Integration

The entire fortune-sheet library (UI components, state runtime, formula parser, engine) is forked into
`packages/fortune-sheet/`. There is no external `@fortune-sheet/core` dependency — everything lives
in-repo under full source control.

See [TODO-FORTUNE-SHEETS.md](TODO-FORTUNE-SHEETS.md) for all outstanding cleanup work (biome coverage,
lodash removal, CSS migration, shadcn adoption, typing debt).
