# Fortune-sheet — open issues, smoke tests, shadcn backlog

> Living scratch doc to pick this up after a context reset.
> Last updated: 2026-04-25 (commit `b5c3b7e7`).

---

## 1. Resolved — DataVerification dropdown click-through

**Status:** Fixed 2026-04-25 in commit `b5c3b7e7`. `DropdownList` rewritten as
a controlled shadcn `DropdownMenu` (`DropdownMenuCheckboxItem` for multi-
select, `DropdownMenuItem` for single-select). Trigger is the existing
chevron div via `asChild` so the engine's `cellFocus` keeps positioning it.
`SheetOverlay` now renders `<DropDownList />` once unconditionally; the
standalone chevron div + `dataVerificationHintBoxRef` are gone.

### Lesson — portaled events still bubble through the React tree

Switching to shadcn alone did **not** fix the bug. Radix portals
`DropdownMenuContent` to `document.body` (out of `cellArea`'s DOM tree),
but **React synthetic events still bubble through the React tree across
portals**. So clicking a menu item still fired `cellAreaMouseDown` (an
ancestor `onMouseDown` in `SheetOverlay`), which moved the selection to the
cell beneath the popup before our `onSelect` could write the value.

**Fix:** add `luckysheet-mousedown-cancel` to `DropdownMenuContent`. The
DOM-level guard at `SheetOverlay/index.tsx:60`
(`e.target.closest('.luckysheet-mousedown-cancel')`) walks the **DOM**
(not the React tree), so it stops at the portaled content in body and
short-circuits selection movement.

**Generalize:** any future shadcn floating UI rendered as a descendant of
`cellArea` (validation popups, color pickers, etc.) must put
`luckysheet-mousedown-cancel` on its portaled content for the same
reason. `FilterMenu` is mounted at the `Workbook` root (sibling of
`<Sheet />`), so it doesn't need the class — only descendants of
`cellArea` do.

---

## 2. Smoke tests still owed

The repo has merged a stack of fortune-sheet refactors without an end-to-end
smoke pass. Sequence to run in `apps/sheets`:

### Recently merged (need verification)
- [ ] **`useExhaustiveDependencies` PR1 (29 sites)** — see
      `docs/FORTUNE-SHEET-EFFECT-DEPS-AUDIT.md`. Most likely regression
      surface: drag-fill, paste, freeze, sheet-switch selection
      restore (Sheet:193, SheetOverlay:311, SheetTab/SheetItem:59 — all B-cat
      dep removals).
- [x] **`useExhaustiveDependencies` PR2 (6 sites, 2026-04-26, commit
      `d65a49fb`)** — Category E audit-needed sites cleaned up.
      Smoke-tested by user. Real fixes: `dataToCelldata` + `reduceUndoList`
      hoisted to module scope (Workbook lose `biome-ignore`); `clickHandler`
      wrapped in `useCallback([setContext, refs])` (Toolbar `mobileToolbar`
      loses `biome-ignore`); `mergedSettings.fontList` added as missing dep
      to settings-sync effect (real bug — runtime fontList changes weren't
      propagating to the font dropdown). Same commit also tightened
      `Settings.customToolbarItems` type (`icon: LucideIcon`, `onClick: () =>
      void`) — dropped 2 `noExplicitAny` ignores in `Toolbar/index.tsx`.
- [ ] **es-toolkit / lodash migration** — drag-fill specifically (caught a
      regression last time via code-reviewer agent, not tests).
- [ ] **Biome on `components/`** — 84 `any` swaps, locale `keyof typeof`
      lookups, catch-block `instanceof Error` narrowing in ContextMenu
      insert/delete row+col paths.
- [ ] **`RangeDialog` shadcn refactor** — open data-verification → click
      range-pick icon → range dialog opens non-modal → click cells to fill
      → OK button writes value back to parent dialog.
- [x] **`data-verification` toolbar exposure** — basic single-select
      dropdown flow verified 2026-04-25 (rule setup, chevron, popup, click
      writes to correct cell, outside-click closes). Multi-select toggle
      still owed.
- [ ] **shadcn cleanup pass (commit `b5c3b7e7`)** — the §3 sweep below
      touched `DataVerification`, `LinkEditCard`, `ConditionFormat/ConditionRules`,
      `ContextMenu/index.tsx`, `CustomSort`, `LocationCondition`, `SplitColumn`,
      `FilterMenu`. Walk through each dialog/popover.
- [ ] **Follow-up shadcn sweep (commits `bdb71f94` + `91e28493`)** — touched
      `LinkEditCard` (CSS migration + 2 raw `<input>` → `Input`; 4 div-buttons
      → real `<button>`), `ZoomControl` (custom menu → Popover; +/-/trigger/
      preset items → `<button>`; component since removed entirely),
      `SheetOverlay` bottom-add-row (shadcn `Button` + `Input`),
      `ContextMenu/index.tsx` (`menuItemClass` const dedupe), `FormulaSearch`
      (broken-window `cn()` + list rows → `<button>`). Also dropped 4 dead
      `.luckysheet-cell-flow-*` rules from `SheetOverlay/index.css`. Verify:
      link card open/edit/delete, bottom add-row click + back-to-top click,
      formula list keyboard navigation (Enter/Space).
- [ ] **`LinkEditCard` directory rename (commits `dd46088a` + `3b5642a2`)** —
      `LinkEidtCard/` → `LinkEditCard/`. Trivial single-import update; should
      be invisible at runtime. Spot-check link card still renders.
- [ ] **Engine cleanup batch (commits `1b2b36a0` + `2608d5f5`)** — engine
      subpath export, `getCellTextInfo`/`getFontSet` ctx unification (3 sites
      previously omitted locale fonts; now consistent), `colorGradation` array
      bug fix, `applyCellStyle` helper extraction (14× dedupe), bubble sort →
      `Array.sort`, sum loop → `reduce`, plus mechanical sweeps (22 dead
      `console.log`, jQuery legacy comments, stale ReferenceError comments,
      `substr` → `slice`, `indexOf > -1` → `includes`, dead try/catch around
      internal calls). Smoke surfaces: any sheet using colorGradation /
      dataBar conditional formatting (especially overlapping rules); cell
      text rendering with non-default fonts (locale fontarray indices); drop
      cell fill with type 4-8; paste flows that previously called the dead
      `rowlenByRange` paths; right-click menus that touch number formats.
      Engine test suite (`engine/test/conditional-format.test.ts`) and the
      6 HTML-export tests cover the bug-fix path.

### Per-feature paths
- [ ] **Cell editing & paste** (InputBox + FxEditor + Workbook clusters):
      type a value, paste a multi-line range, formula entry, switch sheets
      mid-edit, Esc to cancel.
- [ ] **Sheet redraw + freeze** (Sheet:186, 193, 198, 228 — biggest dep
      cleanup): scroll, resize, freeze a row + column, add columns past the
      freeze line.
- [ ] **Selection box** (SheetOverlay:311): switch sheets, verify a fresh
      sheet gets default A1 but a sheet with prior selection keeps it.
- [ ] **Data-verification dropdown** (DropdownList): single-select write
      and outside-click close verified 2026-04-25. Still owed: multi-select
      toggle (rule with `type2 = true`), preselect on re-open, switching to
      another validated cell while popup is open.
- [ ] **Filter menu** (post `b5c3b7e7` Popover refactor): apply filter,
      hide values, re-open filter — should remember which rows are hidden.
      By-color submenu hover (cursor crossing the `sideOffset` gap should
      not flicker — 120ms close-debounce). filter-by-condition row should
      look disabled, not interactive.
- [ ] **CustomSort / LocationCondition / SplitColumn** dialogs (post
      `b5c3b7e7`): walk through select/checkbox/radio interactions, confirm
      `DialogFooter` layout matches RangeDialog.
- [ ] **Link card** (LinkEditCard:99): hyperlink a cell, click another cell
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

Initial scan 2026-04-25. `@workspace/ui` is shadcn-based; these sites used
raw HTML. Most landed in commit `b5c3b7e7`.

### High-value (also fixes / prevents bugs)
| Where | Currently | Should be | Notes |
|---|---|---|---|
| ~~`DataVerification/DropdownList.tsx`~~ | ~~custom div + items~~ | ~~`DropdownMenu`~~ | **Done `b5c3b7e7`** — see §1 lesson |
| ~~`ContextMenu/FilterMenu.tsx` floating panel~~ | ~~custom fixed-position div~~ | ~~`Popover` (virtual `PopoverAnchor`)~~ | **Done `b5c3b7e7`** |
| ~~`ContextMenu/FilterMenu.tsx` submenus~~ | ~~div-positioned with manual collision~~ | ~~Nested `Popover`~~ | **Done `b5c3b7e7`** — 120ms hover-close debounce to bridge `sideOffset` gap |

### `<select>` → shadcn `Select` — all done
- ~~`DataVerification/index.tsx` (5 sites)~~ — done
- ~~`LinkEditCard/index.tsx` (2 sites)~~ — done
- ~~`ConditionFormat/ConditionRules.tsx` (1 site)~~ — done; also fixed a pre-existing bug where the original `<select>` wasn't passing `value`
- ~~`CustomSort/index.tsx` (1 site)~~ — done

### `<input type="checkbox">` → shadcn `Checkbox` — all done
- ~~`LocationCondition/index.tsx` (3 sites)~~ — done; 5 radios also collapsed into one `RadioGroup` (they had unique `name` attrs before so didn't actually form a group)
- ~~`SplitColumn/index.tsx` (3 sites)~~ — done; `getRegStr` in `state/modules/splitColumn.ts` no longer walks `.childNodes[0].checked` (incompatible with Radix `Checkbox` rendering as `<button>`); now takes `(selected: ReadonlySet<string>, otherValue: string)` derived from React state
- ~~`ContextMenu/FilterMenu.tsx` (3 sites)~~ — done
- ~~`CustomSort/index.tsx` (1 site)~~ — done

### `<input type="radio">` → shadcn `RadioGroup` — all done
- ~~`LocationCondition/index.tsx` (2 sites)~~ — done
- ~~`CustomSort/index.tsx` (2 sites)~~ — done

### `<button>` → shadcn `Button` — all done
- ~~`DataVerification/index.tsx` (2 range-pick icon buttons)~~ — done
- ~~`ConditionFormat/ConditionRules.tsx` (2 color-swatch buttons)~~ — done
- ~~`ContextMenu/index.tsx` (2 color-picker triggers)~~ — done

### `<table>` (lower priority, semantic markup is fine to keep)
- `CustomSort/index.tsx` — sort column/order layout. Left as-is.
- `SplitColumn/index.tsx` — preview grid. Left as-is.

### Previously deferred — now done

- ~~**`LinkEditCard/index.css` color-token migration.**~~ Done. All 182 lines
  of CSS migrated to Tailwind + theme tokens inline; `index.css` deleted;
  2 raw `<input>` → shadcn `Input`. `fortune-link-modify-modal` +
  `range-selection-modal` classes preserved on the range-selection div
  (DOM-targeted from `state/modules/hyperlink.ts:214,237`).
- ~~**`menuItemClass` propagation to `ContextMenu/index.tsx`.**~~ Done.
  Module-level const extracted; 4 inline duplicates replaced. Note: kept
  `gap-2` (which `FilterMenu`'s version omits) because the ContextMenu
  call sites have inline `<input>` next to text and need the spacing.

---

## 3.6. `colorGradation` rules — `format.cellColor` / `format.textColor` reads on an array-shaped `format`

**Resolved 2026-04-26 in commit `1b2b36a0`.** In `engine/conditional-format.ts::evaluateConditionalFormat`
the `colorGradation` branch read `format.cellColor`/`format.textColor` on the `if`-arm (existing
computeMap entry) when `format` is actually a string array of gradient stops, blanking the cell color on
overlapping rules. Both arms now compute the gradient color once and merge through the shared
`applyCellStyle` helper. Regression tests in `engine/test/conditional-format.test.ts` and
`apps/api/src/test/sheets-html-export.test.ts`.

---

## 3.5. `getCellTextInfo` redundant `ctx?` parameter

**Resolved 2026-04-26 in commit `1b2b36a0`.** The optional 5th `ctx?: Context` parameter was redundant —
the two canvas render paths passed `this.sheetCtx` as both the 3rd and 5th argument, while three other
callers omitted it entirely (silently disabling locale fonts). Parameter dropped; `getFontSet` now
requires `Context` and reads it from the 3rd `sheetCtx` argument. All 5 call sites simplified to a
single `Context`.

---

## 4. Reference

- Full audit: `docs/FORTUNE-SHEET-EFFECT-DEPS-AUDIT.md`
- Master TODO (also covers CSS migration, naming, exports): `docs/TODO-FORTUNE-SHEETS.md`
- Per-conversation memory: `~/.claude/projects/-Users-reinder-Documents-GitHub-eigen/memory/project_fortune_sheet_followups.md`
