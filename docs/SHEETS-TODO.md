# packages/sheet — full-package audit & cleanup TODO (2026-07-11)

**Status: findings complete, no fixes applied yet.** Work the phases at the bottom in order;
mark items done inline as they land.

Global quality overview of `packages/sheet` (~67k lines incl. tests; ~53k non-test across 168
files): duplication, dead code, over-engineering, robustness, simplification. Six parallel
auditors read every non-test file (engine, state modules ×2, state core/events/render/api/locale,
components, cross-cutting sweeps); all high-impact claims are grep- or read-verified, and the
bug-level findings were re-verified by hand in the main session.

## Verdict

The fork is in much better shape than its size suggests. The hard structural work has landed and
held: **zero `as any`** outside the generated grammar parser, a genuinely pure `engine/` (no
state/DOM/React imports, verified), no `lib → sheet` inversions, no duplicated utilities between
`sheet` and `lib`, all dialogs/menus on shared shadcn primitives, all 8 runtime deps used. The
`state/render/` pipeline, `utils/patch.ts`, `filter.ts`, and `searchReplace.ts` read like owned,
modern code.

What remains is concentrated and legible:

1. **Three small real bugs** (fix now, trivial).
2. **A well-defined dead-code layer** — ~35 unused imperative API methods, dead engine exports,
   ~250 dead locale lines, ~470 commented-out inherited lines.
3. **Five large luckysheet-era clone clusters** (row-vs-col / direction copy-paste) that account
   for most of the package's excess size and risk.
4. **Zero test coverage exactly where the assertion density is highest** (`state/events/`,
   especially `paste.ts`).

---

## A. Confirmed bugs (small, fix now)

| # | What | Where | Evidence |
|---|------|-------|----------|
| A1 | Doubled guard makes a cell's own background unreachable in HTML export | `src/state/modules/cell.ts:1116-1127` | `if (checksCF?.cellColor) { if (checksCF?.cellColor) {…} else {… style.background = value }}` — inner `else` arms can never run, so `getStyleByCell` → `rangeValueToHtml` (copy-as-HTML) drops plain cell backgrounds. Hand-verified. |
| A2 | `escapeScriptTag` closing-tag replace missing `/g` | `src/state/utils/index.ts:80` | `.replace(/<script>/g, …).replace(/<\/script>/, …)` — only the first `</script>` is escaped; result feeds `innerHTML` in `InputBox.tsx:91` and `FxEditor/index.tsx:67`. Hand-verified. |
| A3 | `toNumber` mis-parses scientific notation | `src/engine/parser/helper/number.ts:24` | `"1e3"` has no `.` → `parseInt("1e3")` → `1`. Use `Number(value)`. |

**Decide-first (behavior changes, not straight bugs):**

- **CF comparison rules don't coerce thresholds** — `engine/conditional-format.ts:272-284`.
  `greaterThan`/`lessThan` compare `cell.v > conditionValue0` with the raw form string, while the
  `between` branch deliberately does `Number(...)` (`:294`). Numeric-looking text cells compare
  lexically. Pick one convention (the `between` one).
- **`=`/`<>` formula operators use strict `===`** — `engine/parser/evaluate-by-operator/operator/equal.ts:5`.
  Excel's `=` is coercing and case-insensitive (`"A"="a"` → TRUE, `1="1"` → TRUE). May be accepted
  formulajs parity; confirm against the templates we care about.
- **`moveCells.ts:214,261` throws raw `Error(locale_drag.noMerge)` out of an immer reducer** for an
  expected user action (drag would split a merge), leaving the draft mid-mutation and surfacing as
  an uncaught error. Siblings use `ctx.warnDialog = …; return;` — do the same.

## B. Dead code (delete list)

All grep-verified across `packages/` + `apps/` (excluding tests); spot-checks re-run by hand.

**B1. Imperative Workbook API — ~35 of ~50 methods have zero callers** (`src/components/Workbook/api.ts:51-352`).
Dead: `getCellValue, setCellValue, clearCell, autoFillCell, freeze, insertRowOrColumn,
deleteRowOrColumn, hideRowOrColumn, showRowOrColumn, setRowHeight, setColumnWidth, getRowHeight,
getColumnWidth, getSelection, getFlattenRange, getCellsByFlattenRange, getSelectionCoordinates,
getCellsByRange, getHtmlByRange, setCellValuesByRange, setCellFormatByRange, cancelMerge, getSheet,
addSheet, deleteSheet, updateSheet, activateSheet, setSheetName, setSheetOrder, scroll,
addPresences, removePresences, calculateFormula, dataToCelldata, celldataToData, batchCallApis`.
Live set (~16): `applyOp, getAllSheets, mergeCells, setSelection, setCellFormat, insertImage,
remove/replaceImageMediaName, undo, redo, getFlowdata, searchAll, set/revealSearchHighlights,
replace, replaceAll`. This is owned code serving one app, not a published library. Deleting
`batchCallApis` also removes the package's only `as unknown as` cast (`api.ts:343`).

