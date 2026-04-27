# Fortune-Sheet Audit & Refactor TODO

> **TLDR**: Consolidated cleanup list for `packages/fortune-sheet/`. Goal: make the package "ours" —
> biome-clean end to end, lodash-free, CSS fully migrated to Tailwind, shadcn adopted, typing tightened.
> See priority phases at bottom.

> **Recently shipped (2026-04-26):** The icon-row `Toolbar/` (~1395 LOC) was replaced with a Google-Sheets-style
> `MenuBar/` (Edit / View / Insert / Format / Data menus + `CustomBorder.tsx`). Previously missing UI for text
> Rotation (`tr` field), CF Color Scales (12 presets), and CF Data Bars (6 solid presets) shipped in the Format
> menu. `Screenshot` and `LocationCondition` were deleted entirely. Net ~−1500 LOC across the package.
> Spec: [`PROPOSAL_FORTUNE_SHEET_TOOLBAR.md`](PROPOSAL_FORTUNE_SHEET_TOOLBAR.md).

The package is a full fork of fortune-sheet + luckysheet (no external `@fortune-sheet/core` dependency).
Treat it as owned code: fix broken windows when touching it, prefer modern patterns over preserving legacy.

## Legend

- **CSS** = has legacy `.css` file to migrate to Tailwind
- **BTN** = uses `div` buttons instead of shadcn `Button`
- **DLG** = uses or should use `useDialog` hook
- **WRAP** = thin wrapper, candidate for removal or simplification
- **EXP** = should be exported as named function (not `default`)
- **DONE** = already migrated in previous session

---

## 1. CSS Files to Migrate

All remaining `.css` files should be converted to Tailwind utilities and then deleted. The `css.d.ts` module declaration
can be removed once no `.css` imports remain.

| File                               | Lines  | Status   | Notes                                                                                     |
|------------------------------------|--------|----------|-------------------------------------------------------------------------------------------|
| `SheetTab/index.css`               | 280    | TODO     | Sheet tab area, active/hover states, scroll buttons. Hardcoded colors.                    |
| `SheetOverlay/index.css`           | 882    | TODO     | Largest file. Cell selection, drag, resize, frozen panes, cell editor, formula bar.        |
| `SheetOverlay/ScrollBar/index.css` | 40     | TODO     | Custom scrollbar styling.                                                                 |
| `LinkEditCard/index.css`           | —      | **DONE** | Deleted. Migrated to Tailwind + theme tokens inline in `index.tsx`.                       |
| `ContextMenu/index.css`            | —      | **DONE** | Deleted.                                                                                  |
| `Workbook/index.css`               | —      | **DONE** | Deleted.                                                                                  |
| `DataVerification/index.css`       | —      | **DONE** | Deleted.                                                                                  |
| `SearchReplace/index.css`          | —      | **DONE** | Deleted.                                                                                  |
| `ConditionFormat/index.css`        | —      | **DONE** | Deleted.                                                                                  |

### Action items

- [ ] Migrate `SheetTab/index.css` → Tailwind classes
- [ ] Migrate `SheetOverlay/index.css` → Tailwind classes (break into multiple PRs)
- [ ] Migrate `SheetOverlay/ScrollBar/index.css` → Tailwind
- [x] Migrate `LinkEditCard/index.css` → Tailwind + shadcn components — done
- [ ] Delete `css.d.ts` once all CSS imports are removed

---

## 2. Div Buttons → shadcn `Button`

Components using styled `<div>` elements as buttons instead of shadcn `Button`:

All `button-basic` div buttons have been migrated to shadcn `Button` across all components
(DataVerification, FormulaSearch, LocationCondition, SplitColumn, SearchReplace, FilterMenu,
CustomSort, RangeDialog, LinkEditCard). **DONE.**

---

## 3. `useDialog` Usage Audit

The `useDialog` hook (in `hooks/useDialog.tsx`) wraps `ModalContext` to show/hide dialogs using shadcn `Dialog`. The
`useAlert` hook builds on top of it for simple ok/yesno alerts.

