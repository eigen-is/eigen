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
├── cells.ts        # nullCellRender/cellRender (background, indicators, tick box, list chevron, text, grid lines)
├── cell-text.ts    # Text painter + overflow-span variant (layout stays in modules/text.ts)
├── data-bar.ts     # Conditional-format data bar
├── overflow.ts     # Text-spill map + trace + the shared per-row cache (cleared via the facade's idle timer)
├── borders.ts      # config.borderInfo pass (viewport walk + merge-edge filter) + dash patterns
└── filter-ui.ts    # Autofilter range border + buttons (lazy Path2D glyphs — module eval is DOM-free)
```

Container-resize contract (app code may rely on it): `Sheet` keeps a `ResizeObserver` on its
placeholder and skips 0×0 boxes, so a hidden workbook re-measures its canvas when it is shown
again — `apps/sheets` hides the workbook rather than unmounting it for the mobile comments pane.

## Yjs Sync

| Key     | Type    | Purpose                                   |
|---------|---------|-------------------------------------------|
| `state` | Y.Map   | `snapshot` — the encoded workbook (see § Snapshot format v2) |
| `ops`   | Y.Array | Incremental ops for real-time sync        |

**Why op-based**: Full JSON snapshots cause overwrite conflicts. Ops are granular — concurrent edits on different cells
merge cleanly.

**One route to a sheet's config, and its collections always exist.** There is no `ctx.config` shortcut — read the
current sheet's config with `getSheetConfig(ctx, id?)` (`state/context.ts`, beside `getFlowdata`) and write through
`ctx.sheets[i].config`. Two things depend on this and are easy to break:

- immer records the **creation** of a key as one `add` carrying the whole new value, so a write to a config
  collection that does not exist yet ships the entire collection and last-writer-wins over a peer. Every collection is
  therefore materialized by `normalizeSheetConfig` (`engine/replay-ops.ts`) wherever a sheet enters any consumer —
  `initSheetData`, the replay base, `addSheet` ops, `createDefaultSheets`, and the Workbook seeding effect. Its
  `SHEET_CONFIG_COLLECTIONS` list `satisfies keyof ExtendedSheetConfig`, so a new collection fails the build rather
  than silently reopening the hole. This mirrors the row/column grid materialization in `engine/defaults.ts`, and for
  the same reason: **a base that is less materialized than the writer makes granular patches fail to resolve**, and
  `replaySheetsOps` then rolls back the whole batch — the edit is lost, not degraded.
- a write on a path that then rejects the operation still costs the user an undo entry and ships an op. Because the
  collections already exist, no writer needs to create one, so this cannot happen by accident; `src/test/state/rejected-writes.test.ts`
  is the table-driven gate that keeps it that way. Add a row to it when you add a writer.

**`config.borderInfo` is a map of each cell's own sides, keyed `"r_c"` like `merge`.** Toolbar layouts are expanded per cell at write time (`applyBorder`, `state/modules/border.ts`); `border-none` and every carry tombstone delete the key; nothing is mirrored onto the neighbour across a shared edge (that would create the neighbour's key as one whole-object `add`, the first-write clobber above). Merges are a read-time filter over raw storage — `mergeEdgeSides` in `packages/lib/src/sheets/borders.ts` is the one predicate the canvas, xlsx and HTML export share — and only the canvas pass skips hidden rows and columns. Order carries nothing, so two clients bordering different cells converge (`src/test/state/modules/border-convergence.test.ts`); two clients bordering the *same* cell still do not, because each applies its own op optimistically — see [PROPOSAL_SHEETS_YJS_CONFIG.md](proposals/PROPOSAL_SHEETS_YJS_CONFIG.md).

**Resize measures page coordinates.** Mousedown stores `e.pageX`/`e.pageY`; mouseup subtracts it. Mousedown and
mouseup measure from different elements (the header vs the overlay container), so anything element-relative needs a
fudge factor to bridge them — there used to be a hand-tuned `3` doing exactly that. No movement is a click, any
movement is a resize.

**Flow**: Local edit → `onOp` callback → push to Y.Array → Yjs WebSocket → remote `applyOp()` (no React re-render).

**Snapshot**: Saved on `beforeunload` (flushes latest data to `state.snapshot` and clears the ops array). New joiners
load from the snapshot, then replay any pending ops that arrived during initial sync via the shared
`replaySheetsOps(sheets, opBatches)` from `@workspace/sheet/engine` — the same function the BE document
reader uses, so every consumer agrees on what "snapshot + ops → `Sheet[]`" means.

**`selections` never persists**: it's a per-client cursor — the ops path drops it (`filterPatch`) and the
snapshot encoder strips it (`snapshot-codec.ts`; a persisted cursor once resurfaced on open as phantom
stats-bar values for a selection nobody made).

## Snapshot format (v2)

The `state.snapshot` string is written and read ONLY through
`encodeSheetsSnapshot` / `decodeSheetsSnapshot` (`packages/lib/src/sheets/snapshot-codec.ts`,
exported via `@workspace/lib/sheets`). v1 was `JSON.stringify(Sheet[])` — 56MB for a real
340k-cell workbook (224 distinct style combos and ~110 distinct border payloads repeated
per cell); v2 interns both in workbook-global dictionaries and is ~4.5× smaller (12.6MB for
the same workbook). The codec lives at the serialization seam only: in-memory `Sheet[]`,
the op format and `replaySheetsOps` are untouched.

- Envelope: `{"f":"eigensheets/2","computed":bool,"styles":[…],"borders":[…],"sheets":[…]}`.
- Cells: `[r, c, styleIdx, content?]` tuples; a bare-primitive content means `v` with
  `m === String(v)` (rehydrated on decode); style-only cells carry no content slot. The
  dense `data` matrix folds into the cell list at encode (editor flushes carry authoritative
  `data` over stale `celldata`) and is never persisted; `selections` never persists either.
- `config.borderInfo`'s `"r_c"` entries become `[r, c, borderIdx]` tuples over an interned
  `borders` dictionary (order carries nothing; the map is rebuilt on decode).
- `calcChain` is never persisted. `computed: true` (importer post-recalc, every editor
  flush) makes the decoder seed it from the `f` cells — which is exactly the signal
  `sheetsNeedRecalc` keys off, so the § Server-side recalc gate is unchanged: an
  uncomputed snapshot (recalc-failed import) decodes without a chain and exports recalc.
- Any input that is not a v2 envelope — a v1 `[`-snapshot, a corrupt envelope, a future tag — throws `Unknown sheets snapshot format`, as does a `borderCells` entry that is not a `[r, c, idx]` tuple (the pre-N2 toolbar-range shape); the editor then opens read-only on defaults and never persists (see `use-sheet.ts` `loadedRef`). A pre-N2 v2 snapshot whose borders are all cell entries decodes benignly — those were already `[r, c, idx]` tuples, and decode drops their obsolete `null` sides.
- `readSheetsFromDoc` materializes the dense `data` matrix for every sheet after replay
  (`withMaterializedData`): v2 snapshots are celldata-only, but the renderers'
  conditional-format pass and the cross-sheet formula resolver read `data`. Accepted bound:
  the matrix spans the celldata extent, so one far-flung cell (think `XFD1048576`) makes a
  preview/extract read allocate a huge dense grid — bounded by the one-shot Worker's
  deadline/death, same class as the editor's own `initSheetData`.

## Where each cell-bound property lives

Two storage patterns, deliberately. Everything that IS the cell — value, formula, number format, bg/font color, bold/italic, rotation, rich-text runs — lives on the `Cell` object in the matrix and travels with it: overwrite the cell and you overwrite all of it, one op. Everything that is bound to the grid *position* rather than the cell's content lives in an `"r_c"`-keyed map beside the matrix, with its own carry rules:

| Property | Home | Why not on the cell |
|---|---|---|
| Borders | `config.borderInfo` | A border survives content deletion, and a cell op replaces the whole `Cell` — border-on-cell would make "A types a value, B draws a border" a whole-cell clobber. The side map keeps the two edits on different keys, which is what makes them converge (§ Yjs Sync) |
| Merges | `config.merge` | Spans cells by definition |
| Data validation | `sheet.dataVerification` | Rule outlives the value it validates |
| Hyperlinks | `sheet.hyperlink` | Link outlives edits to the display text |
| Row/col geometry | `config.rowlen` / `columnlen` / `rowhidden` / `colhidden` / `customHeight` / `customWidth` | Axis-keyed, not cell-keyed |

Since N2 (2026-08-30) every `"r_c"` map is the same shape and shares the same machinery: `parseCellKey` (`packages/lib/src/sheets/borders.ts`) is the one key parser, `shiftCellKeyedForInsert/Delete` (`engine/rowcol.ts`) the one row/column re-keyer (borderInfo shifts in the engine with the other config collections; dataVerification and hyperlink through the same helper state-side), and `normalizeSheetConfig` materializes every config collection on every base. **`borderInfo` was the one exception until N2** — an append-only command log replayed at render time, whose order was semantic and could not converge; [SHEETS-TODO.md § N2](SHEETS-TODO.md) records the reshape.

Two arrays remain, on purpose: `conditionalFormatRules` and `alternateFormatRules` are ordered because order IS the rule priority (Excel's model, exported as explicit xlsx priorities). They share a much smaller cousin of the old border defect — two clients appending a rule at the same moment can disagree about priority order, visible only where rules overlap — which belongs to the same same-slot family as concurrent same-cell edits; see [PROPOSAL_SHEETS_YJS_CONFIG.md](proposals/PROPOSAL_SHEETS_YJS_CONFIG.md).

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
  from the Y.Doc card via `hooks.getCommentInfo(r, c)`. Same painter and same size as the other two
  corner marks — see § Cell corner indicators
- **Context menu**: the shared `CommentLifecycleMenuItems`, fed by `hooks.commentLifecycle` (the `useCommentLifecycle` bundle) plus `hooks.getCommentInfo` for the cell's card. Only the two cell-anchor writes stay sheet-specific hooks: `hooks.onAddComment` and `hooks.onDeleteComment`
- **Comments/activity pane**: the shared `PanelColumn` — one component for both panels on every viewport,
  driven by `useDocumentPanels(isMobile)`
- **Card dialogs**: the shared `CommentLifecycleDialogs` (open card, edit, resolve, delete), fed by
  `useCommentLifecycle`

On mobile the pane takes the whole width, so `editor.tsx` **hides** the workbook wrapper (`hidden`) instead
of unmounting it — the engine's `ResizeObserver` re-measures the canvas when it comes back (see the
container-resize contract above). Hiding that wrapper also takes the floating find bar with it.

## Tick boxes (checkbox data verification)

A tick box is a **data-verification rule**, not a cell format — the same model Google uses. `Insert →
Tick box` and the **cell right-click menu** both write `{ type: 'checkbox', value1: 'TRUE',
value2: 'FALSE' }` over the selected range (`insertCheckbox`); the context-menu entry is the one that
matches the common intent, which is converting an existing TRUE/FALSE column rather than creating
something. `Data → Data verification` keeps the dialog for custom selected/not-selected labels, and
seeds it with the same TRUE/FALSE pair so a fresh checkbox rule is confirmable without typing.
Everything lives in `packages/sheet/src/state/modules/data-verification.ts`.

- **The cell value is the checked state.** `isCheckboxChecked(rule, value)` compares the cell's display
  value against `rule.value1` case-insensitively — there is no flag on the rule. That is what makes an
  imported, pasted, typed or formula-produced `TRUE` render ticked.
- **Applying a rule never overwrites data.** `applyDataVerification` seeds `value2` into **empty** cells
  only, so pointing a tick box at an existing TRUE/FALSE column is lossless.
- **A formula cell is a read-only tick.** `checkboxChange` returns `false` when the cell carries `f`;
  clicking it would otherwise replace the formula with a literal.
- **Only the box toggles.** `checkboxRect` is the single geometry both the painter
  (`state/render/cells.ts`) and the mousedown hit-test (`state/events/mouse-cell.ts`) use — the same
  split as `FILTER_BUTTON_WIDTH`/`HEIGHT` — and both hand it the same box, built by `cellTextBox`
  from the cell's own bounds. Clicking elsewhere in the cell selects it like any other; Space/Enter
  toggle the focused cell (`state/events/keyboard.ts`).
- **Nothing toggles while a cell edit is open.** Clicking a tick box to put its reference into an
  `=IF(` being composed inserts the reference and nothing else — a toggle would write the cell and
  kick a recalc behind the half-typed formula. Same gate on the list chevron, which would otherwise
  open a dropdown over the formula, and the keyboard path bails on the same condition.
- **Default rules draw the box alone**, the way Google does; a rule with custom values also draws its
  label, the only way to tell "Yes" from "No". So does a cell holding a value the rule names neither
  of: `showsCheckboxLabel` is what keeps `Insert → Tick box` over a column of `Yes` / `Maybe` / `n/a`
  from painting the data out of existence (applying a rule never rewrites it). Empty cells inside a
  range still draw the plain unchecked box (`nullCellRender`), so the range reads as one column.
- Selecting a whole column (a header click, `row: [0, visibledatarow.length - 1]`) is bounded to the
  last row that holds data, so one menu click cannot write ~1M keys into the snapshot. A range the
  user dragged is applied exactly as selected, past the used extent included — that is how a
  checklist over still-empty rows gets its boxes.

## List chevrons (dropdown data verification)

A `dropdown` rule paints a chevron on **every** cell it covers, always — the same deal every other cell
affordance offers. It used to be a single hidden DOM div that `cellFocus` un-hid on mousedown, so a
keyboard user who arrowed onto a validated cell saw nothing, and a read-only viewer never saw it at all.

- **The glyph is canvas paint** (`renderDropdownChevron` in `state/render/cells.ts`), called from both
  `cellRender` and `nullCellRender` — in a real workbook most list-validated cells are empty, and a blank
  validated cell is otherwise indistinguishable from a blank free-text one.
- **One geometry, painter and hit-test.** `dropdownChevronRect` (`state/modules/data-verification.ts`)
  right-aligns the 8px glyph and centres it vertically; `isDropdownChevronClick` builds its click target
  from the same rect, and both drop out below `DROPDOWN_CHEVRON_MIN_WIDTH`. Same split as
  `checkboxRect` and `FILTER_BUTTON_WIDTH`/`HEIGHT`.
- **It overlays the cell text** rather than reserving width, the way Google's does — reserving would
  reflow every validated column.
- **Colour is the cell's own `fc` at 55% alpha**, not a flat grey: real workbooks put list rules on
  dark-filled cells a fixed grey would vanish into.
- **Clicking it opens the list**; a click anywhere else in the cell just selects. Read-only viewers still
  see the chevron but get no list — `cellFocus` never positions the anchor when editing is disallowed.
- The DOM element that remains (`#sheet-dataVerification-dropdown-btn`) is an invisible,
  non-clickable anchor for the Radix portal, nothing more.

## The validation card (prompt / rejection)

A validated cell says two things: the prompt its author wrote (or a generated one), and — when the
value in it fails the rule — why. Both render through one React card,
`components/DataVerification/HintCard.tsx`, from one model, `getValidationHint(ctx, r, c)`.

- **Derived from the focus cell, every render.** It replaced a singleton `<div>` that `cellFocus`
  wrote with `innerHTML` and positioned in raw pixels from a mousedown handler. That one stranded
  over the previous cell when you arrowed away, never appeared for a keyboard user at all, and put
  any collaborator's rule text (or an imported xlsx's `dv.prompt`) straight into markup. Rendering
  it declaratively closes all three: React makes the text content rather than markup.
- **A rejection outranks a prompt** — one card serves both states, and the rejection is the more
  urgent. `confirmMessage` refuses to write a rule it warns about, so an empty-valued rule can no
  longer reach the painter.
- **It stands down while the list is open** (`context.dataVerificationDropDownList`) — the two hang
  over the same corner of the cell.
- **Copy lives in the locale** (`state/locale/en.ts` → `dataVerification.hintCard` + `optionLabel`),
  assembled by `describeValidationRule(item, kind)` — which also supplies the `prohibitInput` warn
  dialog, so the two ways a rejected value is reported say the same thing.

## Cell corner indicators

Three marks can sit in a cell's corners: a comment (top-right), an invalid value and a forced string
(top-left). One painter, `drawCellIndicator` in `state/render/cells.ts`, and one geometry,
`cellIndicatorRect` / `CELL_INDICATOR_SIZE` in `state/modules/cell-glyph.ts` — they used to be 11px, 5px
and 6px of inline magic numbers, with the comment block copied verbatim between `nullCellRender` and
`cellRender`. Colours are hardcoded light like every other canvas colour (RENDERING.md § Theming).

## Cell glyphs outrank the drag handles

The selection box carries two invisible DOM hit targets over the canvas — the drag-to-move band
straddling its border and the fill handle's grab at its bottom-right corner (see the CSS pinned by
`test/components/SheetOverlay/selection-hit-targets.test.ts`). A painted glyph in the same corner used to
lose to them: a press on the list chevron at the fill corner started a fill drag, a press on a comment
or invalid-value triangle under the band started a move. `cellGlyphAt` (`state/modules/cell-glyph.ts`)
is the one predicate that says which glyph — `dropdown`, `checkbox`, `comment`, `invalid` — sits under a
sheet-space point, from the same rects the painter draws (`dropdownChevronRect`, `checkboxRect`,
`cellIndicatorRect`). Both handle mousedowns in `OverlayVisuals` ask `cellGlyphAtPointer` first and, on
a hit, neither stop propagation nor start a drag: the press bubbles to the cell area, whose
`handleCellAreaMouseDown` opens the list, toggles the box or selects the marked cell as it always did.
The hover path (`updateCanvasHover` in `events/mouse-drag.ts`) writes the same answer to
`context.cellGlyphHover`, which sets the cell area's cursor (pointer on a chevron or tick box) and, via
`data-glyph-hover`, stands the handles' own `move`/`crosshair` cursors down so the affordance matches
what a press will do. Row and column resize never compete — those handles live in the headers.

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
  canonical no-snapshot base for the FE hook and `readSheetsFromDoc`.
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

