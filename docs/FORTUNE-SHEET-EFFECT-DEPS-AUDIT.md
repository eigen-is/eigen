# Fortune-sheet `useExhaustiveDependencies` audit

> Snapshot of the 100 diagnostics across 36 hook sites in
> `packages/fortune-sheet/src/components/**`. **Status: complete (2026-04-26)** —
> all 36 sites are now either fixed (real missing deps added) or carry a permanent
> `biome-ignore` with a per-site reason. The rule is on (no per-file override in
> `biome.jsonc`).

## Summary

| Category | Sites | Diags |
|---|---:|---:|
| **A. Convert eslint-disable → biome-ignore** (intentional, no behaviour change) | 18 | 75 |
| **B. Remove unused extra deps** (effect runs less often, low risk) | 7 | ~9 |
| **C. Trigger-as-dep biome-ignore** (extras that are *intentional* re-triggers) | 3 | 3 |
| **D. Add a missing dep** (likely-correct fix, low risk) | 1 | 1 |
| **E. Audit-needed missing deps** (could be a bug or a luckysheet-fork pattern) | 7 | 12 |

Categories A+B+C+D = 29 sites that can be merged with low risk after a single
smoke pass. Category E (7 sites) is where regressions, if any, will hide.

## A. Convert `eslint-disable` → `biome-ignore`

Original author marked these as deliberate; biome doesn't honor eslint
comments, so we just translate the directive. **No code-behaviour change.**

| File:line | Hook | Diags |
|---|---|---:|
| `ConditionFormat/ConditionRules.tsx:49` | useEffect | 2 |
| `DataVerification/DropdownList.tsx:24` | useEffect | 7 |
| `DataVerification/DropdownList.tsx:59` | useEffect | 6 |
| `DataVerification/index.tsx:131` | useEffect | 3 |
| `FxEditor/NameBox.tsx:8` | useMemo | 4 |
| `FxEditor/index.tsx:39` | useEffect | 9 |
| `FxEditor/index.tsx:74` | useCallback | 4 |
| `FxEditor/index.tsx:251` | useMemo | 3 |
| `SheetOverlay/InputBox.tsx:41` | useMemo | 3 |
| `SheetOverlay/InputBox.tsx:51` | useLayoutEffect | 13 |
| `SheetOverlay/InputBox.tsx:108` | useEffect | 2 |
| `SheetOverlay/ScrollBar/index.tsx:18` | useEffect | 7 |
| `Sheet/index.tsx:186` | useEffect | 1 |
| `Sheet/index.tsx:198` | useEffect | 3 |
| `SheetOverlay/index.tsx:326` | useEffect | 1 |
| `SheetOverlay/index.tsx:379` | useMemo | 4 |
| `Workbook/index.tsx:124` | useMemo | 1 |
| `Workbook/index.tsx:132` | useEffect | 3 |

**Action:** for each site, replace
`// eslint-disable-next-line react-hooks/exhaustive-deps`
with
`// biome-ignore lint/correctness/useExhaustiveDependencies: <one-line reason>`.

## B. Remove unused extra deps

The dep array lists names that the hook body doesn't actually read. Removing
them makes the effect run less often. **Low risk** — observable change is
"effect re-runs less", not "effect captures stale values".

| File:line | Extras to remove | Why safe |
|---|---|---|
| `FilterOption/index.tsx:27` | `getContainer` | Unused in callback body |
| `LinkEidtCard/index.tsx:99` | `rc` | Body only sets state from `originAddress/Text/Type` |
| `Sheet/index.tsx:193` | `context.rowHeaderWidth, context.columnHeaderHeight, context.devicePixelRatio` | Body only touches `refs.canvas` and `placeholderRef` |
| `SheetOverlay/ContentEditable.tsx:38` | `root` | It's a ref; refs don't go in deps |
| `SheetOverlay/index.tsx:311` | `context.currentSheetId` | Body reads `draftCtx.currentSheetId`, not `context.currentSheetId` |
| `SheetTab/SheetItem.tsx:59` | `context.currentSheetId` | Same pattern as above |
| `ContextMenu/FilterMenu.tsx:333` | `hiddenRows` | It's a ref |

**Smoke check after change:** drag-fill, paste, range selection, custom sort,
filter dropdowns — anything that touches selection state.

## C. Trigger-as-dep `biome-ignore` (extras that are intentional)

The dev added an extra dep to *trigger* the effect even though the body
doesn't directly read it. Biome flags it as unused; behaviour is correct.

| File:line | Trigger dep | Why it's intentional |
|---|---|---|
| `Sheet/index.tsx:228` | `context` | The whole context object is the trigger — every change should redraw the canvas via `scheduleRedraw` |
| `SheetTab/index.tsx:41` | `context.luckysheetfile` | Re-check whether the tab scroll button should appear when the sheet list changes |
| `FilterOption/index.tsx:17` | `visibledatarow, visibledatacolumn, currentSheetId, filter_select` | Re-create filter options on any of these changes — body reads `draftCtx`, biome can't see the connection |

**Action:** add `biome-ignore` with reason on each.

## D. Add the missing dep (likely correct)

| File:line | Missing | Reason |
|---|---|---|
| `SheetOverlay/index.tsx:422` | `showDialog` | `useDialog` returns a stable function but biome can't prove it; safest to add |

## E. Audit-needed missing deps

These are the ones that could be a bug, or could be a deliberate
luckysheet-fork pattern. **Recommend per-site smoke-testing before deciding.**

