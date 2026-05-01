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
   line 14. ~90 files / 48k LOC. Three pre-pass blockers before flipping the switch:
   - **~25 `@ts-ignore` directives remaining** (Group F — real type/data gaps,
     per-site judgment, not a mechanical sweep). Mechanical pre-passes shipped
     2026-04-30 cleared 35/60 (Groups A/C/D/E in `921904a6`, Group B in
     `4d1f2cfe`). Sites listed below.
   - **~232 `any` annotations** (31 in `api/rowcol.ts` alone) → biome's
     `noExplicitAny` rule.
   - **Formatter sweep** across all state files.

   Once typing tightens, collapse state's `Sheet` / `SheetConfig`
   (`state/types.ts`) into `Omit<lib.Sheet, …> & {editor extras}` — the shared
   shapes already live in `@workspace/lib/sheets`; only `borderInfo: any[]` and
   `luckysheet_conditionformat_save: any[]` keep state from extending lib
   directly today.

   **Group F ts-ignore sites (deferred per-site work, line numbers as of 2026-04-30):**
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

### Misc cleanups

6. **`SheetTab` shadcn migration** — bottom tab bar
   (`components/SheetTab/index.tsx` + `SheetItem.tsx`, ~580 LOC TSX) still
   has its own ~272 LOC `index.css` (also part of TODO #2's CSS migration —
   tackle them together). Add/delete/rename/hide/color all use bespoke
   styling and dropdowns; should adopt shadcn `DropdownMenu` (rename, color,
   hide, etc.) and `Tailwind` for layout. Drag-and-drop reorder + scroll
   buttons can stay as plain buttons. `ContextMenu/SheetTab.tsx` (the
   right-click on a tab) already uses shadcn — only the tab bar itself needs
   the pass.

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
- **Row/col op engine wrap + BE/FE replay (2026-05-01)** — right-click insert/delete row &
  column on a sheet with merges, frozen rows, active filter, data-verification rule,
  conditional format. Verify shifts correctly + selection follows + formulas update. Also:
  cold-join with pending row/col ops (browser A inserts a row, closes tab without flushing;
  browser B opens fresh and sees the inserted row); active-session remote op; snapshot-only
  load path. Exercises the new shared `replaySheetsOps` on both BE and FE initial-load.

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

### 2026-05-01

- **Context-free row/col op replay** (spec: `docs/superpowers/specs/2026-05-01-context-free-row-col-ops-design.md`).
  Pure data-shift logic for `insertRowCol` / `deleteRowCol` extracted from `state/modules/rowcol.ts`
  into the headless engine. New exports from `@workspace/fortune-sheet/engine`:
  - `applySheetsInsertRowCol<S extends Sheet>(sheets, op): S[]` and
    `applySheetsDeleteRowCol<S extends Sheet>(sheets, op): S[]` — generic over sheet shape so
    state.Sheet[] flows through with editor-runtime extras typed end-to-end (no `as any` casts).
  - `replaySheetsOps(sheets, opBatches): Sheet[]` — single source of truth for "snapshot + ops →
    `Sheet[]`". Used by both BE document reader (`apps/api/src/lib/document/sheets.ts`) and FE
    initial-load (`apps/sheets/src/components/sheets/hooks/use-sheet.ts`); typed shape adapters
    (`asInsertValue` / `asDeleteValue`) pin `op.value` so future field drift fails fast.
  - `functionStrChange` relocated from `state/modules/formula-range.ts` to `engine/formula-shift.ts`.
  - State's `insertRowCol` / `deleteRowCol` now wrap the engine and only handle state-only
    fields (filter / frozen / dataVerification / hyperlink / calcChain / luckysheet_select_save).
  - FE collapsed two-phase mount (snapshot then `applyOp(pendingOps)`) into single replay-then-mount;
    `pendingOpsRef` and post-mount replay `useEffect` removed. Ongoing ops over WebSocket still
    flow through `workbook.applyOp` as before.
  - Reviewer-flagged followups also shipped: `RowColOp` discriminated union split into
    `InsertRowColOp` + `DeleteRowColOp` (CODE-STANDARDS "no unnecessary discriminated union for two
    cases"); dead all-sheet calcChain loop in state collapsed to single target-sheet pass (the
    cross-sheet formula-text rewrite moved to engine, leaving the loop with only the target branch
    active).
  - Smoke test still owed: cold-join with pending ops; active-session remote op; snapshot-only
    path. Already in "Smoke tests still owed" as the row/col op smoke item — extends to cover
    the new BE/FE replay path.

### 2026-04-30

