# Sheets Cell Glyphs

> **TLDR:** Tick boxes, list chevrons and the three corner marks are canvas paint, not DOM. The model and geometry live in `packages/sheet/src/state/modules/data-verification.ts` and `cell-glyph.ts`, the paint in `state/render/cells.ts`. Not obvious from the code: a tick box is a data-verification rule and the cell value is its checked state, painter and hit test read one rect per glyph, a glyph under a selection handle wins the press, and nothing toggles while a cell edit is open. The workbook model around them: [SHEETS.md](SHEETS.md).

## A tick box is a validation rule, and the value is its state

`Insert → Tick box` and the cell context menu both call `insertCheckbox`, which writes a `checkbox` rule with the values `TRUE` and `FALSE`. That is Google's model: a tick box is data validation, not a cell format. The context-menu entry exists because the common intent is converting an existing TRUE/FALSE column.

There is no checked flag on the rule. `isCheckboxChecked` compares the cell's display value with the rule's checked value, ignoring case. So an imported, pasted, typed or formula-produced `TRUE` renders ticked. Applying a rule seeds the unchecked value into empty cells only, so a tick box over an existing column loses nothing. A formula cell is a read-only tick, because a toggle would replace the formula with a literal.

A default rule draws the box alone, the way Google does. A rule with custom values also draws its label, the only way to tell "Yes" from "No". So does a cell holding a value the rule names neither of (`showsCheckboxLabel`), so a tick box laid over a column of prose never paints the data away. Empty cells in the range draw the plain unchecked box, so the range reads as one column.

A header click selects the whole axis, so `insertCheckbox` clips it to the used extent (`clipToUsedExtent` in `state/utils/index.ts` says why). A dragged range applies exactly as selected, which is how a checklist over empty rows gets its boxes.

## A list chevron is painted on every cell its rule covers

A `dropdown` rule paints a chevron on every cell it covers, empty ones included (`renderDropdownChevron`, called from `cellRender` and `nullCellRender`). Most list-validated cells are empty, and without the chevron a blank validated cell looks like a free-text one. Keyboard users and read-only viewers see it too.

It overlays the cell text rather than reserving width, because reserving would reflow every validated column. Its color is the cell's own `fc` at 55% alpha, since real workbooks put list rules on dark fills that a fixed gray would vanish into.

Clicking the chevron opens the list, and a click anywhere else in the cell selects. A viewer sees the chevron but gets no list. The `#sheet-dataVerification-dropdown-btn` element is only an invisible anchor for the portaled menu.

## Painter and hit test read one rect

Each glyph has one geometry function that both the painter and the mousedown hit test call: `checkboxRect`, `dropdownChevronRect` and `cellIndicatorRect`. It is the same split as the filter button's `FILTER_BUTTON_WIDTH`/`HEIGHT`, and it means a glyph and its click target cannot drift apart. The tick box gets its bounds from `cellTextBox` on both sides. Only the box toggles; Space or Enter toggles the focused cell. The chevron's click strip is wider than the glyph but built from the same rect, and both drop out below a minimum column width.

## Nothing toggles while a cell edit is open

Clicking a tick box while composing `=IF(` inserts the cell's reference and nothing else. A toggle would write the cell and kick a recalc behind the half-typed formula. The chevron is gated the same way, since its list would open over the formula, and so is the keyboard path (`state/events/mouse-cell.ts`, `keyboard.ts`).

## Three corner marks share one painter

A comment (top-right), an invalid value and a forced string (top-left) are all drawn by `drawCellIndicator` at `cellIndicatorRect`. The size is `CELL_INDICATOR_SIZE` in `packages/lib/src/constants/comment-indicator.ts`, which the canvas apps' `CommentIndicator` reads too, so a comment mark looks the same in every app. Filled and empty cells reach the same painter. A comment triangle takes its card's color, and red when the card has none.

Canvas colors are hardcoded light, because the grid is paper and doesn't re-theme ([RENDERING.md](../packages/sheet/RENDERING.md#theming-the-light-pinned-surface)).

## A glyph outranks the selection handles

The selection carries two invisible DOM hit targets over the canvas: the move band on its border and the fill handle at its corner. Without a precedence rule, a press on a chevron at the fill corner starts a fill drag. `cellGlyphAt` (`state/modules/cell-glyph.ts`) says which glyph sits under a point, from the painter's rects. Both handles ask it first, and on a hit they start no drag, so the press reaches the cell area, which opens the list, toggles the box or selects. `packages/sheet/src/test/state/events/mouse-cell.test.ts` pins the chevron at the fill corner and a mark under the band.

The hover path writes the same answer to `context.cellGlyphHover`, which shows a pointer over a chevron or tick box and stands the handles' own cursors down. Row and column resize never compete, because those handles live in the headers.

## The validation card follows the focus cell

One React card, `components/DataVerification/HintCard.tsx`, shows a validated cell's prompt or, when its value fails the rule, why. `getValidationHint` derives it from the focus cell on every render. So it follows keyboard navigation, never strands over the previous cell, and renders a collaborator's or an xlsx file's prompt as text, never as markup.

A rejection outranks a prompt, since it is the more urgent message. The card stands down while the list is open, because both hang over the same corner. The copy is assembled by `describeValidationRule`, which also words the `prohibitInput` dialog, so both ways a rejected value is reported say the same thing.

## See also

- [SHEETS.md](SHEETS.md): the workbook model, and where validation rules live
- [COMMENTS.md](COMMENTS.md): the comment cards behind the corner triangle
- [RENDERING.md](../packages/sheet/RENDERING.md): the canvas and DOM overlay layers
