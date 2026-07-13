# Sheets — TODO

Single source of truth for all remaining sheets work (`packages/sheet`, `apps/sheets`, xlsx
import/export). Everything below is open backlog.
Direction decided 2026-07-12: behave like Excel/Google Sheets wherever the two agree.

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
- [ ] HTML paste: inline `text-decoration:underline` on a td is never read into `cell.un` — only
      the `<style>` class block is consulted, so WPS/Excel inline underline is silently dropped
      (characterized in `paste-html.test.ts`)
- [ ] HTML paste: the `<style>` class-block parser assumes TAB-indented property lines
      (`nameReg = /^[^\t].*/gm`); space-indented clipboards (both committed fixtures!) parse to an
      empty style map, so class-based styling may be dead for real Excel-for-Mac paste — confirm
      real clipboard indentation, then fix the parser or drop the dead path
- [ ] HTML paste: a `<tr>` without a `height` attribute writes `rowlen[targetR] = null`
      (`paste.ts` `targetRowHeight as number`), potentially nulling pasted-row heights
- [ ] `iscelldata` rejects absolute whole-row ranges (`$1:$3`) — stray `s` in `reg_cellRange`
      (`engine/formula-utils.ts`); F4-cycling a whole-row ref sticks after one step
      (pinned in `formula-reference-cycle.test.ts`)

## 5. Rendering

- [ ] sheet dark mode — future dark pass, chrome-side only. The workbook surface (canvas + headers +
      overlays) is already pinned light and renders pixel-identically in light/dark via the
      `.eigen-paper` convention in `globals.css`. What's left: adopt `.eigen-paper` on the docs page —
      it still pins itself with literal `bg-white text-black`, so token-driven visuals inside it (e.g.
      the `--warning` search highlights) still flip in dark mode. Needs its own pixel gate (changes
      docs dark search-highlights)

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
- [ ] operator-family seam: `=`/`<>` are coercing + case-insensitive (2026-07-12), but `<` `>`
      `<=` `>=` still raw-JS coerce — blank `A1>=0` is TRUE while `A1=0` is FALSE, and `"A"<"a"`
      is TRUE alongside `"A"="a"` TRUE. Decide + implement Excel-parity ordering semantics
      (`engine/parser/evaluate-by-operator/operator/{greater,less}-than*.ts`)
- [ ] `normalizeMonthMinuteTokens` (xlsx import) diverges from numfmt's classifier on three
      pathological formats (`;` consumed by a `_x` skip, `_\x` 3-char skip/fill, `B1`/`B2`
      calendar markers). Rendering is provably unaffected (numfmt classifies case-insensitively);
      worst case is a mislabeled dialog chip — align the port if exactness ever matters

## 7. App / architecture

- [ ] move the sheets toolbar onto the shared `ColumnLayout` chrome (currently the engine's own
      MenuBar; the one app not on the shared layout)
