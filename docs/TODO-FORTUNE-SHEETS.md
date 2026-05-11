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

1. **Enable biome on `state/`** — ✅ done on `biome-state-cleanup` (merged
   2026-05-10). 218 fortune-sheet files at 0 errors / 0 warnings; typecheck
   green across all 12 workspaces; 749 fortune-sheet tests + 1189 API tests
   pass. Net –3,400 LOC across 16 commits.

   **Canonical types landed in `@workspace/lib/sheets`:** `MergeCell`,
   `BorderInfo` (with `BorderRange`/`BorderType`/`RangeBorderInfo`/
   `CellBorderInfo`), `DataVerificationRule`. State-only entry shapes
   (`FilterEntry`, `CalcChainEntry`, `AlternateFormatEntry`) live in
   `state/types.ts`.

   **Loose typing kept** (each with a documented biome-ignore + WHY pointing
   here):
   - `SheetConfig.borderInfo: any[]` — producers in paste/rowcol/toolbar/
     selection/dropCell/api/cell push raw object literals whose `rangeType`
     discriminator isn't `as const`-tagged. Tightening cascades ~30 errors;
     readers narrow at the use-site (`const borderInfo: BorderInfo[] =
     cfg.borderInfo ?? []`).
   - `Sheet.luckysheet_conditionformat_save: any[]` — same producer pattern;
     wire shape is `ConditionalFormatRule[]` in lib.
   - `SheetConfig.authority: any` — protection.ts reads a varied flag bag;
     tightening requires inverting the field set across all protection modes.
   - `Freezen.freezenhorizontaldata: any[]` / `.freezenverticaldata: any[]` —
     mixed `(number | number[])[]` runtime shape; consumers pass to helpers
     expecting plain `number[]`.
   - `state/modules/formula-range.ts::rangeSetValue(selected: any)` —
     column-header / row-header click handlers pass `row: [null, null]`
     (or `column: [null, null]`) to denote a whole-column/row reference;
     `getRangetxt` (`cell.ts:993`) explicitly reads those null sentinels at
     runtime. Canonical `SingleRange = { row: number[]; column: number[] }`
     is the type lie — widening to `(number | null)[]` cascades through
     ~56 consumers (most index `.row[0]` as plain `number`). The honest
     fix is to widen lib's `SingleRange` and add narrows at every read site
     that needs a real number.

   Once those producers are migrated in lockstep, state's `Sheet` / `SheetConfig`
   can collapse into `Omit<lib.Sheet, …> & { editor extras }`.

   **Group F `@ts-ignore` sites still pending** (11 remain, deferred per-site work; line numbers as of 2026-04-30):
   - `modules/cell.ts:1222,1224` — runtime-stamped `cell._color` /
     `cell._fontSize` not on the shared `Cell` type. Add as optional fields,
     or narrow.
   - `events/paste.ts:324,766,1333` — `cfg.merge[key] = …` — `Sheet.config.merge`
     not typed as `Record<string, MergeCell>`.
   - `events/paste.ts:1682` — `genarate()` returns untyped tuple →
     `[cell.m, cell.ct, cell.v] = mask`. Type the return.
   - `events/paste.ts:1732` — `locale_fontjson[fa]` index sig.
   - `events/paste.ts:1790,1792` — `parseInt(td.getAttribute(...), 10)` —
     `getAttribute` returns `string | null`.
   - `events/mouse-cell.ts:252`, `events/mouse-header.ts:175,541`,
     `modules/formula-editor.ts:868` — `currSelection.anchorNode?.parentNode`
     indexed into `childNodes` (es-toolkit `indexOf` typing).
   - `modules/inline-string.ts:231`, `modules/cell.ts:170,1130,1134,1152,1180` —
     dynamic-key writes / `delete` on non-optional / `forEach` key annotation.
   - `api/cell.ts:126,204`, `api/rowcol.ts:24` — `cell[attr] = v`,
     `attr === "bd"` narrowing, `frozen.type` literal union.
   - `modules/toolbar.ts:157,186,188` — `value[attr] = focusStatus`,
     `d[r][c] = {v: value}` then index write.

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

6. **`from-xlsx.ts::parseA1` duplicates engine's `parseA1`** —
   `apps/api/src/lib/import/sheets/from-xlsx.ts:208-216` defines a private
   `parseA1` that returns `{r, c}` and only handles plain `A1` addresses.
   The engine's exported `parseA1` (`@workspace/fortune-sheet/engine`) returns
   `{col, row}` and handles `$`-absolute references and sheet-name prefixes.
   Replace and adapt the two `parseRange` callsites to swap the field names.

