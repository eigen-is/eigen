# Sheet Package TODO

Pending work for `packages/sheet/`. The package is a full fork of
fortune-sheet + luckysheet — no external `@fortune-sheet/core` dependency.
Treat it as **owned code**: fix broken windows when touching it, prefer
modern patterns over preserving legacy.

For architecture see [SHEETS.md](SHEETS.md). For component layering see
[`packages/sheet/RENDERING.md`](../packages/sheet/RENDERING.md).

---

## Outstanding

### Core technical debt

1. **CSS migrations** — 3 files remain (size verified 2026-04-28); then delete
   `src/css.d.ts`:
   - `SheetOverlay/index.css` (812 LOC, largest — split into multiple PRs).
   - `SheetTab/index.css` (272 LOC).
   - `SheetOverlay/ScrollBar/index.css` (40 LOC).
   Before removing any class, grep `state/` for `luckysheet-*` selectors — see
   [DOM Selector Coupling](#dom-selector-coupling).

2. **Regenerate `engine/parser/grammar-parser/grammar-parser.ts`** from upstream
   jison rather than hand-editing. Currently biome-excluded. No urgency. The
   only remaining `export default` lines in the package live under
   `engine/parser/` and will be regenerated together.

### Server-side features

3. **xlsx CF export** — `apps/api/src/lib/export/sheets/xlsx.ts` doesn't write
   conditional-format rules. Translate the package's rules into ExcelJS native
   `worksheet.addConditionalFormatting` so Excel evaluates them on file open
   (no formula engine needed for xlsx — Excel does it natively). The
   `ConditionalFormatRule` discriminated union (engine + lib) gives the rule
   shape needed to introspect each rule type.

4. **Server-side recalc in `readSheetContent()`** — engine API ready
   (`engine.recalculateAll(resolver)`); `apps/api` consumer just needs the
   wiring. Defer until export, search indexing, or scripting actually needs
   fresh values; today the consumer reads the last-saved `cell.v` from the
   snapshot, which is fine. See [SHEETS.md § Headless Formula Engine](SHEETS.md#headless-formula-engine).

5. **PDF export computes `buildBorderMap` + `getGridBounds` twice per sheet** —
   `apps/api/src/lib/export/sheets/pdf.ts` calls `getSheetContentSize(sheet)`
   for every sheet (which builds the border map + grid bounds), then calls
   `renderSheetsHtml(sheets)` which calls `renderSheet` → `buildBorderMap` +
   `getGridBounds` again per sheet. Border-info iteration is O(borderInfo
   entries × cells); on dense workbooks this doubles the export work for no
   benefit. Either pre-compute bounds once and pass through, or expose a
   combined `{html, sizes}` from `html.ts`.

### Polish

6. **`SheetTab` shadcn migration** — bottom tab bar
   (`components/SheetTab/index.tsx` + `SheetItem.tsx`, ~580 LOC TSX) still
   has its own ~272 LOC `index.css` (also part of TODO #1's CSS migration —
   tackle them together). Add/delete/rename/hide/color all use bespoke
   styling and dropdowns; should adopt shadcn `DropdownMenu` (rename, color,
   hide, etc.) and `Tailwind` for layout. Drag-and-drop reorder + scroll
   buttons can stay as plain buttons. `ContextMenu/SheetTab.tsx` (the
   right-click on a tab) already uses shadcn — only the tab bar itself needs
   the pass.

7. **`applyInsert` / `applyDelete` deep-clone the full target sheet** —
   `cloneDeep(target)` at `engine/rowcol.ts:187,393` clones every field
   (state-only fields included) when the engine writes only `data`, `config`,
   and `conditionalFormatRules`. State wrapper then mutates the state-only
   fields, throwing away the wasteful clone. Profile first; only optimize if
   row/col ops show up hot.

8. **`events/keyboard.ts:F4` — dead keybinding** — the F4 branch in formula
   edit mode just `preventDefault()`s. Standard spreadsheet F4 should cycle a
   formula reference `A1` → `$A$1` → `A$1` → `$A1` → `A1`. Treated as feature
   work (DOM-walk the formula editor, parse the reference under the caret,
   cycle `$` markers, restore selection), not a bug fix — separate effort.

---

## Architecture & invariants

### Engine boundary

`engine/` is pure, DOM-free, and has zero imports from `state/`. State imports
freely from engine. Server-side consumers (`apps/api`) import from the
`@workspace/sheet/engine` subpath export, which restricts type-checking
to the engine subset — keeps `verbatimModuleSyntax` + `noUnusedParameters`
happy.

The boundary is deliberate. Pure formula evaluation, CF rule evaluation, ref
shifting (`functionCopy`), parsing, dependency graph, formatting — all engine.
Context-coupled orchestration (`execFunctionGroup`, `groupValuesRefresh`,
`insertUpdateFunctionGroup`, `getAllFunctionGroup`) lives in
`state/modules/formula-exec.ts`. The `formula-ui.ts` barrel re-exports both so
UI consumers don't see the split.

### Cell / Sheet invariants for external producers

When generating sheet `Cell` / `Sheet` data outside the package
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

### Layering / z-index

Project-wide convention lives in
[`docs/CODE-STANDARDS.md` § Z-Index / Layering](CODE-STANDARDS.md#z-index--layering).
Sheet-package specifics:

- **Canvas-internal overlays stay ≤ z-30.** Selection layers z-8…z-20;
  scrollbars, data-validation hint box, context-menu scrim, LinkEditCard,
  bottom-controll-row all sit at z-20–30. Mobile touch handle at z-25.
  Filter button (column header) at z-12. Image boxes at z-19/z-20.
- **Portaled Radix menus rely on shadcn's z-50 default.** Cell context menu,
  filter menu (+ submenu), formula autocomplete/hint, all-sheets selector,
  sheet-tab menus — none carry an inline `style={{ zIndex }}`. If a menu
  appears under something, fix the offender, don't bump the menu.
- **App-level chrome around the workbook must not introduce z-index.** The
  comments panel is a flex sibling next to the canvas; treat any future
  side panel the same way (slides pattern). The previous `zIndex: 1005`
  wrapper covered the topbar's notification dropdown — don't reintroduce it.
