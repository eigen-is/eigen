---
title: "Set up data validation"
description: "Restrict what can be entered in a cell by adding a dropdown list or a rule that checks the value before it is accepted."
type: how-to
tags: [sheets, data-validation, dropdown, rules]
related: [sheets/enter-and-edit-data, sheets/conditional-formatting]
order: 50
updated: 2026-11-02
---

Data validation lets you control what goes into a cell. You can add a dropdown list so people pick from a fixed set of options, or write a rule that rejects a value if it falls outside a range, does not match a pattern, or fails another condition.

## Open the data validation dialog

1. Select the cell or cells you want to validate.
2. Open the **Data** menu and click **Data validation**.

The dialog shows the current selection in the **Cell range** field. You can type a different range there, or click the grid icon next to it to select a range with the mouse. When you confirm the range, the dialog comes back with everything you had filled in.

When you click **OK**, Sheets checks the rule first. If something can't be used, such as a range that names no cells or a list with no options, the dialog stays open and a message under the field says what is wrong.

If you selected a whole column by clicking its header letter, the field shows it as `B:B`, and the rule covers every row of that column, including the rows below your data. A whole row shows as `2:2`.

## Add a dropdown list

1. Under **Validation condition**, choose **Drop-down list** from the menu.
2. In the field below, type the options separated by commas, for example `Yes,No,Maybe`. To use values from existing cells instead, click the grid icon next to the field and select the range.
3. Tick **Allow multiple selection** if you want people to be able to pick more than one option from the list.
4. Click **OK**.

A cell with a dropdown shows a small arrow at its right edge. Click it to open the list of options, or select the cell and press **Alt+Down**.

## Add a checkbox

1. Under **Validation condition**, choose **Checkbox**.
2. Optionally, enter the values that represent the **Selected** (checked) and **Not selected** (unchecked) states.
3. Click **OK**.

The cell displays a checkbox that toggles between the two values when clicked.

## Add a number rule

1. Under **Validation condition**, choose **Number**, **Whole number**, or **Decimal number**, depending on what you need.
2. Choose a condition from the second menu: **Between**, **Not between**, **Equal to**, **Not equal to**, **Greater than**, **Less than**, **Greater than or equal to**, or **Less than or equal to**.
3. Enter the value or values the rule compares against.
4. Click **OK**.

**Text length** follows the same steps and conditions, but checks the number of characters in the cell rather than a numeric value.

## Add a text rule

1. Under **Validation condition**, choose **Text**.
2. Choose a condition: **Includes**, **Does not include**, or **Equal to**.
3. Type the text the rule checks against.
4. Click **OK**.

## Add a date rule

1. Under **Validation condition**, choose **Date**.
2. Choose a condition: **Between**, **Not between**, **Equal to**, **Not equal to**, **Earlier than**, **Not earlier than**, **Later than**, or **Not later than**.
3. Enter the date or dates the rule compares against.
4. Click **OK**.

## Options that apply to all rules

Two checkboxes at the bottom of the dialog apply to every validation type:

- **Prohibit input when input data is invalid**: blocks the entry and shows a failure notice if someone types a value that fails the rule.
- **Show prompt when the cell is selected**: displays a hint message when the cell receives focus. When this is ticked, a text field appears where you can write the hint.

## Remove a rule

1. Select the cells whose rule you want to remove.
2. Open **Data → Data validation**.
3. Click **Delete validation**.

The rule is removed from those cells.

## Rules when you paste or insert

When you copy or cut cells and paste them in the same browser tab, their rules come along. They replace the rules of the cells you paste over, and a copied cell without a rule removes the rule where it lands.

A row or column you insert inside a rule's range gets the rule. One you insert above or right below the range doesn't.

An edit that would break one rule into too many separate pieces isn't made. Pasting a cell with a rule and one without down a long column does that, since the rule would land on every other row. Sheets leaves the sheet as it was and shows "This edit would make a data validation rule too complex." The same goes for a fill, a move and the format painter.

<div class="eigen-callout">

A spreadsheet whose rules were set up in an older version of Eigen opens without its dropdowns, checkboxes and other rules. Every cell keeps its value. Set the rules up again, or import the original Excel file again.

</div>
