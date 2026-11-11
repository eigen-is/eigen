# Proposal: conditional formatting and data validation move to a side panel in Sheets

This proposal moves the two rule editors of Sheets, conditional formatting and data validation, out of their modal dialogs and into the right-hand panel, where comments, activity and the chart panel already live. Each panel is a list of the sheet's rules with an editor behind every row, as in Google Sheets.

**Status:** approved on 2026-11-11 with every recommendation below; not built. [ROADMAP-POST-1.md](../ROADMAP-POST-1.md) has its row. The owner asked on 2026-11-11 whether Sheets can use the sidebar more, after seeing Google's "Data validation rules" sidebar. What this proposal says about the code was true on 2026-11-11, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: Sheets has one right-hand slot. Comments and activity use it, and so does the panel of a selected chart or image. Conditional formatting and data validation are modal dialogs: they cover the grid, they can't show the rules a sheet already has next to the cells, and data validation swaps to a second dialog to pick a range. This proposal gives each a panel: a list of the current sheet's rules with **Add rule** and **Remove all**, and an editor view that reuses the dialogs' fields. The grid stays usable, so a range is picked on it directly. The Sheets editor holds the slot in one app-level hook, so the shared comments type stays as it is. Data validation can move first, because its rules already have ids. Editing a conditional format from a panel needs rules with ids, which is finding F9 of the simplification audit, a stored-format change the owner approved on 2026-11-11. No new API route, database migration or npm package is needed. About 6 to 9 days in four phases.

## Goals

1. A user sees every rule of the current sheet in one list, with its type and range, next to the cells it covers.
2. A rule can be edited after it is made. Today a conditional format can only be deleted and made again.
3. A range is picked on the grid while the editor stays open, with no second dialog.
4. One slot rule for the right-hand side of Sheets, so a new panel is a new kind, not a new boolean.
5. A rule edit is one undo step and one op.

## Non-goals

