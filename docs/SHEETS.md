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
  to `'General'` when Excel reports no explicit format. `SSF.format(undefined, n)` returns `""`, which blanks
  the display cell on recalc.
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
├── ssf.ts                  # Number formatting (SSF.format)
├── format.ts               # Format type inference
├── a1-notation.ts          # A1 ↔ row/col parsing
├── types.ts                # CellResolver, EvaluationResult, FormulaEngineState
└── index.ts                # Barrel exports
```

**Key capabilities:**
- `evaluate(formula, sheetId, row, col, resolver)` — single formula evaluation
- `recalculateAll(resolver)` — batch recalculation of all formulas in dependency order (server-side)
- `getDependencies(formula, sheetId)` — extract cell references from a formula
- `format(value, pattern)` — SSF number/date formatting

**Architecture boundary:** Context-coupled orchestration functions (`execFunctionGroup`, `groupValuesRefresh`,
etc.) live in `state/modules/formula-exec.ts`. The `formula-ui.ts` barrel re-exports from both, so UI consumers
don't see the split.

**Next step:** Wire `recalculateAll()` into the Document Content Layer's `readSheetContent()` for accurate
formula values in export, search indexing, and scripting.

See [PROPOSAL_SHEETS_REFACTORING.md](PROPOSAL_SHEETS_REFACTORING.md) for the full design and remaining work.

## Fortune-Sheet Integration

The entire fortune-sheet library (UI components, core engine, formula parser) is forked into `packages/fortune-sheet/`.
There is no external `@fortune-sheet/core` dependency — everything lives in-repo under full source control.

See [TODO-FORTUNE-SHEETS.md](TODO-FORTUNE-SHEETS.md) for the UI refactoring audit (CSS migration, shadcn adoption).
