# Fortune-Sheet Audit & Refactor TODO

> **TLDR**: Consolidated cleanup list for `packages/fortune-sheet/`. Goal: make the package "ours" —
> biome-clean end to end, lodash-free, CSS fully migrated to Tailwind, shadcn adopted, typing tightened.
> See priority phases at bottom.

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
| `LinkEidtCard/index.css`           | 182    | TODO     | Link edit modal. Replace with shadcn `Dialog`/`Input`/`Button`.                           |
| `ContextMenu/index.css`            | —      | **DONE** | Deleted.                                                                                  |
| `Workbook/index.css`               | —      | **DONE** | Deleted.                                                                                  |
| `DataVerification/index.css`       | —      | **DONE** | Deleted.                                                                                  |
| `SearchReplace/index.css`          | —      | **DONE** | Deleted.                                                                                  |
| `ConditionFormat/index.css`        | —      | **DONE** | Deleted.                                                                                  |

### Action items

- [ ] Migrate `SheetTab/index.css` → Tailwind classes
- [ ] Migrate `SheetOverlay/index.css` → Tailwind classes (break into multiple PRs)
- [ ] Migrate `SheetOverlay/ScrollBar/index.css` → Tailwind
- [ ] Migrate `LinkEidtCard/index.css` → Tailwind + shadcn components
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

| Component                            | Uses `useDialog` | Uses `useAlert` | Notes                                                    |
|--------------------------------------|------------------|-----------------|----------------------------------------------------------|
| `ConditionFormat/index.tsx`          | Yes              | No              | Shows `ConditionRules` dialog                            |
| `ConditionFormat/ConditionRules.tsx` | Yes (hideDialog) | No              | Dialog content itself                                    |
| `ContextMenu/index.tsx`              | Yes              | Yes             | Shows `CustomSort` dialog, alerts for errors             |
| `ContextMenu/SheetTab.tsx`           | No               | Yes             | Delete/hide sheet alerts                                 |
| `ContextMenu/FilterMenu.tsx`         | No               | Yes             | Sort error alerts                                        |
| `CustomSort/index.tsx`               | Yes (hideDialog) | No              | Dialog content, closes on confirm                        |
| `DataVerification/index.tsx`         | Yes              | No              | Shows RangeDialog                                        |
| `DataVerification/RangeDialog.tsx`   | Yes              | No              | Navigates back to parent dialogs                         |
| `FormatSearch/index.tsx`             | Yes              | No              | Decimal places validation alert                          |
| `FormulaSearch/index.tsx`            | No               | No              | **Could use `useDialog`** — currently standalone         |
| `LocationCondition/index.tsx`        | No               | No              | **Could use `useDialog`** — currently standalone         |
| `SplitColumn/index.tsx`              | No               | No              | **Could use `useDialog`** — currently standalone         |
| `SearchReplace/index.tsx`            | No               | No              | Rendered inline, not a dialog                            |
| `SheetOverlay/index.tsx`             | Yes              | Yes             | Main overlay, shows various dialogs                      |
| `Toolbar/index.tsx`                  | Yes              | No              | Shows formula/format/location/split/verification dialogs |

### Observations

- `useDialog` / `useAlert` pattern is well-established and consistent
- `FormulaSearch`, `LocationCondition`, `SplitColumn` are shown via `showDialog()` from the Toolbar but don't use
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
| `ContextMenu/SheetTab.tsx`           | `const SheetTabContextMenu: React.FC` + `export default` | `export function SheetTabContextMenu()`         |
| `ContextMenu/Menu.tsx`               | `const Menu: React.FC` + `export default`                | `export function Menu()`                        |
| `ContextMenu/Divider.tsx`            | `const Divider: React.FC` + `export default`             | `export function Divider()`                     |
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
| `ZoomControl/index.tsx`              | `const ZoomControl: React.FC` + `export default`         | `export function ZoomControl()`                 |
| `SVGIcon.tsx`                        | `const SVGIcon: React.FC` + `export default`             | `export function SVGIcon()`                     |
| `SVGDefines.tsx`                     | `const SVGDefines: React.FC` + `export default`          | `export function SVGDefines()`                  |
| `hooks/usePrevious.tsx`              | `function usePrevious` + `export default`                | `export function usePrevious()`                 |

