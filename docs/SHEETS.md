# Sheets App

> **TLDR**: Collaborative spreadsheet using an in-tree sheet engine (`packages/sheet`, published as
> `@workspace/sheet`; forked from fortune-sheet/luckysheet) + Yjs. Op-based sync: each edit produces a small op pushed to Y.Array; remote clients
> apply via `applyOp()`. Stored as `.eigensheets` Drive folders.

## Architecture

```
packages/sheet/     # Forked React UI + core engine + formula parser (full source control)
├── components/MenuBar/         # Google-Sheets-style menu bar (Edit/View/Insert/Format/Data + CustomBorder)
apps/sheets/src/components/sheets/
├── hooks/use-sheet.ts          # Yjs integration (op-based sync)
├── hooks/use-active-comments.ts # Scan cell matrix for comment IDs + anchor texts
├── editor.tsx                  # Workbook config + MenuBar left/right items + comment panel/dialog
└── toolbar.tsx                 # File menu + share/mode + comment toggle buttons (passed as leftItems/rightItems)
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
load from the snapshot, then replay any pending ops that arrived during initial sync via the shared
`replaySheetsOps(sheets, opBatches)` from `@workspace/sheet/engine` — the same function the BE document
reader uses, so every consumer agrees on what "snapshot + ops → `Sheet[]`" means.

## Mount-time Bootstrap

On first mount, the Workbook (`packages/sheet/src/components/Workbook/index.tsx`) reconciles the
incoming `Sheet[]` before rendering:

1. **Materialize `data`** — expand sparse `celldata` into a 2D `data` matrix.
2. **Recompute formulas** — `api.calculateFormula(draftCtx)` walks each sheet's `data` matrix, evaluates
   every cell with `f`, and writes the result back. This refreshes displayed values (not stale cached
   results from xlsx import or a previous save) and populates `sheet.calcChain` as a side-effect via
   `insertUpdateFunctionGroup`. `ctx.formulaCache.formulaCellInfoMap` lazy-primes on the first edit via
   `execFunctionGroup`, so no eager priming is needed at mount.

This lets importers (xlsx, seed data, migrations) emit `Sheet[]` with as little as `celldata + f` — the
Workbook handles the rest. The xlsx importer goes well beyond that minimum: it also emits `config`
(merges, row/col sizes, `rowhidden`/`colhidden`, borders), `frozen`, `filterRange`,
`conditionalFormatRules`, and caches each cell's display string (`m`) through the engine's numfmt so
the first paint matches the editor. Two invariants importers still must uphold:
- **Pair `ct.fa` with `ct.t`**: whenever a cell has `ct.t` (type), set `ct.fa` (format assignment). Default
  to `'General'` when Excel reports no explicit format. Without an `fa`, `format(undefined, n)` falls through
  to the raw value — date serials display as numbers (e.g. `44927` instead of `1/1/2023`), percents lose
  their `%` sign, etc.
- **Formula cells carry `f` with leading `=`**: `isFormula()` checks `value[0] === '='`.

## Comments

Comments anchor to cells via `commentCardIds?: string[]` on the `Cell` type. The upstream fortune-sheet
built-in comment system (ps field, NotationBoxes, comment module) was fully removed and replaced with the
shared Eigen comment-card infrastructure (see [`docs/COMMENTS.md`](COMMENTS.md)).

- **Canvas indicator**: triangle (top-right) drawn when `cell.commentCardIds?.length > 0`; color comes
  from the Y.Doc card via `hooks.getCommentInfo(r, c)`
- **Context menu**: "Add comment" (no comment) or "View comment" / "Delete comment" (has comment), wired via
  `hooks.onAddComment/onViewComment/onDeleteComment` from settings
- **Comment panel**: `CommentPanel` sidebar toggled via toolbar button
- **Thread viewing**: `NoteCardDialog` + `CommentThread` popup

See [COMMENTS.md](COMMENTS.md) for the full shared comment architecture.

## Headless Formula Engine

A DOM-free formula engine lives in `packages/sheet/src/engine/`. It evaluates formulas using a
`CellResolver` interface — the same engine powers both the UI (resolver reads from Context) and server-side
evaluation (resolver reads from Yjs snapshot).

```
engine/
├── formula-engine.ts       # FormulaEngine class (evaluate, recalculateAll, getDependencies)
├── formula-utils.ts        # Pure utilities (iscelldata, checkBracketNum, calPostfixExpression)
├── formula-shift.ts        # functionCopy + functionStrChange (formula relative-ref shifters)
├── rowcol.ts               # applySheetsInsertRowCol / applySheetsDeleteRowCol (pure row/col data shifts)
├── replay-ops.ts           # replaySheetsOps (snapshot + ops → Sheet[]; shared by BE + FE initial-load)
├── dependency-graph.ts     # Topological sort + cycle detection
├── cell-resolver.ts        # CellResolver interface + createArrayResolver
├── format.ts               # Format type inference (uses numfmt for rendering)
├── conditional-format.ts   # Pure CF evaluator (evaluateConditionalFormat, cfSplitRange, getColorGradation)
├── a1-notation.ts          # A1 ↔ row/col parsing
├── validation.ts           # Data validation helpers
├── types.ts                # CellResolver, EvaluationResult, FormulaEngineState (+ re-exports of shared shapes from @workspace/lib/sheets)
├── parser/                 # Pure formula parser (JISON + @formulajs/formulajs, zero DOM)
└── index.ts                # Barrel exports
```

**Key capabilities:**
- `evaluate(formula, sheetId, row, col, resolver)` — single formula evaluation
- `recalculateAll(resolver)` — batch recalculation of all formulas in dependency order (server-side)
- `getDependencies(formula, sheetId)` — extract cell references from a formula
- `format(value, pattern)` — numfmt-backed number/date formatting
- `replaySheetsOps(sheets, opBatches)` — pure snapshot + ops → `Sheet[]`. Handles `add`/`remove`/`replace`
  patches via `opToPatchOnSheets`, `addSheet`/`deleteSheet` inline, and `insertRowCol`/`deleteRowCol` via
  the typed shape-adapter + `applySheetsInsertRowCol`/`applySheetsDeleteRowCol`. Used by the BE document
  reader and the FE Yjs sync handler — single source of truth for both initial-load paths.
- `applySheetsInsertRowCol<S extends Sheet>(sheets, op)` / `applySheetsDeleteRowCol<S extends Sheet>(sheets, op)`
  — pure data shifts for row/col ops over lib.Sheet-typed fields (`data`, `config.merge`, `config.rowhidden`,
  `conditionalFormatRules`, cross-sheet formula refs). Generic over `S` so the editor's wider
  `state.Sheet[]` flows through with its extras unchanged. Editor-managed fields (filter /
  filterRange / frozen / dataVerification / hyperlink / calcChain / selections) are shifted by the
  state wrapper in `state/modules/rowcol.ts` after the engine call.

**Architecture boundary:** Context-coupled orchestration functions (`execFunctionGroup`, `groupValuesRefresh`,
etc.) live in `state/modules/formula-exec.ts`. The `formula-ui.ts` barrel re-exports from both, so UI consumers
don't see the split.

### Remaining Work — Server-side recalc

The engine is extracted and the BE replay path is wired (`apps/api/src/lib/document/sheets.ts` calls
`replaySheetsOps`), so cell positions and formula text are correct. But `readSheetsContent()` still returns
the last-saved `cell.v` from the post-replay snapshot — values aren't recomputed. To get fresh values,
build a `CellResolver` over the replayed `Sheet[]` and call `engine.recalculateAll(resolver)` before mapping
to `SheetContent`. Consumers (export, search indexing, scripting) pick this up transparently.

## Headless Conditional Formatting

`engine/conditional-format.ts` exposes a pure `evaluateConditionalFormat(rules, data, options?)` that
returns a `ComputeMap` of `"r_c" → { textColor?, cellColor?, dataBar? }` style entries — the same map the
canvas painter uses on the client.

```ts
import { evaluateConditionalFormat } from '@workspace/sheet/engine';