| File:line | Missing | Smoke path | My read |
|---|---|---|---|
| `ContextMenu/FilterMenu.tsx:284` | `filterContextMenu` | Open filter menu near the right/bottom edge of viewport; check it re-positions when contents change | Position-recompute effect already keyed on `?.x`/`?.y`; "more specific" diag is biome being pedantic. **Likely fine to biome-ignore.** |
| `SheetOverlay/index.tsx:415` | `cellValue`, `rangeText` | Click into a cell, click out, verify range/value display in toolbar updates correctly | Comment says "Runs only when sheet focus toggles" — this is **intentional snapshotting**. biome-ignore. |
| `Toolbar/index.tsx:99` | `settings.hooks!.onInsertImage`, `settings.hooks?.onInsertImage` | Click insert-image toolbar button | If callback is recreated each render, omitting is fine. **Probably biome-ignore** but worth a 30-sec test. |
| `Toolbar/index.tsx:889` | `clickHandler` | Resize the window below 1200px to trigger mobile toolbar; click any button | `clickHandler` is recreated every render — adding it as a dep would defeat the `useMemo`. **biome-ignore** with reason. |
| `Workbook/index.tsx:202` | `dataToCelldata`, `reduceUndoList` | Undo/redo a sheet delete | Inner functions, technically capture closure. **Probably intentional**; existing tests cover undo/redo so safe. |
| `Workbook/index.tsx:283` | `dataToCelldata` | Sheet undo with cell data | Same. |
| `Workbook/index.tsx:390` | `mergedSettings.fontList` | Verify font dropdown shows configured `fontList` from settings | The body uses `mergedSettings.column/row/defaultFontSize` but not `fontList` — biome must be wrong here, or there's a stale read I missed. **Investigate.** |

## Recommended smoke-test paths (when the cleanup PR is in)

In rough priority order:

1. **InputBox** (13 + 3 + 2 + 9 = 27 diags concentrate here): single-cell
   edit, formula entry with arrow-key range selection, paste from
   clipboard, Esc to cancel edit, switch sheets while editing.
2. **Sheet redraw / freeze** (Sheet:186, 193, 198, 228 + SheetOverlay
   scroll sync): scroll, resize, change zoom, freeze a row + a column,
   add columns past the freeze line.
3. **DropdownList & DataVerification** (7+6+3 diags): set up a
   data-validation dropdown, switch sheets, change validation type,
   verify pre-selected values.
4. **FxEditor** (9+4+3+4 = 20 diags): function dropdown, formula entry
   with NameBox, formula range selection.
5. **Toolbar mobile** (Toolbar:889): resize window below 1200px, click
   each toolbar button group.
6. **Filter menu** (FilterMenu:284, 333): open filter menu near viewport
   edges, scroll-bound submenu.
7. **Selection / range / search** (SheetOverlay:415, 422): cell focus
   change, search/replace dialog open/close.
8. **Sheet operations** (Workbook:202, 283, 390): delete sheet → undo,
   font-list-driven settings.

## Suggested PR order

1. **PR 1:** Categories A + B + C + D (29 sites). Big diff, all
   low-risk. Smoke-test paths 1–4. Re-enable biome rule on those files. **Shipped.**
2. **PR 2:** Category E (7 sites). Smaller, but each site needs
   per-site judgement and matching smoke-test path. Remove the
   `biome.jsonc` override entirely once this lands. **Shipped 2026-04-26.**

## PR 2 outcomes (2026-04-26, commit `d65a49fb`)

The 6 remaining sites (`FilterMenu.tsx:284` was resolved earlier when the
floating panel was rewritten as a shadcn `Popover`). 3 sites lose
`biome-ignore` entirely via real refactor; 1 site is also fixed (real bug)
but keeps `biome-ignore` for a separate trigger-as-dep pattern; 2 sites
keep `biome-ignore` with permanent reasons.

| Site | Resolution |
|---|---|
| `SheetOverlay/index.tsx:417` | `biome-ignore` — intentional one-shot snapshot on focus toggle. Adding `rangeText`/`cellValue()` would re-snapshot continuously. |
| `Toolbar/index.tsx:99` (`getToolbarItem`) | `biome-ignore` — `settings` is recreated on every props change in Workbook (`Object.values(props)` spread); adding it would invalidate every toolbar item memo. `settings.hooks?.onInsertImage` is read from closure at click time. |
| `Toolbar/index.tsx` (`mobileToolbar` memo) | **Fixed** — wrapped `clickHandler` in `useCallback(..., [setContext, refs])` and added it to `mobileToolbar`'s deps. No `biome-ignore` needed. |
| `Workbook/index.tsx` (`setContextWithProduce`) | **Fixed** — hoisted `dataToCelldata` (pure) and `reduceUndoList` (takes `globalCache` ref as 3rd param) to module scope. Both are now stable. No `biome-ignore` needed. |
| `Workbook/index.tsx` (`handleUndo`) | **Fixed** — same as above; `dataToCelldata` is now module-scoped. No `biome-ignore` needed. |
| `Workbook/index.tsx` (settings-sync `useEffect`) | **Fixed** (real bug) — added `mergedSettings.fontList` to deps (real missing read; `draftCtx.fontList = mergedSettings.fontList` was not picked up on runtime fontList changes). `context.currentSheetId` + `context.luckysheetfile.length` retained as intentional re-trigger deps (body reads via `draftCtx`); `biome-ignore` documents the trigger-as-dep pattern. |

Also tightened in the same commit: `Settings.customToolbarItems` type
(`icon: LucideIcon` required, `onClick: () => void`) — drops 2
`noExplicitAny` ignores in `Toolbar/index.tsx`. No internal callers, safe
public-type narrowing.
