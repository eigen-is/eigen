# Sheets xlsx-fidelity program

> **TLDR**: Multi-cycle effort to make xlsx → `.eigensheets` conversion faithful and bring the
> sheet feature set/UX toward Google Sheets parity. Cycles 0–6 are done; this doc carries the
> status, the backlog, and the working method so a fresh session can continue without archaeology.
> Architecture background: [SHEETS.md](SHEETS.md).

## Status (2026-06-11)

| Cycle | Scope | Landed |
|---|---|---|
| 0 | Fidelity audit (4-stage gap matrix: in xlsx → exceljs → `Sheet[]` → renders) + filter diagnosis | audit artifacts local-only, see § Working method |
| 1 | Numeric display strings render through numfmt at import (`m = update(fa, v)`, not `String(raw)`) | merge `3aa538a4` |
| 2 | Hidden rows/cols (`config.rowhidden/colhidden`) + frozen panes (`Sheet.frozen`, now a lib-type field) | merge `379395f4` |
| 3a | Autofilter range → `Sheet.filterRange` (lib-type field); buttons render on load | merge `de36c674` |
| 4 | Conditional formatting import (all 8 cellIs ops, expression/formula rules per sqref sub-range, colorScale→colorGradation, dataBar, top10, aboveAverage, duplicateValues; iconSet skipped). Engine: 4 new conditionNames, per-property no-clobber style merge, **fixed formula CF rules never rendering in the editor** (evaluator mutated the immer-frozen ctx) | merge `84e7410f` |
| 3b | Filter-by-condition tier: `FilterEntry.byCondition` (18-name union), pure evaluator, enabled UI section in the filter menu; condition takes precedence over by-values | merge `b168bd07` |
| — | Whole-diff polish (test consolidation, `filterConditionArity`, docs refresh) + simplify pass (per-Confirm matcher hoisting, `KNOWN_CONDITION_NAMES` completed) | merges `057b830c`, `45a21744` |
| 5 | Data-validation/dropdowns import → `Sheet.dataVerification` (now a lib-type field): list → dropdown (literal lists + live range refs incl. quoted cross-sheet names), whole/decimal/textLength/date with the full operator → type2 table, prompts → hints, stop-style errors → `prohibitInput`; custom/any, defined-name sources and non-literal operands skipped; emission clamped to used extent + margin | merge `64ae806d` |
| 6 | Hyperlinks import → `Sheet.hyperlink` (now a lib-type field): web/mailto targets verbatim as `webpage`, `#`-prefixed internal locations as `cellrange`/`sheet` (quotes kept for getcellrange, stripped for sheet-name equality); linked cells get the `hl` backref. Engine: scheme allowlist in `goToLink`/`isLinkValid` — http/https/mailto pass verbatim, scheme-less keeps the https:// prepend, scripting schemes (`javascript:`, `data:`, `file:`, …) never navigate (mailto was mangled into `https://mailto:…` before). Also fixed the broken `@source` globs in `packages/ui` globals.css (three-up → nonexistent dirs) that left package-only Tailwind classes — incl. the LinkEditCard's `z-30` — out of every app's CSS, making the link preview card unclickable. Hardening: `noopener,noreferrer` on link `window.open`, host:port kept scheme-less, ReDoS regex defused | merge `c8111020` |

Excel priority semantics for CF: rules are emitted sorted by priority **descending** because the
engine compute-map merge is last-write-wins per property — the highest-precedence rule is applied
last and wins.

## Remaining cycles (signed-off order)

7. **Date/number format UX** — Google-Sheets-style format dialogs (preset list with live
   previews + custom format builder). Independent of import work.
8. **Export parity** — close the xlsx round-trip for everything that landed.
- **Filter menu visual redesign (Google parity)** — deliberately deferred for design iteration
  in small steps with Reinder; the functional condition tier is in. Reference: Google's
  per-column menu (sort A–Z/Z–A, sort by colour, filter by colour, filter by condition, filter
  by values with search).

## Backlog

- **BUG — filter buttons misrender across a freeze pane**: when the autofilter row spans frozen
  columns/rows, the per-column filter buttons land at wrong positions after scrolling (buttons
  drift over the wrong cells; observed 2026-06-11 on a sheet with frozen panes + autofilter).
  Likely the `FilterOption` overlay positions against unscrolled canvas coordinates without the
  freeze-pane offset split that the selection overlay handles. Start at
  `packages/sheet/src/components/FilterOption/index.tsx` (geometry) and the freeze offsets in
  `state/modules/freeze.ts`.
- Name box shows `A1:NaN` on initial sheet load before any selection (init-state only; correct
  after first click).
- xlsx `customFilters`/`top10`/`dynamicFilter`/`colorFilter` **criteria** import — the condition
  model now exists (`FilterEntry.byCondition`); exceljs only exposes the autofilter range, so
  criteria need a raw-XML read of `<filterColumn>` children.
- CF `stopIfTrue` is ignored (per-property merge applies regardless); Excel's aboveAverage
  stdDev/equalAverage sub-variants map to plain above/belowAverage.