- **TODO #1 — `state/` ts-ignore pre-pass: 35/60 cleared** across two commits.
  - **`921904a6`** (Groups A/C/D/E, 21 ts-ignores, bundled with unrelated work
    by a concurrent commit — provenance loss, work itself is correct):
    - **Group A (14):** added explicit return type
      `[number[], number[], number, number, number, number] | null` to
      `mergeMove` / `mergeMoveMain` in `modules/cell.ts`. Killed all destructure-
      site ignores in `cell.ts`, `events/mouse-drag.ts`, `events/mouse-cell.ts`,
      `events/mouse-header.ts`, `modules/formula-range.ts`, `modules/selection.ts`.
      Bonus broken-window cleanup at `events/mouse-cell.ts:651-722` removed
      16 dead `as number` / `as number[]` casts that the destructure no longer
      needs.
    - **Group C (3):** changed `execFunctionGroup`'s `id?: string` → `id?: string |
      null` in `modules/formula-exec.ts:742`. Function body already handled `null`
      via `if (id == null)`. Cleared callsites in `modules/refresh.ts`,
      `events/paste.ts`, `modules/toolbar.ts`.
    - **Group D (2):** added `as const` to `defaultStyle` in `canvas.ts:11` so
      `textBaseline: "middle"` / `textAlign: "center"` become CanvasTextBaseline /
      CanvasTextAlign assignable.
    - **Group E (2):** typed previously untyped `cell` param of
      `checkNoNullValue` / `checkNoNullValueAll` in `modules/toolbar.ts` as
      `Cell | null`. Internal `let v: any` retained for the local-reassign-to-
      primitive pattern (a controlled compromise; clean separate-vars refactor
      deferred).
  - **`4d1f2cfe`** (Group B, 14 ts-ignores, clean standalone commit): deleted
    dead IE 6-9 fallback branches across `modules/cursor.ts` (4),
    `events/mouse-cell.ts` (1), `events/mouse-header.ts` (2),
    `modules/formula-editor.ts` (5), `events/paste.ts` (2). Dropped
    `document.selection`, `document.body.createTextRange()`, IE TextRange
    `moveToElementText/collapse/select`, and `window.clipboardData` fallbacks.
    Outer `if (window.getSelection)` / `if (document.createRange)` wrappers
    unwrapped — both APIs are non-optional in modern lib.dom. Inner null guards
    (`if (!currSelection) return`) preserved. paste.ts: `let` → `const` since
    `clipboardData` no longer reassigned. Inner Group F `@ts-ignore` lines on
    `parentNode` chains preserved per scope (still listed under Group F above).
  - Net: 25 Group F ignores remain. No mechanical sweeps will help them — each
    is a real type/data gap requiring per-site judgment. `bun run typecheck`
    green after each pass.

### 2026-04-29

- **TODO #6 — Formula autocomplete + hint popups rebuilt on Radix Popover**.
  Both `SheetOverlay/FormulaSearch` (the typed-text candidate list) and
  `SheetOverlay/FormulaHint` (the post-commit signature/argument card) were
  silently broken: `FormulaSearch`'s keyboard nav, click, and Enter/Tab commit
  were all unwired since the `2026-04-28` shadcn cleanup dropped the
  `luckysheet-formula-search-item*` classes that `InputBox` queried via
  `document.querySelector` + `classList.add/remove`; `FxEditor`'s popup had
  never had any wiring at all; both popups were also pinned to the cell
  width by their flex parent and hidden behind the `z-1003` scrollbar.
  Rebuild:
  - New `SheetOverlay/FormulaPopup` wraps both popups in a Radix `Popover` with
    a fixed-position virtual anchor tracked off the input element's
    `getBoundingClientRect` (rect re-read on resize/scroll). Portals out of
    the editor's `z-19` stacking context, lands at `z-1010` above scrollbars,
    width is `w-80` (320px) so the popup no longer follows cell width.
  - New `hooks/useFormulaAutocomplete` owns the autocomplete keyboard +
    insertion path for both `InputBox` and `FxEditor`. Wraps shared
    `useSuggestions` (now at `@workspace/ui/hooks/use-suggestions`, moved
    from the chat folder since it's generic; chat-message-input now imports
    relatively) with a synchronous Enter/Tab commit that reads
    `context.functionCandidates` directly — bypassing the effect-driven
    countRef in `useSuggestions` to avoid the count-vs-visible race.
  - `FormulaSearch` items render as `eigen-list-item` `<li>`s with
    `onMouseDown`+`preventDefault` for click; active row's description shown
    (was hardcoded to row 0).
  - `FormulaHint` lost its broken `X` (close) and `ChevronUp` (collapse)
    button stubs — both had `cursor-pointer`+`title` but no `onClick`.
    Layout collapsed from triple-absolute-positioned divs to plain flow.
  - DOM-side helper extracted to
    `formula-editor.ts::insertFormulaFunctionDom(target, name): boolean` —
    pure DOM, no `ctx`; callers do the state mutation in their own
    `setContext` recipe (avoids mixing side effects with immer).
  - `useSuggestions`: `selectedIndex` moved to a ref alongside its `useState`,
    so `handleKeyDown` is no longer recreated on every arrow press. Benefits
    chat too (consumer `useCallback` deps no longer cascade).
  - `state/context.ts`: `functionCandidates: any[]` → `FunctionCandidate[]`.
  - Removed the now-unused `id="luckysheet-formula-search-c"` (DOM selector
    coupling for this popup is gone).

### 2026-04-28

- **Shared type consolidation**: `Cell`, `CellMatrix`, `CellStyle`, `CellType`,
  `InlineStringSegment`, `SingleRange`, `Range` and the `ConditionalFormatRule`
  family are now canonical in `@workspace/lib/sheets`. Engine + state re-export
  from there — single source of truth, zero parallel definitions. Added
  `BorderInfo` discriminated union (`CellBorderInfo | RangeBorderInfo`); apps/api
  HTML export and import test narrow on `rangeType === 'cell'` before reading
  `value`. State's `Sheet`/`SheetConfig` retain editor-runtime extras and keep
  `borderInfo: any[]` + `luckysheet_conditionformat_save: any[]` (producer code
  in state pushes untyped rules) — collapse via `Omit<lib.Sheet, …> & {extras}`
  is part of TODO #1 once state-side typing tightens.
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