| Component                            | Uses `useDialog` | Uses `useAlert` | Notes                                                             |
|--------------------------------------|------------------|-----------------|-------------------------------------------------------------------|
| `ConditionFormat/index.tsx`          | Yes              | No              | Shows `ConditionRules` dialog                                     |
| `ConditionFormat/ConditionRules.tsx` | Yes (hideDialog) | No              | Dialog content itself                                             |
| `ContextMenu/index.tsx`              | Yes              | Yes             | Shows `CustomSort` dialog, alerts for errors                      |
| `ContextMenu/FilterMenu.tsx`         | No               | Yes             | Sort error alerts                                                 |
| `CustomSort/index.tsx`               | Yes (hideDialog) | No              | Dialog content, closes on confirm                                 |
| `DataVerification/index.tsx`         | Yes              | No              | Shows RangeDialog                                                 |
| `DataVerification/RangeDialog.tsx`   | Yes              | No              | Navigates back to parent dialogs                                  |
| `FormatSearch/index.tsx`             | Yes              | No              | Decimal places validation alert                                   |
| `FormulaSearch/index.tsx`            | No               | No              | Shown via `showDialog()` from `MenuBar/insert-menu.tsx`           |
| `SplitColumn/index.tsx`              | No               | No              | Shown via `showDialog()` from `MenuBar/data-menu.tsx`             |
| `SearchReplace/index.tsx`            | No               | No              | Rendered inline, not a dialog                                     |
| `SheetOverlay/index.tsx`             | Yes              | Yes             | Main overlay, shows various dialogs                               |
| `MenuBar/edit-menu.tsx`              | Yes              | Yes             | Shows `FormulaSearch` (find/replace), alerts                      |
| `MenuBar/insert-menu.tsx`            | Yes              | No              | Shows `FormulaSearch` dialog (More functions…), `LinkEditCard`    |
| `MenuBar/format-menu.tsx`            | Yes              | No              | Shows `FormatSearch`, `ConditionRules`, `ManageRules` dialogs     |
| `MenuBar/data-menu.tsx`              | Yes              | No              | Shows `CustomSort`, `SplitColumn` dialogs                         |

### Observations

- `useDialog` / `useAlert` pattern is well-established and consistent
- `FormulaSearch` and `SplitColumn` are shown via `showDialog()` from the MenuBar but don't use
  `useDialog` themselves — this is fine since they receive `onCancel` prop
- No custom dialog implementations found — all go through `ModalContext`

---

## 4. Export Style Audit (`default` → named export)

Components using `export default` that should use named function exports for consistency:

| File                                 | Current                                                  | Proposed                                        |
|--------------------------------------|----------------------------------------------------------|-------------------------------------------------|
| `ConditionFormat/index.tsx`          | `const ConditionalFormat: React.FC` + `export default`   | `export function ConditionalFormat()`           |
| `ConditionFormat/ConditionRules.tsx` | Named + default                                          | Remove redundant default                        |
| `ContextMenu/index.tsx`              | `const ContextMenu: React.FC` + `export default`         | `export function ContextMenu()`                 |
| `ContextMenu/FilterMenu.tsx`         | `const FilterMenu: React.FC` + `export default`          | `export function FilterMenu()`                  |
| `CustomSort/index.tsx`               | `const CustomSort: React.FC` + `export default`          | `export function CustomSort()`                  |
| `DataVerification/DropdownList.tsx`  | `const DropDownList: React.FC` + `export default`        | `export function DropDownList()`                |
| `DataVerification/RangeDialog.tsx`   | `const RangeDialog: React.FC` + `export default`         | `export function RangeDialog()`                 |
| `FilterOption/index.tsx`             | `const FilterOptions: React.FC` + `export default`       | `export function FilterOptions()`               |
| `FxEditor/index.tsx`                 | `const FxEditor: React.FC` + `export default`            | `export function FxEditor()`                    |
| `FxEditor/NameBox.tsx`               | `const LocationBox: React.FC` + `export default`         | `export function NameBox()` (fix name mismatch) |
| `ImgBoxs/index.tsx`                  | `const ImgBoxs: React.FC` + `export default`             | `export function ImgBoxs()`                     |
| `NotationBoxes/index.tsx`            | `const NotationBoxes: React.FC` + `export default`       | `export function NotationBoxes()`               |
| `Sheet/index.tsx`                    | `const Sheet: React.FC` + `export default`               | `export function Sheet()`                       |
| `SheetList/index.tsx`                | `const SheetList: React.FC` + `export default`           | `export function SheetList()`                   |
| `SheetList/SheetListItem.tsx`        | `const SheetListItem: React.FC` + `export default`       | `export function SheetListItem()`               |
| `SheetList/SheetHiddenButton.tsx`    | `const SheetHiddenButton: React.FC` + `export default`   | `export function SheetHiddenButton()`           |
| `SheetTab/index.tsx`                 | `const SheetTab: React.FC` + `export default`            | `export function SheetTab()`                    |
| `SheetTab/SheetItem.tsx`             | `const SheetItem: React.FC` + `export default`           | `export function SheetItem()`                   |
| `SVGIcon.tsx`                        | `const SVGIcon: React.FC` + `export default`             | `export function SVGIcon()`                     |
| `SVGDefines.tsx`                     | `const SVGDefines: React.FC` + `export default`          | `export function SVGDefines()`                  |
| `hooks/usePrevious.tsx`              | `function usePrevious` + `export default`                | `export function usePrevious()`                 |

