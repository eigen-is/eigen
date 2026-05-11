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
   (`FilterEntry`, `AlternateFormatEntry`) live in `state/types.ts`.
   `CalcChainEntry` and `AncestorFormulaCell` are engine-canonical (formula
   dep graph + calc-chain node) — defined in `engine/types.ts` and
   re-exported through `state/types.ts`.

   **Loose typing kept** (each with a documented biome-ignore + WHY pointing
   here): all previously-listed sites are now closed — see Tightened entries
   below for `formula-range`, `border`, and the other migrated producers.
   - ~~`state/modules/formula-range.ts::rangeSetValue(selected: any)`~~ — closed
     2026-05-11, see below.
   - ~~`state/modules/border.ts::getBorderInfoComputeRange` returns
     `Record<string, any>`~~ — closed 2026-05-11, see below.

   **Tightened on `biome-state-cleanup` (2026-05-11)** — landed alongside Group F:
   - `Sheet.luckysheet_conditionformat_save` is now `ConditionalFormatRule[]`.
     `setConditionRules` returns early on names outside the canonical union
     (previously created silent no-op rules); `appendRule` annotates literals
     as `ColorGradationRule | DataBarRule`; `paste.ts::CutPasteSide.cdformat`
     and the cut-paste rule-array narrow through. Tests in
     `condition-format-presets.test.ts` narrow via `if (rule.type !== …)`
     guards. Side-fix: the cut-paste rule clone no longer aliases its
     `cellrange` back into the source rule (the previous code reassigned
     `cellrange` on the same object twice).
   - `SheetConfig.borderInfo` is now `BorderInfo[]` (was `any[]`). Producers
     in `paste.ts`/`dropCell.ts`/`selection.ts`/`moveCells.ts`/`rowcol.ts`/
     `toolbar.ts`/`api/cell.ts` annotate each `bd_obj` literal with its
     variant (`CellBorderInfo`/`RangeBorderInfo`). Reader loops capture
     `cfg.borderInfo[i]` into a local `entry` for narrowing (the old
     `cfg.borderInfo[i].range` pattern didn't propagate the discriminator).
     `handleBorder(ctx, type, ...)` is now typed `BorderType` instead of
     `string`; `format-menu.tsx` types `borderItems` so `value` flows as
     `BorderType | 'divider'`. Side-fixes: lib's `CellBorderInfo.value.{l,r,t,b}`
     widened from `BorderSide | undefined` to `BorderSide | null | undefined`
     (producers emit explicit `null` for cleared sides, readers `isNil`-check
     either); `getQKBorder()` returns `BorderSide` directly instead of a
     `[style, color]` tuple, four call sites simplified; pre-existing typo
     fix in HTML paste's right-border trigger (`td.style.borderRight` instead
     of the inherited-from-bl `td.style.borderLeft`); `normalizeSelection`
     overloaded to preserve non-undefined when callers pass literal arrays.
   - `Freezen.freezen{horizontal,vertical}data` is now a named-object
     `FreezenAxisData` (`{ pos, boundary, scroll, cumulative, edge }`) — was
     `any[]` masking a `[number, number, number, number[], number]` tuple
     with magic-index reads across 8 functions. Producer in `freeze.ts`
     emits the object literal; `scrollToFrozenRowCol`, `fixPositionOnFrozenCells`,
     `fix{Row,Column}StyleOverflowInFreeze`, and the three `drawFrozen*` helpers
     in `Sheet/index.tsx` now read named fields. Dead `Freezen.horizontal.top`
     and `Freezen.vertical.left` outer fields removed (written, never read).
     Side-fixes: two commented-out jQuery scrollbar callbacks deleted; the
     `boundary + offset` accumulation in `scrollToFrozenRowCol` collapsed
     from three statements to one per axis.
   - `getBorderInfoComputeRange` / `getBorderInfoCompute` return
     `ComputedBorderMap` (was `Record<string, any>`). `ComputedBorderEntry`
     reuses lib's canonical `BorderSide` for each side; the producer coerces
     `RangeBorderInfo.style` from `number | string` to `number` once at the
     entry, so the 8 consumer sites (canvas/paste/dropCell/moveCells/selection)
     assign computed sides into `CellBorderInfo.value.{l,r,t,b}` without per-
     site casts. `selection.ts::rangeValueToHtml` now captures
     `borderInfoCompute[\`${r}_${c}\`]` once per cell into a local before
     reading sides — was repeated template-literal indexing across the
     merged-cell histogram and the two non-merged blocks (~190 LOC dropped).
     Side-fixes: histogram bump pattern factored into a `bumpHistogram`
     helper (was 8 inlined `isNil`/`+= 1` quadruples); pre-existing
     `${r}_${c}` typo at the `bl_obj` (left edge of merged cell) site
     fixed — was sampling top-left's `.l.style` for every cell on the left
     edge instead of the per-cell value, masking mixed-style edges on
     non-uniform merges; non-merged border CSS factored into a
     `cellBorderCss(border)` helper (was 4 × ~5 LOC duplicated across two
     branches). Pre-existing slash-branch bug in `paste.ts` (multi-tile
     slash paste using `minh`/`minc` offsets) committed as a separate fix
     ahead of the type tightening; a follow-up reorder swaps the slash-copy
     branch (now `else if (computeEntry?.s)`) ahead of the within-sheet
     overlap clear branch (`else if (borderInfoCompute[\`${h}_${c}\`])`) so
     a slash source whose computed-map coordinates collide with another
     bordered cell in the source range no longer drops silently.
   - `SheetConfig.authority` is now `SheetAuthority` (was `any`). The fork
     never ported upstream luckysheet's protect-sheet dialog — no UI or
     xlsx-import path writes the field, only `protection.ts` reads it. The
     new type captures exactly the five fields the four readers touch
     (`sheet`, `selectLockedCells`, `selectunLockedCells`, `hintText`,
     `defaultSheetHintText`); the dead locale strings (`formatCells`,
     `insertRows`, `editObjects`, …) were not added per CODE-STANDARDS
     "no placeholders." Side-fixes in `protection.ts`: the four readers
     now share a single guard pattern (`aut = sheetFile.config?.authority`
     + one `isNil(aut) || isNil(aut.sheet) || aut.sheet === 0` early
     return), replacing two repeated `isNil`-of-`config` + `isNil`-of-`aut`
     checks per function; dead commented-out `locale()` / `local_protection`
     lookup and the unreachable `isAllEdit = false` branch (with its
     `TODO checkProtectionLockedSqref(…)` block) removed from
     `checkProtectionSelectLockedOrUnLockedCells`; `let ht = ''` +
     if/else fallback in `checkProtectionFormatCells` collapsed to
     `ctx.warnDialog = aut.hintText || aut.defaultSheetHintText` (empty
     strings are falsy, matches the prior `length > 0` semantic);
     `let selectLockedCells = false; if (...) selectLockedCells = true;`
     pattern in `checkProtectionAllSelected` collapsed to direct
     `const` assignment.
   - `rangeSetValue(selected: any)` is now `RangeOrWholeAxis` (discriminated
     union of `SingleRange | { row: [null,null]; column: number[] } |
     { row: number[]; column: [null,null] }`, in `state/types.ts`). The whole-
     axis sentinels from column-header / row-header click handlers are now
     a typed variant rather than a `[null, null]` lie inside `SingleRange`.
     `getRangetxt` (the only other reader) widens to the same union; two
     module-local type predicates (`isWholeColumnRef` / `isWholeRowRef`)
     drive the narrowing (TS doesn't propagate tuple-vs-array index access
     into sibling-field narrowing, so the inline `range.row[0] === null`
     check that was tried first didn't narrow `range.column`). The merge-
     branch check in `rangeSetValue` now guards `rf !== null && cf !== null`
     before building the `${rf}_${cf}` merge-key string — semantically a
     no-op (the previous code stringified to `"null_null"` which never
     matches a merge key) but lets TS narrow rf/cf to `number` before
     emitting the `[rf, rf]` / `[cf, cf]` `SingleRange` literal. Lib's
     `SingleRange = { row: number[]; column: number[] }` stays pure — the
     10 other `getRangetxt` call sites and ~56 SingleRange consumers across
     state untouched.
   - State's `Sheet` and `SheetConfig` (in `state/types.ts`) now collapse
     onto lib's canonical shapes: `SheetConfig = LibSheetConfig & { editor
     extras }`, `Sheet = Omit<LibSheet, 'config'> & { config?: SheetConfig;
     editor extras }`. All overlapping fields were byte-identical (incl.
     `showGridLines: boolean | number` which lib was already widened to)
     — pure additive collapse, no field type changes, ~25 LOC removed.
     `engine/rowcol.ts` had used the `SheetConfig & { rowReadOnly,
     colReadOnly, customHeight, customWidth }` pattern locally since the
     engine extraction; the state-side collapse generalises it. `config`
     is `Omit`'d because state's SheetConfig is wider; all other lib
     fields flow through transparently. Editor extras kept on state:
     `SheetConfig` adds `customHeight`/`customWidth`/`authority`/
     `rowReadOnly`/`colReadOnly`; `Sheet` adds 21 fields covering
     selection state, calc chain, filters, frozen panes, dynamic-array
     spill ranges, hyperlinks, alternateformat, dataVerification, images,
     pivot-table placeholder, and the editor-only `addRows`/`status`/
     `hide`/`color`/`defaultRowHeight`/`defaultColWidth`.
   - `EditorSheetConfigExtras` hoisted to `engine/types.ts` to dedupe the
     four editor-only structural fields the engine's row/col shifter and
     state both touch (`rowReadOnly`, `colReadOnly`, `customHeight`,
     `customWidth`). Was declared independently twice
     (`engine/rowcol.ts::ExtendedSheetConfig` and
     `state/types.ts::SheetConfig`); both now reference the shared type.
     Engine is the right home: state imports from `../engine/types`
     already, and lib stays unaware of editor extras (preserves the
     `fortune-sheet → lib` direction rule). Standardised key-type on
     `Record<string, number>` for all four — state had `rowReadOnly`/
     `colReadOnly` as `Record<number, number>` while the engine used
     `Record<string, number>`. Six state-side local declarations flipped
     to match (`state/modules/rowcol.ts` ×5, `InputBox.tsx` ×2,
     `f_rowhidden_new` on touch). Cleanup on touch in
     `engine/test/replay-ops.test.ts`: the `// biome-ignore lint/
     suspicious/noExplicitAny` + `as any` for `{ rowReadOnly: { 0: 1 } }`
     is gone — the test typed the sheet as
     `Sheet & { config?: EditorSheetConfigExtras }` instead.
     Pre-existing `Record<number, number>` annotations on
     non-EditorSheetConfigExtras fields (`rowlen`/`columnlen`/`rowhidden`)
     in `state/api/rowcol.ts` and `state/events/paste.ts` left for the
     next touch — same "writer narrower than lib field" pattern but
     scoped out of this PR.
   - `state/api/sheet.ts::initSheetData` now delegates to the engine's
     `celldataToData(celldata, rowCount?, colCount?)` (re-exported via
     `state/api/common.ts`) instead of inlining a ~30 LOC `maxBy`/`times`/
     fill loop. The empty-grid fallback is preserved by passing
     `row != null && row > 0 ? row : draftCtx.defaultrowNum` per axis —
     matches the `row > 0 && column > 0` invalid-input guard the sibling
     `updateSheet` in `state/modules/sheet.ts:158` still uses; `??` alone
     would treat `row: 0` as "explicitly 0 rows" instead of "use default."
     Return type tightened `CellMatrix | null` → `CellMatrix`: the null-
     branch required `lastRowNum=0 && lastColNum=0` simultaneously,
     unreachable when defaults (84/60) are always > 0. The one caller that
     checked `temp !== null` (`Workbook/index.tsx:430`) simplifies to a
     direct assignment. Pre-existing "expand cell data" WHAT-comment
     dropped on touch.
   - Closes the `rowlen`/`columnlen` part of the
     `EditorSheetConfigExtras`-entry follow-up (the `rowhidden` claim was
     inaccurate — `state/types.ts:126` already had it as
     `Record<string, number>` end-to-end). `state/api/rowcol.ts::getRowHeight`/
     `getColumnWidth` local builders flipped `Record<number, number>` →
     `Record<string, number>` to match lib's canonical `rowlen`/`columnlen`;
     `state/events/paste.ts:1580` `as Record<number, number>` cast on
     `cfg.rowlen = {}` removed. Side-fixes on touch in `getRowHeight`/
     `getColumnWidth`: redundant `Number(item)` calls dropped (param is
     already `number[]`), inline `size` variable inlined, and `forEach` →
     `for-of` per the project's for-of-over-array-forEach preference.
   - Cross-area type dedup driven by a state+engine+lib type audit:
     `AncestorFormulaCell` (formula dep-graph adjacency, used by both engine
     `FormulaCellInfo` and state `FormulaCell`) was declared identically in
     `engine/types.ts` and `state/types.ts`; hoisted to engine and exported,
     state imports. `CalculationChainEntry` (engine) and `CalcChainEntry`
     (state) had the same shape modulo state's optional `index?`; unified
     under engine's `CalcChainEntry` (rename + `index?` added), four call-
     sites renamed (`engine/cell-resolver.ts`, `engine/index.ts`,
     `state/modules/formula-cache.ts`, package root `index.ts`). Local
     `FilterSelect` type in `state/modules/rowcol.ts:15` was a shadow of
     lib's `SingleRange`; dropped, `FilterObj` uses `SingleRange` directly.
     Side-fixes on touch in `state/types.ts`: `Sheet.luckysheet_selection_range`
     and `Sheet.filter_select` field types flipped from inline
     `{ row: number[]; column: number[] }` to `SingleRange[]` /
     `SingleRange` — same lib shape, three fewer inline declarations.

   **Group F `@ts-expect-error` sites — closed on `biome-state-cleanup`
   (2026-05-11):** all 12 directives in `state/` + `components/Workbook` are
   gone (the original TODO listed sites that had already been resolved during
   the state cleanup; the surviving 12 became 0).
   - `inline-string.ts::removeClassWidthCss` — `attrToCssName` is now `as
     const` + a typed `isStyleAttr` predicate.
   - `modules/cell.ts::setCellValue` `delete cell.v` — narrowed via
     `cell != null && isPlainObject(cell)` (runtime guard, no `!`).
   - `modules/cell.ts::isAllSelectedCellsInStatus` — parameter is now
     `StyleAttr`; the CSS DOM key indexes through a typed
     `cssDomKeyForAttr` map (`keyof CSSStyleDeclaration`) instead of
     `camelCase(attrToCssName[attr])`.
   - `modules/cell.ts::getFontStyleByCell` — parameter widened to
     `Cell & UnderlineHints`; loop iterates the explicit `STYLE_KEYS`
     literal (`as const satisfies readonly StyleAttr[]`); the lodash
     `forEach` is gone; underline default fontSize = 10.
   - `events/mouse-cell.ts` / `events/mouse-header.ts` — formula-range
     anchor lookup uses `Array.from<Node>(siblings).indexOf(anchorParent)`
     after widening `anchorParent` to `Node | null` (bypasses the lib.dom
     ChildNode/ParentNode overlap check).
   - `components/Workbook/index.tsx::onPaste` — IE-legacy
     `window.clipboardData` fallback removed (modern browsers always set
     `e.clipboardData` for paste handlers).
   - Broken window fixed on touch: `ConditionFormat/ManageRules.tsx`
     dropped its local `Rule` subset type and `as Rule[]` cast, now
     narrows per `ConditionalFormatRule` variant (`default` / `dataBar` /
     `colorGradation` / `icons`) for both the swatch and the description.

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

6. **`from-xlsx.ts::parseA1` duplicates engine's `parseA1`** — ✅ done on
   `biome-state-cleanup` (2026-05-11). Replaced the private `parseA1` +
   `parseRange` helpers with engine's `parseA1Range` from
   `@workspace/fortune-sheet/engine`; `buildMergeStructures` now destructures
   `{ start, end }` with `row`/`col` fields instead of
   `{ top, left, bottom, right }`. ExcelJS's `worksheet.model.merges` always
   normalises to plain `"A1:B2"`-style ranges, so the engine's wider acceptance
   (`$`-absolute refs, sheet prefixes, single-cell input) doesn't change xlsx
   behaviour. Adjacent broken-window flips: two `Array.prototype.forEach` loops
   in the same file converted to `for-of` with `.entries()`. Test at
   `apps/api/src/test/sheets-import.test.ts:209` continues to pass.

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

9. **JSDoc sweep across `state/`** — ✅ done on `biome-state-cleanup`
    (2026-05-11). Removed the only remaining `@param`-style JSDoc block
    (`state/modules/rowcol.ts::insertRowCol`) plus 8 other `/** */` TSDoc-style
    blocks across `state/events/mouse-{drag,header,resize}.ts` and
    `state/modules/rowcol.ts`. Most were WHAT-style restatements of the
    function name; the `mouse-header.ts` block was a duplicated WHY comment
    that the variable names already convey. One genuine WHY
    (`context/modal.tsx::ModalOptions.modal`) converted to `//` form to keep
    the "stays interactive" note while dropping the JSDoc syntax. Net –40 LOC
    across 6 files. Zero `/** */` blocks remain in the package source.

10. Move package to `apps/sheets/src/fortune-sheet/` — only `apps/sheets/`
    consumes it. Low priority, rename-only with no code impact.

### Carry-overs from earlier review passes

11. **`applyInsert` / `applyDelete` deep-clone the full target sheet** —
    `cloneDeep(target)` at `engine/rowcol.ts:187,393` clones every field
    (state-only fields included) when the engine writes only `data`, `config`,
    and `luckysheet_conditionformat_save`. State wrapper then mutates the
    state-only fields, throwing away the wasteful clone. Profile first; only
    optimize if row/col ops show up hot.

12. **`events/keyboard.ts:F4` — dead keybinding** — the F4 branch in formula
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