7. **PDF export computes `buildBorderMap` + `getGridBounds` twice per sheet** —
   `apps/api/src/lib/export/sheets/pdf.ts` calls `getSheetContentSize(sheet)`
   for every sheet (which builds the border map + grid bounds), then calls
   `renderSheetsHtml(sheets)` which calls `renderSheet` → `buildBorderMap` +
   `getGridBounds` again per sheet. Border-info iteration is O(borderInfo
   entries × cells); on dense workbooks this doubles the export work for no
   benefit. Either pre-compute bounds once and pass through, or expose a
   combined `{html, sizes}` from `html.ts`.

### Misc cleanups

8. **`SheetTab` shadcn migration** — bottom tab bar
   (`components/SheetTab/index.tsx` + `SheetItem.tsx`, ~580 LOC TSX) still
   has its own ~272 LOC `index.css` (also part of TODO #2's CSS migration —
   tackle them together). Add/delete/rename/hide/color all use bespoke
   styling and dropdowns; should adopt shadcn `DropdownMenu` (rename, color,
   hide, etc.) and `Tailwind` for layout. Drag-and-drop reorder + scroll
   buttons can stay as plain buttons. `ContextMenu/SheetTab.tsx` (the
   right-click on a tab) already uses shadcn — only the tab bar itself needs
   the pass.

9. **`initSheetData` inlines `celldataToData`** —
   `state/api/sheet.ts:16-54` builds the dense `data` matrix manually
   (`maxBy` / `times` / fill loop) when adding/initialising a sheet. Engine
   has the canonical `celldataToData(celldata, rowCount?, colCount?)`
   re-exported from `state/api/common.ts` since 2026-05-01. Replace the inline
   loop, passing `row ?? defaultrowNum`, `column ?? defaultcolumnNum` to
   preserve the editor's empty-grid fallback.

10. **JSDoc sweep across `state/`** — CODE-STANDARDS.md "No JSDoc". Many
    state-module functions still carry `/** @param {string} type ... */` blocks
    that contradict the actual TS types. Pre-existing legacy; not worth a
    targeted PR but delete on touch (e.g. `state/modules/rowcol.ts:593-601`
    on `insertRowCol`).

11. Move package to `apps/sheets/src/fortune-sheet/` — only `apps/sheets/`
    consumes it. Low priority, rename-only with no code impact.

### Carry-overs from earlier review passes

12. **`applyInsert` / `applyDelete` deep-clone the full target sheet** —
    `cloneDeep(target)` at `engine/rowcol.ts:187,393` clones every field
    (state-only fields included) when the engine writes only `data`, `config`,
    and `luckysheet_conditionformat_save`. State wrapper then mutates the
    state-only fields, throwing away the wasteful clone. Profile first; only
    optimize if row/col ops show up hot.

13. **`events/keyboard.ts:F4` — dead keybinding** — the F4 branch in formula
    edit mode just `preventDefault()`s. Standard spreadsheet F4 should cycle a
    formula reference `A1` → `$A$1` → `A$1` → `$A1` → `A1`. Treated as feature
    work (DOM-walk the formula editor, parse the reference under the caret,
    cycle `$` markers, restore selection), not a bug fix — separate effort.

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
- **Row/col op engine wrap + BE/FE replay (2026-05-01)** — right-click insert/delete row &
  column on a sheet with merges, frozen rows, active filter, data-verification rule,
  conditional format. Verify shifts correctly + selection follows + formulas update. Also:
  cold-join with pending row/col ops (browser A inserts a row, closes tab without flushing;
  browser B opens fresh and sees the inserted row); active-session remote op; snapshot-only
  load path. Exercises the new shared `replaySheetsOps` on both BE and FE initial-load.
- **BE replay-on-read end-to-end** (`document-cleanup` merge, 2026-05-02-03):
  - Edit a cell → reload before auto-flush → BE replay resurrects the
    unflushed edit and the page rehydrates with it.
  - Export to xlsx with pre-flush edits → opened workbook shows the edits
    (validates the celldata-resync-without-ops path that fixed the
    "exported sheet looks empty" bug, commit `e0124f02`).
  - Hostile op queue (queue an insertRowCol against a `rowReadOnly` row, or
    push past 10000 rows): export still succeeds with a console warn,
    skipping the offending op rather than crashing the render.

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