- Named ranges, protected ranges, alternating colours and pivot tables. Google puts them in sidebars, but Eigen has none of them. The slot in this proposal is where they would go.
- New rule types. The panels edit what the dialogs edit today. The conditions an xlsx import brings that the form can't express are listed, not made editable ([§ The editor view](#the-editor-view)).
- A panel on other hosts of the Workbook. The chart sheets of [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md) mount the Workbook in a dialog, with no panel slot ([§ Who opens a panel](#who-opens-a-panel)).
- Moving the other sheet dialogs ([§ What moves and what stays](#what-moves-and-what-stays)).

## Current state

**One slot, two tenants.** `SheetEditor` (`apps/sheets/src/components/sheets/editor.tsx`) draws the workbook and, to its right, one of two things. `useDocumentPanels` (`packages/lib/src/core/comments/hooks/use-document-panels.ts`) holds `DocumentPanel = 'comments' | 'activity'` (`packages/lib/src/types/comments.ts`), and `PanelColumn` (`packages/ui/src/components/comments/panel-column.tsx`) draws it: a `Column` of `PROPERTIES_PANEL_WIDTH_PX` (256), with the title and the close button in its toolbar and the back arrow on a phone. When no such panel is open and a chart or image is selected, `FloatingObjectPanel` (`floating-object-panel.tsx`) takes the place, on desktop only.

**A sheet-owned panel body already exists.** The Workbook reports the selected chart through the `onChartPanelChange` hook (`ChartPanelState` in `packages/sheet/src/state/settings.ts`), and the app mounts `ChartPanelSections`, exported from `@workspace/sheet`, inside its panel. The body writes through the `WorkbookInstance` API (`setChartSpec`, `setChartLook`, `setChartDataRange`, which returns a refusal), not through the Workbook's React context ([SHEETS.md](../SHEETS.md#a-selected-charts-panel-is-a-canvas-charts-and-a-typed-edit-is-one-undo-step)).

**Every other sheet dialog is modal.** Each draws its own `FormDialog` and opens through `useDialog` into the one slot `ModalProvider` holds (`packages/sheet/src/hooks/useDialog.tsx`, `context/modal.tsx`). The range picker is the one non-modal shell.

**Conditional formatting is two dialogs and a menu.** Format → Conditional formatting (`components/MenuBar/conditional-formatting-menu.tsx`) lists 13 rule types in two submenus, 12 color scale and 6 data bar presets, **Manage rules** and **Delete rule → Delete sheet rules**. A rule type opens `ConditionRules` (`components/ConditionFormat/ConditionRules.tsx`), which adds one rule over the selection: the dialog has no range field. A preset adds its rule at once. `ManageRules` (`ManageRules.tsx`) lists the current sheet's rules with a swatch, a description and the range, and deletes one by its index. It can't edit, add or reorder.

**Data validation is one dialog and no list.** Data → Data validation opens `DataValidation` (`components/DataValidation/index.tsx`) on the focus cell's rule. It has a range field, eight rule types, and **Delete validation** for the range. Its grid buttons close it and open `CellRangeDialog` (`components/CellRangeDialog/index.tsx`) in the non-modal shell, whose OK or Cancel opens `DataValidation` again with the draft (`pickRange`). Nothing lists a sheet's validation rules.

**The two rule kinds are stored differently.** `Sheet.conditionalFormatRules` is an ordered array with no ids (`packages/lib/src/sheets/types.ts`): the order is the priority. `deleteSheetRule` splices by index, and a carry writes a changed rule by its index ([SHEETS.md](../SHEETS.md#position-bound-properties-live-beside-the-cell)). The first rule on a sheet writes the whole list, so two rules added at once can lose one ([SHEETS-TODO.md](../SHEETS-TODO.md#sync-and-undo)). Adding or removing a rule changes the list's length, which makes it a structural undo entry that any peer batch drops ([SHEETS.md](../SHEETS.md#undo-is-per-tab-and-a-peers-batch-ends-your-structural-steps)). `Sheet.dataValidations` is a map from an id to a rule and its ranges, written one key at a time ([SHEETS.md](../SHEETS.md#a-validation-rule-is-stored-once-over-its-ranges)). Where rules overlap, as an xlsx file allows, the highest id wins (`compareValidationIds`).

**A viewer has no way in.** The Format and Data menus are hidden when `allowEdit` is off (`components/MenuBar/index.tsx`).

## What moves and what stays

Google's own split is the guide: a sidebar for things that are a list the user keeps beside the grid, a dialog for one question that is answered and gone.

| Group | Today | Proposed | Why |
|---|---|---|---|
| Conditional formatting: add a rule, Manage rules | `ConditionRules`, `ManageRules` | Panel | A list of rules that each cover a range. The user wants to see the cells while editing, and comes back to the list |
| Data validation | `DataValidation`, with `CellRangeDialog` for the range | Panel | The same, and the range picker is a workaround for the dialog being modal |
| Custom sort, Split text, Resize row or column | `CustomSort`, `SplitColumn`, `ResizeDialog` | Stay dialogs | One action on the selection: fill in, OK, done. Nothing to list and nothing to come back to |
| Custom number, date and currency formats | `FormatDialogs` | Stay dialogs | A pick from a list for the selected cells. Google keeps these as dialogs too |
| Insert function | `InsertFunctionDialog` | Stays a dialog | A search and a pick that ends in the cell editor |
| Link | `LinkEditDialog`, with `CellRangeDialog` for a cell-range link | Stays a dialog | One link on one cell, opened from its card. It keeps the range picker's `link` variant |
| Notices and confirms | `showNotice` | Stay dialogs | They block on purpose |

Find and replace is the find bar already, not a dialog. The chart panel is a panel already.

## Design

### One hook holds the slot

The right-hand side of Sheets has two kinds of tenant. An explicit panel is opened by a click and stays until it is closed: comments, activity, and now conditional formatting and data validation. The object panel is implicit: it follows the selection.

**Recommended: an app-level hook, `useSheetPanels`, beside `use-sheet.ts` in `apps/sheets/src/components/sheets/hooks/`.** It calls `useDocumentPanels` unchanged and adds one state of its own, `rulesPanel: 'conditional-format' | 'validation' | null`. Opening a rules panel calls `closePanels`, and opening comments or activity clears `rulesPanel`, so at most one explicit panel is open and the last one opened wins. It answers one value the editor switches on, in this order:

| Slot | Shown when |
|---|---|
| `comments`, `activity` | `useDocumentPanels`' `panel` is set |
| `conditional-format`, `validation` | `rulesPanel` is set |
| `object` | None of the above, a chart or image is selected, and the viewport is not a phone |

So `DocumentPanel` and `PanelColumn`'s props stay as every other app uses them, and the sheet-only kinds stay in the Sheets app. `mobilePanelOpen` widens to "any explicit panel on a phone", so the workbook hides for a rules panel as it does for comments, and `onSearchOpenChange` closes a rules panel on a phone as it closes comments.

**A chart selected while a rules panel is open: the rules panel stays.** That is today's rule for comments ("The comment and activity panels take the place of the properties panel, as in Slides", `editor.tsx`), and Google's: its chart editor opens on a double-click, never on a select. The chart still moves, resizes and takes its menu on the grid. Closing the rules panel shows the chart's panel.

**The alternative: make the shared hook generic.** `useDocumentPanels<Extra>` would hold `'comments' | 'activity' | Extra` in its one state, and `PanelColumn` would take a body for the extra kinds. It saves the small "open one, close the other" wiring. It costs a type parameter in lib's comments domain and a sheet-shaped branch in a comments component that Docs, Slides, Vector and Stickies also mount. Not recommended while Sheets is the only app with extra kinds.

### One column shell

A rules panel is a third right-hand scaffold beside `PanelColumn` and `PropertiesPanel`, so the shell becomes one wrapper in `packages/ui`: the `Column` with `id="panel"`, the 256px width, the left border, `ToolbarTitle`, a place for actions, the close button on desktop and `onBack` on a phone. That is the outer half of `PanelColumn` today. `PanelColumn` keeps its props and draws its two bodies inside the wrapper, and the rules panel draws its own. `PropertiesPanel` is a plain `div` that never shows on a phone, and is left alone.

### Who opens a panel

The menu rows live in the Workbook, and the slot lives in the app. So the Workbook asks, as it asks for the image picker: a new hook `onOpenRulesPanel?: (kind) => void` in `Hooks` (`state/settings.ts`). Format → Conditional formatting and Data → Data validation call it. A host that passes no hook gets the rows disabled, as Insert → Image is without `onInsertImage`. That covers a Workbook mounted in a dialog.

The Format submenu shrinks to what the panel doesn't do in one click: the color scale and data bar presets stay as rows that add their rule at once, and one **Conditional formatting rules** row opens the panel. The two rule-type submenus, **Manage rules** and **Delete rule** go, since the panel's list, **Add rule** and **Remove all** replace them ([open question 5](#open-questions)).

### How the body reaches the workbook

**Recommended: as the chart panel does.** The bodies live in `packages/sheet` and are exported like `ChartPanelSections`. The Workbook reports what they show through one hook, `onRulesPanelChange`, with the current sheet's id, its conditional formats, its validation rules and the selection as range text, memoized on what it reads so the app's `setState` bails out when nothing changed. The bodies write through new `WorkbookInstance` methods that wrap the existing state functions (`setConditionRules`, `deleteSheetRule`, `clearSheetRules`, `applyDataValidation`, `clearValidations`). A method that can refuse returns the reason, as `setChartDataRange` does, so `conditionRuleError`, `validationRange` and `validationValueProblem` keep running against the live context.

**The alternative: a portal.** The app hands the Workbook an element, and the Workbook renders the body into it, inside its own `WorkbookContext`. The forms then move almost unchanged, with no new API methods. It is a second way for a panel body to reach the workbook, beside the chart panel's, and it puts the Workbook in charge of a subtree the app lays out. Not recommended.

### The list view

Each panel opens on a list of the current sheet's rules, and follows the sheet when the tab changes.

- **A row** is what `ManageRules` draws today: `RuleSwatch`, `describeRule` and the ranges in A1 text for a conditional format; the rule type's label (`VALIDATION_TYPES`) and the ranges for a validation rule, such as "Checkbox, B2:B5". A click opens the editor. A delete button on the row removes the rule. Pointing at a row or opening it selects its ranges on the grid, so the user sees what it covers.
- **Add rule** opens the editor on a new rule over the current selection.
- **Remove all** removes every rule of this kind on the sheet: `clearSheetRules` for conditional formats, each id for validation rules. It asks nothing, because one undo brings them back.
- **Empty** shows "No rules on this sheet." and **Add rule**.

Conditional formats list in priority order. Reordering by drag waits for the keyed store ([§ The rule store comes first](#the-rule-store-comes-first)), where a move writes one key.

### The editor view

The editor takes the list's place in the panel, with a back arrow to the list, **Done** and **Cancel**. It reuses the fields of `ConditionRules` and `DataValidation`. Their `FormDialog` wrappers go, and the bodies are restacked for 256px.

- **Conditional format.** A range field, which the dialog never had because it used the selection. A rule type select over `RULE_COPY`'s 13 types, in place of the two submenus. Then the value fields and the two `ColorChoice` rows as they are.
- **Validation.** The dialog's fields in the dialog's order: range, type, condition, values, the two toggles. **Delete validation** is the row's delete button.
- **Editing an existing conditional format is new.** It needs a function that reads a stored rule back into the form's draft (`ConditionRulesProps`). Three kinds don't map back: the conditions only an import writes (`greaterThanOrEqual`, `lessThanOrEqual`, `notEqual`, `notBetween`), a `formula` rule, which is also what a value typed with `=` is stored as ([SHEETS.md](../SHEETS.md#a-dialog-value-typed-with--is-stored-as-a-formula-rule)), and a color scale or data bar. For these the editor shows the condition as text and edits the range and, for the first two, the colors. Making them fully editable is a later row.
- **The editor closes back to the list** when the tab changes or a peer deletes the rule it holds.

### A range is picked on the grid

The panel is not modal, so the grid takes clicks while the editor is open. A range field has the grid button it has today. Pressing it puts the field in pick mode: the field is highlighted and follows the grid's selection, as `CellRangeDialog`'s effect follows `context.selections`, until the button is pressed again or another field takes the focus. The field stays typeable. The same button serves a drop-down list's source range. So `DataValidation`'s `pickRange`, its `draft` prop and `CellRangeDialog`'s `validation` variant go.

A simpler form is a **Use selection** button that copies the current selection into the field once. It is fewer states, and one more click per pick ([open question 3](#open-questions)).

### No live writes, and one undo step per rule

The chart panel writes every keystroke inside a gesture, and peers see the title as it is typed. A rule can't do that: a half-typed rule is often one the checks refuse, and a half-typed validation rule with **Prohibit input** on would refuse a peer's typing.

**Recommended: the editor holds a local draft, and Done writes it once.** That is what the dialogs do. One write is one op and one undo entry, so no `beginGesture` is needed. The draft is not in the workbook, so ⌘Z in a field is the field's own undo, which is right here, and `PropertyHistoryContext` is not needed for the editor. The list's buttons do write at once, and the focus is then in the panel, outside the Workbook's keydown. So the panel hands the undo chord to the workbook's `undo` and `redo`, with `undoChord` (`packages/ui/src/lib/undoChord.ts`), as the object panel's fields do.

**A local preview is a later step.** Google shows a conditional format on the grid while it is edited. Eigen can do the same without a write: the draft rule goes into the local context, never into an op, and `getComputeMap` (`state/modules/condition-format.ts`) adds it to the rules it evaluates. It is a small change, but it is a second input to the painter's cache, so it is its own phase and only for conditional formats.

### On a phone, and for a viewer

**A phone gets the panel as a full-screen column**, as it gets comments ([LAYOUT.md](../LAYOUT.md#on-a-phone-only-the-mobilecolumn-renders), [MOBILE.md](../MOBILE.md#a-phone-shows-one-column-and-the-rest-stays-mounted)). The workbook is hidden, not unmounted. So a range can't be picked on the grid there: a new rule takes the selection the user made before opening the panel, the range field is typed, and the grid button is hidden. The dialogs work on a phone today, so leaving the panel out there would take the feature away.

**A viewer gets nothing, as today.** The Format and Data menus are hidden without `allowEdit`, so there is no way in. A read-only list would need a new entry point for a viewer, and nobody has asked for one. A panel that is open when the user loses write access closes.

## The rule store comes first

Finding F9 of [SHEETS-SIMPLIFICATION-AUDIT.md](../SHEETS-SIMPLIFICATION-AUDIT.md#f9) proposes one keyed, ordered store for both rule kinds: `Record<id, { ranges, order, … }>` with `order` a fractional key, as images and charts have. It sizes itself at about 400 lines rewritten for about 130 fewer, high risk.

What each part of this proposal needs from it:

| Part | Needs F9? | Why |
|---|---|---|
| The slot, the shell, the validation panel | No | Validation rules already have ids, and each write is one key |
| The conditional-format list, add and delete | No, but no better than today | The list is drawn from the live sheet, so a delete names the index the user sees. The race is the one `ManageRules` has: a peer's add or remove still in flight |
| Editing a conditional format | **Yes** | The editor holds one rule while the user types, for seconds or minutes. A peer's add or remove in that time moves the index, and Done would overwrite another rule. An id inside the array record does not help, because the op names the rule by its index path |
| Reorder | **Yes** | In an array a move rewrites the list. In the keyed store it writes one `order` |

F9 also makes a rule add or remove an ordinary key write, so it stops being a structural undo entry that a peer's batch drops, and it closes the SHEETS-TODO row "Two conditional-format rules added at once can lose one".

**F9 is a stored-format change, approved by the owner on 2026-11-11 ("we don't have to be BC").** It changes the snapshot (`packages/lib/src/sheets/snapshot-codec.ts`), the op shapes (`yjs-ops.ts`), the engine's shift and carry, the xlsx import and export of rules, and the HTML export. The owner has ruled that stored sheet JSON need not stay backward compatible and that a shape the build no longer reads may be dropped where it is read ([SHEETS-TODO.md § Package rulings](../SHEETS-TODO.md#package-rulings)). So no decoder conversion is required; whoever builds F9 picks the simpler of converting old rules (array index to `order`) or dropping them. To check at its Step 0: a workbook whose log was not yet folded holds old ops with index paths, which the new build must fold or drop without harm.

**Nothing else needs a Critical Rules yes.** The panels are client code in `packages/sheet`, `apps/sheets` and `packages/ui`. No new API route, no schema version in a `db-config.ts`, no column in `users3.db`, no npm package.

## Phasing and effort

| Phase | What | Effort | Needs |
|---|---|---|---|
| 1 | The slot: `useSheetPanels`, the column shell in `packages/ui`, `onOpenRulesPanel` and `onRulesPanelChange` | S (1 day) | Nothing |
| 2 | The validation panel: list, editor, pick mode, Remove all, the phone column. The Data menu row opens it | M (2 to 3 days) | Phase 1 |
| 3 | The conditional-format panel without edit: list, Add rule with a range field and a type select, delete, Remove all. The Format submenu shrinks | M (1 to 2 days) | Phase 1 |
| 4 | F9, then edit and reorder for conditional formats | M for F9 as the audit sizes it, then S to M (1 to 2 days) | F9 merged (approved 2026-11-11) |
| 5 | Local preview of a conditional format while it is edited | S | Phase 3. Optional |

Phases 2 and 3 can ship without phase 4. Phase 3 before 4 leaves conditional formats where they are today, delete and make again, but in the panel.

**What goes away:** `ManageRules` as a dialog, `ConditionRules` as a dialog, `DataValidation`'s `FormDialog`, `pickRange` and `draft` prop, `CellRangeDialog`'s `validation` variant (the read-only branch and the `variant` prop's second meaning), the two rule-type submenus, **Manage rules** and **Delete rule** in `conditional-formatting-menu.tsx`. With phase 4, `deleteSheetRule`'s index and what the audit lists under F9.

**Docs in the same cycle:**

- Help center: `apps/index/src/data/support/sheets/data-validation.md` (its "Open the data validation dialog" section, every "click **OK**", the grid-icon paragraph) and `sheets/conditional-formatting.md` (the menu paths, "In the dialog that opens", Manage rules) are rewritten. `sheets/tick-boxes.md` changes its last section, which points at Data → Data validation. `sheets/create-and-edit.md` and `sheets/enter-and-edit-data.md` change their undo paragraph with phase 4, since a removed rule stops being a step a peer's edit ends.
- [SHEETS.md](../SHEETS.md): the dialog paragraph of "`packages/sheet` is a fork we own", "A dialog value typed with `=` is stored as a formula rule" (its title and "Manage rules then lists it"), a new section for the rules panels beside the chart panel's, and with phase 4 the array paragraph of "Position-bound properties live beside the cell", "A validation rule is stored once over its ranges" and the structural-entry list.
- [LAYOUT.md](../LAYOUT.md) and [SHARED-PRIMITIVES.md](../SHARED-PRIMITIVES.md): the column shell.
- [SHEETS-TODO.md](../SHEETS-TODO.md): the lost-rule row closes with phase 4. `CHANGELOG.md` per phase.

## Risks

- **256px is narrow.** `DataValidation`'s between row and the conditional format's two inputs with "and" need restacking, and the color popovers need room to open. Check at the first build before the rest.
- **Focus.** The grid's keydown and the cell editor's refocus (`useCellEditorRefocus`) assume a dialog gives the focus back when it closes. A panel never closes that way: a click on the grid must take the focus from a panel field, and typing in a panel field must not reach the cell editor. The chart panel's fields already live with this.
- **A draft and a peer.** A peer can change or delete the rule an editor holds. With ids the editor can tell, and closes or keeps the draft as a new rule. Without ids it can't, which is why edit waits for phase 4.
- **F9 is rated high risk by its own audit.** Its Step 0 sizes it again and goes to the owner before it is built.

## Open questions

1. ~~**Is the stored-format change of F9 approved?**~~ Ruled 2026-11-11: yes, with no backward compatibility needed. F9 is being built.
2. ~~**Build the validation panel before F9?**~~ Ruled 2026-11-11, as recommended: yes. It needs no format change and is the panel the owner saw in Google.
3. ~~**Pick mode or a Use selection button for the range?**~~ Ruled 2026-11-11, as recommended: pick mode, since it is what the grid button does today, without the second dialog.
4. ~~**Local draft with Done, or live writes as the chart panel?**~~ Ruled 2026-11-11, as recommended: the draft, for the reasons in [§ No live writes](#no-live-writes-and-one-undo-step-per-rule), with the local preview as an optional phase 5.
5. ~~**Do the rule types leave the Format menu?**~~ Ruled 2026-11-11, as recommended: yes, with the presets kept as one-click rows. The other answer keeps the 13 rows and has each open the panel's editor on that type.
6. ~~**A read-only list for a viewer?**~~ Ruled 2026-11-11, as recommended: no, as today.
7. **Where does this sit on the roadmap?** Its row is in ROADMAP-POST-1's deferred table, as a product change nobody is blocked on. Phase 4's F9 is already in the audit's Wave 3, so the owner may want phases 1 and 2 sooner.

## Related

- [SHEETS.md](../SHEETS.md): the dialog slot, the chart panel, how each rule kind is stored
- [SHEETS-SIMPLIFICATION-AUDIT.md](../SHEETS-SIMPLIFICATION-AUDIT.md#f9): F9, the keyed rule store
- [SHEETS-TODO.md](../SHEETS-TODO.md#sync-and-undo): the rows F9 closes
- [COMMENTS.md](../COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it): the pane on a phone
- [LAYOUT.md](../LAYOUT.md) and [MOBILE.md](../MOBILE.md): `Column`, the phone's one column
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md): a Workbook mounted with no panel slot