**Already using named exports:** `ChangeColor`, `ConditionRules`, `FormatSearch`, `FormulaSearch`, `LocationCondition`,
`SplitColumn`, `LinkEditCard`, `Toolbar`, `useDialog`, `useAlert`, `useOutsideClick`.

---

## 5. Shared UI Component Adoption

Components from `packages/ui/` (documented in `docs/LAYOUT-SHARED-COMPONENTS.md`) that could replace inline
implementations:

| Fortune-Sheet Component                | Shared Replacement                                                               | Notes                                                                                                                                                                                                     |
|----------------------------------------|----------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ContextMenu/Menu.tsx` + `Divider.tsx` | `@workspace/ui/components/context-menu`                                          | Custom context menu could use shadcn `ContextMenu` or `DropdownMenu` sub-components. **Complex** — the fortune-sheet context menu has custom positioning logic and inline inputs, so this is non-trivial. |
| `FilterMenu.tsx` filter buttons        | `@workspace/ui/components/button`                                                | Replace `button-basic` divs                                                                                                                                                                               |
| `LinkEidtCard/index.tsx`               | `@workspace/ui/components/dialog`, `input`, `button`, `select`                   | Full rewrite with shadcn components would eliminate `LinkEidtCard/index.css` entirely                                                                                                                     |
| `CustomSort/index.tsx`                 | `@workspace/ui/components/checkbox`, `radio-group`, `select`, `button`, `dialog` | Replace native `<input type="checkbox/radio">` and `<select>` with shadcn equivalents                                                                                                                     |
| `DataVerification/DropdownList.tsx`    | `@workspace/ui/components/popover` or `command`                                  | Custom dropdown could use shadcn `Popover`                                                                                                                                                                |
| `FilterMenu.tsx` select/checkbox items | `@workspace/ui/components/checkbox`                                              | Replace native `<input type="checkbox">` with shadcn `Checkbox`                                                                                                                                           |
| `FormulaSearch/index.tsx`              | `@workspace/ui/components/input`, `select`                                       | Replace inline-styled `<input>` and `<select>`                                                                                                                                                            |
| `ZoomControl/index.tsx`                | Consider `@workspace/ui/components/popover`                                      | Zoom preset menu could use shadcn `Popover` instead of custom absolute-positioned div                                                                                                                     |
| `SheetOverlay` bottom add-row          | `@workspace/ui/components/input`, `button`                                       | If present, replace with shadcn                                                                                                                                                                           |

### Already using shared UI

- `ConditionFormat/ConditionRules.tsx` — `Button`, `Input`, `Checkbox`, `Label`, `Popover`, `ColorPicker`,
  `DialogHeader/Footer`
- `ConditionFormat/index.tsx` — `DropdownMenu*`
- `ChangeColor/index.tsx` — `ColorPicker`
- `FormatSearch/index.tsx` — `Button`, `Input`, `Label`, `cn`
- `DataVerification/index.tsx` — `Button`
- `SearchReplace/index.tsx` — `Button`, `Input`, `Checkbox`, `Label`, `Tabs`
- `Toolbar/index.tsx` — `SharedToolbar`, `TooltipButton`, `DropdownMenu*`
- `context/modal.tsx` — `Dialog`, `DialogContent`
- `hooks/useDialog.tsx` — `Button`, `DialogHeader/Title/Description/Footer`

---

## 6. Component-Level Notes

### `SVGIcon.tsx` / `SVGDefines.tsx`

- `SVGIcon` is a thin wrapper around `<svg><use xlinkHref>` — **keep**, it's used everywhere
- `SVGDefines.tsx` is 1254 lines of inline SVG symbol definitions — consider extracting to a separate SVG sprite file or
  using Lucide icons where possible
- Some SVG icons have hardcoded Chinese labels (`裁剪`, `恢复原图`, `删除`) in `ImgBoxs/index.tsx` — should be localized

### `ContextMenu/` (index, Menu, Divider, FilterMenu, SheetTab)

- **CSS**: `index.css` (283 lines) imported by both `index.tsx` and `SheetTab.tsx`
- **BTN**: FilterMenu has 4 `button-basic` divs
- `Menu.tsx` still has `luckysheet-*` CSS class names mixed with Tailwind — clean up
- `FilterMenu.tsx` is 801 lines — largest component, has Chinese comments, uses `immer` `produce` for local state
- `SheetTab.tsx` uses `SVGIcon` for right arrow — could use Lucide `ChevronRight`
- `Divider.tsx` is a simple `<div>` — already uses Tailwind, **keep as-is**

### `CustomSort/index.tsx`

- Uses native `<input type="checkbox/radio">` and `<select>` — replace with shadcn
- Uses `button-basic button-primary` div — replace with `Button`
- Has `fortune-sort` class name but no CSS definition found — likely dead class
- Chinese comments present — translate to English

### `DataVerification/` (index, DropdownList, RangeDialog)

- `index.tsx` — **DONE** (buttons migrated to shadcn)
- `index.css` — **Delete** (no longer imported)
- `DropdownList.tsx` — still imports `index.css`, uses custom dropdown styling, uses `SVGIcon`
- `RangeDialog.tsx` — imports `index.css`, uses `button-basic` divs, has `#range-dialog` ID styling

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

