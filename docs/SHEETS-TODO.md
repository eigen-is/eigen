# Sheets — TODO

Single source of truth for all remaining sheets work (`packages/sheet`, `apps/sheets`, xlsx
import/export). Groups 1–2 are decided and ready to execute; the rest is open backlog.
Direction decided 2026-07-12: behave like Excel/Google Sheets wherever the two agree.

## 1. Small bugs + decided behavior changes (do first, one branch)

Bugs:

- [ ] border-slash applies `borderRange[0]` to every selected range — use `borderRange[j]`
      (`state/modules/border.ts`, NOTE in code)
- [ ] `functionStrChange`'s unary-minus predecessor scan skips a char (reads `i-2`; preserved as
      `skipPrevChar` in `engine/formula-shift.ts`) — unify both walkers on read-`i-1`, drop the flag
- [ ] drag-fill number-format handling is direction-asymmetric: only `down` keeps an existing
      `ct` and applies the `##0.00` mask, which emits garbage like `"2.5.00"` — make all four
      directions consistent (keep `ct`, fix the mask) (`state/modules/drop-cell.ts`, `isDown`)
- [ ] name box shows `A1:NaN` on initial sheet load, before any selection
- [ ] imported lowercase `mm` date patterns show "Minute" chips in the custom date/time dialog
      (tokenizer follows Google's `M` month / `m` minute); switching a variant on a mislabeled
      chip writes minutes where months were
- [ ] `top10` CF evaluation is O(n²) (`indexOf` over the sorted slice per cell) — use a `Set`
- [ ] silent `catch {}` in `checkSpecialFunctionRange` (`state/modules/formula-exec.ts`) —
      justify with a comment or narrow the handling
- [ ] `cfSplitRange` silently returns `[]` for an unknown `type` (a caller typo would drop all
      CF ranges) — throw instead (`engine/conditional-format.ts`; behavior pinned in tests)

Decided behavior changes (Excel/Google parity):

- [ ] CF comparison rules must coerce thresholds with `Number()` like the `between` branch
      already does (`engine/conditional-format.ts` greaterThan/lessThan and peers)
- [ ] formula `=` / `<>` become coercing and case-insensitive (`"A"="a"` → TRUE, `1="1"` → TRUE)
      per Excel (`engine/parser/evaluate-by-operator/operator/equal.ts` + notEqual)
- [ ] `moveCells` raises a raw `throw Error(drag.noMerge)` out of an immer reducer for an
      expected user action — use `ctx.warnDialog` like its siblings (`state/modules/move-cells.ts`)
- [ ] delete the Chinese ID-card/phone validators (`state/modules/data-verification.ts`
      `identificationNumber`/`phone` + their DataVerification dialog entries)
- [ ] remove the CJK special-case in sort (`state/modules/sort.ts` ~:134) — plain `'en'`
      `localeCompare` for all text

## 2. Presence (decided: wire it up)

- [ ] Feed Yjs awareness into `WorkbookInstance.addPresences`/`removePresences` —
      `SheetOverlay` already fully renders collaborator cursors from `context.presences`;
      nothing ever feeds it. Small, well-defined job; delivers live cursors in shared sheets.

## 3. xlsx round-trip fidelity backlog

- [ ] filter **criteria** import/export (`customFilters`/`top10`/`dynamicFilter`/`colorFilter`):
      the condition model exists (`FilterEntry.byCondition`) but exceljs only exposes the
      autofilter range — needs raw-XML read/write of `<filterColumn>` children
- [ ] CF `stopIfTrue` is ignored; Excel's aboveAverage stdDev/equalAverage sub-variants map to
      plain above/belowAverage
- [ ] DV `allowBlank` dropped at import (no engine field); error/prompt titles and custom error
      text dropped too (engine generates its own copy)
- [ ] range-keyed `dataVerification` (mirroring CF's `cellrange`): removes the DV import clamp,
      silent truncation past the extent, per-snapshot rule duplication, the dialog's per-cell
      expansion loop, and the `checkboxChange` rule-aliasing hazard. Sheet-JSON format is free
      to change (dev-only carve-out); realistically its own cycle
- [ ] Excel outline groups (`outlineLevel` row/col grouping + collapse buttons) not imported
- [ ] borders on value-less non-merge cells don't import (`from-xlsx` returns on `isEmptyCell`
      before `convertBorder`; merge constituents bypass via `anchorByCell`)
- [ ] rich-text runs flatten to a single string at import (export already writes `ct.s` runs)
- [ ] defined names are dropped (formulas referencing names break) — decide inline-resolve at
      import vs real support
- [ ] hidden column inside a filter range: the drawn button state can belong to a different
      column than the one a click opens (only when the hidden column has an active filter)
- [ ] filter-menu date condition input is a plain text field — needs a date picker
- [ ] by-values checkboxes stay visible (and ignored) while a condition is active on a column —
      resolve in the Google-parity filter-menu redesign (accordion makes the active mode explicit)

## 4. Tests + gated refactors

- [ ] HTML-table paste branch (`pasteHandler`'s CellMatrix arm in `state/events/paste.ts` — the
      third copy of the offsetMC/merge remap) has zero test coverage; it is DOM-bound and bun
      test has no DOM. Add a browser probe or DOM-capable test BEFORE any refactor touches it
- [ ] `cfSplitRange`: derive `operatePart`/`allPart` from `restPart` instead of triplicating
      ~45 range literals (characterization tests are in place)
- [ ] `evaluateConditionalFormat` (~380 lines) repeats the same per-cell scan 6+ times across
      rule types — one `forEachCellInRanges` helper collapses most of it (engine tests exist)
- [ ] server-side recalc: batch-evaluate replayed formulas (`getCalculationOrder` +
      `engine.evaluate`; seam described in `docs/SHEETS.md` § Remaining Work) so exports and the
      search index serve fresh values instead of last-saved `cell.v`

## 5. Rendering

- [ ] lock the body overlays (selection box, cell editor, presence, fill handle) to the scroll
      bus like the headers — they scroll natively and drift ~1 frame from the canvas during
      fast/ProMotion scrolls (`RENDERING.md` § Scrolling)
- [ ] the same overlays must CLIP below frozen panes — the headers already do this correctly,
      so reuse (and share) that logic
- [ ] `SheetOverlay/index.css`: 795 lines, ~46 hardcoded hex colors vs 21 theme-token uses —
      migrate to theme tokens (prerequisite for dark mode)
- [ ] F4 in cell editing should cycle the reference at the caret (A1 → $A$1 → A$1 → $A1 → A1);
      currently only the browser default is suppressed (`state/events/keyboard.ts`)

## 6. Code debt (opportunistic — fix when touching the area)

- [ ] es-toolkit migration half-done: all 54 imports use `es-toolkit/compat`, zero use core —
      finish or drop the ambition
- [ ] non-null-assertion hotspots (~450): `paste.ts`, `DataVerification/index.tsx`, `rowcol.ts`,
      `drop-cell.ts`, `SheetOverlay/index.tsx` — tighten alongside future work there
- [ ] `FormulaCache` `unknown`-typed drag-resize fields force `!`-casts at every use
      (`formula-cache.ts` / `formula-range.ts`)
- [ ] stringly-typed DOM seams: `mouse-drag.ts`/`mouse-resize.ts` querySelector + direct style
      writes, `keyboard.ts` document.querySelector().focus() — migrate when touching drag previews
- [ ] engine emits a state-runtime name: `engine/formula-utils.ts` hard-codes
      `luckysheet_compareWith(...)` which only resolves in the state eval sandbox — parameterize
      the callee or move the generator to state
- [ ] grammar parser regeneration from upstream jison (`engine/parser/grammar-parser/` — the
      sole remaining `as any` area)
- [ ] CF formula-evaluator wiring duplicated (8 lines) between
      `state/modules/condition-format.ts` and the HTML export's `buildCfFormulaEvaluator` —
      extract a shared helper if a third consumer appears
- [ ] deprecated `document.execCommand` in `InputBox.tsx` (no clean replacement yet; revisit)
- [ ] minor tidy-ups: no-delay `setTimeout(fn)` sequencing (`SheetTab`, `SheetOverlay`), DOM
      mutation inside a `setContext` recipe (`DataVerification/DropdownList.tsx`), inline style
      object in `context/modal.tsx`, `insertMenu` repeating `autoSelectionFormula` 4×,
      `.substr()` ×4 in `cell.ts`

## 7. App / architecture

- [ ] move the sheets toolbar onto the shared `ColumnLayout` chrome (currently the engine's own
      MenuBar; the one app not on the shared layout)