`readSheetsFromDoc()` can recompute formula cells through our own engine before returning — but only
the **export** read asks for it. Preview and the search index (the `extract-text` op) pass
`{ recalc: false }` and serve the replayed values as-is, valueless formula cells staying empty: a legacy
never-computed workbook costs an unbounded full recalc (~39s measured on a 2.3MB-xlsx-derived doc),
past the 30s preview/extract Worker deadline — which killed every preview of such a doc forever
(2026-08-04 prod incident). Exports keep the recompute under their 120s deadline, because a flat
deliverable with blank formula cells is wrong output. The recompute is a single pure engine function, `recalcSheets(Sheet[]) → Sheet[]`
(`engine/recalc.ts`, barrel-exported), and where it runs it is **gated** — only where staleness can actually exist.

Why gated, not on every read: a doc edited live in a browser is already fresh. The client's dependent
recompute runs inside the op-emitting `produce`, so recomputed `v` **and** `m` persist as Yjs ops and
replay server-side (`replaySheetsOps`). The genuinely stale population is narrow — xlsx-imported docs
never opened in an editor, and crash/race divergence between formula text and cached value.
`recalcSheets` therefore fires only when `sheetsNeedRecalc` sees a sheet with `f` cells but no populated
`calcChain`. The chain itself is never persisted (§ Snapshot format v2): for v2 snapshots the decoder
seeds it exactly when the envelope says `computed: true` (every editor flush, every recalc-successful
import), so the gate sees the same signal it always keyed off. Any recalc failure falls back to the replayed
stale-but-valid `Sheet[]` — an export must never 500 because recalc hiccuped. The xlsx importer
(`import/sheets/transform.ts`, in the same Worker) also runs `recalcSheets` once at import and encodes
with `computed: true`, so the read gate never fires for imported docs (a recalc-failed import encodes
`computed: false` and exports recompute).

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

