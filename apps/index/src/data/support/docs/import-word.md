---
title: "Import a Word document"
description: "Replace the contents of a document with text, headings, and images from a .docx file."
type: how-to
tags: [docs, import, word, docx]
related: [docs/export, docs/create-and-edit]
order: 100
updated: 2026-10-23
---

You can import a `.docx` file into an open document. The import replaces everything in the document with the content from the Word file: its text and formatting, headings, lists, tables, page breaks, images, charts, and equations.

<div class="eigen-callout">

Importing replaces the entire document: its text, headers and footers, and page setup. Eigen saves a version of the document first, so you can get the previous content back from **File → Version history**. See [Restore a previous version of a document](/support/docs/doc-versions).

</div>

## Import from inside the document

1. Open the document in Docs.
2. Click **File** in the toolbar.
3. Click **Import…**.
4. In the **Import docx file** dialog, browse your Drive and select the `.docx` file you want to use, then click **Select**. To use a file from your computer instead, click **Upload from device** and pick the file from the file chooser.
5. A dialog reminds you that the file replaces the whole document. Click **Import**, or **Cancel** to leave the document as it is.

An **Importing docx file** dialog shows while the file imports. When it closes, the document content is replaced. Images from the Word file are carried across and stored with the document. They count toward your drive's storage: if they don't fit in the space left, the import stops and the document stays as it was.

## Convert a Word file in Drive

If the `.docx` file is already in Drive and you want to turn it into a new document rather than overwrite an existing one:

1. Right-click the `.docx` file in Drive (or open its **⋮** menu).
2. Click **Convert to Document**.

Eigen creates a new document in the same folder, with the same name as the Word file. The original `.docx` file stays in place.

## What comes across

Your text keeps its bold, italic, underline, strikethrough, color, highlight, all caps, small caps, and alignment. Fonts become Eigen's own: a sans-serif font such as Calibri or Arial shows in Inter, Eigen's default font, a serif font such as Times New Roman in Source Serif 4, and a monospace font such as Courier New in JetBrains Mono.

- The Word file's normal text becomes the document's normal text: its font, size, color, line spacing, and space before and after. See [Format text](/support/docs/format-text).
- Text in a different size from the normal text keeps its size. Headings take Eigen's heading sizes.
- A paragraph keeps its indents, but a paragraph in a quote follows the quote's indent, and the first paragraph of a list item the list's. It also keeps its line spacing and the space before and after it where they differ from the normal text. In lists, quotes, and tables the space between paragraphs is Eigen's own.
- Headings stay headings, and Word's Title and Subtitle styles become a Title and a Subtitle.
- Numbered lists keep their numbers, the number they start at, and their style (1, a, A, i, or I). A list keeps counting across a page break, and a page break inside a list item stays in that item.
- Checkboxes become a checklist, ticked or not.
- Tables keep their merged cells, column widths, and cell colors. A table wider than the page shrinks to fit.
- Images keep their size and caption. An image that floats left or right of the text floats there in Eigen too.
- Column, bar, line, and pie charts become charts you can edit, with their data, colors, title, size, and caption. A chart floats as an image does, and a 3-D chart comes in flat. See [Insert images, charts, and tables](/support/docs/images-and-tables).
- Footnotes stay footnotes, with their formatting and links, and endnotes become footnotes. A footnote with a custom mark, such as *, gets a number instead.
- The header and footer come across, with page numbers and page counts, and the first page's own header and footer when the Word file has them. An image that floats in a header or footer comes in on a line of its own.
- A page break, "Page break before" in Word's paragraph settings, and a section break that starts a new page all start a new page in Eigen.
- The paper size, orientation, and margins. A document has one page setup, so when the Word file's sections differ, the last section's is used.
- Blank lines stay, except the ones right before a new page.
- Equations become equations you can edit, and one that Word shows on its own line stays on its own line. A very large equation comes in as its text. See [Insert and edit equations](/support/docs/equations).
- A Word file you downloaded from Eigen keeps its code blocks' languages.

## What doesn't come across

- Comments aren't imported. The commented text stays.
- A Word file with different headers or footers for even and odd pages comes in with the odd pages' ones on every page.
- A watermark, or a picture that sits behind the text from the header, such as a full-page letterhead, is left out. So is a footnote mark in a header or footer.
- Tracked changes come in as if you had accepted them all.
- Line spacing set to **Exactly** or **At least** in Word follows the normal text's, and normal text set that way is single-spaced.
- A SmartArt graphic comes in as its text, one paragraph per shape.
- A chart Eigen can't draw the way Word does, such as an area, scatter, doughnut, or combo chart, becomes a line that names the kind of chart and its title, for example **Scatter chart not imported**.
- A chart in a header, footer, or footnote comes in as its title only.
- An equation takes the size of the text around it, so a size set inside a Word equation doesn't come across.
- A WMF or EMF picture, a format older Office files often use, shows as a broken image with its description. You can delete it. When you download the document, it's left out.

A password-protected Word file can't be imported. Open it in Word, remove the password, save it, and import it again.
