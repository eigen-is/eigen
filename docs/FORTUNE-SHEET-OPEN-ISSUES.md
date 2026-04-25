# Fortune-sheet — open issues, smoke tests, shadcn backlog

> Living scratch doc to pick this up after a context reset.
> Last updated: 2026-04-25.

---

## 1. Open bug — DataVerification dropdown click-through

**Symptom:** open a cell with a dropdown data-verification rule (e.g. `ja,nee`).
The dropdown popup appears under the cell. **Clicking `ja` or `nee` selects the
cell BELOW the popup instead of writing the value to the original cell.**

**Reproduce:**
1. `bun run serve:sheets`
2. Pick a cell, toolbar → ShieldCheck (data-verification)
3. Set "Verification condition: Dropdown", value `ja,nee`, Confirm
4. Click that cell → small ⌄ chevron appears
5. Click chevron → popup with `ja` / `nee` opens
6. Click `ja` → BUG: selection moves to cell below; `ja` is not written

**File involved:** `packages/fortune-sheet/src/components/DataVerification/DropdownList.tsx`
(rendered conditionally in `SheetOverlay/index.tsx` when
`context.dataVerificationDropDownList` is true).

### What's been tried
- ✗ `onMouseDown={(e) => e.stopPropagation()}` on the popup container —
  already in place, doesn't prevent the symptom.
- ✗ Restored upstream `luckysheet-mousedown-cancel` class guard:
  `cellAreaMouseDown` returns early if `e.target.closest('.luckysheet-mousedown-cancel')`.
  Tagged the DropdownList container with that class. Shipped to main as commit
  `5f306aae`. **Did not fix the bug** — confirmed by user smoke test.
- ✗ Tried adding `e.preventDefault(); e.stopPropagation()` on the popup item
  itself plus immutable `arr` for `selected`. Untested, reverted (uncommitted).

### Plausible hypotheses
1. **Selection moves on `mousedown` somewhere we haven't traced.** `cellAreaMouseDown`
   should be the only mousedown selection mover but the React-tree
   stopPropagation doesn't seem to actually stop it. Check whether something
   listens at `document` capture phase, or via portal, or whether `cellArea`
   has a native `addEventListener('mousedown', …)` we missed.
2. **The popup item itself isn't the click target.** If the popup has a
   stacking-context bug (`bg-background` resolving transparent? z-index inside
   a containing block?), browser `elementFromPoint` returns the canvas/cell
   below instead of the popup item. Test: set `console.log(e.target)` in the
   item's onClick — if it logs the cell-area div, it's a stacking issue.
3. **`setSelected(arr)` inside the immer recipe + array mutation
   (`arr.push(vStr)`)**: state mutation might leave React in a weird state
   that re-renders without `dataVerificationDropDownList = false` taking
   effect. Reverted attempt to fix this part too.
4. **Radix-style fix is the right call regardless.** Rewrite `DropdownList`
   to use shadcn `Popover` + `Command` (or `DropdownMenu`). Radix portals the
   content out of `cellArea`, manages focus + outside-click, and gives us
   proper event isolation — same shape of fix that resolved the
   `RangeDialog` click-through.

### Recommended next step
**Don't keep trying to plug holes — refactor `DropdownList` to a Radix
`Popover` (or `DropdownMenu` for single-select / `Command` if we want
keyboard search).** Trigger = the chevron div in `SheetOverlay`. Open state
= `context.dataVerificationDropDownList` (controlled). PopoverContent =
items. This will fix the bug AND unlock follow-on shadcn cleanup (see §3).

---

## 2. Smoke tests still owed

The repo has merged a stack of fortune-sheet refactors without an end-to-end
smoke pass. Sequence to run in `apps/sheets`:

### Recently merged (need verification)
- [ ] **`useExhaustiveDependencies` PR1 (29 sites)** — see
      `docs/FORTUNE-SHEET-EFFECT-DEPS-AUDIT.md`. Most likely regression
      surface: drag-fill, paste, freeze + zoom, sheet-switch selection
      restore (Sheet:193, SheetOverlay:311, SheetTab/SheetItem:59 — all B-cat
      dep removals). 7 sites tagged `FIXME audit-needed (PR 2)` are still
      `biome-ignore`d.
- [ ] **es-toolkit / lodash migration** — drag-fill specifically (caught a
      regression last time via code-reviewer agent, not tests).
- [ ] **Biome on `components/`** — 84 `any` swaps, locale `keyof typeof`
      lookups, catch-block `instanceof Error` narrowing in ContextMenu
      insert/delete row+col paths.
- [ ] **`RangeDialog` shadcn refactor** — open data-verification → click
      range-pick icon → range dialog opens non-modal → click cells to fill
      → OK button writes value back to parent dialog.