- Data validation `allowBlank` is dropped (no engine field) — blanks follow the engine's existing
  semantics regardless of the xlsx flag. Error/prompt titles and custom error text are dropped
  too; the engine generates its own hint/failure copy.
- Per-cell `r_c` keying is the root cause behind the DV import clamp (margin constants, silent
  truncation past the extent, duplicated rule objects in every snapshot): a range-keyed
  `dataVerification` (mirroring CF's `cellrange`) would delete all three and the dialog's own
  per-cell expansion loop. Related hazard: `checkboxChange` mutates the rule object in place, so
  any producer that aliases one rule across cells misbehaves — the importer defends by cloning
  per cell. Sheet-JSON format is free to change (dev-only carve-out); realistically its own cycle.
- The hyperlink scheme allowlist (`resolveWebLink`) lives FE-only in `state/modules/hyperlink.ts`
  — correct today (both consumers are there; exports render no links). If cycle 8 export parity
  starts rendering hyperlinks, move it to a BE-importable seam (`packages/lib/src/sheets`)
  instead of reimplementing.
- Excel outline groups (`outlineLevel` row/col grouping with collapse buttons) are not imported —
  distinct from hidden rows.
- Date condition input in the filter menu is a plain text field (no date picker).
- By-values checkboxes stay visible (and are ignored) while a condition is active on a column —
  resolve in the Google-parity redesign (accordion makes the active mode explicit).
- Engine `top10` CF evaluation uses `indexOf` over the sorted slice per cell (O(n²) on large
  ranges); pre-existing, now reachable from import. A `Set` lookup would fix it.
- CF formula-evaluator wiring is duplicated (8 lines) between
  `state/modules/conditionFormat.ts` and the HTML export's `buildCfFormulaEvaluator` — extract a
  shared helper if a third consumer appears.
- Imported hyperlink cells keep Excel's font styling; dialog-authored links hardcode
  `rgb(0,0,255)` + underline (saveHyperlink). Divergence is intentional — forcing the dialog
  style at import would clobber theme-styled link cells.
- Excel-AUTHORED internal hyperlinks (a `<hyperlink location=…>` attr without a rel) are dropped
  by exceljs's reconcile (`hyperlinkMap` only maps rel-based entries) and never reach the cell
  surface — they don't import. Rel-based `#location` targets (what exceljs and Google Sheets
  exports write) do. Same cell-surface gap behind the raw-XML link-part counts from the cycle 0
  audit (75 INT/70 EXT raw) vs the exceljs-visible 38/70 the importer maps.
- Rich-text runs flatten to a single string at import; defined names are dropped (formulas
  referencing names break — decide inline-resolve at import vs. real support).
- Out of scope (decided 2026-06-10): importing Excel comments/notes — Eigen has its own
  comment-card system.

## Working method (kept because it worked)

One **full-cycle subagent** per cycle with a complete brief (project rules digest, audit facts,
exact file pointers, TDD red→green, scoped test commands, browser-verification recipe), then an
**independent review subagent** on the branch diff, then the controller merges to `main` —
one branch per cycle, `--no-ff`. Reviews are two-stage where deliverables warrant it
(spec compliance first, then quality) and obey signal-over-volume: "clean" is a valid verdict.

**Browser verification is mandatory per cycle, not optional.** The pattern that works:

1. Convert the benchmark through the real pipeline as a throwaway dev user (signup is open on
   the local API): upload via `POST /drive/:owner/:mount/file/:parentId` (multipart), convert via
   `POST /drive/:owner/:mount/file/:pathId/convert/eigensheets`.
2. Drive the running dev app headless with Playwright (`chromium.launch({ channel: 'chrome' })`,
   inject the `better-auth.session_token` cookie for `localhost` — cookies are host-scoped, so it
   works across ports). Sheets app: port 3013 under the `/sheets` base path.
3. **Screenshot every worksheet tab and actually READ the screenshots** — verdicts come from
   pixels, not from data-shape assertions alone. Interaction probes (scroll for frozen panes,
   click filter buttons, apply a condition, reload for persistence) catch what static shots miss.
4. Long-running dev server quirks: first canvas render takes 20–30 s (poll for `canvas`);
   a stale-HMR double-import of `main.tsx?t=…` can crash the first load — serve that request an
   empty module via Playwright route interception, or just load again.
5. Compare against the previous cycle's baseline screenshots — regressions show up immediately.

Local-only artifacts (gitignored, `docs/superpowers/`): the Cycle 0 gap matrix + filter
assessment (`audit/`), per-cycle spec records (`specs/`), and all verification screenshots
(`audit/screens/`). The real benchmark workbooks live in the local drive data and must never
enter git. The audit script (`apps/api/scripts/audit-xlsx.ts`) regenerates the 4-stage report
for any xlsx.

Synthetic-fixture tests are the committed regression net: `apps/api/src/test/sheets-import.test.ts`
builds workbooks with exceljs in-test and asserts on the converted snapshot through the full
upload→convert→Yjs pipeline (shared helpers at the top of the file). Sheet-engine behavior tests
live in `packages/sheet/src/{engine,state}/test/`.
