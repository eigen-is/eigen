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
├── editor.tsx                  # Workbook config + MenuBar left/right items + comments/activity pane
└── toolbar.tsx                 # File menu + share/mode + comment toggle buttons (passed as leftItems/rightItems)
```

### Canvas renderer

`state/canvas.ts` is a thin facade: the `Canvas` class (`drawMain` / `drawRowHeader` /
`drawColumnHeader` / `drawFreezeLine`), consumed only by `components/Sheet/index.tsx` (one
`drawMain` per freeze region). The facade also owns the render-cache idle timer (measure-text +
cell-overflow caches clear after 100 ms without a draw). The drawing itself lives in
`state/render/`:

```
state/render/
├── types.ts        # RenderPass (per-drawMain shared state) + defaultStyle + shared shapes
├── geometry.ts     # Pure viewport math (visible ranges, cell edges, HALF_PIXEL/BORDER_FIX) — unit-tested
├── headers.ts      # Row/column header strips
├── phases.ts       # collectVisibleCells → renderCells → renderMergedCells
├── cells.ts        # nullCellRender/cellRender (background, indicators, checkbox, text, grid lines)
├── cell-text.ts    # Text painter + overflow-span variant (layout stays in modules/text.ts)
├── data-bar.ts     # Conditional-format data bar
├── overflow.ts     # Text-spill map + trace + the shared per-row cache (cleared via the facade's idle timer)
├── borders.ts      # config.borderInfo pass + dash patterns
└── filter-ui.ts    # Autofilter range border + buttons (lazy Path2D glyphs — module eval is DOM-free)
```

Container-resize contract (app code may rely on it): `Sheet` keeps a `ResizeObserver` on its
placeholder and skips 0×0 boxes, so a hidden workbook re-measures its canvas when it is shown
again — `apps/sheets` hides the workbook rather than unmounting it for the mobile comments pane.

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

**`selections` never persists**: it's a per-client cursor — the ops path drops it (`filterPatch`), and
`use-sheet.ts` strips it from the snapshot on both write and read (older docs may still carry one baked in;
a persisted cursor resurfaced on open as phantom stats-bar values for a selection nobody made).

## Mount-time Bootstrap

On first mount, the Workbook (`packages/sheet/src/components/Workbook/index.tsx`) reconciles the
incoming `Sheet[]` before rendering:

1. **Materialize `data`** — expand sparse `celldata` into a 2D `data` matrix (`api.initSheetData`).
2. **Seed the calc chain, don't recompute** — `api.seedCalcChain(draftCtx)` records each sheet's formula
   cells in `sheet.calcChain` without evaluating them. Displayed values come straight from the incoming
   `Sheet[]`: xlsx-imported sheets carry Excel's last computed values (and the importer now recomputes them
   through our own engine at import — see § Server-side recalc), persisted sheets were saved post-recompute,
   and a later edit lazily kicks the engine for just the affected sub-graph (`execFunctionGroup`) — recalc
   is proportional to the edit, not the workbook. `ctx.formulaCache.formulaCellInfoMap` lazy-primes on the
   first edit, so no eager priming or full-workbook sweep happens at mount.

This lets importers (xlsx, seed data, migrations) emit `Sheet[]` with as little as `celldata + f` — the
Workbook handles the rest. The xlsx importer goes well beyond that minimum: it also emits `config`
(merges, row/col sizes, `rowhidden`/`colhidden`, borders), `frozen`, `filterRange`,
`conditionalFormatRules`, `dataVerification`, `hyperlink` (with the `hl` cell backref), and caches
each cell's display string (`m`) through the engine's numfmt so the first paint matches the editor.
Two invariants importers still must uphold:
- **Pair `ct.fa` with `ct.t`**: whenever a cell has `ct.t` (type), set `ct.fa` (format assignment). Default
  to `'General'` when Excel reports no explicit format. Without an `fa`, `format(undefined, n)` falls through
  to the raw value — date serials display as numbers (e.g. `44927` instead of `1/1/2023`), percents lose
  their `%` sign, etc.
- **Formula cells carry `f` with leading `=`**: `isFormula()` checks `value[0] === '='`.

## Comments

Comments anchor to cells via `commentCardIds?: string[]` on the `Cell` type. The upstream fortune-sheet
built-in comment system (ps field, NotationBoxes, comment module) was fully removed and replaced with the
shared Eigen comment-card infrastructure — see [COMMENTS.md](COMMENTS.md) for the card model, hooks and
components.

- **Canvas indicator**: triangle (top-right) drawn when `cell.commentCardIds?.length > 0`; color comes
  from the Y.Doc card via `hooks.getCommentInfo(r, c)`
- **Context menu**: "Add comment" (no comment) or "View comment" / "Delete comment" (has comment), wired via
  `hooks.onAddComment/onViewComment/onDeleteComment` from settings
- **Comments/activity pane**: the shared `PanelColumn` — one component for both panels on every viewport,
  driven by `useDocumentPanels(isMobile)`
- **Card dialogs**: the shared `CommentLifecycleDialogs` (open card, edit, resolve, delete), fed by
  `useCommentLifecycle`

On mobile the pane takes the whole width, so `editor.tsx` **hides** the workbook wrapper (`hidden`) instead
of unmounting it — the engine's `ResizeObserver` re-measures the canvas when it comes back (see the
container-resize contract above). Hiding that wrapper also takes the floating find bar with it.

## Headless Formula Engine

A DOM-free formula engine lives in `packages/sheet/src/engine/`. It evaluates formulas using a
`CellResolver` interface — the same engine powers both the UI (resolver reads from Context) and server-side
evaluation (resolver reads from Yjs snapshot).

The modules that carry the weight:

```
engine/
├── formula-engine.ts       # FormulaEngine class (evaluate)
├── parser/                 # Pure formula parser (JISON + @formulajs/formulajs, zero DOM)
├── cell-resolver.ts        # CellResolver interface + createArrayResolver
├── dependency-graph.ts     # Topological sort (getCalculationOrder)
├── dependency-index.ts     # Reverse index: which formulas read a given cell (per-cell + block buckets)
├── recalc.ts               # recalcSheets — server-side gated full recalc (see § Server-side recalc)
├── replay-ops.ts           # replaySheetsOps (snapshot + ops → Sheet[]; shared by BE + FE initial-load)
├── rowcol.ts               # applySheetsInsertRowCol / applySheetsDeleteRowCol (pure row/col data shifts)
├── celldata.ts             # Sparse `celldata` ↔ dense `data` matrix conversions
└── conditional-format.ts   # Pure CF evaluator (evaluateConditionalFormat, cfSplitRange, getColorGradation)
```

Smaller pure helpers sit next to them: `a1-notation.ts`, `format.ts`, `validation.ts`, `defaults.ts`
(canonical empty-grid size), the formula-text shifters (`formula-shift.ts`, `formula-reference-cycle.ts`)
and `formula-utils.ts`. `types.ts` holds the engine types plus re-exports of the shared shapes from
`@workspace/lib/sheets`; `index.ts` is the barrel.

**Key capabilities:**
- `evaluate(formula, sheetId, row, col, resolver)` — single formula evaluation
- `replaySheetsOps(sheets, opBatches)` — pure snapshot + ops → `Sheet[]`. Handles `add`/`remove`/`replace`
  patches via `opToPatchOnSheets`, `addSheet`/`deleteSheet` inline, and `insertRowCol`/`deleteRowCol` via
  the typed shape-adapter + `applySheetsInsertRowCol`/`applySheetsDeleteRowCol`. Used by the BE document
  reader and the FE Yjs sync handler — single source of truth for both initial-load paths.
  Celldata-only sheets materialize to at least the editor's default grid
  (`DEFAULT_SHEET_ROW_COUNT` × `DEFAULT_SHEET_COLUMN_COUNT`, engine `defaults.ts`) so ops recorded
  against a never-flushed doc resolve; a batch that still cannot apply is rolled back and skipped
  with a warning instead of making the doc unreadable. `createDefaultSheets()` (same module) is the
  canonical no-snapshot base for the FE hook and `readSheetsContent`.
- `applySheetsInsertRowCol<S extends Sheet>(sheets, op)` / `applySheetsDeleteRowCol<S extends Sheet>(sheets, op)`
  — pure data shifts for row/col ops over lib.Sheet-typed fields (`data`, `config.merge`, `config.rowhidden`,
  `conditionalFormatRules`, cross-sheet formula refs). Generic over `S` so the editor's wider
  `state.Sheet[]` flows through with its extras unchanged. Editor-managed fields (filter /
  filterRange / frozen / dataVerification / hyperlink / calcChain / selections) are shifted by the
  state wrapper in `state/modules/rowcol.ts` after the engine call.

**Architecture boundary:** Context-coupled orchestration functions (`execFunctionGroup`, `groupValuesRefresh`,
etc.) live in `state/modules/formula-exec.ts`; UI consumers import the engine modules and `formula-exec.ts`
directly.

### Server-side recalc

`readSheetsContent()` recomputes formula cells through our own engine before returning, so exports,
preview, and the search index serve engine-verified `v`/`m` rather than whatever value was last cached
in the snapshot. The recompute is a single pure engine function, `recalcSheets(Sheet[]) → Sheet[]`
(`engine/recalc.ts`, barrel-exported), and it runs **gated** — only where staleness can actually exist.

Why gated, not on every read: a doc edited live in a browser is already fresh. The client's dependent
recompute runs inside the op-emitting `produce`, so recomputed `v` **and** `m` persist as Yjs ops and
replay server-side (`replaySheetsOps`). The genuinely stale population is narrow — xlsx-imported docs
never opened in an editor, and crash/race divergence between formula text and cached value.
`recalcSheets` therefore fires only when `sheetsNeedRecalc` sees a sheet with `f` cells but no populated
`calcChain` (editor-flushed snapshots carry the chain; imported ones don't), and any recalc failure
falls back to the replayed stale-but-valid `Sheet[]` — an export must never 500 because recalc
hiccuped. The xlsx importer (`import/import-document.ts`) also runs `recalcSheets` once at import, so the
persisted snapshot carries computed values (and a `calcChain`) and the read gate never fires for it.

What the function does, in order: materialize each sheet's dense `data` from `celldata` (a resolver over
null `data` would recompute everything to blanks); discover formula cells by scanning `data` for `f`
(never trusting `calcChain`); build the dependency graph by porting the state layer's
`setFormulaCellInfo`/`getcellrange`/`isFunctionRange` into the engine (the engine has zero state imports,
so the logic is duplicated rather than shared — the INDIRECT/OFFSET/INDEX special-casing is preserved);
order via `getCalculationOrder`; evaluate through the shared `FormulaEngine`, results flowing through
`execFunctionGlobalData` so a downstream cell reads its upstream result; **freeze volatiles**
(`NOW`/`TODAY`/`RAND`/`RANDBETWEEN` keep their cached value, matching Excel/Sheets "read a closed file"
semantics — a passive export stays deterministic); and write back `v` plus a pragmatic `m`
(`update(ct.fa, v)` when the cell carries a format mask, error sentinels as `v = m = '#…'` with
`ct.t = 'e'`, `String(v)` otherwise). An engine error never overwrites a non-error cached value: a
function this build lacks (XLOOKUP, TEXTJOIN, LET, FILTER, …) evaluates to `#NAME?`, so rather than
destroy Excel's correct cached result at import the cached `v`/`m` is kept and the
`execFunctionGlobalData` seed is skipped, so downstream cells read the cached value through the resolver
(same freeze-is-safe direction as volatiles); only a cell with no cached value gets the error sentinel.
Every cell is guarded, so one poisoned formula never aborts the pass.

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
`CellResolver`. Both state (`state/modules/condition-format.ts::getComputeMap`) and the server-side
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
`evaluateFormula` callback. This CF pass reads `cell.v` — it doesn't recompute the sheet's own
formulas, only the CF rule's formula against existing values. The cell values it reads are already
engine-fresh, though: `readSheetsContent` runs the gated `recalcSheets` (see § Server-side recalc)
before the sheets reach any exporter.