### `LinkEidtCard/` (index, CSS)

- **CSS**: 183 lines — full migration needed
- **BTN**: 2 `button-basic` divs in `renderBottomButton`
- Typo in directory name: `LinkEidtCard` should be `LinkEditCard`
- Complex component with 3 modes (toolbar, range-selection, editing)
- Uses `SVGIcon` for icons — some could be Lucide

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
- Imports `ZoomControl` component
- Chinese comments — translate

### `SplitColumn/index.tsx`

- **DONE** — buttons migrated to shadcn `Button`

### `LocationCondition/index.tsx`

- **DONE** — buttons migrated to shadcn `Button`

### `Toolbar/` (index, CustomBorder, toolbar-helpers)

- Already uses shared `Toolbar` and `TooltipButton` from `@workspace/ui`
- Uses `DropdownMenu*` from shadcn
- `toolbar-helpers.tsx` — helper components for toolbar items
- `CustomBorder.tsx` — border style picker, uses shadcn `Popover`
- Well-migrated, minimal cleanup needed

### `Workbook/` (index, api, CSS)

- `index.tsx` — main workbook component, handles context/state
- `api.ts` — workbook API bridge functions
- `index.css` — 56 lines of container layout — easy migration
- Core component — minimal UI changes needed

### `ZoomControl/index.tsx`

- Uses Tailwind with theme tokens (`hover:bg-muted`, `bg-popover`) — **good**
- Custom dropdown menu — could use shadcn `Popover` for the preset menu
- Uses `SVGIcon` for plus/minus — could use Lucide icons

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

- ~~Delete dead CSS files~~ — 5 of 9 CSS files deleted (ContextMenu, Workbook, DataVerification, SearchReplace, ConditionFormat)
- ~~Replace `button-basic` divs with shadcn `Button`~~ — all migrated
- ~~Fix `NameBox.tsx` export name~~ — done
- ~~Replace hardcoded colors in components~~ — done in .tsx files (still present in remaining .css)

### Next — Medium effort

1. Fix `LinkEidtCard` directory typo → `LinkEditCard`
2. Migrate `LinkEidtCard/index.css` to Tailwind + shadcn (182 lines)
3. Replace native `<input>`, `<select>`, `<checkbox>` with shadcn equivalents in CustomSort, FilterMenu
4. Convert remaining `export default` → named exports (~4 components)
5. Translate Chinese comments to English

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

- **Lodash removal**: 53 files still `import _ from 'lodash'`. Most calls are mechanical swaps
  (`_.isNil` → `x == null`, `_.cloneDeep` → `structuredClone`, `_.forEach` → `for...of`). Blocks
  turning on biome for `state/` without drowning in `noImportNamespace` warnings.
- **`any` annotations**: ~210 across `state/` (30 in `rowcol.ts` alone). Tightening enables strictness.
- **`@ts-ignore` debt**: ~80 directives across `state/` + `components/` — each hides a typing gap.
- **`ConditionFormat.ts` (1,768 lines) vs `conditionalFormat.ts` (578 lines)**: both live in
  `state/modules/` with unclear separation. Audit then merge or rename.
- **Enable biome on `state/`**: blocked by lodash + `any`; do after those.
- **Enable biome on `components/`**: smaller lift, independent of `state/`. Start here.

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