**Decision (Reinder, 2026-07-11): delete, don't expose.** These are not missing capability —
almost all are one-line wrappers over `state/api/`/`state/modules/` functions that stay (they're
what the UI calls, and `state/api` has its own tests). The dead layer is fortune-sheet's
published-library remote control; Eigen's app drives the workbook through the UI and through
`applyOp` (the op stream). An exposed method is an untested promise (Workbook-level coverage is
~zero), and resurrecting any wrapper later is a three-line diff since `state/api` remains. If a
real programmatic consumer arrives (scripting/macros, AI agent), design that surface
deliberately — almost certainly op-based like `applyOp` — rather than keep this grab bag.
`batchCallApis` goes unconditionally.

**Exception — presence is a half-finished feature, not dead code.** `addPresences` /
`removePresences` have no callers, but `SheetOverlay/index.tsx:644` fully renders collaborator
cursors from `context.presences` — nothing ever feeds it. Unlike the other methods this is
user-visible value the product lacks (live cursors in shared sheets). Split it out of the
cleanup as its own decision: **wire it up** (Yjs awareness → `addPresences`; small, well-defined
job — preferred, since sheets is a collab editor) **or remove renderer + API pair together** so
no half-feature lingers. Do not delete the pair as part of the dead-surface trim.

**B2. Engine dead exports** — `detectCycle` (`engine/dependency-graph.ts:54`, exported from both
barrels, zero callers, and internally uses a color convention that contradicts its own file);
`parseA1` (`engine/a1-notation.ts:37`; only `parseA1Range` is used); `CellResolver.getRange`
(interface `engine/types.ts:88` + impl `cell-resolver.ts:19`, no caller);
`FormulaEngine.recalculateAll` + `getDependencies` + `format` + `resetState`
(`engine/formula-engine.ts:161-280`, ~90 lines, production-dead — only a test pins them;
production uses `engine.evaluate`). Delete or promote deliberately.

**B3. Engine barrel over-exports** — of ~40 value exports on `@workspace/sheet/engine`, only ~14
are consumed outside the package (`columnIndexToLabel, createArrayResolver, createDefaultSheets,
evaluateConditionalFormat, FormulaEngine, functionCopy, iscelldata, parseA1Range, quoteSheetName,
rowIndexToLabel, replaySheetsOps, toA1, unquoteSheetName, update`). Trim the rest
(`cfSplitRange, getCalculationOrder, celldataToData, operatorjson, …`) to internal, per the
"barrel exports = public surface" rule. `getColorGradation` and `detectAbsolute` are
internal-only too.

**B4. State dead code** — `isdatatype` (`state/modules/validation.ts:30`, zero callers; the
`.date` branch of `isdatatypemulti` is likewise never read); `invalidateCFCache`
(`conditionFormat.ts:214`, orphaned — the cache self-invalidates on identity change);
`chatatABC` (`state/utils/index.ts:165-218` — live body is byte-identical to
`indexToColumnChar:45-53`, plus 38 commented lines; repoint `searchReplace.ts:53`);
`matchesFilterCondition` (`filter.ts:431`, test-only wrapper); dead params
`changeSheet(_isPivotInitial, _isNewSheet, _isCopySheet)` (`sheet.ts:31`), `hasPartMC(_cfg)`
(`validation.ts:47`), `setConditionRules(_protection, _generalDialog)` (`conditionFormat.ts:54`),
and the `_r/_c/_dynamicArray_compute` trio threaded through
`isFunctionRange`/`checkSpecialFunctionRange` (`formula-exec.ts:46-204`); inert `checksAF`
threading in `cell.ts:1053-1146` (hardcoded `[]`, guards can never fire).

**B5. Dead locale sections** — `state/locale/en.ts` is 9,870 lines; 88.7% is `functionlist`
(formula help data — legit, keep). But `print`, `websocket`, `alternatingColors`, `imageCtrl`,
`imageText`, `cellFormat`, `punctuation`, `dropCell` (~250 lines) have zero references, and
`pivotTable` (57 lines) is used only for `.title` (`state/utils/index.ts:13`).