**Already using named exports:** `ChangeColor`, `ConditionRules`, `FormatSearch`, `FormulaSearch`,
`SplitColumn`, `LinkEditCard`, `useDialog`, `useAlert`, `useOutsideClick`.

---

## 5. Shared UI Component Adoption

Components from `packages/ui/` (documented in `docs/LAYOUT-SHARED-COMPONENTS.md`) that could replace inline
implementations:

| Fortune-Sheet Component                | Shared Replacement                                                               | Notes                                                                                                                                                                                                     |
|----------------------------------------|----------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `FilterMenu.tsx` filter buttons        | `@workspace/ui/components/button`                                                | **DONE** (commit `b5c3b7e7`)                                                                                                                                                                              |
| `LinkEditCard/index.tsx` + `index.css` | `@workspace/ui/components/dialog`, `input`, `button`, `select`                   | **DONE** — `<select>` (b5c3b7e7), then full CSS-to-Tailwind + 2 raw `<input>` → `Input`; `index.css` deleted                                                                                              |
| `CustomSort/index.tsx`                 | `@workspace/ui/components/checkbox`, `radio-group`, `select`, `button`, `dialog` | **DONE** (commit `b5c3b7e7`) — all native form controls migrated; buttons in `DialogFooter`                                                                                                                |
| `DataVerification/DropdownList.tsx`    | `@workspace/ui/components/dropdown-menu`                                         | **DONE** (commit `b5c3b7e7`) — controlled `DropdownMenu` with `CheckboxItem`/`Item`. Trigger via `asChild` on the existing chevron div. Required `luckysheet-mousedown-cancel` on `DropdownMenuContent` — see `FORTUNE-SHEET-OPEN-ISSUES.md` §1 |
| `FilterMenu.tsx` select/checkbox items | `@workspace/ui/components/checkbox` + `popover`                                  | **DONE** (commit `b5c3b7e7`) — `Checkbox` for value list, `Popover` (virtual `PopoverAnchor`) for the panel + nested `Popover` for filter-by-color                                                         |
| `FormulaSearch/index.tsx`              | `@workspace/ui/components/input`, `select`                                       | **DONE** — already shadcn-migrated in an earlier commit; broken-window `cn()` fix applied this sweep                                                                                                       |
| `SheetOverlay` bottom add-row          | `@workspace/ui/components/input`, `button`                                       | **DONE** — `fortune-add-row-button` divs/spans → `Button`; raw `<input>` → `Input`; dead `.fortune-add-row-button` / `#luckysheet-bottom-add-row*` / `#luckysheet-bottom-return-top` rules dropped from `index.css` |

### Already using shared UI

- `ConditionFormat/ConditionRules.tsx` — `Button`, `Input`, `Checkbox`, `Label`, `Popover`, `ColorPicker`,
  `Select`, `DialogHeader/Footer` (post `b5c3b7e7`)
