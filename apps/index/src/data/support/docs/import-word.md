---
title: "Import a Word document"
description: "Replace the contents of a document with text, headings, and images from a .docx file."
type: how-to
tags: [docs, import, word, docx]
related: [docs/export, docs/create-and-edit]
order: 100
updated: 2026-10-10
---

You can import a `.docx` file into an open document. The import replaces everything in the document with the content from the Word file: its text and formatting, headings, lists, tables, page breaks, and images.

<div class="eigen-callout">

Importing replaces the entire document. The previous content is gone after the import completes. If you want to keep it, make a copy of the document first.

</div>

## Import from inside the document

1. Open the document in Docs.
2. Click **File** in the toolbar.
3. Click **Import docx file…**.
4. In the **Import docx file** dialog, browse your Drive and select the `.docx` file you want to use, then click **Select**. To use a file from your computer instead, click **Upload from device** and pick the file from the file chooser.

An **Importing docx file** dialog shows while the file imports. When it closes, the document content is replaced. Images from the Word file are carried across and stored with the document.

## Convert a Word file in Drive

If the `.docx` file is already in Drive and you want to turn it into a new document rather than overwrite an existing one:

1. Right-click the `.docx` file in Drive (or open its **⋮** menu).
2. Click **Convert to Document**.

Eigen creates a new document in the same folder, with the same name as the Word file. The original `.docx` file stays in place.

## What comes across

Your text keeps its bold, italic, underline, strikethrough, color, highlight, all caps, small caps, and alignment. Fonts become Eigen's own: a sans-serif font such as Calibri or Arial shows in Inter, Eigen's default font, a serif font such as Times New Roman in Source Serif 4, and a monospace font such as Courier New in JetBrains Mono.

- Headings stay headings, and Word's Title style becomes a Heading 1.
- Numbered lists keep their numbers, the number they start at, and their style (1, a, A, i, or I). A list keeps counting across a page break, and a page break inside a list item stays in that item.
- Checkboxes become a checklist, ticked or not.
- Tables keep their merged cells and column widths. A table wider than the page shrinks to fit.
- Images keep their size and caption. An image that floats left or right of the text floats there in Eigen too.
- Footnotes and endnotes become a numbered list at the end of the document, linked from the text.
- A page break, "Page break before" in Word's paragraph settings, and a section break that starts a new page all start a new page in Eigen.
- Blank lines stay, except the ones right before a new page.
- A Word file you downloaded from Eigen keeps its code blocks' languages.

## What doesn't come across

- Comments, headers, and footers aren't imported. The commented text stays.
- Tracked changes come in as if you had accepted them all.
- Font sizes, line spacing, and indents follow Eigen's own. Text set noticeably smaller than the rest becomes **Small** text.
- A SmartArt graphic comes in as its text, one paragraph per shape, and a chart as its title only.
- Equations come in as plain text.
- A WMF or EMF picture, a format older Office files often use, shows as a broken image with its description. You can delete it. When you download the document, it's left out.

A password-protected Word file can't be imported. Open it in Word, remove the password, save it, and import it again.
