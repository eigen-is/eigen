# Sheets — TODO

Single source of truth for all remaining sheets work (`packages/sheet`, `apps/sheets`, xlsx import/export, sheets clipboard).
Direction decided 2026-07-12: behave like Excel/Google Sheets wherever the two agree.

Every entry below was re-verified against the code on 2026-08-28. Line numbers, counts and claims are current as of `6a302654f`. Items that turned out to be already fixed, never accurate, or not worth doing are listed under [Closed / dropped](#closed--dropped) with the reason, so they don't get re-added.

Effort: **S** = under half a day · **M** = one to three days · **L** = its own cycle.

## Open questions — decide before building

These are choices, not tasks. Several were recorded in the old list as settled rulings, but the code shows they were never actually put to a human. Nothing below should be implemented until the question above it has an answer.

### Q1 — When the editor can't calculate an imported formula, should it delete the number Excel put there?

**The problem.** Importing an Excel file brings in each formula *and* the number Excel last calculated for it. If our engine doesn't know a function the formula uses, we produce `#NAME?`. On the server we refuse to overwrite the imported number with that error. In the editor we don't: the moment anything upstream changes, the number is replaced by `#NAME?`, sent to every collaborator, and written into the saved document. **The original number is then gone for good** — not hidden behind the error, destroyed.

The old list recorded this as deliberate, on the grounds that "showing a number that no longer matches its inputs is a lie". That reasoning is sound as far as it goes, but it was written without weighing the destructive half, and it reads like an assistant's judgement rather than yours.

**Options.**
- **A. Keep today's behaviour.** Honest about staleness. But one keystroke permanently deletes data that came from the user's own Excel file.
- **B. Mirror the server's guard into the editor.** The imported number survives. But it can silently drift out of date, and it looks like a working formula when it isn't.
- **C. Keep the value and mark it.** Keep the number, flag the cell (corner marker plus a tooltip: "this value came from Excel and can't be recalculated here — FUNCTION isn't supported yet"). Nothing destroyed, nothing misrepresented. Costs a small piece of UI and somewhere to store the flag.
- **D. Fix the cause — add the missing functions.** The right long-term answer, now scoped (see [Formula engine](#formula-engine)): about eight common classics, three of which arrive free with a library upgrade.

C and D are not exclusive; C is the safe stopgap while D proceeds.

### Q2 — How should `<`, `>`, `<=`, `>=` compare things?

**The problem.** Those four operators currently hand both values straight to JavaScript. JavaScript sorts text by character code, so `"Zebra" < "apple"` is TRUE for us and FALSE in Excel. It can't compare text against a number at all, so `"abc" > 1` is FALSE where Excel says TRUE (in Excel every piece of text ranks above every number). Excel and Google Sheets agree with each other on all of this. We match neither.

Note the old list had one detail backwards: on a blank cell, `A1>=0` returning TRUE is **correct**. It's `A1=0` returning FALSE that's wrong — Excel and Sheets both say TRUE there.

**Options.**
- **A. Implement Excel's rules.** One shared helper behind all six operators: a blank counts as `0` against a number and as empty text against text; numbers sort below text, text below TRUE/FALSE; text compares case-insensitively. Imported sheets then behave the way their author expected. Some formulas in existing Eigen documents will change answer on the next recalc — that's the point, but it is a change.
- **B. Leave it.** Any formula comparing text with `<`/`>`, or comparing a blank with `=`, keeps giving a wrong answer with no error shown. This is the silent-wrong-answer class, the hardest for a user to catch.
- **C. Fix only the blank-versus-zero mismatch in `=`.** Cheap, removes the visible inconsistency between `A1=0` and `A1>=0`, leaves text ordering wrong.

### Q3 — What is the in-memory shortcut allowed to be?

**Settled by the cross-tab/cross-login requirement, recorded here so it isn't relitigated.** Today, pasting inside one spreadsheet doesn't really use the clipboard: the app remembers which cells you selected and copies them across in memory (`ctx.copyState` holds *coordinates only* — the fidelity comes from re-reading the live cells). That object cannot survive a second tab or a second login, so it can no longer be the source of truth.

It can survive as a **cache**: a same-tab paste of a large range skips serialize/parse by checking that the clipboard payload's identity matches the cached one. The contract has to be *the clipboard payload alone is sufficient; the cache is an equal-output shortcut* — enforced by a test that runs both paths over the same range and asserts identical resulting sheet state. Without that test the cache drifts and the cross-tab path rots exactly as it has today.

The only open part: keep the cache, or drop it for one code path? Dropping it costs speed on big same-tab pastes and buys one less thing to keep in sync.

### Q4 — Should a block of cells become its own kind of clipboard item?

**The problem.** The shared clipboard understands two things: a piece of text, and a picture. A block of cells is neither, so today it's squeezed into the text slot and only the visible values survive.

**Options.**
- **A. Add a "cells" kind.** Values, formulas, formats, colours, merges, row heights and column widths travel properly. Copying between two spreadsheet files finally works, and cross-tab copying stops losing things. Costs a new type every app must at least know to ignore, plus a size limit.
- **B. Keep squeezing it into text.** No work, but copying between two spreadsheet files stays lossy forever.
- **C. Hide it in the free-form `meta` bag.** Fastest to build, and the same shortcut was already taken once and had to be undone — it made sizes and styles silently disappear between apps. Not recommended.

A is the only option that delivers the stated goal.

### Q5 — How big is too big?

**The problem.** Carrying full detail — every cell's formula, format, colour and border — makes the payload far larger than the plain text it replaces, and the transport is URI-encoded JSON inside an HTML attribute. Fifty thousand cells can reach several megabytes. Browsers have limits, and even below them a copy that pauses for a second feels broken.

**Options.**
- **A. No limit.** Small copies are perfect; a large copy may hang or fail silently on some browsers, intermittently and unreproducibly.
- **B. A limit, falling back to the simpler format above it.** Over the threshold, copy the plain table — values, formats, colours, widths, no formulas or validation rules. Copy is always fast and never fails, but a large copy silently loses formulas.
- **C. A limit, with a warning.** As B plus "this selection is large — formulas were not included", so the user can choose to copy in two halves.

C is the honest one. Measure a realistic large sheet before picking the number. (A side channel between tabs would raise the ceiling, but it only works in one browser profile, so it doesn't help across logins.)

### Q6 — What happens to a picture when cells are copied to someone else's spreadsheet?

**The problem.** Pictures aren't stored in the clipboard. The clipboard stores a pointer saying "the picture lives over there, in that file", and the browser fetches it on paste — **as the pasting user**. That works for you. It breaks when a different person pastes, because they may have no permission to open the source file. The picture just disappears, with no explanation.

This is correct security behaviour and must not be weakened by widening drive access. But it does mean a reference-only image is not a self-contained payload across logins.

**Options.**
- **A. Leave it.** Pictures arrive when you have access, vanish silently when you don't. Free and safe, but it looks like a bug and will be reported as one.
- **B. Leave it, but say so.** Same behaviour plus "1 image could not be copied — you don't have access to the original." Still free, no longer looks broken.
- **C. Embed small pictures in the payload.** Below a size cap, carry the actual image data so it always pastes. Works for everyone, but the payload gets big, large pictures still fail (so you need B anyway), and it means a picture can leave a restricted file by being copied. Defensible — the copier could screenshot it — but it should be a decision, not an accident.

B now; C only if it's actually asked for.

### Q7 — If a formula is pasted into a different file, what should it point at?

**The problem.** `=SUM(A1:A10)` means "the ten cells above me". `=Budget!B4` means "cell B4 on the sheet called Budget". Paste into a different file and there may be no sheet called Budget. This never comes up today, because a copy between files carries no formulas at all — only the numbers.

**Options.**
- **A. Carry formulas and shift them the way pasting normally does.** Relative references move correctly; references to a missing sheet go `#REF!`. Matches Excel and Google Sheets, and users already understand `#REF!`.
- **B. Formulas within one file, values everywhere else.** Never broken, never surprising, and quietly worse than the tool people are used to. They will notice.
- **C. Offer a choice.** "Paste values / paste formulas". Most control, most clicks, more to build — worth having eventually regardless of the default.

A is what every spreadsheet user expects. Note this requires the payload to carry its **source anchor and sheet name**, so the target can recompute the offset.

### Q8 — If cells are cut in one tab and pasted in another, should the originals disappear?

**The problem.** Cut means move, and moving needs two things: the cells appear in the new place, and they leave the old one. The clipboard only carries the first. The old tab has to be told to delete them — and it may be a different browser, a different machine, or a different person.

**Options.**
- **A. Across tabs, a cut behaves like a copy.** Simple, predictable, no half-finished moves. But a cut that doesn't remove isn't really a cut, and someone ends up with duplicates.
- **B. Delete the originals when the paste happens.** A real move, but only within one browser and login. Between two people it cannot work at all, and a half-applied move is worse than none.
- **C. Cut only moves where you cut it.** Within one tab, cut moves; anywhere else it copies and says so. Two behaviours, each easy to explain, and no data loss.

C is the honest one.

### Q9 — How much should survive when cells are pasted into a document or a slide?

**The problem.** A range is a grid; a document flows and a slide is a free canvas. Neither has a natural home for column widths, conditional formatting and formulas. Something must be dropped — the question is how much.

**Options.**
- **A. Text only (roughly today).** Nothing surprising happens, and nothing useful arrives. Users rebuild the table by hand.
- **B. A real formatted table.** Documents already do this; extend it to slides. The common case — "put this table in the report" — just works, and formulas become their displayed values, which is what people want there anyway. Costs a slides-side table renderer.
- **C. A picture of the table.** Looks exactly right, completely uneditable and unsearchable. Good as an option, bad as a default.

B, with C possibly offered later as an explicit "paste as image".

### Q10 — Is the 68-second first open a real user problem, or one monster test file?

Every cold-open number we have comes from a single document: the 340k-cell, 16-sheet workbook converted from a 2.3MB xlsx. Nobody has ever timed a normal-sized sheet opening. Measuring a small and a medium workbook is about an hour and decides whether 68s means "one enormous file" or "everything is slow" — and that answer governs whether any remaining performance work is worth funding. Do this before spending anything else on the open path.

### Q11 — Is "the sheet-JSON format is free to change" still true?

The range-keyed `dataVerification` rework is L-sized and justified by a parenthetical claiming a "dev-only carve-out". That phrase appears nowhere in the repo except the old TODO line, and "dev-only" stopped being true when eigen.is went live. The accurate framing is "migration allowed, no backwards-compatibility required" — a different and more expensive promise. Confirm before anyone starts.

### Q12 — Who opens an exported spreadsheet in real Excel, and when?

An agent can't do this; it needs a person with Excel or Google Sheets. It's a documented [VERIFICATION.md](VERIFICATION.md) obligation, owed since 2026-08-05. The rule exists because exceljs already burned us once — it wrote internal hyperlinks our own importer accepted and Google Sheets rejected. Either someone spends twenty minutes on it, or we consciously drop the rule for xlsx.

## Bugs

Verified, user-visible, bounded. None needs a decision first.

- [ ] **HTML paste loses every class-based style from Excel for Mac** — the `<style>` class-block parser only handles TAB-indented property lines (`nameReg = /^[^\t].*/gm` plus `.split('\n\t')`, `state/events/paste.ts:1385-1392,1429-1433`). Excel for Mac indents with 8 spaces; the committed fixture proves it (it carries a `msohtmlclip` `<link href>`, so it is a genuine Mac clipboard) and parses to an empty style map. Make the parser whitespace-agnostic. **Do not delete the path** — a tab-indented clipboard exercises it and `paste-html.test.ts` pins that. Both committed fixtures then become positive tests. **S**
- [ ] **HTML paste nulls row heights** — a `<tr>` with no `height` attribute writes `rowlen[targetR] = null` on *every* pasted row (`paste.ts:1415`, `targetRowHeight as number`), clobbering heights the user set and violating the declared `rowlen?: Record<string, number>`. The canvas tolerates the null; xlsx export doesn't — `apps/api/src/lib/export/sheets/to-xlsx.ts:151` multiplies it into a zero-height row. **S**
- [ ] **HTML paste drops inline underline** — `cell.un` is read only from the `<style>` class block (`paste.ts:1464`), while its neighbours `bl`/`it`/`fc`/`bg` all OR in the inline `td.style` value. Mirror them. Characterized in `paste-html.test.ts`. **S**
- [ ] **Filter buttons disagree with the column they open** — `createFilterOptions` emits a button for hidden columns too (`state/modules/filter.ts:180-193`, no `colhidden` skip), and a hidden column has zero width so its rect coincides exactly with the previous visible column's. The draw loop paints the higher column last while the hit-test returns the lower one, so button state, hover feedback and click target disagree. Skipping hidden columns when building `options.items` fixes draw and hit-test from one source. (The old note's "only when the hidden column has an active filter" was wrong in both directions — hover and the inverse active/idle pairing misbehave too.) **S**
- [ ] **F4 sticks on whole-row references** — stray `s` in the absolute-row alternative of `reg_cellRange` (`[$][0-9]+s`, `engine/formula-utils.ts:57`), so `$1:$3` isn't recognised as a range anywhere `iscelldata` is consulted. F4-cycling stops after one step (pinned in `formula-reference-cycle.test.ts`), and absolute whole-row refs also miss editor range highlighting and `cellrange` hyperlink/DV validation. **S**
- [ ] **Filter menu can crash on a tall sheet** — three `without(x, ...arr)` calls spread a row bucket as call arguments (`components/ContextMenu/FilterMenu.tsx:549,553,571`). All blank rows collapse into one bucket and there is no row-count cap, so a tall imported sheet with an autofilter can pass V8's argument limit. Rewrite as a Set difference. Not reachable on the reference workbook (largest sheet ≈ 426 rows). **S**
- [ ] **Ctrl+Shift+F focuses the wrong workbook** — `state/events/keyboard.ts:429,435` and `state/modules/hyperlink.ts:173,191` query the whole `document` instead of the workbook container, while `refs.cellInput` already exists (`src/context/index.ts:13`). Picks the wrong instance when two workbooks are mounted. **S**
- [ ] **Conditional formatting may render differently in HTML export than on canvas** — the two evaluator wirings have drifted: export evaluates at the rule anchor (`apps/api/src/lib/export/sheets/render.ts:224`), the canvas at the target cell (`state/modules/condition-format.ts:262`), while both files' comments claim they match. Determine whether the engine re-anchors relative refs after `functionCopy` has already shifted them; if it doesn't, exported CF is wrong. Reconcile and pin with a test before considering any shared-helper extraction. **S** to reconcile
- [ ] **By-values checkboxes are silently ignored while a condition is active** — the checkbox list renders unconditionally (`FilterMenu.tsx:496-585`) but Confirm discards it when a condition is set (`:611-632`, "a selected condition takes precedence"). A user unticks values, picks a condition, hits Confirm, and the ticks do nothing. Disable or collapse the list while a condition is active. (The old note deferred this to a "Google-parity filter-menu redesign" that exists nowhere — no doc, no branch, no ticket.) **S**
- [ ] **Filter date conditions accept anything and silently match nothing** — both operand fields are an untyped `Input` shared by every condition (`FilterMenu.tsx:471-491`); an unparseable date filters nothing rather than reporting an error (`filter.ts:346-358`). A date picker is one possible fix, but Google Sheets itself uses a free-text field with relative-date presets, so the real defect is the silent failure. **S** for the error, **M** for a picker

## Clipboard — put sheets on the shared system

Goal: a sheets → sheets copy-paste must work **between browser tabs and between different user logins**, which means the complete payload has to live in the clipboard itself. The shared writer already produces exactly the right shape — real table HTML plus an Eigen metadata span in one `text/html` payload — and sheets already writes both. The gaps are on the read side and in the type model. See [CLIPBOARD.md](CLIPBOARD.md) and [PROPOSAL_COPY_PASTE.md](proposals/PROPOSAL_COPY_PASTE.md).

**Today, in one line:** sheets writes the eigen payload on every copy but can never read it back, because `components/Workbook/index.tsx:632` skips `readEigenClipboard` whenever the HTML contains `fortune-copy-action-table` — which sheets' own copy always emits (`state/modules/selection.ts:1495`). Same-tab paste is served from `ctx.copyState` in memory, so it looks perfect. **Cross-tab paste is already broken**: the receiving tab has no `copyState`, the marker still suppresses the eigen read, and it falls through to the foreign-HTML parser, losing formulas, number formats, CF rules, data validation and hyperlinks.

Depends on **Q3**–**Q9**.

- [ ] **Step 0 — write the custom MIME on the async path too.** `writeEigenClipboardAsync` (`packages/lib/src/core/clipboard/clipboard.ts:159-171`) writes only `text/html` + `text/plain`, unlike the sync path, so every async-written payload round-trips through the HTML marker. Slides button-copy is lossy because of it (`ROADMAP.md:49`). Unrelated to sheets, same file, removes an asymmetry the grid work would inherit. **S**
- [ ] **Step 1 — define `EigenClipboardGridItem`** in `packages/lib/src/types/clipboard.ts`, reusing `Cell` and `ConditionalFormatRule` from `packages/lib/src/sheets/types.ts` — already the FE+BE-shared shapes and already the wire type for ops, so no new type surface and no new dependency edge. Add a builder plus a strict read-side validator next to `parseEigenJson`: the wire is forgeable by any web page, and a grid item is far more dangerous than a text item. Version it, and make the reader fall through to the HTML table on an unknown variant rather than throwing. **Depends on Q4.** **M**
- [ ] **Step 2 — producer.** A pure `rangeToGridItem(ctx, ranges)` in `packages/sheet/src/state/`, sitting *beside* `rangeValueToHtml`, never inside it. Wire into `Workbook/index.tsx:610-614`. Unit-testable with no DOM. Must carry the **source anchor `{r, c}` and sheet name** so the consumer can recompute the paste offset — reference rebasing moves from producer to consumer (**Q7**). **M**
- [ ] **Step 3 — consumer.** Refactor `pasteHandlerOfCopyPaste` (`paste.ts:843-1215`) to take a materialized matrix plus side-tables instead of `copyState` coordinates. The same function then serves both paths and `copyState` becomes a pure optimisation (**Q3**). Reuses the existing per-cell placement, merge, CF, validation and hyperlink machinery. **L**
- [ ] **Step 4 — flip the read order.** Delete the `isInternalCopy` veto at `Workbook/index.tsx:632-634` for an explicit fall-through: eigen grid item → eigen text/image items → `fortune-copy-action-table` + live `copyState` → foreign HTML table → plain-text/TSV. Retire the now-dead `isEqual` fingerprint (`paste.ts:1251-1332`). **This alone fixes cross-tab sheets → sheets**, so it is worth landing even if Step 3 slips. **M**
- [ ] **Step 5 — images inside a range.** Nested image items with cell anchors. This is new behaviour, not a re-encoding: a range copy drops floating images entirely today. Independently shippable, and carries the cross-login caveat. **Depends on Q6.** **M**
- [ ] **Step 6 — size ceiling and degradation.** Measure, cap, fall back to the HTML table above the cap with a clear rule for what is lost. **Depends on Q5.** **S**
- [ ] **Step 7 — cut coordination** (only if wanted). **Depends on Q8.** **M**
- [ ] **Step 8 — cross-app fidelity** (optional). Grid → slides table, grid → vector. Docs already gets a real table from the HTML. **Depends on Q9.** **L**

**Must not break, in either direction:**

- The visible `<table>` must keep going out on `text/html` verbatim — it is the only reason pasting into Excel, Google Sheets, Numbers and email works. **`rangeValueToHtml` stays the outbound HTML source of truth and must not become a renderer of the grid item.** Two producers over one range is a real drift risk, but deriving the HTML from the JSON changes what Excel receives, which is the exact regression to avoid. Deriving it later is always possible; changing it now is not reversible.
- The foreign-HTML parser (`paste.ts:1358+`) must survive byte-for-byte — it is the only reason pasting *from* those works. The three HTML-paste bugs above live in it and are **not** made moot; the conversion only stops our own users hitting them, including the cross-tab case that hits them today.
- `hasRichHtmlBeyondMarker` must keep returning true for a sheets copy. Docs relies on it (`apps/docs/src/components/docs/editor.tsx:453`) to parse the sheets table into a real Tiptap table; if the HTML table stopped being emitted, **sheets → docs would silently degrade to a paragraph of tab-separated text**. Most likely regression in the whole program.
- Don't change the `fortune-copy-action-table` marker string — load-bearing in three modules and a committed test fixture, and any clipboard content copied before the change stops being recognised.
- Don't widen drive ACLs to make cross-login image paste work. The 403 is correct behaviour (**Q6**).

**Behaviour changes to expect and test:** retiring `isEqual` makes the copy-time snapshot authoritative, so "copy, edit the source, paste" changes meaning — arguably more correct, but different. And a payload copied before a deploy may be pasted after it, so the grid item needs to tolerate version skew between two tabs on different builds.

## xlsx round-trip fidelity

One correction that applies across this section: **the raw-XML seam already exists on both sides.** Import loads and regex-parses worksheet XML (`readLocationHyperlinks`, reusing the same zip); export reopens its own output zip to rewrite sheet XML (`rewriteInternalHyperlinks`). Anything needing raw XML extends tested code rather than inventing a pass.

- [ ] **DV `allowBlank` is dropped, making us stricter than the source file** — exceljs exposes it; there is no engine field. Excel checks "ignore blank" by default, so after import you cannot clear a validated cell: Enter pops a warning and refuses the edit. Export also hard-codes `allowBlank: true` (`to-xlsx.ts:670,678,695`), losing it the other way. One field on `DataVerificationRule`, one guard in `validateCellData`, both converters. **S**
- [ ] **DV error/prompt titles and custom error text are dropped** — deliberate (`from-xlsx.ts:691-693`: the engine generates its own copy, and there is a whole `ValidationHint`/`describeValidationRule` system behind that). Reopening it is a product decision, and it should not stay bundled with `allowBlank` above, which needs no decision at all. **M** if wanted
- [ ] **Borders on value-less non-merge cells don't import** — the `return` at `from-xlsx.ts:230` precedes `convertBorder` at `:233`, and `isEmptyCell` tests only `v/f/bg/fc/hl`, so a border-only cell counts as empty. Merge constituents bypass it because `buildMergeStructures` registers every constituent in `anchorByCell`, which makes the loss look arbitrary. Put the border in `borderInfo` rather than pushing border-only cells, or `celldata` balloons on ruled-but-blank regions. **S**
- [ ] **Filter criteria don't round-trip** — exceljs's `AutoFilterXform` is a leaf node: it drops `<filterColumn>` on read *and* cannot emit it, so both halves need raw XML. The condition model exists but is editor-side only (`FilterEntry.byCondition` in `state/types.ts:166`; lib's `Sheet` carries only `filterRange`), so importing criteria means promoting `filter` to the lib type. Also needs `rowhidden` recomputed from the criteria at import. **M**
- [ ] **CF `stopIfTrue` and the aboveAverage sub-variants are lost** — exceljs never parses `stopIfTrue`, `stdDev` or `equalAverage` (`cf-rule-xform.js` `createNewModel`), so import needs raw XML. Priority ordering already works (`from-xlsx.ts:375-379`); `stopIfTrue` additionally needs a rule-level short-circuit in `engine/conditional-format.ts`, which today layers overlapping rules per style property with no early exit. Symptom: a cell covered by two rules where Excel stops at the first shows both blended. **M**
- [ ] **Rich-text runs flatten at import** — both value paths join runs and discard formatting (`from-xlsx.ts:978-981`, `:827`); `buildCellType` never emits `ct.s`. Export already writes them (`to-xlsx.ts:326-328`), so the target format is pinned by an existing helper. **M**
- [ ] **Defined names are dropped** — exceljs exposes `workbook.definedNames`; the engine has no named-range concept. The break is *deferred*, not immediate: `recalc.ts`'s `hasNonErrorCachedValue` guard means Excel's cached value displays correctly on open, and the formula only turns `#NAME?` on the first edit. Export then writes formula text naming a range the file no longer defines. That reframes it as a cheap-mitigation-versus-real-feature call rather than an import-correctness bug. **M** to inline-resolve at import, **L** for real support
- [ ] **Excel outline groups aren't imported** — no `outlineLevel` anywhere in `packages/sheet`; the engine has no grouping model, header gutter or collapse control to import into. exceljs already exposes the data. Not a converter gap but a missing editor feature. No data is lost: a collapsed group arrives as plain hidden rows via the existing `rowhidden`/`colhidden` passes, so the reader can unhide them but can't expand or re-collapse, and grouping is gone on export. **L**
- [ ] **Range-keyed `dataVerification`** (mirroring CF's `cellrange`) — removes the import clamp (`DV_ROW_MARGIN = 1000`/`DV_COL_MARGIN = 100`), the silent truncation past the extent, per-snapshot rule duplication, and the dialog's per-cell expansion loops. Symptom: validation covering a whole column stops applying ~1000 rows past the last row holding data. Note the old entry's fifth motivation is gone — the `checkboxChange` rule-aliasing hazard died in `67f08d41f`, and a tick box now reads its state from the cell value. Export-side bloat is not a motivation: exceljs coalesces adjacent identical rules back into rectangular sqrefs. **Depends on Q11.** **L**
- [ ] **Stale comment** — `from-xlsx.ts:674` still justifies per-cell rule cloning with "the engine mutates rules in place", which has been false since `67f08d41f` and now contradicts the comment in `data-verification.ts` saying rules are read-only. **S**
- [ ] **`normalizeMonthMinuteTokens` diverges from numfmt on three pathological formats** — `;` consumed by a `_x` skip (our `splitFormatSections` doesn't know `_`/`*`), the `_\x` 3-char skip/fill (we consume two characters, leaving the third exposed to month re-casing), and `B1`/`B2` calendar markers (we push an adjacency breaker where numfmt matches them first). Rendering is provably unaffected — numfmt lower-cases every datetime token before classifying — so the worst case is a mislabeled chip in the custom-format dialog, and editing that chip then corrupts the format. The `_\x` case also re-cases a literal character in the stored format string, which is a write rather than just a mislabel. **S**

## Formula engine

- [ ] **IFERROR can't trap an unknown name or function** — `=IFERROR(XLOOKUP(...),"")` and `=IFERROR(NOSUCHNAME,"fb")` yield `#NAME?` where Excel returns the fallback, because the unknown-operator guard (`evaluate-by-operator.ts:57`) and `_callVariable` (`parser.ts:120`) throw above the in-band conversion and unwind the whole parse. **This is not blocked on Q2.** Return the formulajs `#NAME?` singleton instead of throwing, and propagate that one identity through the comparison operators while every other error keeps today's coerce-to-false behaviour. (The blanket coercion's original justification — an `OR(x="", VALUE(x)>limit)` pattern — was separately fixed at source in `formula-function.ts:34-46`.) Trapping at the IFERROR call site is not an option: jison reduces bottom-up, so the inner call evaluates before IFERROR's own reduction. **S**
- [ ] **Function names starting with `_` are a syntax error** — both lexer rules require a leading letter (`grammar-parser.jison:8,14`), so `=IFERROR(__xludf.DUMMYFUNCTION("…SPARKLINE…"),"")` lexes as variable-DECIMAL-function, hits no matching grammar production, and renders `#ERROR!`. This is why those cells fail; it is a *different* bug from the IFERROR gap above, and fixing IFERROR alone won't fix them. One lexer rule, after which they become the trappable `#NAME?` case. **S**
- [ ] **Comparison operators don't match Excel** — `<` `>` `<=` `>=` are raw JS (`(x ?? 0) > (y ?? 0)`), so text sorts by code point and case-sensitively and numbers never compare below text; `=`/`<>` coerce and fold case but treat a blank as `""` rather than `0`. One shared `compareValues` helper behind all six operators. **Depends on Q2.** **M**
- [ ] **Cover the missing functions.** The whole surface is `Object.keys(formulajs)` on formulajs 2.9.3 — 513 names; nothing else registers functions and the only override is `VALUE`. Missing, by tier:
      - **Tier 1, ordinary business sheets (8):** `OFFSET`, `INDIRECT`, `TEXTJOIN`, `MAXIFS`, `MINIFS`, `HYPERLINK`, `ADDRESS`, `FORMULATEXT`
      - **Tier 2, modern lookup + dynamic arrays (13):** `XLOOKUP`, `XMATCH`, `FILTER`, `SORT`, `SORTBY`, `SEQUENCE`, `RANDARRAY`, `LET`, `LAMBDA`, `TEXTSPLIT`, `TEXTBEFORE`, `TEXTAFTER`, `ARRAYFORMULA`
      - **Tier 3, array reshaping (18):** `VSTACK`, `HSTACK`, `TOCOL`, `TOROW`, `CHOOSECOLS`, `CHOOSEROWS`, `TAKE`, `DROP`, `EXPAND`, `WRAPROWS`, `WRAPCOLS`, `BYROW`, `BYCOL`, `MAP`, `REDUCE`, `SCAN`, `MAKEARRAY`, `ISOMITTED`
      - **Tier 4, Google-only / external data (8):** `QUERY`, `SPARKLINE`, `IMPORTRANGE`, `IMPORTDATA`, `GOOGLEFINANCE`, `GOOGLETRANSLATE`, `DETECTLANGUAGE`, `SORTN` — can't be implemented locally; should render as a documented placeholder
      - The classics are otherwise well covered (`SUMIF(S)`, `COUNTIF(S)`, `VLOOKUP`, `INDEX`, `MATCH`, `IFS`, `SWITCH`, `UNIQUE`, `SPLIT`, `TEXT`, `EOMONTH`, `XIRR`, `REGEX*`, `CELL`, `SUBTOTAL`, `AGGREGATE`).

      Two things scope this: a **formulajs 2.9.3 → 4.6.0 bump delivers 12 for free** (`CHOOSECOLS CHOOSEROWS DROP EXPAND HSTACK MAXIFS MINIFS MMULT MUNIT SORT TEXTJOIN VSTACK`), though it renames enough to need its own compatibility pass. And **Tier 2/3 need spill, which the engine does not have** — `recalc.ts:590,607` writes `cell.m = String(result.value)` and `inferType` has no array case, so an array result becomes the string `"1,2,3"` in one cell. Shipping `FILTER`/`SORT`/`SEQUENCE` without spill would produce comma-joined junk, arguably worse than `#NAME?`. **M** for Tier 1 + the bump, **L** with spill
- [ ] **Mirror the recalc guard into the editor** — `execFunctionGroup` → `executeAffectedFormulas` (`state/modules/formula-cache.ts:343`) → `groupValuesRefresh` (`state/modules/formula-exec.ts:600`) writes unconditionally, unlike `engine/recalc.ts:780`. **Depends on Q1.** **S** to mirror
- [ ] **Cross-sheet click-to-reference is dead** — `formulaCache.rangetosheet` is declared (`state/modules/formula-cache.ts:149`) and read (`formula-range.ts:38,98,101`) but never assigned in source; the only assignment anywhere is in a test propping up a field production never sets. So `getRangetxt` always sees `currentId === sheetId` and the sheet-name branch (`state/modules/cell.ts:919-935`) is unreachable. Switching tabs cancels the composition anyway (`SheetItem.tsx:251-265` → `cancelNormalSelected`). Either delete the field and its branches (**S**), or build the feature — which means teaching the tab-switch path to preserve rather than cancel an active composition, touching focus, the range-highlight overlay and undo (**M–L**). Decide the feature first; the debt follows.

## Performance

Program history and measurements: gitignored `docs/superpowers/sheet-perf/PHASE0-MEASUREMENTS.md`. Shipped through P4 (snapshot v2 56.5→12.6MB; import 21.4→4.7s; html render 153s/82MB → 7.3s/10.4MB; production tab-switch benchmark).

- [ ] **Re-time the xlsx convert on a quiet machine.** `PHASE0-MEASUREMENTS.md` records import at 4.7 s
      post-P2; a 2026-08-28 re-run of the same 2.3 MB reference workbook took **7.64 s**. The machine was
      heavily loaded (load average 9.7–12.8 on 10 cores), which could account for all of it, so this is a
      flag rather than a finding — but nobody should quote 4.7 s until it has been re-confirmed. **S**
- [ ] **The 68-second cold open.** Re-measured 2026-08-28 on current code and a fresh production build:
      a freshly converted workbook opened in **68.0 s**, four-run median **~69 s** (range 55.6–81.8 s),
      with `domReady` at 4.2–5.6 s — so ~64 s is client-side after the DOM is ready. The number is
      current, not stale. The workbook that has been opened repeatedly since 2026-08-05 is slower
      still at **80 s** (`data.db` 2.59 MB vs 1.72 MB). Server-side is not the problem: T10 logged the
      collab document loading in 357 ms. **Depends on Q10.** Start with attribution — no profile has
      ever been taken across the cold open. Evidence: gitignored `docs/superpowers/sheets-tickets/T12-remeasure-2026-08-28.md`. **M** to measure, unknown to fix
      - Note: the old entry fused two independent numbers. The 16.5 s figure is the *first tab switch*
        to Incurred, measured after the canvas already exists. It is not a component of the 68 s.
      - The re-run also showed the spread is far wider than P4 implied — 55.6–81.8 s across four runs of
        the same file on the same build, on a loaded developer machine. Any future optimisation claiming
        less than ~15 s cannot be demonstrated here without many more replicates, so **fix the bench
        before trusting a result**: a quiet machine, or many more runs.
- [ ] **Persist the live text-measure cache.** `measureTextCache` (`state/modules/text.ts:111`) is content-addressed — keyed by string plus full font string — and safe to persist past the 100ms render-cache idle timer (`state/canvas.ts:156`) with a size cap. Worth ~5.7% of a tab switch. **S**
- [ ] **`measureTextCellInfoCache` has never worked.** Declared at `state/modules/text.ts:112`, cleared, read at `:362`, and **never written anywhere in the tree** since the fork — so `getCellTextInfo` (1.9%) recomputes on every call, even inside a single draw burst. Either delete the dead field so nobody assumes caching is handled, or make it work — which needs a sheet-id in the key (it's keyed `r_c` today, so persisting it across sheets returns sheet A's layout for sheet B) plus invalidation on every edit, paste, style change, resize and incoming Yjs op, none of which exists. `state/render/overflow.ts:16` has the same missing-sheet-id key. Deleting is recommended unless the cold-open work turns out to need it. **S** to delete, **M** to build
- [ ] **Open one of our xlsx exports in real Excel or Google Sheets.** **See Q12.** **S**, human-only

## Code debt

Opportunistic — fix when touching the area. Nothing here is worth scheduling on its own.

- [ ] **Delete five dead `FormulaCache` fields** — `rangeResizeObj`, `rangeResize`, `rangeResizexy`, `rangeResizeWinH`, `rangeResizeWinW` (`state/modules/formula-cache.ts:129-139`) are declared and never read or written anywhere, in source or tests. They force zero `!`-casts; they are upstream residue that makes the class look like it holds drag-resize state. Five-line deletion. **S**
- [ ] **The `.jison` grammar source is stale and dangerous** — `grammar-parser.ts` carries a local fix the `.jison` never received (`83dc7c815`, "bare cell ref to an empty cell no longer evaluates to true"), and there is no jison dependency or regeneration script in the repo. Regenerating from it today would silently revert that fix. Delete the file, or add a `DO NOT REGENERATE — diverged at 83dc7c815` header. **Do not** plan a regeneration. **S**
- [ ] **Remaining `any` debt** — 2 `as any` in non-test source, both in the generated `grammar-parser.ts` (`:555`, `:613`), so "sole remaining `as any` area" holds. The real debt is 45 `: any` annotations: 35 in `grammar-parser.ts` (generated, leave), **8 in `state/modules/cell.ts`** (`:37,40,69,81,104,126,137,608`) and **2 in `engine/types.ts`** (`:156`, `:165`). Those 10 are worth tightening. **S**
- [ ] **`insertMenu` repeats `autoSelectionFormula` four times** — `components/MenuBar/insert-menu.tsx:131,146,161,176`, four blocks identical except for `'AVERAGE' | 'COUNT' | 'MAX' | 'MIN'` and the label. ~60 lines collapse to a `.map`. SUM stays separate (it routes through `handleSum`). The clearest, lowest-risk item on the list. **S**
- [ ] **Inline style object in `context/modal.tsx:49-55`** — on a `DialogContent` that already carries a `className`. Trivially `flex flex-col max-h-[75vh] overflow-hidden w-[500px] max-w-[90vw]`. Verify the arbitrary value actually renders after the swap; new `[...]` values can silently no-op on a long-running dev server. **S**
- [ ] **`.substr()` — 12 hand-written sites across 6 files**, not 4 in `cell.ts`: `state/api/cell.ts:135` (2), `state/modules/text.ts:881`, `filter.ts:645,661`, `toolbar.ts:754,757,794,835`, `cell.ts:186,187,189,204`. The 7 in `grammar-parser.ts` are generated — leave them. Note `.substr(-1)`/`.substr(-2)` need `.slice()`, not `.substring()`. No user impact; do it as one sweep only if someone is already in these files. **S**
- [ ] **Non-null assertions** — ~630 across non-test source. Real hotspots: `state/events/paste.ts` (88), `components/DataVerification/index.tsx` (84), `state/modules/rowcol.ts` (56), `components/Workbook/index.tsx` (33), `components/MenuBar/format-menu.tsx` (19), `components/SheetOverlay/index.tsx` (18). `drop-cell.ts` has three and does not belong on the list. Strictly tighten-while-you're-in-there: each removal is a behaviour decision about what to do when the value *is* null. **Don't let this become a cycle.**
- [ ] **`forEach` sites — 34**, split 24 object-iteration (needing `Object.entries`; `rowcol.ts` ×18, `api/rowcol.ts` ×2, `conditional-format.ts` ×2, `api/cell.ts`, `validation.ts`) and 10 array-like that convert mechanically. The `return false` break blocker exists at exactly **one** site (`formula-exec.ts:115`); `paste.ts:446,1193` pass a possibly-undefined array that compat tolerates and `for…of` would not. Opportunistic one-line edits, not a dedicated pass.
- [ ] **One `SheetItem` DropdownMenu per sheet tab** — `components/SheetTab/SheetItem.tsx:348` mounts a Radix menu per tab and opens it from `onContextMenu`, against the singleton `useContextMenu` rule the grid itself follows (`useSheetContextMenu.tsx:437`). It doubles as the chevron trigger, so converting means splitting the two entry points. **M**
- [ ] **Delete the dead `formula.find: 'Learn more'` locale key** (`state/locale/en.ts:9625`) — no consumer; the upstream help panel it belonged to is gone. **S**
- [ ] **Drag-preview DOM seams** — `mouse-drag.ts` (13 querySelector + 13 direct style writes) and `mouse-resize.ts` (6 + 30) reach into preview elements by class. These are deliberate per-frame imperative writes kept off React's render path; a ref-based rewrite buys nothing visible. Migrate only if the drag previews are being reworked anyway. **M**
- [ ] **es-toolkit: policy, not migration.** All 52 imports in `packages/sheet` use `es-toolkit/compat`, zero use core. Of 41 imported symbols, 24 have core equivalents with subtly different null/path semantics and 17 don't exist in core at all. A migration means a semantic audit of 24 functions against a 900-test suite for an unmeasured bundle win. **Policy: compat is fine, don't add more.** Revisit only if bundle size is actually being measured.

## Closed / dropped

Verified 2026-08-28 and removed from the list. Recorded so they don't come back.

| Item | Why it's gone |
|---|---|
| Find-and-replace dialog z-index clash | **Fixed.** The dialog was deleted (`b56035551`); sheets uses the shared find bar, whose stacking is handled structurally by the `isolate` wrapper at `doc-search-provider.tsx:392`, and whose clicks can't reach the grid because it renders outside `SheetOverlay` |
| Formula "learn more" dialog broken | **Fixed.** The upstream help panel is gone; `InsertFunctionDialog` and `FormulaHint` were rebuilt on shared Dialog/Popover primitives. Only a dead locale key remained (now listed under Code debt) |
| Tab colour needs a submenu | **Fixed** in `6704fc224`. `ColorPickerMenuItem` is a real `DropdownMenuSub` per the house rule |
| Move the sheets toolbar onto `ColumnLayout` | **Dropped — premise false.** Sheets list routes already run on `ColumnLayout` via `DriveLayout`, and the editor already mounts a shared `Column` (`PanelColumn`). `MenuBar` hand-rolls the identical `h-12 app-gutter-x border-b` bar. Zero user-visible gain, and `MenuBar` reads a `WorkbookContext` created inside `Workbook`, so it can't be lifted into a `toolbar` prop without splitting the provider |
| Sheet dark mode | **Not a TODO.** A completed design decision, already documented with rationale in `packages/sheet/RENDERING.md` § Theming. The `.eigen-paper` convention is unchanged and still pins every named surface |
| Snapshot v2.1 (formula dedup, style-cell compression) | **Dropped.** Decoding the whole 12.6MB snapshot takes 126ms out of a 68s open — 0.2%. Worse, SPEC-P2 measured formula-pattern dedup as *adding seconds* of decode-side shifting to the same open path. Re-propose only if the Q10 measurement attributes real time to snapshot decode or transfer |
| `luckysheet_compareWith` parameterization | **Dropped — premise false.** The emitted string is never evaluated by anything: there is no eval sandbox anywhere in the repo, and both callers discard the return value (`recalc.ts:231-235` documents that only the side effect matters). "Parameterize the callee" would parameterize a name nothing calls |
| `FormulaCache` `unknown` fields force `!`-casts | **Premise false.** The five fields are entirely dead, forcing zero casts. Re-filed under Code debt as a deletion |
| `document.execCommand` replacement | **Dropped.** Four sites, not one (`InputBox.tsx:139,140`, `paste.ts:1660`, `clipboard.ts:37` — the last deliberately kept, with a comment explaining why). `execCommand` is deprecated but universally shipped, and there is no spec'd replacement preserving native undo in a contenteditable. Rewriting it by hand is how you break undo |
| No-delay `setTimeout` sequencing | **Dropped.** Nine sites, not two, and they are deliberate "after React commits / after focus settles" yields — `InputBox.tsx:104-106` documents its own. Replacing them with `queueMicrotask` or effects is a behaviour change dressed as tidying |
| `checkboxChange` rule-aliasing hazard | **Fixed** in `67f08d41f`. A tick box stores no checked flag; the cell value answers that (`packages/lib/src/sheets/types.ts:133-134`). It was one of five motivations for range-keyed DV; the other four stand |
