# Sheet Package TODO

Pending work for `packages/sheet/`. The package is a full fork of
fortune-sheet + luckysheet — no external `@fortune-sheet/core` dependency.
Treat it as **owned code**: fix broken windows when touching it, prefer
modern patterns over preserving legacy.

For architecture see [SHEETS.md](SHEETS.md). For component layering see
[`packages/sheet/RENDERING.md`](../packages/sheet/RENDERING.md).

---

## Outstanding

### Core technical debt

1. **CSS migrations** — 3 files remain (size verified 2026-04-28); then delete
   `src/css.d.ts`:
   - `SheetOverlay/index.css` (812 LOC, largest — split into multiple PRs).
   - `SheetTab/index.css` (272 LOC).
   - `SheetOverlay/ScrollBar/index.css` (40 LOC).
   Before removing any class, grep `state/` for `luckysheet-*` selectors — see
   [DOM Selector Coupling](#dom-selector-coupling).

2. **Regenerate `engine/parser/grammar-parser/grammar-parser.ts`** from upstream
   jison rather than hand-editing. Currently biome-excluded. No urgency. The
   only remaining `export default` lines in the package live under
   `engine/parser/` and will be regenerated together.

   ⚠️ Manual fix in `case 1` (top-level Formula production): undefined result
   is coerced to `0` so Jison doesn't surface its `return true` accept-state
   sentinel as the formula value for bare-ref formulas to empty cells (e.g.
   `='Sheet'!B13`). Any regen must reapply this — see commit `e0fe9990`.

### Server-side features

3. **xlsx CF export** — `apps/api/src/lib/export/sheets/xlsx.ts` doesn't write
   conditional-format rules. Translate the package's rules into ExcelJS native
   `worksheet.addConditionalFormatting` so Excel evaluates them on file open
   (no formula engine needed for xlsx — Excel does it natively). The
   `ConditionalFormatRule` discriminated union (engine + lib) gives the rule
   shape needed to introspect each rule type.

4. **Server-side recalc in `readSheetContent()`** — engine API ready
   (`engine.recalculateAll(resolver)`); `apps/api` consumer just needs the
   wiring. Defer until export, search indexing, or scripting actually needs
   fresh values; today the consumer reads the last-saved `cell.v` from the
   snapshot, which is fine. See [SHEETS.md § Headless Formula Engine](SHEETS.md#headless-formula-engine).

5. **PDF export computes `buildBorderMap` + `getGridBounds` twice per sheet** —
   `apps/api/src/lib/export/sheets/pdf.ts` calls `getSheetContentSize(sheet)`
   for every sheet (which builds the border map + grid bounds), then calls
   `renderSheetsHtml(sheets)` which calls `renderSheet` → `buildBorderMap` +
   `getGridBounds` again per sheet. Border-info iteration is O(borderInfo
   entries × cells); on dense workbooks this doubles the export work for no
   benefit. Either pre-compute bounds once and pass through, or expose a
   combined `{html, sizes}` from `html.ts`.

### Polish

6. **`SheetTab` shadcn migration** — bottom tab bar
   (`components/SheetTab/index.tsx` + `SheetItem.tsx`, ~580 LOC TSX) still
   has its own ~272 LOC `index.css` (also part of TODO #1's CSS migration —
   tackle them together). Add/delete/rename/hide/color all use bespoke
   styling and dropdowns; should adopt shadcn `DropdownMenu` (rename, color,
   hide, etc.) and `Tailwind` for layout. Drag-and-drop reorder + scroll
   buttons can stay as plain buttons. `ContextMenu/SheetTab.tsx` (the
   right-click on a tab) already uses shadcn — only the tab bar itself needs
   the pass.

7. **`applyInsert` / `applyDelete` deep-clone the full target sheet** —
   `cloneDeep(target)` at `engine/rowcol.ts:187,393` clones every field
   (state-only fields included) when the engine writes only `data`, `config`,
   and `conditionalFormatRules`. State wrapper then mutates the state-only
   fields, throwing away the wasteful clone. Profile first; only optimize if
   row/col ops show up hot.

8. **`events/keyboard.ts:F4` — dead keybinding** — the F4 branch in formula
   edit mode just `preventDefault()`s. Standard spreadsheet F4 should cycle a
   formula reference `A1` → `$A$1` → `A$1` → `$A1` → `A1`. Treated as feature
   work (DOM-walk the formula editor, parse the reference under the caret,
   cycle `$` markers, restore selection), not a bug fix — separate effort.

---

## Mount-cost reduction follow-up

Branch `perf/sheets-mount` (4 commits, 2026-05-27) cut a 16-sheet/125k-formula
xlsx import open from ~60 s to ~9 s in the browser by attacking the four
slowest mount steps:

1. `calculateSheetFromula` was O(formulas²) — `setCellValue` + `insertUpdateFunctionGroup`
   each linear-scanned `calcChain` on every formula cell. Rewritten to rebuild
   `calcChain` in one pass and write values via `setCellValueInternal`. ~33 s → ~1 s.
2. `cloneDeep(originalData)` at `Workbook/index.tsx:389` deleted — Workbook takes
   ownership; immer auto-freezes the result tree on finalize, no external mutator
   survives. ~900 ms saved.
3. Mount-time `api.calculateFormula(draftCtx)` replaced with `api.seedCalcChain(draftCtx)`
   — same calcChain population, no engine eval. ~1 s saved on this file. Cached
   values from the xlsx import (or the previous flush) are used as-is; first edit
   triggers per-sub-graph recompute via `execFunctionGroup`.
4. Grammar-parser `case 1` bug (above): bare-ref formulas to empty cross-sheet
   cells were returning `true`. Surfaced once (3) stopped masking it. Coerce
   undefined→0 at the top-level Formula production.

### Where the remaining ~9 s sits (not yet measured in browser)

Bun-side simulation has the post-step-3 produce body at ~870 ms. Browser is ~3–5×
slower, plus React commit + canvas first paint. Suspects, no measurements yet:

- `JSON.parse` on the 48 MB snapshot string (~600 ms projected in browser).
- 48 MB `originalData` object held in memory until GC; allocations are not free.
- Per-cell style attrs repeated everywhere — see size breakdown below.
- `calcRowColSize` walks every row + every column once on first paint to build
  cumulative size maps (Explore agent flagged this).
- React commit on 16 SheetTabs + Workbook tree.

`packages/sheet/probe-xlsx.ts` (untracked) does the produce-side bench end-to-end.
`packages/sheet/probe-size.ts` (untracked) breaks down where the 48 MB go. Both
expect `test.xlsx` at repo root. Keep around as a regression check.

### Where the 48 MB JSON goes (from `probe-size.ts`)

```
xlsx (compressed):                       2.22 MB
JSON snapshot:                          47.82 MB   (21.6× xlsx)
gzipped JSON:                            1.98 MB   (already on the wire via
                                                    perMessageDeflate at
                                                    apps/api/src/routes/collab.ts:41)

cells:                                  28.19 MB
  of which per-cell style attrs:        17.29 MB   (ff/fc/bg/fs/ht/vt/...)
  of which formula text:                 2.96 MB
  of which redundant .m=.v:              0.31 MB
borderInfo arrays:                      19.27 MB
other config + sheet shells:             0.36 MB

top 5 style signatures account for ~200k of 340k cells:
  65 906 × {"ff":"Inter","fc":"#000000","fs":10,"ht":0,"vt":0}
  36 252 × {"ff":"Inter","fc":"#000000","fs":10,"ht":2}
  33 894 × {"ff":"Inter","fc":"#000000","ht":0,"vt":0}
  31 504 × {"ff":"Inter","fc":"#000000","bg":"#F3F3F3","ht":0,"vt":0}
  30 806 × {"ff":"Inter","fc":"#000000","bg":"#FFFFFF","fs":10,"ht":2}
```

### Next step (when this session resumes) — Option 1 + Option 2d combined

The highest-leverage pairing for first-paint latency:

- **Pool styles + borderInfo into per-sheet tables (Option 1).**
  Build a `styles: CellStyle[]` and `borders: BorderBox[]` table per sheet at
  xlsx-import time. Cells carry an `s: number` / `b: number` index instead of
  inlined `ff/fc/bg/fs/ht/vt/...` and inlined border-corner objects. Style
  mutation appends a new entry (no in-place compaction).

- **Switch the Yjs snapshot to one entry per sheet (Option 2d).**
  Replace `state.snapshot: string` (one 48 MB JSON) with
  `state.snapshots: Y.Map<sheetId, string>` (one JSON per sheet). Editing one
  sheet only rewrites that sheet's entry. Reduces flush churn dramatically.

- **Hydrate only the active sheet on mount.**
  With per-sheet snapshots, `use-sheet.ts` can lazy-parse only the currently
  visible sheet on first sync; others parse on tab-switch. First paint becomes
  bounded by active-sheet size, not total doc size.

- **Result projection on `test.xlsx`:** active sheet (MASTER DATA) is 24 MB raw.
  Pooled → ~7 MB. Parse cost → ~70 ms in browser. First paint should land
  comfortably under 1 s.

#### File list for Option 1 (where the diff lands)

- `packages/lib/src/sheets/types.ts` — `Sheet` gains `styles?: CellStyle[]` and
  `borders?: BorderBox[]`; `Cell` gains optional `s?: number`, `b?: number`.
- `apps/api/src/lib/import/sheets/from-xlsx.ts` — build the tables during import;
  emit indexes per cell. The `theme` palette concept already exists, fits the
  same pattern.
- `packages/sheet/src/state/canvas.ts` — every `cell.<styleAttr>` read becomes
  `style[cell.s].<attr>` via a resolver. ~30–40 read sites.
- `packages/sheet/src/state/modules/cell.ts` — `setCellValue`'s style-update
  branches: append-and-repoint to the styles table instead of in-place attr write.
- `packages/sheet/src/components/Workbook/index.tsx` — wire the resolver into
  the context if needed.
- Engine: zero changes (engine doesn't touch style attrs).
- Tests: extend `state/test/api/cell.test.ts` for the new mutation pattern;
  `from-xlsx` test for the new schema.

#### File list for Option 2d (per-sheet snapshots)

- `apps/api/src/lib/document/sheets.ts` — `readSheetsContent` reads each
  `snapshots.get(sheetId)` instead of one `snapshot`. `writeSheetsToYjs` writes
  one entry per sheet. Op format already has sheet id, no Op change needed.
- `apps/sheets/src/components/sheets/hooks/use-sheet.ts` — initial sync hydrates
  only the active sheet from `snapshots.get(activeId)`. Tab-switch reads on demand.
  `stateMap.observe(...)` becomes a per-key observer.
- `packages/sheet/src/components/Workbook/index.tsx` — accept a `hydrateSheet`
  callback; render placeholder for un-hydrated sheets.
- Migration: pre-release per
  [project_eigen_pre_release_no_migrations.md](memory). Existing imports must
  be re-imported; not a problem for dev.

### Other levers considered (and why deferred)

- **`Y.Map<Map<Cell>>` (Yjs-native cell tree)** — kills the snapshot+ops model,
  but every canvas paint reading through Yjs proxies would be measurably slower.
  Not the right tool for the sheet engine's hot path.
- **Snapshot blob outside Yjs (in mount storage), Yjs only carries ops** —
  cleanest architecturally, but the biggest single refactor (two-phase load,
  versioned blob ↔ ops consistency). Defer until Option 1+2d isn't enough.
- **Web Worker for the engine** — bigger win after first paint is fast. Engine
  resolver currently has no DOM coupling so it could be worker-safe with effort.
- **Stream-parse JSON** — niche. With pooling the JSON is small enough that
  blocking JSON.parse is acceptable.

### Before the next session

- [ ] Browser instrumentation: drop `performance.mark` / `performance.measure`
      calls into `use-sheet.ts` (WS sync → snapshot fetch → parse → setInitialData)
      and `Workbook/index.tsx` (effect entry → seedCalcChain → exit) so we get
      a real flame-graph breakdown of the ~9 s. Without it we're optimizing on
      Bun-side estimates.
- [ ] Decide whether Option 1 lands first as its own PR (independent win, doesn't
      need 2d to ship), or in lockstep with 2d (smaller follow-up diff if the
      data shape changes together).
- [ ] Investigate the "89% no-cached-value from exceljs" finding in MASTER DATA
      (probe-compare.ts). Independent of perf; affects correctness for
      "lazy recompute after import" any future scenario where mount-time
      recompute is fully removed for refreshes too.

---

## Architecture & invariants

### Engine boundary

`engine/` is pure, DOM-free, and has zero imports from `state/`. State imports
freely from engine. Server-side consumers (`apps/api`) import from the
`@workspace/sheet/engine` subpath export, which restricts type-checking
to the engine subset — keeps `verbatimModuleSyntax` + `noUnusedParameters`
happy.

The boundary is deliberate. Pure formula evaluation, CF rule evaluation, ref
shifting (`functionCopy`), parsing, dependency graph, formatting — all engine.
Context-coupled orchestration (`execFunctionGroup`, `groupValuesRefresh`,
`insertUpdateFunctionGroup`, `getAllFunctionGroup`) lives in
`state/modules/formula-exec.ts`. The `formula-ui.ts` barrel re-exports both so
UI consumers don't see the split.

### Cell / Sheet invariants for external producers

When generating sheet `Cell` / `Sheet` data outside the package
(xlsx importers, migrations, seed data), three invariants are assumed but not
documented by the types:

1. **`ct.fa` must be set whenever `ct` is set.** `setCellValue` calls
   `update(cell.ct.fa!, v_p)` → `SSF.format(undefined, n)` returns `""`,
   blanking the cell on recalc. Default to `'General'`.
2. **`sheet.calcChain` must be populated when cells have `f`.**
   `setFormulaCellInfoMap` early-returns on null `calcChain`, leaving
   `formulaCellInfoMap` empty. `Workbook/index.tsx` calls
   `api.seedCalcChain(draftCtx)` on mount to walk data and add `{r,c,id}` for
   every cell with `.f` — but importers should still populate it directly to
   avoid a per-mount scan. Mount no longer re-evaluates formulas (values come
   from import/persistence); first edit triggers `execFunctionGroup` which
   lazy-primes `formulaCellInfoMap` from the chain.
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

### Layering / z-index

Project-wide convention lives in
[`docs/CODE-STANDARDS.md` § Z-Index / Layering](CODE-STANDARDS.md#z-index--layering).
Sheet-package specifics:

- **Canvas-internal overlays stay ≤ z-30.** Selection layers z-8…z-20;
  scrollbars, data-validation hint box, context-menu scrim, LinkEditCard,
  bottom-controll-row all sit at z-20–30. Mobile touch handle at z-25.
  Filter button (column header) at z-12. Image boxes at z-19/z-20.
- **Portaled Radix menus rely on shadcn's z-50 default.** Cell context menu,
  filter menu (+ submenu), formula autocomplete/hint, all-sheets selector,
  sheet-tab menus — none carry an inline `style={{ zIndex }}`. If a menu
  appears under something, fix the offender, don't bump the menu.
- **App-level chrome around the workbook must not introduce z-index.** The
  comments panel is a flex sibling next to the canvas; treat any future
  side panel the same way (slides pattern). The previous `zIndex: 1005`
  wrapper covered the topbar's notification dropdown — don't reintroduce it.
