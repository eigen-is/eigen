---
title: "Format cells and numbers"
description: "Change the appearance of cells in Sheets: text style, number format, alignment, borders, and more."
type: how-to
tags: [sheets, formatting, cells, numbers, alignment, borders]
related: [sheets/conditional-formatting]
order: 60
updated: 2026-06-08
---

Sheets lets you change how cells look without changing the values inside them. You can apply text styles, number formats, colours, borders, and alignment from the **Format** menu in the toolbar.

All formatting requires edit access to the spreadsheet. The quick-format buttons in the centre of the toolbar are hidden when the spreadsheet is read-only.

## Text style

To change how text looks in one or more cells:

1. Select the cells you want to format.
2. Open **Format → Text**.
3. Choose from the available styles:
   - **Bold (Ctrl+B)**: makes the text heavier.
   - **Italic (Ctrl+I)**: tilts the text.
   - **Underline**: adds a line under the text.
   - **Strikethrough (Alt+Shift+5)**: draws a line through the text.
4. To change the font family, open **Format → Text → Font** and pick a font from the list.
5. To change the text colour, open **Format → Text → Font color** and pick a colour from the picker.

## Font size

1. Select the cells.
2. Open **Format → Font size** and choose a size: 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, or 72.

## Number format

Number formatting controls how a value is displayed. The stored value does not change.

1. Select the cells.
2. Open **Format → Number** and choose a format:

   | Format | What it shows |
   |--------|--------------|
   | **Automatic** | Sheets decides the display based on the value |
   | **Plain text** | Shows the raw value with no formatting |
   | **Number** | Shows two decimal places (e.g. `1000.12`) |
   | **Percent** | Multiplies by 100 and adds a % sign (e.g. `12.21%`) |
   | **Scientific** | Scientific notation (e.g. `1.01E+5`) |
   | **Accounting** | Currency symbol, two decimal places, negatives in brackets |
   | **Currency** | Currency symbol followed by the value |
   | **Date** | Formats as `yyyy-MM-dd` |
   | **Time** | Formats as `hh:mm AM/PM` |
   | **Time 24H** | Formats as `hh:mm` |
   | **Date time** | Date and time combined |

3. To choose from a wider list of currency, number, or date formats, point to **Custom formats** and then open **More currency formats**, **More number formats**, or **More date and time formats**.

## Cell colour

### Fill colour

1. Select the cells.
2. Open **Format → Fill color** and pick a colour from the picker.

You can also use the fill colour button (the highlighter icon) in the quick-format bar in the centre of the toolbar.

### Text colour

1. Select the cells.
2. Open **Format → Text → Font color** and pick a colour.

The text colour button (a letter icon with a colour stripe beneath it) is also in the quick-format bar.

## Alignment

### Horizontal alignment

1. Select the cells.
2. Open **Format → Alignment** and choose **Left**, **Center**, or **Right**.

The three alignment buttons in the quick-format bar in the centre of the toolbar do the same thing.

### Vertical alignment

1. Select the cells.
2. Open **Format → Alignment** and choose **Top**, **Middle**, or **Bottom**.

## Text wrapping

By default, text that is wider than a cell overflows into the next empty cell. You can change this:

1. Select the cells.
2. Open **Format → Wrapping** and choose an option:
   - **Overflow**: text spills into the next empty cell (the default behaviour).
   - **Wrap**: the row grows taller to show all the text inside the cell.
   - **Clip**: text is cut off at the cell edge.

## Text rotation

To rotate text inside a cell:

1. Select the cells.
2. Open **Format → Text rotate** and choose a preset: **None**, **Tilt Up**, **Tilt Down**, **Stack Vertically**, **Rotate Up**, or **Rotate Down**.

## Borders

To add or remove borders around cells:

1. Select the cells.
2. Open **Format → Borders** and choose a border type:
   - **Top border**, **Bottom border**, **Left border**, **Right border**: adds a border to one side only.
   - **No border**: removes all borders from the selection.
   - **All borders**: adds borders around and between every cell in the selection.
   - **Outside border**: adds a border around the outer edge of the selection only.
   - **Inside border**: adds borders between cells, but not around the outer edge.
   - **Horizontal borders** or **Vertical borders**: adds borders in one direction only.
   - **Slash border**: draws a diagonal line across each cell.

To set a custom border colour or line style, point to **Custom border…** at the bottom of the **Borders** submenu and pick a colour and a style. The settings apply the next time you click a border type.

## Merge cells

Merging combines several cells into one. The content of the top-left cell is kept; content in other cells is discarded.

1. Select the cells to merge.
2. Open **Format → Merge cells** and choose an option:
   - **Merge all**: merges the entire selection into one cell.
   - **Merge Horizontally**: merges each row in the selection separately.
   - **Merge Vertically**: merges each column in the selection separately.

To split merged cells back apart, select the merged cell and choose **Format → Merge cells → Unmerge**.

<div class="eigen-callout">

Merging cells can break sorting, filtering, and some formulas. Avoid merging cells inside a data range you intend to sort or filter.

</div>

## Clear formatting

To remove all formatting from a selection without changing the values:

1. Select the cells.
2. Open **Format → Clear formatting**.

Clearing formatting removes text styles, colours, alignment settings, borders, and number formats. It keeps the cell values.