**B6. Commented-out inherited code, ~470 lines package-wide** — `state/events/` alone carries
~310 (every `paste.ts` handler is prefixed with dead `isEditMode()/tooltip.info` blocks, e.g.
`:197-204`, `:375-382`; `copy.ts:41-46,81-86,109-114`); `refresh.ts:52-79` (leaving
`jfrefreshgrid` a thin wrapper whose comments describe removed behavior);
`moveCells.ts`, `sort.ts:93-106`, `merge.ts:8-11`, `selection.ts:914-948` (35-line jQuery block),
`toolbar.ts` (tooltip/isEditMode blocks). Also stale annotations: the eslint-disable above
`cancelFunctionrangeSelected` (`cell.ts:602` — it *is* used) and the outdated `O(n²) concat`
comment in `formula-exec.ts:454`.

**B7. Dead DOM placeholders** — `SheetOverlay/index.tsx:473-476,491,551,686-692`:
`luckysheet-multipleRange-show`, `luckysheet-dynamicArray-hightShow`,
`luckysheet-chart-rangeShow`, `luckysheet-row/column-count-show`, `luckysheet-cell-copy`,
`luckysheet-grdblkflowpush/grdblkpush` — never queried, no CSS. (Keep the
`luckysheet-cell-flow*` scroll surface.) Plus dead prop `ChangeColor.triggerParentUpdate`
(`ChangeColor/index.tsx:7`; sole caller passes `() => {}`).

## C. Duplication — the five big clone clusters

Ranked by size × risk. These are the classic luckysheet row-vs-col / direction copy-paste; each
is one extraction away from collapsing.

**C1. `border.ts getBorderInfoComputeRange` — one ~1,290-line function** (`state/modules/border.ts:43-1330`).
Eleven `borderType` branches each re-implement the same motif: init `borderInfoCompute[key]`,
write `{color, style}`, propagate to the merge-aware neighbour on the opposite side; the
neighbour block is pasted 12+ times. → `setSide(map, r, c, side)` + `propagateToNeighbour(...)`;
each branch becomes a short loop. Biggest single win in the package.

**C2. Selection-extension geometry pasted ~7×** across the mouse layer:
`mouse-cell.ts:178-243,369-409`, `mouse-drag.ts:79-128`, `mouse-header.ts:105-141,270-292,432-468,596-618`.
The `if (last.top > row_pre) {…} else if (===) {…} else {…}` row block + its column twin
(~40 lines/copy) computing `top/height/rowseleted/left/width/columnseleted`. A selection bugfix
currently needs 7 edits. → one `extendSelectionGeometry(...)` helper.

**C3. `dropCell.ts` direction and date-fill clones** (`state/modules/dropCell.ts`).
`updateDropCell:2136-2554` — four ~100-line `down/up/right/left` branches differing only in index
arithmetic; the number-format block appears 4×, the border push 8×. `getDataByType:933-1618`
(685 lines) — weekday roll-back inlined 6×, month/year forecast loop repeated per type,
`chnWeek2/chnWeek3` producers identical. → axis/sign-parameterized inner writer + `rollToWeekday`.
~500 lines collapse.

**C4. `selection.ts` target-duplication** — `moveHighlightCell:650-952` and
`moveHighlightRange:955-1326` each duplicate their entire body per target
(`rangeOfSelect` vs `rangeOfFormula`), incl. a ~350-line merge-walk clone. Also:
`rangeValueToHtml:1496-1578` repeats the border-side histogram 4×, and
`fixRow/ColumnStyleOverflowInFreeze:1823-1938` are exact axis twins. → operate on a common
`{row, column, focus}` accessor.

**C5. The formula tokenizer exists in triplicate** — `engine/formula-shift.ts:108`
(`functionCopy`), `:198` (`functionStrChange`), and `state/modules/formula-exec.ts:209` all
hand-roll the same char-walker (paren/quote/comma/operator state machine; the operator branch is
verbatim at `formula-shift.ts:158` and `:277`). Likewise `shiftRef:21` and
`functionStrChange_range:320` parse+reformat refs the same way. This is the trickiest string
logic in the package, maintained in 3 copies. → one `walkFormulaRefs(txt, onRef)` in the engine
+ shared `parseRef`/`formatRef`.

**Smaller pairs:** `handleNumberIncrease/Decrease` (`toolbar.ts:753-910`, ~80% identical);
the `type === 'c'` axis swap ~10× in `toolbar.ts`; `shiftStateOnlyFieldsForInsert/Delete`
mirror forks (`rowcol.ts:41-539`); verbatim 27-line unmerge loop twice in `merge.ts:41-67,106-132`;
identical magic-keycode gate in `InputBox.tsx:157-171` + `FxEditor/index.tsx:170-184` (deprecated
`e.keyCode` magic numbers, extract `shouldTriggerFormulaInput(e)`); comment-triangle drawing
duplicated in `render/cells.ts:89-98,238-247`; paste.ts internal repeats (cfSplitRange
border-clear 3×, `offsetMC` remap in all three paste handlers).

