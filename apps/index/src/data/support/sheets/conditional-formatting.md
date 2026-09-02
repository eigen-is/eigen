---
title: "Apply conditional formatting"
description: "Colour cells automatically based on their values by adding conditional formatting rules in Sheets."
type: how-to
tags: [sheets, formatting, conditional formatting, colour]
related: [sheets/format-cells]
order: 70
updated: 2026-06-08
---

Conditional formatting changes the colour of a cell whenever its value meets a rule you set. You can highlight cells that cross a threshold, pick out duplicates, or colour a whole range with a gradient that reflects the spread of values.

## Add a highlight rule

Highlight rules apply a text colour or background colour to cells that match a specific condition.

1. Select the cells you want to format.
2. Open the **Format** menu and choose **Conditional formatting**.
3. Point to **Highlight cell rules** to open its submenu. Choose a condition:
   - **Greater than** or **Less than**: enter a number as the threshold.
   - **Between**: enter a lower and upper bound.
   - **Equal to**: enter an exact value or text.
   - **Text contains**: enter a text string.
   - **Date is**: pick a date.
   - **Duplicate value**: flag duplicate or unique values in the selection.
4. In the dialog that opens, set the colours you want to apply. Tick **Text color** to change the text colour, or **Cell color** to fill the background, then click the colour swatch next to each to pick a colour.
5. Click **OK**.

## Add an item selection rule

Item selection rules highlight the top or bottom values in a range, or cells above or below the average.

1. Select the cells you want to format.
2. Open the **Format** menu, choose **Conditional formatting**, then point to **Item selection rules**.
3. Choose a condition: **Top 10**, **Top 10%**, **Last 10**, **Last 10%**, **Above average**, or **Below average**.
4. For the top/bottom rules, change the number in the dialog if you want more or fewer items highlighted.
5. Set the colours and click **OK**.

## Apply a colour scale

A colour scale shades cells with a gradient that reflects their value relative to the rest of the range. Higher values get one colour, lower values another.

1. Select the range.
2. Open **Format → Conditional formatting → Color scale**.
3. Choose one of the preset gradients from the submenu. The range is coloured immediately.

## Apply a data bar

A data bar draws a coloured bar inside each cell proportional to its value.

1. Select the range.
2. Open **Format → Conditional formatting → Data bar**.
3. Choose a colour preset. The bars appear in the cells straight away.

## View and delete rules

To see all the rules on the current sheet, open **Format → Conditional formatting → Management rules**. The dialog lists every rule, shows a colour preview, and shows the range it applies to. Click the **×** next to a rule to delete it.

To remove all conditional formatting from the current sheet at once, open **Format → Conditional formatting → Delete rule → Delete sheet rule**.