- `ConditionFormat/index.tsx` — `DropdownMenu*`
- `ChangeColor/index.tsx` — `ColorPicker`
- `ContextMenu/FilterMenu.tsx` — `Button`, `Checkbox`, `Input`, `Popover` (post `b5c3b7e7`)
- `ContextMenu/index.tsx` — `Button` (color-picker triggers, post `b5c3b7e7`)
- `CustomSort/index.tsx` — `Button`, `Checkbox`, `Label`, `RadioGroup`, `Select`, `DialogFooter` (post `b5c3b7e7`)
- `DataVerification/index.tsx` — `Button`, `Checkbox`, `Input`, `Label`, `Select`, `DialogHeader/Footer` (post `b5c3b7e7`)
- `DataVerification/DropdownList.tsx` — `DropdownMenu` + `DropdownMenuCheckboxItem`/`DropdownMenuItem` (post `b5c3b7e7`)
- `FormatSearch/index.tsx` — `Button`, `Input`, `Label`, `cn`
- `LinkEditCard/index.tsx` — `Button`, `Select` (post `b5c3b7e7`; CSS still pending)
- `MenuBar/index.tsx` + menu files — `DropdownMenu*`, `Popover`, `ColorPicker`
- `SearchReplace/index.tsx` — `Button`, `Input`, `Checkbox`, `Label`, `Tabs`
- `SplitColumn/index.tsx` — `Button`, `Checkbox`, `Input`, `Label`, `DialogFooter` (post `b5c3b7e7`)
- `context/modal.tsx` — `Dialog`, `DialogContent`
- `hooks/useDialog.tsx` — `Button`, `DialogHeader/Title/Description/Footer`

---

## 6. Component-Level Notes

### `SVGIcon.tsx` / `SVGDefines.tsx`

- `SVGIcon` is a thin wrapper around `<svg><use xlinkHref>` — **keep**, it's used everywhere
- `SVGDefines.tsx` is 1254 lines of inline SVG symbol definitions — consider extracting to a separate SVG sprite file or
  using Lucide icons where possible
- Some SVG icons have hardcoded Chinese labels (`裁剪`, `恢复原图`, `删除`) in `ImgBoxs/index.tsx` — should be localized

### `ContextMenu/` (index, FilterMenu)

- ~~**CSS**: `index.css` (283 lines)~~ — deleted
- ~~**BTN**: FilterMenu has 4 `button-basic` divs~~ — done in `b5c3b7e7`
- ~~**Deferred:** `menuItemClass` Tailwind string duplicated~~ — done in `bdb71f94`; const extracted, 4 inline duplicates deduped
- `FilterMenu.tsx` — fixed-position panel, manual collision detection, and flyout submenu replaced with shadcn `Popover` + nested `Popover` in `b5c3b7e7`. Remaining: Chinese comments, `immer` `produce` patterns

### `CustomSort/index.tsx`

- **DONE** (commit `b5c3b7e7`) — `Select`, `Checkbox`, `RadioGroup`, `Button`, action buttons in `DialogFooter`
- `fortune-sort` class name has no CSS definition — dead class, can be removed in a follow-up

### `DataVerification/` (index, DropdownList, RangeDialog)

- `index.tsx` — **DONE** — selects + range-pick buttons + dialog footer fully shadcn (commit `b5c3b7e7`)
- `index.css` — **Delete** (no longer imported)
- `DropdownList.tsx` — **DONE** — controlled shadcn `DropdownMenu`. See `FORTUNE-SHEET-OPEN-ISSUES.md` §1 for the portaled-events lesson
- `RangeDialog.tsx` — **DONE** — uses `useDialog` + shadcn (commit `0b1f3de0`)

### `FilterOption/index.tsx`

- Uses `luckysheet-*` CSS class names from `SheetOverlay/index.css`
- No own CSS file — depends on parent styles
- Clean component, no major issues

### `FormatSearch/index.tsx`

- **DONE** — already uses shadcn `Button`, `Input`, `Label`, `cn`

### `FormulaSearch/index.tsx`

- **DONE** — buttons migrated to shadcn `Button`
- Still uses inline border/color styles (`border-[#d4d4d4]`, `bg-[#8c89fe]`) — replace with theme tokens

### `FxEditor/` (index, NameBox)

- Uses inline Tailwind but with hardcoded colors (`border-[#d4d4d4]`, `border-[#e5e5e5]`)
- `NameBox.tsx` exported as `LocationBox` but file is `NameBox.tsx` — fix naming inconsistency
- Uses `SVGIcon` for fx icon
- No CSS file — clean

### `ImgBoxs/index.tsx`

- Heavy use of `luckysheet-modal-dialog-*` CSS classes (from `SheetOverlay/index.css`)
- Chinese hardcoded strings: `裁剪`, `恢复原图`, `删除` — localize via `locale()`
- Font Awesome icons (`fa fa-pencil`, `fa fa-trash`, etc.) — replace with Lucide or SVGIcon

