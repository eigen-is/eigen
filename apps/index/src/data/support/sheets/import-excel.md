---
title: "Import an Excel file"
description: "Bring an .xlsx spreadsheet into Eigen Sheets: add its sheets to a spreadsheet, replace a spreadsheet with it, or convert a file already in Drive."
type: how-to
tags: [sheets, import, excel, xlsx, spreadsheet]
related: [sheets/get-started, sheets/export-spreadsheet]
order: 110
updated: 2026-10-23
---

You can bring an Excel workbook into Sheets in two ways: import it into a spreadsheet you have open, as new sheets or in place of its content, or convert an `.xlsx` file stored in Drive into a new spreadsheet.

## Import into an open spreadsheet

1. Open the spreadsheet.
2. Click **File** in the top-left of the menu bar.
3. Click **Import…**.
4. A dialog opens. You can either:
   - Browse your Drive to pick an `.xlsx` file you have already uploaded, then click **Select**.
   - Click **Upload from device** to open a file chooser and pick an `.xlsx` file from your computer.
5. Choose how the workbook comes in, then click **Import**:
   - **Insert as new sheets** adds the workbook's sheets after the ones the spreadsheet has. This is the default.
   - **Replace spreadsheet** replaces the whole spreadsheet with the workbook.

An **Importing xlsx file** dialog shows while Sheets loads all the sheets from the workbook. The change is saved automatically.

When you insert, a sheet whose name the spreadsheet already uses gets "(Copy)" added to its name, so **Budget** comes in as **Budget(Copy)**. Formulas and links from the workbook that point at that sheet follow the new name, so they keep showing the same values.

When you replace, Eigen saves a version of the spreadsheet first, so you can get the previous content back from **File → Version history**. See [See and restore previous versions of a file](/support/drive/file-versions).

## Convert an Excel file in Drive to a new spreadsheet

If you have an `.xlsx` file sitting in Drive, you can turn it into a Sheets spreadsheet without opening it first. This leaves the original file in place and creates a new spreadsheet alongside it.

1. Open [Drive](/drive) and find the `.xlsx` file.
2. Right-click the file (or open the **⋮** menu) and choose **Convert to Sheet**.

Drive creates a new spreadsheet in the same folder and opens it in Sheets.

## What carries over

The import reads every worksheet in the workbook and preserves:

- Cell values (text, numbers, booleans, and dates)
- Formulas
- Merged cells
- Column widths and row heights
- Cell borders
- Text formatting: bold, italic, underline, strikethrough, font size, and text color, also where one cell mixes several formats
- Fill colors
- Text alignment (horizontal and vertical), text wrapping, and text rotation
- The sheet tab names, colors, and order
- Hidden sheets, which stay hidden until you show them from the **View** menu
- The gridlines setting (hidden or visible)
- Conditional formatting rules, data validation rules, and hyperlinks
- Frozen rows and columns, and the range a filter covers (the values ticked in each column's dropdown are not carried over)

Fonts from Excel are mapped to the four fonts Sheets supports. Common sans-serif fonts (such as Calibri, Arial, and Verdana) map to Inter; serif fonts (such as Times New Roman and Georgia) map to Source Serif 4; monospace fonts (such as Courier New and Consolas) map to JetBrains Mono; Comic Sans maps to Excalifont.

## What does not carry over

The following are not imported:

- Charts
- Images embedded in cells
- Comments and notes

If these are important, keep the original `.xlsx` file in Drive so you have a reference copy.

A password-protected Excel file can't be imported. Open it in Excel, remove the password, save it, and import it again.

A workbook whose only sheets are chart sheets can't be imported yet, because Sheets has nothing to show from it.