Webpage hyperlinks render as `target="_blank" rel="noopener noreferrer"` anchors, scheme-gated
through the same `resolveWebLink` (`@workspace/lib/sheets/web-link`) the editor's link navigation
uses; internal (`sheet`/`cellrange`) links stay plain text. Native xlsx export lives in
`export/sheets/xlsx.ts` — coverage and encoding decisions in [EXPORT.md](EXPORT.md#sheets-export).

### Accepted xlsx round-trip drifts (decisions, pinned in tests where applicable)

Recorded by the xlsx-fidelity program (cycles 0–8, 2026-06; full history in git —
`docs/SHEETS-XLSX-FIDELITY.md` before its 2026-07-12 removal). These are deliberate, not bugs:

- Hyperlinks: `sheet` links re-import as `cellrange` anchored at `'Name'!A1`; `cellrange` range
  tails reduce to their top-left cell (exceljs's internal-link pattern needs a single trailing
  cell ref); bare refs gain the own sheet's quoted prefix; a webpage URL containing exactly one
  `!` with a cell-shaped tail is misdetected as internal by exceljs's pattern.
- Imported hyperlink cells keep Excel's font styling while dialog-authored links hardcode
  blue + underline — forcing the dialog style at import would clobber theme-styled link cells.
- An Excel link to ANOTHER workbook carrying a sheet anchor (`r:id → other.xlsx` +
  `location="Sheet1!A1"`) imports as an internal cellrange link (the location attr wins over
  the rel; disambiguating needs the rel target compared against the location — edge-case wash).
- `duplicateValue` CF exports as the COUNTIF expression recipe and re-imports as a `formula`
  rule (rule-type drift, rendering identical); `occurrenceDate` CF (editor-only) is not exported.
- `encodeCfOperand` quotes exotic numeric literals (`1e5`, `+5`) as text — the faithful inverse
  of the importer's `parseCfLiteral`; the engine compares with JS coercion, so rendering is
  unaffected either way.
- Export denormalizes CF — one `<conditionalFormatting>` element per engine rule — while exceljs
  re-merges per-cell DV back to a handful of sqrefs; exported files stay smaller than their
  sources (size note only).
- The DV exporter always writes `allowBlank: true` (Excel's UI default).
- Excel comments/notes are not imported (decided 2026-06-10) — Eigen has its own comment cards.

The engine is exposed as a `@workspace/sheet/engine` subpath export. Server-side
consumers (`apps/api`) import only from this subpath, which restricts type-checking to the pure
DOM-free subset that satisfies stricter compiler options (`verbatimModuleSyntax`,
`noUnusedParameters`).

### Constraints

- **Parser origin**: the parser is derived from hot-formula-parser (Handsontable's older parser, inherited
  via the upstream fortune-sheet fork); `@formulajs/formulajs` covers ~200 functions, not Excel's full ~400.
- **Volatile functions** (`RAND`, `NOW`, `TODAY`) return new values on each server evaluation — correct
  behavior, but differs from the cached snapshot.
- **Circular references**: `getCalculationOrder` (`engine/dependency-graph.ts`) never errors on a
  cycle — its visited-set breaks the walk, so cyclic cells evaluate in visit order.
- **INDIRECT/OFFSET/INDEX** produce dynamic references the dependency graph can't analyze statically;
  `isFunctionRange()` handles these specially — preserve that logic when touching the graph.

### Not in scope

Replacing the sheet engine, adding formula functions beyond formulajs, server-side UI rendering, real-time
formula recalc push (formulas are evaluated on read, not on write).

## Upstream Origin

The entire fortune-sheet + luckysheet upstream library (UI components, state runtime, formula parser, engine)
was forked into `packages/sheet/`. There is no external `@fortune-sheet/core` dependency — everything lives
in-repo under full source control.