### `LinkEditCard/` (index)

- **DONE** — `<select>` → shadcn `Select` (`b5c3b7e7`); `index.css` deleted, all 182 lines migrated to Tailwind utilities + theme tokens inline; 2 raw `<input>` → shadcn `Input`. Only `fortune-link-modify-modal` + `range-selection-modal` classes preserved (DOM-targeted from `state/modules/hyperlink.ts`). Directory renamed from `LinkEidtCard` to `LinkEditCard`.
- Complex component with 3 modes (toolbar, range-selection, editing)
- Uses Lucide icons (`Copy`, `Pencil`, `Unlink`)

### `NotationBoxes/index.tsx`

- Inline styles for comment box positioning — required for dynamic positioning
- Uses `ContentEditable` from SheetOverlay — good reuse
- No CSS file — clean

### `SearchReplace/index.tsx`

- **DONE** — fully migrated to shadcn `Tabs`, `Button`, `Input`, `Checkbox`, `Label`

### `Sheet/index.tsx`

- Core canvas rendering component — no UI migration needed
- Uses Tailwind flex utilities — clean
- No CSS file

### `SheetList/` (index, SheetListItem, SheetHiddenButton)

- Uses Tailwind with hardcoded colors (`hover:bg-[#efefef]`, `hover:bg-[#d0d0d0]`)
- Replace with theme tokens (`hover:bg-accent`, `hover:bg-muted`)
- Still uses `fortune-context-menu luckysheet-cols-menu` from ContextMenu CSS
- `SheetHiddenButton` uses `SVGIcon`

### `SheetOverlay/` (index, ColumnHeader, RowHeader, InputBox, ContentEditable, ScrollBar, FormulaHint, FormulaSearch)

- **CSS**: `index.css` (957 lines) — the largest CSS file, shared by many components
- Core spreadsheet interaction layer — migration must be careful
- `ContentEditable.tsx` — custom contenteditable div, **keep**
- `FormulaSearch/` and `FormulaHint/` — formula autocomplete UI, uses inline styles
- `ScrollBar/` — custom scrollbar with its own CSS

### `SheetTab/` (index, SheetItem)

- **CSS**: `index.css` (281 lines) — tab area, active states, scroll buttons
- Uses `luckysheet-*` class names extensively
- `SheetItem.tsx` has drag-and-drop support, context menu, inline editing
- Chinese comments — translate

### `SplitColumn/index.tsx`

- **DONE** (commit `b5c3b7e7`) — `Checkbox`, `Input`, `Button`, action buttons in `DialogFooter`
- `getRegStr` in `state/modules/splitColumn.ts` no longer walks `.childNodes[0].checked` — takes `(selected: ReadonlySet<string>, otherValue: string)` from React state (Radix `Checkbox` renders as `<button>`, not `<input>`)

### `LocationCondition/index.tsx`