const styles = evaluateConditionalFormat(
    sheet.conditionalFormatRules,
    sheet.data,
);
// styles["3_4"] === { cellColor: "#ff8888" }
```

Formula-based rules require an `evaluateFormula` callback; when omitted, formula rules are skipped. The
remaining rule types — `dataBar`, `colorGradation`, the comparison set
(`greaterThan`/`lessThan` and their `OrEqual` variants, `equal`/`notEqual`, `between`/`notBetween`),
`textContains`, `occurrenceDate`, `duplicateValue`, `top10`, `aboveAverage`, etc. — evaluate without
any context.

The callback shifts the rule's formula by `(targetRow - anchorRow, targetCol - anchorCol)` via the
shared `functionCopy` ref shifter (in `engine/formula-shift.ts`), then evaluates against a
`CellResolver`. Both state (`state/modules/conditionFormat.ts::getComputeMap`) and the server-side
HTML/PDF export use this same shape — see § HTML/PDF export below.

### HTML/PDF export

`apps/api/src/lib/export/sheets/html.ts` calls `evaluateConditionalFormat` per sheet and merges
`textColor`/`cellColor` into the cell's inline style. `dataBar` entries render as an
absolutely-positioned `<div>` inside a `position:relative` `<td>`, with geometry mirrored from
the canvas painter. Negative bars hardcode red (canvas legacy); positive bars use the
user-configured `format` colors.

Formula-based CF rules are wired too: `renderSheetsHtml` builds a single `FormulaEngine` plus a
`createArrayResolver` over all loaded sheets (so cross-sheet refs like `=Sheet2!A1>10` resolve),
threads them to `renderSheet`, and the per-sheet `buildCfFormulaEvaluator` produces the
`evaluateFormula` callback. Cell values come from the saved snapshot's `cell.v` — formulas inside
the sheet aren't recomputed; only the CF rule's own formula is evaluated against existing values.

The engine is exposed as a `@workspace/sheet/engine` subpath export. Server-side
consumers (`apps/api`) import only from this subpath, which restricts type-checking to the pure
DOM-free subset that satisfies stricter compiler options (`verbatimModuleSyntax`,
`noUnusedParameters`).

### Constraints

- **Parser origin**: the parser is derived from hot-formula-parser (Handsontable's older parser, inherited
  via the upstream fortune-sheet fork); `@formulajs/formulajs` covers ~200 functions, not Excel's full ~400.
- **Volatile functions** (`RAND`, `NOW`, `TODAY`) return new values on each server evaluation — correct
  behavior, but differs from the cached snapshot.
- **Circular references** are detected by `detectCycle()` in `engine/dependency-graph.ts`.
- **INDIRECT/OFFSET/INDEX** produce dynamic references the dependency graph can't analyze statically;
  `isFunctionRange()` handles these specially — preserve that logic when touching the graph.

### Not in scope

Replacing the sheet engine, adding formula functions beyond formulajs, server-side UI rendering, real-time
formula recalc push (formulas are evaluated on read, not on write).

## Upstream Origin

The entire fortune-sheet + luckysheet upstream library (UI components, state runtime, formula parser, engine)
was forked into `packages/sheet/`. There is no external `@fortune-sheet/core` dependency — everything lives
in-repo under full source control.