`apps/api/src/lib/export/sheets/render.ts` calls `evaluateConditionalFormat` per sheet and merges
`textColor`/`cellColor` into the cell's style. `dataBar` entries render as an
absolutely-positioned `<div>` inside a `position:relative` `<td>`, with geometry mirrored from
the canvas painter. Negative bars hardcode red (canvas legacy); positive bars use the
user-configured `format` colors.

**Class-based styles (full exports only).** `renderSheetsHtml` interns every emitted style —
cell, row height, col width, table, data bar, rotation span — into a workbook-global registry
(`s0`, `s1`, …) and returns `{ html, css }`; the document builders embed the rules in a body
`<style>` element that rides through `sanitizeExportHtml` with the markup. A real workbook
repeats a few hundred distinct styles across hundreds of thousands of cells, and
DOMPurify/jsdom CSS-parses every inline `style` attribute it sanitizes while class attributes
and style-element text pass through as plain strings — inline styles made a 340k-cell export
82MB with ~75% of its 104s spent CSS-parsing (13.7GB RSS); classes render it in ~7s at 10.4MB.
The preview (`renderSheetsPreviewHtml`) keeps inline styles: its body fragment is embedded
without a `<head>` (PREVIEWS.md), and its bytes are golden-pinned.

**Stylesheet text is a different escaping context from a style attribute**, and cell values are
schemaless CRDT strings. Two guarantees keep them inert, both at seams rather than per field:

- `serializeStyleRules` strips what is structural in CSS text from every declaration it emits:
  `<`/`>` (which would end the `<style>` element — and DOMPurify keeps what follows, so an
  `<svg><image href>` becomes a server-side fetch under WeasyPrint), `{`/`}` (rule blocks),
  `\` (a CSS escape, which also spells `url(`/`@import` invisibly to the sanitizer's scan as
  `\75 rl(` / `@\69 mport`), and `/*`/`*/` (a comment that would swallow every later rule —
  in one shared stylesheet that means one odd cell unstyling the rest of the workbook).
- Numeric fields are coerced, not escaped: `columnlen`/`rowlen` go through `cssLength`, the
  same `Number()` guard `getSheetContentSize` applies for the `@page` rule.

Values are still `escapeHtml`'d on the way in, except the font family, where entity encoding
would corrupt a real name (`Bell MT & Co`) — there the quote characters are dropped instead.
The sanitizer applies the data-URI-only `url()` rule to style-element text as well, plus an
`@import` strip and SVG `href`/`xlink:href` coverage (EXPORT.md § Sanitization and SSRF).

Formula-based CF rules are wired too: `renderSheetsHtml` builds a single `FormulaEngine` plus a
`createArrayResolver` over all loaded sheets (so cross-sheet refs like `=Sheet2!A1>10` resolve),
threads them to `renderSheet`, and the per-sheet `buildCfFormulaEvaluator` produces the
`evaluateFormula` callback. This CF pass reads `cell.v` — it doesn't recompute the sheet's own
formulas, only the CF rule's formula against existing values. The cell values it reads are already
engine-fresh, though: `readSheetsFromDoc` runs the gated `recalcSheets` (see § Server-side recalc)
before the sheets reach any exporter.

Webpage hyperlinks render as `target="_blank" rel="noopener noreferrer"` anchors, scheme-gated
through the same `resolveWebLink` (`@workspace/lib/sheets/web-link`) the editor's link navigation
uses; internal (`sheet`/`cellrange`) links stay plain text. Native xlsx export lives in
`export/sheets/to-xlsx.ts` — coverage and encoding decisions in [EXPORT.md](EXPORT.md#sheets-export).

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
- Tick boxes (`checkbox` DV rules) are editor-only: they are not exported, and the cells they decorate
  export as plain booleans. Excel has no cell-level tick box in OOXML that exceljs can write, and
  re-importing a `list` validation of `"TRUE,FALSE"` would come back as a *dropdown* rule — a different
  feature, with a dropdown arrow where the user expects a box.
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