- **DONE** (commit `b5c3b7e7`) — `Checkbox`, `RadioGroup`, `Label`, `Button`, action buttons in `DialogFooter`. 5 separate radios collapsed into a single `RadioGroup` (they had unique `name` attrs before so didn't actually form a group). Inline `style={{ color: '#666' }}` replaced with `peer-disabled:opacity-50`

### `MenuBar/` (index, edit-menu, view-menu, insert-menu, format-menu, data-menu, CustomBorder)

- Replaced the old `Toolbar/` (deleted 2026-04-26). Five `DropdownMenu`s for Edit / View / Insert / Format / Data.
- Uses `DropdownMenu*` from shadcn — same primitives as `ConditionFormat/index.tsx`
- `CustomBorder.tsx` — border style picker, moved from `Toolbar/CustomBorder.tsx`; uses shadcn `Popover`
- `luckysheet-mousedown-cancel` must be on any `DropdownMenuSubContent` inside `cellArea` — same rule as
  `DataVerification/DropdownList.tsx` (see `FORTUNE-SHEET-OPEN-ISSUES.md` §1)

### `Workbook/` (index, api, CSS)

- `index.tsx` — main workbook component, handles context/state
- `api.ts` — workbook API bridge functions
- `index.css` — 56 lines of container layout — easy migration
- Core component — minimal UI changes needed

---

## 7. Hooks Audit

| Hook              | File                       | Used By        | Notes                                                      |
|-------------------|----------------------------|----------------|------------------------------------------------------------|
| `useDialog`       | `hooks/useDialog.tsx`      | 10+ components | Well-designed, wraps `ModalContext`. **Keep.**             |
| `useAlert`        | `hooks/useAlert.tsx`       | 4 components   | Thin wrapper on `useDialog` for ok/yesno alerts. **Keep.** |
| `useOutsideClick` | `hooks/useOutsideClick.ts` | 5 components   | Standard pattern. **Keep.**                                |
| `usePrevious`     | `hooks/usePrevious.tsx`    | 2 components   | Standard ref-based hook. Change to named export.           |

---

## 8. Context Audit

| File                | Notes                                                                                 |
|---------------------|---------------------------------------------------------------------------------------|
| `context/index.ts`  | `WorkbookContext` — core React context for fortune-sheet state. **Keep.**             |
| `context/modal.tsx` | `ModalContext` + `ModalProvider` — dialog management. Uses shadcn `Dialog`. **Keep.** |

---

## 9. Priority Order

### Done

- ~~Delete dead CSS files~~ — 6 of 9 CSS files deleted (ContextMenu, Workbook, DataVerification, SearchReplace, ConditionFormat, LinkEditCard)
- ~~Replace `button-basic` divs with shadcn `Button`~~ — all migrated
- ~~Fix `NameBox.tsx` export name~~ — done
- ~~Replace hardcoded colors in components~~ — done in .tsx files (still present in remaining .css)
- ~~Replace native `<input>`/`<select>`/`<checkbox>` with shadcn equivalents in CustomSort, FilterMenu~~ — done
- ~~`FormulaSearch`, `ZoomControl`, `SheetOverlay` bottom-add-row shadcn migrations~~ — done
- ~~Rename `LinkEidtCard/` → `LinkEditCard/`~~ — done (`dd46088a` + `3b5642a2`)
- ~~9 `<div role="button">` pseudo-buttons → real `<button type="button">`~~ — done (`91e28493`)
- ~~Dedupe `ConditionFormat.ts` vs `conditionalFormat.ts`~~ — merged into `conditionFormat.ts` (camelCase). `cfSplitRange` properly typed with `SingleRange`, dead code removed, boundary types tightened (`DataBar` discriminated union, `CellFormatStyle`, `ComputeMap`)
- ~~`@workspace/fortune-sheet/engine` subpath export~~ — done in commit `1b2b36a0`. `apps/api/tsconfig.json` `paths` kludge removed; consumers import from `@workspace/fortune-sheet/engine` directly.
- ~~`colorGradation` `format.cellColor`-on-array bug~~ — fixed in commit `1b2b36a0`. The if-arm now mirrors the else-arm's positional access; both arms compute the gradient color once via a shared helper. Regression tests in `engine/test/conditional-format.test.ts` and `apps/api/src/test/sheets-html-export.test.ts`.
- ~~`getCellTextInfo` redundant `ctx?` parameter~~ — fixed in commit `1b2b36a0`. Parameter dropped; `getFontSet` now requires `Context`. All 5 call sites use `sheetCtx` consistently — locale fonts no longer silently disabled at the 3 sites that previously omitted the 5th argument.
- ~~Translate Chinese comments to English~~ — done in commits `1b2b36a0` + `2608d5f5`. Remaining CJK is in test fixtures and measurement glyphs (`"田"`); user-facing strings flagged for separate `locale()` migration.
- ~~Mechanical broken-windows sweep~~ — done in commit `2608d5f5`. Dropped 22 commented `console.log` debug lines, 11-line dead fill-type comment, jQuery legacy comments, stale ReferenceError comments, unnecessary `try/catch` around internal calls. `substr` → `slice`, `indexOf > -1` → `includes` modernizations.

### Next — Medium effort

1. Convert remaining `export default` → named exports (~4 components)
2. Translate Chinese comments to English

### Later — Major effort

6. Migrate `SheetTab/index.css` to Tailwind (280 lines)
7. Migrate `SheetOverlay/index.css` to Tailwind (882 lines) — split into sub-tasks
8. Migrate `SheetOverlay/ScrollBar/index.css` to Tailwind (40 lines)
9. Localize hardcoded Chinese strings in `ImgBoxs`
10. Evaluate replacing Font Awesome icons with Lucide
11. Remove `css.d.ts` once all CSS imports eliminated

---

## 10. State Directory (biome excluded)

The `state/` directory (renamed from `core/` during the engine extraction) is currently excluded from
biome linting. It holds the context-coupled runtime — canvas renderer, event handlers, modules, public
API bridge. Outstanding work:

- ~~**Lodash removal**~~: Done. Migrated to `es-toolkit/compat` with named imports and conservative
  native replacements (`Array.isArray`, `Object.keys/entries`, `.map/.filter`, etc.) where target
  types were unambiguous. Null-sensitive calls like `trim(textContent)` stay on es-toolkit to
  preserve lodash's null-safety.
- **`any` annotations**: ~210 across `state/` (30 in `rowcol.ts` alone). Tightening enables strictness.
- **`@ts-ignore` debt**: ~80 directives across `state/` + `components/` — each hides a typing gap.
- ~~**`ConditionFormat.ts` (1,768 lines) vs `conditionalFormat.ts` (578 lines)**~~: done.
  `conditionalFormat.ts` deleted (its only function `cfSplitRange` was a duplicate of
  `CFSplitRange` with proper `SingleRange` typing). `ConditionFormat.ts` renamed to
  `conditionFormat.ts` (camelCase to match neighbors), `CFSplitRange` renamed to
  `cfSplitRange` and properly typed. Dead code removed (`getHistoryRules`,
  `getCurrentRules`, four commented blocks). Cache/lookup boundary types tightened
  (`DataBar` discriminated union, `CellFormatStyle`, `ComputeMap`). All importers
  updated (cell, dropCell, filter, moveCells, selection, toolbar, paste).
- **Enable biome on `state/`**: now unblocked; ~210 `any` annotations will surface as the main
  fix-up work.
- **Enable biome on `components/`**: **done** — covered by biome lint/format. The
  `useExhaustiveDependencies` rule is on (no per-file override) and all 36 hook sites
  surfaced by the original audit are either fixed (real missing deps added; helpers hoisted
  to module scope; one-off callbacks wrapped in `useCallback`) or carry a permanent
  `biome-ignore` with a per-site reason. See `docs/FORTUNE-SHEET-EFFECT-DEPS-AUDIT.md`.

The old monolithic `mouse.ts` (5k+ lines) and `formula.ts` (3.5k lines) have already been split —
`state/events/mouse.ts` is now a 5-line re-export barrel, and `formula.ts` is gone (replaced by
`formula-cache`, `formula-editor`, `formula-exec`, `formula-range`, `formula-ui`, `formulaHelper`).

## 11. DOM Selector Coupling

The `state/` code has ~365 references to `luckysheet-*` class names and IDs, many used as DOM selectors
(`getElementById`, `querySelector`, `getElementsByClassName`). Before removing any class name during CSS
migration, grep `state/` for the class — removing a selector-referenced class silently breaks behavior.

Key IDs/classes that MUST be preserved on component elements:

- `fortune-cell-selected-move` (`moveCells.ts`)
- `luckysheet-modal-dialog-activeImage` (`image.ts`)
- `luckysheet-formula-text-lpar` (`formula-exec.ts`)
- `fortune-search-replace` (`searchReplace.ts`)
- `fortune-freeze-drag-line` (`mouse-*.ts`)
- Many `luckysheet-cell-*` selection classes (165 references in `mouse-cell.ts`)

## 12. Dialog System — intentional bypasses

These components use absolute-positioned divs instead of `useDialog`. This is intentional — they need
drag/resize behavior or cell-anchored positioning the dialog system doesn't support:

- `ImgBoxs` — image drag/resize with 8-point handles
- `NotationBoxes` — comment boxes anchored to cells, draggable/resizable
- `LinkEditCard` — cell-relative positioning
- `DataVerification/DropdownList` — cell-attached dropdown

## 13. Keyboard Handlers

All keyboard shortcuts are manual implementations in `state/events/keyboard.ts` (~950 lines). Most are
too complex/stateful for `@tanstack/react-hotkeys` (arrow navigation with hidden row/col awareness,
formula editing, etc.). Only Ctrl+Z/Y (undo/redo) might be extractable.

## 14. Package Location

This package is only used by `apps/sheets/`. Could be moved to `apps/sheets/src/fortune-sheet/` to make
the dependency explicit. Low priority — a rename-only change with no code impact.
