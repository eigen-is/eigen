# Fortune-Sheet Audit & Refactor TODO

Full audit of `packages/fortune-sheet/src/` — identifying cleanup, shadcn/Tailwind migration, shared component adoption, and structural improvements.

TLDR: use shadcn/shared components everywhere and make typescript more modern by ditching _.foreach etc and export
functions. So if you encounter things like that: fix it.;

## Known Bugs - FIX FIRST!!1!

- Find (and replace) dialog don't get focus (and is probably not using shadcn/useDialog) so when you click on a button
  in the dialog you select a cell below it.
- When you have columns with conditional formatting, pressing ctrl+c to copy (a larege amount of) cells freezes the browser. Without condtional formatted cells it works fine.
- It looks like having one big sheet (with conditional formatting?) also slows down work on other sheets in the same workbook. Can we handle data of the sheets somehow more seperatable?
- Adding extra columns is extremely more slow than adding extra rows. Find out why and try to fix.
- Modernize copy-paste code, should use shared copy-paste logic for this

## Legend

- **CSS** = has legacy `.css` file to migrate to Tailwind
- **BTN** = uses `div` buttons instead of shadcn `Button`
- **DLG** = uses or should use `useDialog` hook
- **WRAP** = thin wrapper, candidate for removal or simplification
- **EXP** = should be exported as named function (not `default`)
- **DONE** = already migrated in previous session

---

## 1. CSS Files to Migrate

All remaining `.css` files should be converted to Tailwind utilities and then deleted. The `css.d.ts` module declaration can be removed once no `.css` imports remain.

| File | Lines | Priority | Notes |
|------|-------|----------|-------|
| `ContextMenu/index.css` | 283 | **High** | Largest CSS file. Styles for context menu, filter menu, filter-by-color submenu, buttons. Many hardcoded colors (`#fff`, `#ccc`, `#0188fb`). Replace with Tailwind + shadcn theme tokens. |
| `SheetTab/index.css` | 281 | **High** | Sheet tab area, active/hover states, scroll buttons, boundaries. Hardcoded colors. |
| `SheetOverlay/index.css` | 957 | **High** | Massive file. Cell selection, drag, resize handles, frozen panes, cell editor, formula bar, data verification, bottom add-row. Most complex migration. |
| `SheetOverlay/ScrollBar/index.css` | ~small | Medium | Custom scrollbar styling. |
| `LinkEidtCard/index.css` | 183 | Medium | Link edit modal, buttons, inputs. Replace with shadcn `Dialog`/`Input`/`Button`. |
| `Workbook/index.css` | 56 | Low | Container layout, popover backdrop, stat area. Mostly layout — easy Tailwind migration. |
| `DataVerification/index.css` | 193 | **DONE** | CSS import removed, Tailwind applied. **Delete this file.** |
| `SearchReplace/index.css` | 162 | **DONE** | CSS import removed, shadcn used. **Delete this file if not already.** |

### Action items
- [ ] Migrate `ContextMenu/index.css` → Tailwind classes on components
- [ ] Migrate `SheetTab/index.css` → Tailwind classes
- [ ] Migrate `SheetOverlay/index.css` → Tailwind classes (break into multiple PRs)
- [ ] Migrate `LinkEidtCard/index.css` → Tailwind + shadcn components
- [ ] Migrate `Workbook/index.css` → Tailwind classes
- [ ] Migrate `SheetOverlay/ScrollBar/index.css` → Tailwind
- [ ] Delete `DataVerification/index.css` (no longer imported)
- [ ] Delete `SearchReplace/index.css` (no longer imported)
- [ ] Delete `css.d.ts` once all CSS imports are removed

---

## 2. Div Buttons → shadcn `Button`

Components using styled `<div>` elements as buttons instead of shadcn `Button`:

| Component | Location | Count | Status |
|-----------|----------|-------|--------|
| `DataVerification/index.tsx` | Bottom actions | 3 | **DONE** |
| `FormulaSearch/index.tsx` | Confirm/Cancel | 2 | **DONE** |
| `LocationCondition/index.tsx` | Confirm/Cancel | 2 | **DONE** |
| `SplitColumn/index.tsx` | Confirm/Cancel | 2 | **DONE** |
| `SearchReplace/index.tsx` | All buttons | ~4 | **DONE** |
| `ContextMenu/FilterMenu.tsx` | Confirm/Cancel/Clear (L664-719) | 3 | **TODO** — `button-basic button-primary/default/danger` divs |
| `ContextMenu/FilterMenu.tsx` | By-color submenu confirm (L756) | 1 | **TODO** |
| `CustomSort/index.tsx` | Confirm button (L155-168) | 1 | **TODO** — `button-basic button-primary` div |
| `DataVerification/RangeDialog.tsx` | Confirm/Close (L83-104) | 2 | **TODO** — `button-basic button-primary/close` divs |
| `LinkEidtCard/index.tsx` | renderBottomButton (L88-107) | 2 | **TODO** — `button-basic button-default/primary` divs |
| `LinkEidtCard/index.tsx` | renderToolbarButton (L110-116) | N/A | Icon buttons — consider `TooltipButton` from shared UI |

### Action items
- [ ] `FilterMenu.tsx`: Replace 4 `button-basic` divs with `<Button>` (primary, outline, destructive variants)
- [ ] `CustomSort/index.tsx`: Replace `button-basic button-primary` div with `<Button>`
- [ ] `RangeDialog.tsx`: Replace 2 `button-basic` divs with `<Button>`
- [ ] `LinkEidtCard/index.tsx`: Replace `renderBottomButton` divs with `<Button>`, toolbar buttons with `TooltipButton`

---

## 3. `useDialog` Usage Audit

The `useDialog` hook (in `hooks/useDialog.tsx`) wraps `ModalContext` to show/hide dialogs using shadcn `Dialog`. The `useAlert` hook builds on top of it for simple ok/yesno alerts.

| Component | Uses `useDialog` | Uses `useAlert` | Notes |
|-----------|-----------------|-----------------|-------|
| `ConditionFormat/index.tsx` | Yes | No | Shows `ConditionRules` dialog |
| `ConditionFormat/ConditionRules.tsx` | Yes (hideDialog) | No | Dialog content itself |
| `ContextMenu/index.tsx` | Yes | Yes | Shows `CustomSort` dialog, alerts for errors |
| `ContextMenu/SheetTab.tsx` | No | Yes | Delete/hide sheet alerts |
| `ContextMenu/FilterMenu.tsx` | No | Yes | Sort error alerts |
| `CustomSort/index.tsx` | Yes (hideDialog) | No | Dialog content, closes on confirm |
| `DataVerification/index.tsx` | Yes | No | Shows RangeDialog |
| `DataVerification/RangeDialog.tsx` | Yes | No | Navigates back to parent dialogs |
| `FormatSearch/index.tsx` | Yes | No | Decimal places validation alert |
| `FormulaSearch/index.tsx` | No | No | **Could use `useDialog`** — currently standalone |
| `LocationCondition/index.tsx` | No | No | **Could use `useDialog`** — currently standalone |
| `SplitColumn/index.tsx` | No | No | **Could use `useDialog`** — currently standalone |
| `SearchReplace/index.tsx` | No | No | Rendered inline, not a dialog |
| `SheetOverlay/index.tsx` | Yes | Yes | Main overlay, shows various dialogs |
| `Toolbar/index.tsx` | Yes | No | Shows formula/format/location/split/verification dialogs |

### Observations
- `useDialog` / `useAlert` pattern is well-established and consistent
- `FormulaSearch`, `LocationCondition`, `SplitColumn` are shown via `showDialog()` from the Toolbar but don't use `useDialog` themselves — this is fine since they receive `onCancel` prop
- No custom dialog implementations found — all go through `ModalContext`

---

## 4. Export Style Audit (`default` → named export)

Components using `export default` that should use named function exports for consistency:

| File | Current | Proposed |
|------|---------|----------|
| `ConditionFormat/index.tsx` | `const ConditionalFormat: React.FC` + `export default` | `export function ConditionalFormat()` |
| `ConditionFormat/ConditionRules.tsx` | Named + default | Remove redundant default |
| `ContextMenu/index.tsx` | `const ContextMenu: React.FC` + `export default` | `export function ContextMenu()` |
| `ContextMenu/FilterMenu.tsx` | `const FilterMenu: React.FC` + `export default` | `export function FilterMenu()` |
| `ContextMenu/SheetTab.tsx` | `const SheetTabContextMenu: React.FC` + `export default` | `export function SheetTabContextMenu()` |
| `ContextMenu/Menu.tsx` | `const Menu: React.FC` + `export default` | `export function Menu()` |
| `ContextMenu/Divider.tsx` | `const Divider: React.FC` + `export default` | `export function Divider()` |
| `CustomSort/index.tsx` | `const CustomSort: React.FC` + `export default` | `export function CustomSort()` |
| `DataVerification/DropdownList.tsx` | `const DropDownList: React.FC` + `export default` | `export function DropDownList()` |
| `DataVerification/RangeDialog.tsx` | `const RangeDialog: React.FC` + `export default` | `export function RangeDialog()` |
| `FilterOption/index.tsx` | `const FilterOptions: React.FC` + `export default` | `export function FilterOptions()` |
| `FxEditor/index.tsx` | `const FxEditor: React.FC` + `export default` | `export function FxEditor()` |
| `FxEditor/NameBox.tsx` | `const LocationBox: React.FC` + `export default` | `export function NameBox()` (fix name mismatch) |
| `ImgBoxs/index.tsx` | `const ImgBoxs: React.FC` + `export default` | `export function ImgBoxs()` |
| `NotationBoxes/index.tsx` | `const NotationBoxes: React.FC` + `export default` | `export function NotationBoxes()` |
| `Sheet/index.tsx` | `const Sheet: React.FC` + `export default` | `export function Sheet()` |
| `SheetList/index.tsx` | `const SheetList: React.FC` + `export default` | `export function SheetList()` |
| `SheetList/SheetListItem.tsx` | `const SheetListItem: React.FC` + `export default` | `export function SheetListItem()` |
| `SheetList/SheetHiddenButton.tsx` | `const SheetHiddenButton: React.FC` + `export default` | `export function SheetHiddenButton()` |
| `SheetTab/index.tsx` | `const SheetTab: React.FC` + `export default` | `export function SheetTab()` |
| `SheetTab/SheetItem.tsx` | `const SheetItem: React.FC` + `export default` | `export function SheetItem()` |
| `ZoomControl/index.tsx` | `const ZoomControl: React.FC` + `export default` | `export function ZoomControl()` |
| `SVGIcon.tsx` | `const SVGIcon: React.FC` + `export default` | `export function SVGIcon()` |
| `SVGDefines.tsx` | `const SVGDefines: React.FC` + `export default` | `export function SVGDefines()` |
| `hooks/usePrevious.tsx` | `function usePrevious` + `export default` | `export function usePrevious()` |

**Already using named exports:** `ChangeColor`, `ConditionRules`, `FormatSearch`, `FormulaSearch`, `LocationCondition`, `SplitColumn`, `LinkEditCard`, `Toolbar`, `useDialog`, `useAlert`, `useOutsideClick`.

---

## 5. Shared UI Component Adoption

Components from `packages/ui/` (documented in `docs/LAYOUT-SHARED-COMPONENTS.md`) that could replace inline implementations:

| Fortune-Sheet Component | Shared Replacement | Notes |
|------------------------|-------------------|-------|
| `ContextMenu/Menu.tsx` + `Divider.tsx` | `@workspace/ui/components/context-menu` | Custom context menu could use shadcn `ContextMenu` or `DropdownMenu` sub-components. **Complex** — the fortune-sheet context menu has custom positioning logic and inline inputs, so this is non-trivial. |
| `FilterMenu.tsx` filter buttons | `@workspace/ui/components/button` | Replace `button-basic` divs |
| `LinkEidtCard/index.tsx` | `@workspace/ui/components/dialog`, `input`, `button`, `select` | Full rewrite with shadcn components would eliminate `LinkEidtCard/index.css` entirely |
| `CustomSort/index.tsx` | `@workspace/ui/components/checkbox`, `radio-group`, `select`, `button`, `dialog` | Replace native `<input type="checkbox/radio">` and `<select>` with shadcn equivalents |
| `DataVerification/DropdownList.tsx` | `@workspace/ui/components/popover` or `command` | Custom dropdown could use shadcn `Popover` |
| `FilterMenu.tsx` select/checkbox items | `@workspace/ui/components/checkbox` | Replace native `<input type="checkbox">` with shadcn `Checkbox` |
| `FormulaSearch/index.tsx` | `@workspace/ui/components/input`, `select` | Replace inline-styled `<input>` and `<select>` |
| `ZoomControl/index.tsx` | Consider `@workspace/ui/components/popover` | Zoom preset menu could use shadcn `Popover` instead of custom absolute-positioned div |
| `SheetOverlay` bottom add-row | `@workspace/ui/components/input`, `button` | If present, replace with shadcn |

### Already using shared UI
- `ConditionFormat/ConditionRules.tsx` — `Button`, `Input`, `Checkbox`, `Label`, `Popover`, `ColorPicker`, `DialogHeader/Footer`
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
- `SVGDefines.tsx` is 1254 lines of inline SVG symbol definitions — consider extracting to a separate SVG sprite file or using Lucide icons where possible
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

| Hook | File | Used By | Notes |
|------|------|---------|-------|
| `useDialog` | `hooks/useDialog.tsx` | 10+ components | Well-designed, wraps `ModalContext`. **Keep.** |
| `useAlert` | `hooks/useAlert.tsx` | 4 components | Thin wrapper on `useDialog` for ok/yesno alerts. **Keep.** |
| `useOutsideClick` | `hooks/useOutsideClick.ts` | 5 components | Standard pattern. **Keep.** |
| `usePrevious` | `hooks/usePrevious.tsx` | 2 components | Standard ref-based hook. Change to named export. |

---

## 8. Context Audit

| File | Notes |
|------|-------|
| `context/index.ts` | `WorkbookContext` — core React context for fortune-sheet state. **Keep.** |
| `context/modal.tsx` | `ModalContext` + `ModalProvider` — dialog management. Uses shadcn `Dialog`. **Keep.** |

---

## 9. Priority Order

### Phase 1 — Quick wins (low risk)
1. Delete dead CSS files (`DataVerification/index.css`, `SearchReplace/index.css`)
2. Replace remaining `button-basic` divs with shadcn `Button` (FilterMenu, CustomSort, RangeDialog, LinkEditCard)
3. Fix `NameBox.tsx` export name (`LocationBox` → `NameBox`)
4. Fix `LinkEidtCard` directory typo → `LinkEditCard`
5. Replace hardcoded colors with theme tokens in SheetList, FormulaSearch, FxEditor

### Phase 2 — Medium effort
6. Migrate `Workbook/index.css` to Tailwind (56 lines)
7. Migrate `LinkEidtCard/index.css` to Tailwind + shadcn (183 lines)
8. Migrate `ContextMenu/index.css` to Tailwind (283 lines)
9. Replace native `<input>`, `<select>`, `<checkbox>` with shadcn equivalents in CustomSort, FilterMenu
10. Convert `export default` → named exports across all components
11. Translate Chinese comments to English

### Phase 3 — Major effort
12. Migrate `SheetTab/index.css` to Tailwind (281 lines)
13. Migrate `SheetOverlay/index.css` to Tailwind (957 lines) — split into sub-tasks
14. Migrate `SheetOverlay/ScrollBar/index.css` to Tailwind
15. Localize hardcoded Chinese strings in `ImgBoxs`
16. Evaluate replacing Font Awesome icons with Lucide
17. Evaluate extracting `SVGDefines.tsx` SVG sprites

### Phase 4 — Optional improvements
18. Use shadcn `Popover` for ZoomControl preset menu
19. Evaluate shadcn `ContextMenu` for right-click menus (complex)
20. Remove `css.d.ts` once all CSS imports eliminated