## D. Simplification / de-indirection

- **D1. Kill the `locale()` shim** — `state/locale/index.ts:3-5` is
  `function locale(_ctx) { return en; }`; 47 call sites thread a context it ignores. Replace with
  direct imports of the `en` groups; delete the wrapper. Mechanical sweep, touches ~40 files.
  Also fold the inline English `optionLabel` map in `context.ts:242-262` into one home.
- **D2. Consolidate the formula-\* module split** — six files by no clear axis. Minimum: fold
  `formulaHelper.ts` (whose functions mutate the cache class defined in `formula-cache.ts`, which
  imports them back) into `formula-cache.ts`; delete the 8-line `formula-ui.ts` barrel.
- **D3. File-naming sweep** — `state/modules/` mixes camelCase (`conditionFormat`,
  `dataVerification`, `dropCell`, `formulaHelper`, `moveCells`, `searchReplace`, `splitColumn`)
  with the kebab-case used everywhere else in the repo. Rename to kebab.
- **D4. `FormulaSearch` name collision** — the insert-function dialog
  (`components/FormulaSearch/`) vs the inline autocomplete
  (`components/SheetOverlay/FormulaSearch/`). Rename the dialog (`InsertFunctionDialog`).
  Same theme: misspelled export `setDropcownValue` (`dataVerification.ts:473`).
- **D5. es-toolkit migration is half-done** — all 54 imports use `es-toolkit/compat` (the
  lodash-shaped shim), zero use the core API. Fine functionally; finish or drop the ambition.
- **D6. Chinese-locale vestiges (product decision)** — `sort.ts:32` collates with `'zh'` (wrong
  for accented Latin; violates the explicit-`'en'` rule) and `:134` special-cases CJK cells;
  `dataVerification.ts:112-147,313` validate *Chinese* ID-card/phone formats and are reachable
  from the DataVerification dialog (`validity` type). Fix the collation; decide whether
  ID-card/phone validation should be generic or dropped.
- **D7. Engine emits a state-runtime name** — `engine/formula-utils.ts:95` hard-codes
  `luckysheet_compareWith(...)` which only resolves in the state eval sandbox. Parameterize the
  callee or move the generator to state.
- **D8. `evaluateConditionalFormat` (~380 lines)** repeats the same
  `for s/r/c` + nil-guard + numeric-check scan 6+ times across rule types
  (`engine/conditional-format.ts:82`). One `forEachCellInRanges` helper collapses most of it.
- **Minor:** no-delay `setTimeout(fn)` sequencing (`SheetTab/index.tsx:80`,
  `SheetOverlay/index.tsx:81,259`); DOM mutation inside a `setContext` recipe
  (`DataVerification/DropdownList.tsx:40`); inline style object in `context/modal.tsx:51-57`;
  `insertMenu` repeating `autoSelectionFormula` 4× where a map over
  `['AVERAGE','COUNT','MAX','MIN']` would do; `.substr()` ×4 in `cell.ts:203-224`;
  deprecated `document.execCommand` in `InputBox.tsx:126` (no clean replacement, note only).

## E. Robustness gaps

- **E1. `state/events/` has ZERO tests** while being the package's most dangerous layer:
  `paste.ts` is 1,804 lines with 49 non-null assertions (the densest in the package, e.g. the
  quadruple-stacked `x[c]!.mc!` chain at `:277-280`), mixing HTML-table parsing, style mapping,
  formula ref-adjust, and cross-sheet cut. `components/` has 1 test in 44 files. By contrast
  engine/parser and state/modules are well covered. Priority: characterization tests for
  `pasteHandler`/`handlePaste` round-trips before touching C-cluster refactors that paste depends on.
- **E2. `cfSplitRange` — 495 untested lines feeding cut/paste/move of conditional formats**
  (`engine/conditional-format.ts:465`): 16 geometric cases, ~45 hand-written range literals; an
  offset typo silently mis-shifts CF ranges. Add characterization tests first; then derive
  `operatePart`/`allPart` from `restPart` instead of triplicating literals.
- **E3. Non-null assertion hotspots** (~496 package-wide): `paste.ts` 49,
  `DataVerification/index.tsx` 49, `rowcol.ts` 33, `dropCell.ts` 25, `SheetOverlay/index.tsx` 22.
  Not urgent per se, but they cluster exactly where tests are absent.