- [ ] **`data-verification` toolbar exposure** — feature works at all
      (currently blocked by §1).

### Per-feature paths
- [ ] **Cell editing & paste** (InputBox + FxEditor + Workbook clusters):
      type a value, paste a multi-line range, formula entry, switch sheets
      mid-edit, Esc to cancel.
- [ ] **Sheet redraw + freeze** (Sheet:186, 193, 198, 228 — biggest dep
      cleanup): scroll, resize, change zoom, freeze a row + column, add
      columns past the freeze line.
- [ ] **Selection box** (SheetOverlay:311): switch sheets, verify a fresh
      sheet gets default A1 but a sheet with prior selection keeps it.
- [ ] **Data-verification dropdown** (DropdownList:24+59): set up a
      dropdown rule, click into a validated cell, change cell, verify
      preselected values look right. (Blocked by §1.)
- [ ] **Filter menu** (FilterMenu:333): apply filter, hide values, re-open
      filter — should remember which rows are hidden.
- [ ] **Link card** (LinkEidtCard:99): hyperlink a cell, click another cell
      with a different hyperlink, verify the card resets the form.
- [ ] **Sheet tab scroll buttons** (SheetTab:41): add many sheets until the
      tab bar overflows, verify scroll arrows appear.
- [ ] **Right-click insert/delete row & column** (ContextMenu): single-row
      insert; multi-select 2+ rows → "noMulti" alert; delete-all-rows → alert.
- [ ] **Sheet tab operations** (CSS dedup + SheetItem catch): rename, delete
      (verify can't delete last sheet), hover/active styling.
- [ ] **Filter by color** (FilterMenu typing): apply a filter on a column
      with multiple cell colors → "Filter by color" submenu.
- [ ] **Visual sanity** (CSS changes): selection box border/color, marching
      ants on Ctrl+C copy.

---

## 3. shadcn refactor backlog

Scan from 2026-04-25. `@workspace/ui` is shadcn-based; these sites still use
raw HTML.

### High-value (also fixes / prevents bugs)
| Where | Currently | Should be | Notes |
|---|---|---|---|
| `DataVerification/DropdownList.tsx` | custom `<div className="absolute z-[10000]">` + items | `Popover` + items (or `Command` for single-select) | **Fixes §1.** Use Radix portal + event isolation |
| `ContextMenu/FilterMenu.tsx:358` | custom `<div className="fixed rounded-md ...">` | `Popover` or `DropdownMenu` | Same shape of bug waiting to happen |
| `ContextMenu/FilterMenu.tsx` submenus | div-positioned with manual collision | `DropdownMenuSub` | Already partially shadcn elsewhere |

### `<select>` → shadcn `Select` (9 sites)
- `DataVerification/index.tsx`: lines 237, 358, 424, 458, 521 (verification type, condition pickers)
- `LinkEidtCard/index.tsx`: 244, 306 (link type)
- `ConditionFormat/ConditionRules.tsx`: 150 (duplicate-value)
- `CustomSort/index.tsx`: 90 (sort-column)

### `<input type="checkbox">` → `Checkbox` (~10 sites)
- `LocationCondition/index.tsx` (3)
- `SplitColumn/index.tsx` (3)
- `ContextMenu/FilterMenu.tsx` (3 — including filter-by-color list)
- `CustomSort/index.tsx` (1)

### `<input type="radio">` → `RadioGroup` (4 sites)
- `LocationCondition/index.tsx` (2 — locationConstant / locationFormula)
- `CustomSort/index.tsx` (2 — asc/desc)

### `<button>` → `Button` (6 sites)
- `DataVerification/index.tsx` (2 — range-pick icon buttons; bug-prone)
- `ConditionFormat/ConditionRules.tsx` (2 — color swatches that open Popover)
- `ContextMenu/index.tsx` (2 — color-picker triggers)

### `<table>` (lower priority, semantic markup is fine to keep)
- `CustomSort/index.tsx:85` — sort column/order layout
- `SplitColumn/index.tsx:126` — preview grid

### Suggested PR sequencing
1. **`DropdownList` → `Popover`** — fixes §1, smallest-blast-radius win
2. **`Select` sweep** (9 sites, mechanical) — single PR
3. **`Checkbox` + `RadioGroup` sweep** (~14 sites, mechanical) — single PR
4. **`FilterMenu` floating panel → `Popover`/`DropdownMenu`** — same class as §1
5. **Remaining native buttons → `Button`**

---

## 4. Reference

- Full audit: `docs/FORTUNE-SHEET-EFFECT-DEPS-AUDIT.md`
- Master TODO (also covers CSS migration, naming, exports): `docs/TODO-FORTUNE-SHEETS.md`
- Per-conversation memory: `~/.claude/projects/-Users-reinder-Documents-GitHub-eigen/memory/project_fortune_sheet_followups.md`
