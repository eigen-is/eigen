# Sheets Export

> **TLDR:** The server renders a workbook to HTML, PDF and xlsx in `apps/api/src/lib/export/sheets/`, from the `Sheet[]` that `readSheetsFromDoc` returns. Not obvious from the code: the full HTML export styles cells by class, because the sanitizer CSS-parses every inline style; that one stylesheet is guarded at two seams; conditional formats run through the same engine as the canvas; and several xlsx round-trip drifts are decisions, not bugs. The Worker, the route and the xlsx writer: [EXPORT.md](EXPORT.md#a-sheet-export-recalcs-and-xlsx-carries-cells-only). The workbook model: [SHEETS.md](SHEETS.md).

## The full export styles cells by class

`renderSheetsHtml` interns every style it emits (cell, row height, column width, data bar, rotation, image) into a workbook-global registry of classes and returns `{ html, css }`. The document builders put the rules in a body `<style>` element, which goes through `sanitizeExportHtml` with the markup.

A real workbook repeats a few hundred styles across hundreds of thousands of cells. DOMPurify on jsdom CSS-parses every inline `style` attribute it sanitizes, but passes class attributes and style-element text through as strings. With inline styles a real workbook's export was 82 MB and took 104 s, mostly CSS parsing.

The preview (`renderSheetsPreviewHtml`) keeps inline styles, because its body fragment embeds without a `<head>` ([PREVIEWS.md](PREVIEWS.md)). Its bytes are golden-pinned in `apps/api/src/test/preview/sheets-preview.test.ts`.

## The stylesheet is guarded at two seams

Cell values are schemaless CRDT strings, and stylesheet text is a different escaping context from a style attribute. Two guards keep it inert, each at a seam rather than per field:

- `serializeStyleRules` strips what is structural in CSS text from every declaration. `<` and `>` would end the `<style>` element, and DOMPurify keeps what follows, so an `<svg><image href>` becomes a server-side fetch under WeasyPrint. `{` and `}` open rule blocks. `\` starts a CSS escape, which spells `url(` or `@import` invisibly to the sanitizer. `/*` opens a comment that would swallow every later rule, so one odd cell would unstyle the rest of the workbook.
- Numeric fields are coerced, not escaped. Row heights and column widths go through `cssLength`, the same `Number()` guard `getSheetContentSize` applies for the `@page` rule.

Values are still `escapeHtml`'d on the way in, except the font family: entity encoding would corrupt a real name like `Bell MT & Co`, so its quotes and backslashes are dropped instead. The sanitizer's data-URI rule and `@import` strip cover style-element text too ([EXPORT.md](EXPORT.md#the-sanitizer-keeps-only-data-references-because-weasyprint-fetches)).

## Conditional formats run through the canvas engine

`render.ts` calls `evaluateConditionalFormat` per sheet and merges its colors into each cell's style, so an export shows what the canvas shows. For formula rules it builds one `FormulaEngine` and one `createArrayResolver` over all loaded sheets, so a cross-sheet rule like `=Sheet2!A1>10` resolves. The pass reads `cell.v` and never recomputes the sheet's own formulas. Those values are already fresh, because `readSheetsFromDoc` ran the gated recalc ([SHEETS-FORMULAS.md](SHEETS-FORMULAS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)).

A data bar is an absolutely positioned `<div>` inside a `position:relative` cell, with geometry mirrored from the canvas painter. Negative bars are red, as on the canvas.

## Floating images are an overlay on the table

A sheet with images wraps its table in a `position:relative` box and emits one absolutely positioned `<img>` per image it can resolve, at the stored position and size, rotated about its center. That is the same box the editor's `ImgBoxs` lays out, because both read the same fields.

The stored coordinates are grid pixels from A1, while the table starts at the used range. So the overlay subtracts the rows and columns above and left of that window. An image above or left of the used range pulls the window back to where the image starts, so the offset never goes negative and the page covers the image.

An image's name is a media reference ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)), looked up in a map the transform prepared: `data:` URIs for an export, preview URLs for a preview. A name that resolves to nothing renders nothing. The xlsx export drops images, because ExcelJS has no floating-picture writer this exporter uses.

## Some xlsx round-trip drifts are decisions

These are deliberate. Where a test pins one, it is in `apps/api/src/test/export/sheets-export.test.ts`. Hyperlinks:

- A `sheet` link re-imports as a `cellrange` link at `'Name'!A1`, and a range link keeps only its top-left cell, because ExcelJS's internal-link pattern needs a single trailing cell ref. A bare ref gains its own sheet's quoted prefix. A webpage URL with exactly one `!` and a cell-shaped tail is misread as internal by that pattern.
- Imported link cells keep Excel's font, while the link dialog sets blue and underline. Forcing the dialog style at import would clobber theme-styled link cells.
- A link to another workbook that carries a sheet anchor imports as an internal link: the `location` attribute wins over the relationship target.

Rules and comments:

- `duplicateValue` exports as a COUNTIF formula and re-imports as a `formula` rule, which renders the same. `occurrenceDate` is editor-only and is not exported.
- `encodeCfOperand` quotes exotic numeric literals (`1e5`, `+5`) as text. The engine compares with `Number()`, so rendering is unaffected.
- The data-validation exporter always writes `allowBlank: true`, Excel's UI default.
- Tick boxes are editor-only. The cells export their values and the rule is dropped: OOXML has no cell tick box ExcelJS can write, and a `"TRUE,FALSE"` list would re-import as a dropdown, a different feature.
- Excel comments and notes are not imported, because Eigen has its own comment cards.

## See also

- [EXPORT.md](EXPORT.md): the export pipeline, the sanitizer, the xlsx importer
- [SHEETS-FORMULAS.md](SHEETS-FORMULAS.md): the recalc that runs before an export
- [PREVIEWS.md](PREVIEWS.md): the sheets preview