- **E4. `FormulaCache` `unknown`-typed drag-resize fields** (`formula-cache.ts:139-153`) force
  `!`-casts at every use (`formula-range.ts:68`). Tighten per the README's own goal.
- **E5. Silent `catch {}`** in `checkSpecialFunctionRange` (`formula-exec.ts:78`) — needs a
  justifying comment or narrower handling. (Only one in the package — the events/rowcol catches
  correctly re-throw.)
- **E6. Stringly-typed DOM seams** — `mouse-drag.ts:164-240`, `mouse-resize.ts:65-121`
  (`querySelector('.fortune-change-size-line')` + direct style writes), `keyboard.ts:401-411`
  (`document.querySelector(...).focus()`). They silently no-op if markup changes. Known
  RENDERING.md leak; migrate when touching the drag previews.

## F. Documentation drift

- `README.md:20` and `keyboard.ts:446` reference **`docs/TODO-SHEETS.md`, which does not exist**
  (no git history either; note the reversed name). Repoint both to this file
  (`docs/SHEETS-TODO.md`).
- README "In-progress" list is stale: SheetTab is already fully shadcn; only **one** CSS file
  remains un-Tailwindised (`SheetOverlay/index.css` — `SheetTab/index.css` and
  `ScrollBar/index.css` no longer exist).
- `RENDERING.md` z-index table is stale: images render at z-19/20 (`ImgBoxs/index.tsx:44,109`),
  not 200/300; the DV dropdown is a portaled shadcn menu (z-50), not z-10000.
- `SheetOverlay/index.css` itself: 795 lines, ~46 hardcoded hex colors (scrollbar `#babac0`,
  selection `#018ffb`, borders `#dfdfdf`…) vs 21 theme-token uses — the one real chunk of
  un-migrated chrome, and it won't adapt to dark mode.

## G. Clean bill of health (verified — don't churn)

- `engine/` purity: zero state/component/DOM/React imports; server-safe as claimed.
- `state/render/`: clean phase decomposition, single render path, no duplication with components.
- `utils/patch.ts`: dense but every branch justified — collab-correctness core, leave it.
- Dialog scaffolding: centralized in `ModalProvider`; the suspected per-dialog duplication does
  not exist. All chrome on `@workspace/ui` primitives; `cn()` everywhere; no hardcoded Tailwind
  colors in TSX; z-indices within the documented `cellArea` carve-out.
- Type hygiene: 0 `as any`, 0 `@ts-ignore`; the 10 `: any` all carry written rationale in two files.
- No duplicate utilities within the package or against `packages/lib/sheets`; deps all used;
  `sheet → lib` one-way rule holds.
- `filter.ts`, `searchReplace.ts`, `dependency-index.ts`, `replay-ops.ts`, `a1-notation.ts`:
  genuinely owned, modern code.
- `state/api/` thin pass-throughs are the intentional public boundary, not dead duplication.
- `findrangeindex` (`formula-editor.ts:503-699`) is irreducible branching, not copy-paste.

## Suggested cleanup program

Ordered so each phase de-risks the next. Sizes are rough.

1. **Bug fixes + trivial deletes** (small, one branch): A1-A3; B4 dead functions/params;
   B7 dead DOM; stale annotations; the `merge.ts` unmerge-loop extraction.
2. **Dead-surface trim** (mechanical, medium): B1 Workbook API prune (decided: delete ~33
   wrappers + `batchCallApis`, keep `state/api` untouched, EXCLUDE the presence pair — see B1
   decision), B2 engine dead exports, B3 barrel trim, B5 locale sections, B6 commented-code
   sweep. Plus F doc refresh (README/RENDERING + resolve the TODO-SHEETS.md dangling pointer).
3. **De-indirection sweeps** (mechanical, medium): D1 `locale()` removal, D2 formula-* fold,
   D3/D4 renames, D6 `'zh'` collation fix.
4. **Test the danger zone** (before refactoring it): E1 paste round-trip characterization
   tests, E2 `cfSplitRange` characterization tests.
5. **The clone-cluster refactors** (largest payoff, do behind the new tests, one cluster per
   branch): C1 border, C2 selection geometry, C3 dropCell, C4 selection targets, C5 tokenizer.
   Pure-refactor gate: replay-ops/API tests + pixel-identical screenshots per VERIFICATION.md.
6. **Optional/decide**: CF coercion + `=` semantics (A-decide items), DataVerification
   ID/phone validators (D6), es-toolkit core migration (D5), `SheetOverlay/index.css`
   Tailwind/token migration (F), **presence: wire Yjs awareness → `addPresences` (preferred)
   or remove renderer + API pair** (see B1 decision).
