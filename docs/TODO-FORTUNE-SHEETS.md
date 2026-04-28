# Fortune-Sheet TODO

Single source of truth for `packages/fortune-sheet/` pending work. Goal: make the
package "ours" — biome-clean end to end, lodash-free (done), CSS fully migrated
to Tailwind, shadcn adopted (done), typing tightened.

The package is a full fork of fortune-sheet + luckysheet — no external
`@fortune-sheet/core` dependency. Treat it as **owned code**: fix broken
windows when touching it, prefer modern patterns over preserving legacy.

For architecture see [SHEETS.md](SHEETS.md). For component layering see
[`packages/fortune-sheet/RENDERING.md`](../packages/fortune-sheet/RENDERING.md).

---

## Outstanding

### Core technical debt

1. **Enable biome on `state/`** — biggest lift. Currently excluded in `biome.jsonc`
   line 14. Will surface ~232 `any` annotations (31 in `rowcol.ts` alone) and ~60
   `@ts-ignore` directives. ~90 files / 48k LOC. Open this incrementally — each
   file's typing gaps are independent.

2. **CSS migrations** — 3 files remain (size verified 2026-04-28); then delete
   `src/css.d.ts`:
   - `SheetOverlay/index.css` (812 LOC, largest — split into multiple PRs).
   - `SheetTab/index.css` (272 LOC).
   - `SheetOverlay/ScrollBar/index.css` (40 LOC).
   Before removing any class, grep `state/` for `luckysheet-*` selectors — see
   [DOM Selector Coupling](#dom-selector-coupling).

3. **Regenerate `engine/parser/grammar-parser/grammar-parser.ts`** from upstream
   jison rather than hand-editing. Currently biome-excluded. No urgency. The
   only remaining `export default` lines in the package live under
   `engine/parser/` and will be regenerated together.

### Server-side features

4. **xlsx CF export** — `apps/api/src/lib/export/sheets/xlsx.ts` doesn't write
   conditional-format rules. Translate fortune-sheet rules into ExcelJS native
   `worksheet.addConditionalFormatting` so Excel evaluates them on file open
   (no formula engine needed for xlsx — Excel does it natively). The
   `ConditionalFormatRule` discriminated union (engine + lib) gives the rule
   shape needed to introspect each rule type.

5. **Server-side recalc in `readSheetContent()`** — engine API ready
   (`engine.recalculateAll(resolver)`); `apps/api` consumer just needs the
   wiring. Defer until export, search indexing, or scripting actually needs
   fresh values; today the consumer reads the last-saved `cell.v` from the
   snapshot, which is fine. See [SHEETS.md § Headless Formula Engine](SHEETS.md#headless-formula-engine).

### Misc cleanups

6. `apps/sheets/src/components/sheets/SheetOverlay/InputBox.tsx`'s arrow-key
   handler manipulates `.luckysheet-formula-search-item-active` on the formula
   autocomplete popup (lines 113, 115, 122–125, 206–235), but
   `SheetOverlay/FormulaSearch/index.tsx` never sets the
   `luckysheet-formula-search-item` / `luckysheet-formula-search-func` /
   `luckysheet-formula-search-item-active` classes — keyboard navigation +
   Enter/Tab selection in the autocomplete have been silently broken since the
   shadcn migration. Fix by lifting the active index into FormulaSearch state
   and threading callbacks through `WorkbookContext`, or (less work) just
   re-add the classes plus the `index === 0` initial active marker. Mouse
   click selection still works.

7. Move package to `apps/sheets/src/fortune-sheet/` — only `apps/sheets/`
   consumes it. Low priority, rename-only with no code impact.

---

## Smoke tests still owed

These were merged without an end-to-end pass in `apps/sheets`. Most have been
running in normal use for days now and are likely fine, but no one has signed
off. Walk through if you touch the related surface.

- **Cell editing & paste** (InputBox + FxEditor + Workbook): type a value,
  paste a multi-line range, formula entry, switch sheets mid-edit, Esc to
  cancel.
- **Sheet redraw + freeze**: scroll, resize, freeze a row + column, add
  columns past the freeze line.
- **Selection box** (post-`useExhaustiveDependencies` cleanup): switch sheets,
  verify a fresh sheet gets default A1 but a sheet with prior selection keeps
  it.
- **Drag-fill** (post-lodash-to-es-toolkit migration): regression caught by
  reviewer once already.
- **Data-verification dropdown** — multi-select toggle (single-select verified
  2026-04-25).
- **Filter menu** — apply filter, hide values, re-open filter; by-color hover
  should not flicker on the `sideOffset` gap (120ms close-debounce).
- **CustomSort / SplitColumn** dialogs (post `b5c3b7e7`): walk through
  select / checkbox / radio interactions, confirm `DialogFooter` layout.
- **Link card** (`LinkEditCard:99`): hyperlink a cell, click another with a
  different hyperlink, verify the card resets the form.
- **Sheet tab scroll buttons** (`SheetTab:41`): add many sheets until the tab
  bar overflows, verify scroll arrows appear.
- **Right-click insert/delete row & column**: single-row insert; multi-select
  2+ rows → "noMulti" alert; delete-all-rows → alert.
- **Sheet tab operations**: rename, delete (verify can't delete last sheet),
  hover/active styling.
- **Multi-language removal regressions** (commit `edb89d78`): insert N rows /
  columns word order; data validation `failureText` / `hintText` (esp.
  `text_length` previously silent on `lang === "en"`); status-bar sum/avg
  shows "1234.56" not "w0.00"; touch-mode scrolling.
- **Visual sanity**: selection box border/color, marching ants on Ctrl+C copy.
- **Server-side formula CF** (commit `2a38e2aa`): export a sheet with a
  formula CF rule (e.g. `=A1>10` over a range) to HTML/PDF. Verify cells fire
  per-cell after relative-ref shifting; absolute `$A$1` rules anchor; cross-
  sheet refs resolve. Engine + html-export tests cover this; manual export
  smoke is the gap.

---

## Architecture & invariants

### Engine boundary

`engine/` is pure, DOM-free, and has zero imports from `state/`. State imports
freely from engine. Server-side consumers (`apps/api`) import from the
`@workspace/fortune-sheet/engine` subpath export, which restricts type-checking
to the engine subset — keeps `verbatimModuleSyntax` + `noUnusedParameters`
happy.

The boundary is deliberate. Pure formula evaluation, CF rule evaluation, ref
shifting (`functionCopy`), parsing, dependency graph, formatting — all engine.
Context-coupled orchestration (`execFunctionGroup`, `groupValuesRefresh`,
`insertUpdateFunctionGroup`, `getAllFunctionGroup`) lives in
`state/modules/formula-exec.ts`. The `formula-ui.ts` barrel re-exports both so
UI consumers don't see the split.

### Cell / Sheet invariants for external producers

When generating fortune-sheet `Cell` / `Sheet` data outside the package
(xlsx importers, migrations, seed data), three invariants are assumed but not
documented by the types:

1. **`ct.fa` must be set whenever `ct` is set.** `setCellValue` calls
   `update(cell.ct.fa!, v_p)` → `SSF.format(undefined, n)` returns `""`,
   blanking the cell on recalc. Default to `'General'`.
2. **`sheet.calcChain` must be populated when cells have `f`.**
   `setFormulaCellInfoMap` early-returns on null `calcChain`, leaving
   `formulaCellInfoMap` empty. `Workbook/index.tsx` derives `calcChain` from
   data on mount and runs `api.calculateFormula(draftCtx)` once to reconcile
   imports — but importers should still populate it.
3. **`api.calculateFormula` relies on `ctx.currentSheetId`.** Call
   `initSheetIndex(draftCtx)` first when calling it in the init produce.

### DOM selector coupling

`state/` has ~365 references to `luckysheet-*` class names and IDs as DOM
selectors (`getElementById`, `querySelector`, `getElementsByClassName`).
Removing a selector-referenced class during CSS migration silently breaks
behavior. Always grep `state/` for the class first.

Critical IDs/classes that MUST be preserved:
- `fortune-cell-selected-move` (`moveCells.ts`)
- `luckysheet-modal-dialog-activeImage` (`image.ts`)
- `luckysheet-formula-text-lpar` (`formula-exec.ts`)
- `fortune-search-replace` (`searchReplace.ts`)
- `fortune-freeze-drag-line` (`mouse-*.ts`)
- 165 `luckysheet-cell-*` selection classes in `mouse-cell.ts`

### Dialog system intentional bypasses

These components use absolute-positioned divs instead of `useDialog`. Required
for drag/resize behavior or cell-anchored positioning:

- `ImgBoxs` — image drag/resize with 8-point handles
- `LinkEditCard` — cell-relative positioning
- `DataVerification/DropdownList` — cell-attached dropdown

### Keyboard handlers

All shortcuts are manual implementations in `state/events/keyboard.ts` (~950
LOC). Most are too complex/stateful for `@tanstack/react-hotkeys` (arrow
navigation with hidden row/col awareness, formula editing). Only Ctrl+Z/Y
(undo/redo) might be extractable.

### Floating UI inside `cellArea`

Any shadcn floating UI (`DropdownMenuContent`, `DropdownMenuSubContent`,
`PopoverContent`, etc.) rendered as a descendant of `cellArea` must put
`luckysheet-mousedown-cancel` on its portaled content. Radix portals out of
the cellArea DOM, but React synthetic events still bubble through the React
tree across portals — without the class, `cellAreaMouseDown` (an ancestor
`onMouseDown` in `SheetOverlay`) fires before the menu's `onSelect`, moving
the selection to the cell beneath the popup. The DOM-level guard at
`SheetOverlay/index.tsx:60` (`e.target.closest('.luckysheet-mousedown-cancel')`)
walks the DOM (not the React tree) and short-circuits selection movement.

`FilterMenu` is exempt — it mounts at the `Workbook` root, sibling of
`<Sheet />`, not a `cellArea` descendant.

### Package location

Only `apps/sheets/` consumes the package. Could move to
`apps/sheets/src/fortune-sheet/` to make the dependency explicit. Low
priority — rename-only.

---

## Recently shipped

### 2026-04-28

- **TODO #3, #7, #8, #9, #10**: cleanup pass.
  - **#3**: tightened `evaluateConditionalFormat` to a `ConditionalFormatRule`
    discriminated union over `type` (`DataBarRule`, `ColorGradationRule`,
    `IconsRule`, `DefaultConditionalFormatRule`). Engine narrows on `rule.type`
    per branch so `format` is correctly typed in each (string[] vs
    `{textColor, cellColor}`). `conditionValue` is `(string | number)[]` with
    explicit `String()` / `Number()` coercion at use sites. Lib mirrors the
    union structurally; `Sheet.luckysheet_conditionformat_save` is now
    `ConditionalFormatRule[]` instead of `unknown[]`. Unblocks #4 (xlsx CF
    export).
  - **#7**: `state/modules/formula-range.ts::functionStrChange_range` migrated
    to engine's `columnLabelToIndex` / `columnIndexToLabel` with a derived
    `rowsMissing`/`colsMissing` flag pair gating the row/col shift logic and
    the output formatter. New `state/test/formula-range.test.ts` (18 cases)
    covers the regression that the engine port would otherwise re-introduce
    (`del col 0,1` on `1:3` corrupting to `A1:A3` via the `c1 < 0` clamp).
  - **#8**: replaced the last hardcoded inline colors in
    `SheetOverlay/FormulaSearch` and `SheetOverlay/FormulaHint` with theme
    tokens, dropped dead `data-func` / `luckysheet-arguments-*` /
    `luckysheet-formula-help-*` classnames (kept the
    `id="luckysheet-formula-search-c"` since `InputBox` uses it as a DOM
    selector). Surfaced #6 above (broken arrow-key navigation in the formula
    autocomplete) as a follow-up.
  - **#9**: dropped the dead `fortune-sort` className wrapper in `CustomSort`
    (no CSS, no layout role) — uses a Fragment now.
  - **#10**: replaced 4 `produce(draft => …)` callbacks in
    `ContextMenu/FilterMenu` with plain functional updates; dropped the
    `immer` import and `pull` from `es-toolkit/compat` for that file.
- **`8c8f4436`**: doc updates — formula CF wiring marked shipped in `SHEETS.md`;
  `RENDERING.md` `Toolbar/` → `MenuBar/*` and `LinkEidtCard` typo → `LinkEditCard`.
- **`2a38e2aa`**: ported `functionCopy` (formula relative-ref shifter) from
  `state/modules/formula-range.ts` (290 LOC removed) to a new
  `engine/formula-shift.ts` (192 LOC). Modernization: dropped unused `ctx:
  Context` first param (state-side dead arg threaded through every recursive
  call); `substr` → `charAt`/`slice`; dead `bracket`/`comma`/`squote` state
  tracking removed; `mode` narrowed from `string` to
  `'up'|'down'|'left'|'right'`; `down/up/left/rightparam` wrappers folded into
  `shiftRef(mode[0], …)`; `isfreezonFuc` renamed `detectAbsolute` and exported.
  State callers updated in `paste.ts` (4 sites), `conditionFormat.ts` (2),
  `sort.ts` (2), `dropCell.ts` (4) — all dropped the dead `ctx` arg. Latent
  bug fixed: switching from state's `columnCharToIndex` (returns NaN) to
  engine's `columnLabelToIndex` (returns -1) plus continuing to test
  missing-axis with `Number.isNaN` would have silently corrupted row-only /
  col-only ranges (`=SUM(1:3)` shifted right → `=SUM(A1:A3)`, fabricating a
  column). Fix: derive `rowsMissing`/`colsMissing` from the source substrings
  up front. Engine now has zero imports from state. Wired formula CF in
  `apps/api/src/lib/export/sheets/html.ts`: `renderSheetsHtml` builds one
  `FormulaEngine` + `createArrayResolver` per export (cross-sheet refs work),
  threads them to `renderSheet`, which uses new helper
  `buildCfFormulaEvaluator(engine, resolver, sheetId)` to produce the per-sheet
  `evaluateFormula` callback. PDF inherits this for free since `pdf.ts` reuses
  `renderSheetsHtml`. New tests: `engine/test/formula-shift.test.ts` (21
  cases), `apps/api/src/test/sheets-html-export.test.ts` (3 cases).

### 2026-04-27

- **`edb89d78`**: dropped multi-language plumbing entirely. `Settings.lang`,
  `ctx.lang`, the browser-language fallback in `Workbook/index.tsx`, and
  `calcSelectionInfo`'s `lang?` parameter all gone. `dataVerification.ts`
  collapsed three 6-way `if (lang === ...)` blocks (in `getFailureText`,
  `getHintText`, and the `cellFocus` HTML prefixes) to single English paths —
  net −365 LOC in that file alone, missing `text_length` case in `getHintText`
  fixed in passing. Net −512 LOC across 5 files.
- **`d0b6d564`**: `state/locale/en.ts` → named export. Last live `export
  default` in `components/` / `hooks/` / `state/` (only `engine/parser/`
  remains).
- **`84c3e272`**: broken-window sweep. `state/modules/mobile.ts` lost unused
  `ctx` params on touch handlers; `state/api/sheet.ts` fixed a dead
  `isNumber(string)` branch on the Excel-style "(n)" copy-suffix bump (always
  returned false on the substring; now uses `Number.parseInt` +
  `Number.isFinite`). Two stray commented `console.log` debug lines dropped.

### 2026-04-26

- **`09b3edbf` … `f3b4b71e`**: Toolbar → MenuBar rewrite. Deleted
  `components/Toolbar/` (~1564 LOC) plus `state/modules/screenshot.ts`,
  `state/modules/locationCondition.ts`, `components/LocationCondition/`. New
  `components/MenuBar/` (Edit / View / Insert / Format / Data + CustomBorder).
  Wired previously missing UI: text Rotation submenu, CF Color Scales (12
  presets), CF Data Bars (6 solid presets). Net ~−1500 LOC. Spec:
  [`PROPOSAL_FORTUNE_SHEET_TOOLBAR.md`](PROPOSAL_FORTUNE_SHEET_TOOLBAR.md).
- **`24e82652`**: zoom feature removed entirely. Browser zoom (Cmd/Ctrl ±)
  covers the use case. ~62 `zoomRatio` refs purged across 27 files. Net −490
  LOC. Surfaced one follow-up — `text.ts::getCellTextInfo` had an unused
  optional `ctx?` param silently disabling locale fonts at 3 of 5 call sites,
  fixed in `1b2b36a0`.
- **`134bd1d1`**: pure CF eval extracted to `engine/conditional-format.ts`
  (1236 LOC). Latent bug fixed in pass: `occurrenceDate` was comparing
  formatted `.m` strings to numeric serials lexicographically; now compares
  numeric `.v` serials.
- **`5856853c`**: CF wired into HTML/PDF export (`textColor`/`cellColor` +
  `dataBar` rendering). Formula-based CF rules deferred (now done in
  `2a38e2aa`).
- **`1b2b36a0` + `2608d5f5` + `2e1ab223` + `7b5ad44c`**: engine cleanup batch.
  `@workspace/fortune-sheet/engine` subpath export added. `colorGradation`
  `format.cellColor`-on-array bug fixed at all 8 sites. `applyCellStyle`
  helper extracted (14× dedupe). CF evaluator: 1236 → 985 LOC. `bc2a21ec`:
  `getColorGradation` accepts `#rrggbb` hex stops.

### 2026-04-25

- **`b5c3b7e7`**: shadcn cleanup pass. DataVerification dropdown click-through
  bug fixed (`DropdownList` rewritten as controlled shadcn `DropdownMenu`;
  `luckysheet-mousedown-cancel` required on portaled content — see
  [Floating UI inside `cellArea`](#floating-ui-inside-cellarea)). All
  `<select>` / `<input type="checkbox">` / `<input type="radio">` migrated to
  shadcn equivalents. ConditionFormat dedup, FilterMenu Popover refactor,
  CustomSort / SplitColumn / LocationCondition dialog migrations. lodash
  fully removed; `es-toolkit/compat` is the only utils dep.
- **`bdb71f94` + `91e28493`**: shadcn follow-up sweep. `LinkEditCard` CSS to
  Tailwind (deleted `index.css`); `SheetOverlay` bottom-add-row; ZoomControl
  Popover. 9 `<div role="button">` → real `<button>`. Net −290 LOC.

### Earlier

Engine extraction: `formula-engine.ts`, `cell-resolver.ts`,
`dependency-graph.ts` (with cycle detection), `format.ts` (numfmt-backed),
`a1-notation.ts`. `formula.ts` (3550 LOC) and `mouse.ts` (5k+ LOC) split into
focused modules — `state/events/mouse.ts` is now a 5-line re-export barrel.
`core/` renamed to `state/`. `formula-parser/` moved to `engine/parser/`.
Biome on `components/` enabled; `useExhaustiveDependencies` rule on. CSS files
deleted: `Workbook/`, `ContextMenu/`, `DataVerification/`, `SearchReplace/`,
`ConditionFormat/`, `LinkEditCard/`.
