---
title: "Set up data validation"
description: "Restrict what can be entered in a cell by adding a dropdown list or a rule that checks the value before it is accepted."
type: how-to
tags: [sheets, data-validation, dropdown, rules]
related: [sheets/enter-and-edit-data, sheets/conditional-formatting]
order: 50
updated: 2026-06-08
---

Data validation lets you control what goes into a cell. You can add a dropdown list so people pick from a fixed set of options, or write a rule that rejects a value if it falls outside a range, does not match a pattern, or fails another condition.

## Open the data verification dialog

1. Select the cell or cells you want to validate.
2. Open the **Data** menu and click **Data verification**.

The dialog shows the current selection in the **Cell range** field. You can type a different range there, or click the grid icon next to it to select a range with the mouse.

## Add a dropdown list

1. Under **Verification condition**, choose **drop-down list** from the menu.
2. In the field below, type the options separated by commas, for example `Yes,No,Maybe`. To use values from existing cells instead, click the grid icon next to the field and select the range.
3. Tick **Allow multiple selection** if you want people to be able to pick more than one option from the list.
4. Click **OK**.

When someone clicks a cell with a dropdown, a small arrow button appears at the right edge. Clicking it opens the list of options.

## Add a checkbox

1. Under **Verification condition**, choose **Checkbox**.
2. Optionally, enter the values that represent the **Selected** (checked) and **Not selected** (unchecked) states.
3. Click **OK**.

The cell displays a checkbox that toggles between the two values when clicked.

## Add a number rule

1. Under **Verification condition**, choose **Number**, **Number-integer**, or **Number-decimal**, depending on what you need.
2. Choose a condition from the second menu: **Between**, **Not between**, **Equal**, **Not equal to**, **More than the**, **Less than**, **Greater or equal to**, or **Less than or equal to**.
3. Enter the value or values the rule compares against.
4. Click **OK**.

**Text-length** follows the same steps and conditions, but checks the number of characters in the cell rather than a numeric value.

## Add a text rule

1. Under **Verification condition**, choose **Text-content**.
2. Choose a condition: **Include**, **Exclude**, or **Equal**.
3. Type the text the rule checks against.
4. Click **OK**.

## Add a date rule

1. Under **Verification condition**, choose **Date**.
2. Choose a condition: **Between**, **Not between**, **Equal**, **Not equal to**, **Earlier than**, **No earlier than**, **Later than**, or **No later than**.
3. Enter the date or dates the rule compares against.
4. Click **OK**.

## Options that apply to all rules

Two checkboxes at the bottom of the dialog apply to every validation type:

- **Prohibit input when input data is invalid**: blocks the entry and shows a failure notice if someone types a value that fails the rule.
- **Show prompt when the cell is selected**: displays a hint message when the cell receives focus. When this is ticked, a text field appears where you can write the hint.

## Remove a rule

1. Select the cells whose rule you want to remove.
2. Open **Data → Data verification**.
3. Click **Delete verification**.

The rule is removed from those cells.

<div class="eigen-callout">

Validation rules travel with the cell when you copy and paste it.

</div>
