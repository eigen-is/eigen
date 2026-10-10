# Proposal: docx that keeps what the editor shows

This proposal replaces the docs app's docx export with a writer of our own and its docx import with a reader of our own, so a document survives a trip through Word.

**Status:** built: phase 1, the writer (`apps/api/src/lib/export/doc/to-docx.ts`, [EXPORT.md](../EXPORT.md#a-docs-docx-is-written-from-its-json-with-the-editors-css-values)); the page setup (`packages/lib/src/docs/eigendoc/page.ts`), which every surface derives its page from; phase 2, the page break (`packages/lib/src/docs/eigendoc/nodes/page-break.ts`, [DOCS.md](../DOCS.md#a-page-break-is-a-dashed-rule-on-screen-and-a-new-page-on-paper)); and phase 3, our own reader in place of mammoth (`apps/api/src/lib/import/doc/`, [EXPORT.md](../EXPORT.md#a-docx-import-replaces-the-document)), chosen by the owner and confirmed by the corpus gate (§ The corpus). The zip is our own too (`apps/api/src/lib/core/zip.ts`). Comments travel neither way: whether they export at all is the owner's open question, and Word comments are not imported. [ROADMAP.md](../ROADMAP.md) keeps the row, beside one row of the schema gaps the corpus found. § Current state and § What survives today describe the code on 2026-10-06, before any of it was built. Treat every claim about the code here as a pointer and verify it in the code before building on it.

> **TLDR**: Eigen writes and reads docx itself. On 2026-10-06 a doc's docx was the export HTML fed to `@turbodocx/html-to-docx`, and a docx import ran mammoth. The structure survived both ways (headings, bold, italic, links, nested lists, merged cells), but almost every visual property was lost, and the export had two bugs: its WebP images made the package invalid, and text marked small was deleted. The writer (phase 1) writes the docx from the ProseMirror JSON with the editor's CSS values, as xlsx is written from the workbook and not from HTML: Eigen's fonts embedded, A4 with 2 cm margins, images as PNG or JPEG made from their source. The schema gained a page break (phase 2). Our own reader (phase 3) reads the WordprocessingML straight into the schema, with no HTML between and every input bounded. On a fresh draw of 100 public files neither had seen it kept 99.98% of the text against mammoth's 99.91%, and every feature but nested list items at or above mammoth's, in a third of the time (§ The corpus). Export, edit in Word, import again keeps what the schema holds. Comments travel neither way yet. The corpus audit counts what real files hold that a doc can't, and those gaps are one ROADMAP row. html-to-docx, mammoth and its HTML pass are gone. No new API route, no database migration.

## Goals

1. A docx opened in Word or LibreOffice looks like the document in the editor: fonts, sizes, spacing, paper, tables, images, code, lists.
2. Export, edit in Word, import again keeps everything the eigendoc schema can represent. This round trip is the main test.
3. A docx made elsewhere imports with its alignment, colors, fonts, highlights, image sizes and list numbering.
4. Open comments travel to Word as Word comments.
5. A measured list of what real docx files contain that Eigen can't hold yet, so schema growth is decided on evidence.

## Non-goals

- Importing Word comments as Eigen threads. A Word comment's author is a name, not an Eigen user, and that needs its own design. Later.
- Headers, footers, footnotes, tables of contents, equations, tracked changes, sections. They go on the corpus list (§ The corpus), not into this proposal.
- Font size, line spacing, indents and cell shading as schema features. Those are editor decisions. Until they exist, import keeps the text and drops the style.
- pptx. That is its own row in [ROADMAP-POST-1.md](../ROADMAP-POST-1.md).

## Current state

**Export goes through HTML.** `renderEigendocExport` (`apps/api/src/lib/export/doc/transform.ts`) renders the doc to the export HTML, and for docx feeds it to `@turbodocx/html-to-docx` 1.22.2 with a title and the page size and margins from the page setup (§ One page setup). It runs in the transform Worker and loads lazily ([EXPORT.md](../EXPORT.md)). EXPORT.md's rule "every format but xlsx and SVG is one HTML document" holds docx inside the HTML path today.

**Images come from the screen preview.** `collectExportMedia` (`apps/api/src/lib/export/media.ts`) takes `getScreenPreview` for every media child on the main thread: a WebP of at most 2560 px at quality 85 (`apps/api/src/lib/preview/preview-cache.ts`). html-to-docx declares only jpeg, png and svg in `[Content_Types].xml`, so the WebP parts are undeclared and the package is invalid, and it stores each image twice.

**Fonts.** `EIGEN_FONTS` (`packages/lib/src/constants/fonts.ts`) is the one list: Inter, Source Serif 4, JetBrains Mono and Excalifont. The app ships them as variable `woff2` files (`packages/ui/src/assets/fonts/`). A docx names the font, and a reader without it falls back, usually to Times New Roman.

**Import goes through mammoth.** `docxToPmJson` (`apps/api/src/lib/import/doc/from-docx.ts`) checks the zip size with JSZip, converts with mammoth 1.12.2, sanitizes with DOMPurify and parses with the eigendoc schema built without `lowlight`, so the importer has no code block. `convertImage` names images `image-0.png`, … by order; an unknown content type gets `.png`.

**Comments.** The writer exports the open threads, not the resolved ones. Each card becomes a Word comment with its author's name, initials and date; its replies become replies (`commentsExtended.xml` threads them with `w15:paraIdParent`, as Word 2013 and later do). An anchor on a figure (`commentCardId`) wraps the figure's run.

The card's title and description are in the Y.Doc, which the Worker already has, but no backend code reads them yet. `readCards` is private to a React hook file (`packages/lib/src/core/comments/hooks/use-comment-cards.ts`), behind a barrel the backend may not import, so it moves to a React-free subpath of lib ([ARCHITECTURE.md § Backend imports of lib](../ARCHITECTURE.md#backend-imports-of-lib)). The description is HTML, and `sanitizeCommentCardHtml` needs a browser `document`, so the Worker turns it into plain paragraphs with the JSDOM the import already loads there; a Word comment holds text runs, not HTML.

The rest is main-thread data, prepared beside the media and passed to the Worker as plain values:

- **Open or resolved** lives only in the thread's `comments.db` index row (`CommentEntry.status`, `packages/lib/src/types/chat.ts`; read through `openCommentIndex`, `apps/api/src/lib/chat/comment-index.ts`). A thread with no index row counts as open, as it does everywhere else ([COMMENTS.md](../COMMENTS.md)).
- **The replies** are in the container's chat. `readChatContent` (`apps/api/src/lib/document/chat.ts`) is the wrong shape: one byte-capped string, newest first, for search. A new query over `messages` beside it returns author, date and body per message, oldest first.
- **Names and initials.** A card's `creator` and a reply's `authorEmail` are emails, so the names come from a user lookup. `creator` is optional; a card without one gets an empty author, which Word accepts.

### What survives today

P preserved, D degraded, L lost.

| Feature | Export | Import |
|---|---|---|
| Headings, paragraphs, line breaks | P (Times bold) | P; Title and Subtitle become paragraphs; empty paragraphs dropped |
| Bold, italic, strike, sub and superscript | P | P (double strike lost) |
| Underline | P | L (mammoth needs a style map) |
| Small | L, the text is deleted | n/a |
| Inline code | D, no monospace | L |
| Font family | D, the name is written but readers lack the font | L |
| Text color | P | L |
| Highlight | D, written as shading | L |
| Alignment | P | L |
| Lists, nested, ordered start | P | P nesting; start number lost; adjacent lists merged |
| Task list | D, a bullet and an indented paragraph; checked state lost | our export comes back as a bullet; mammoth turns a Word checkbox into an `<input>` the schema has no rule for |
| Merged cells | P | P |
| Column widths | L, equal columns | L |
| Header row | D, plain cells | P only if Word marks it |
| Table borders | L, borderless | n/a |
| Images | D, invalid package, preview quality, stored twice | D, width lost |
| Caption, image alignment, wrap | L, L, inline | caption a separate paragraph; floats inline |
| Code block | D, one line | L |
| Blockquote | D, indented, no bar | the Quote style becomes a paragraph |
| Horizontal rule | L | L |
| Comments | L (the text stays) | L |
| Page size and margins | P, from the page setup | L |
| Page break | P at the top level; dropped in a list item, quote or table cell until the writer | P; dropped in a nested list item, an item directly above a nested one, or a note; a numbered list split by a break restarts at 1 |
| Footnotes | n/a | D, a `[1]` link and a list at the end |
| Equations, simple fields (TOC) | n/a | L, the text is dropped |

## Design

### One page setup

The page setup is built. One value describes the page, and every surface derives what it needs from it: the editor, browser print, quick look, the Drive thumbnail, the HTML export, the PDF and today's docx. File → Page setup… shows it, read-only.

`packages/lib/src/docs/eigendoc/page.ts` holds `PageSetup`, `PAPER_SIZES` and `DEFAULT_PAGE_SETUP`, exported from the eigendoc barrel the API already imports. The values are in millimetres, because paper is defined in them: A4 is `{ width: 210, height: 297, margin: { top: 20, right: 20, bottom: 20, left: 20 } }`. A page is landscape when its width exceeds its height. Beside them, one derivation per unit:

- `pagePx`: pixels at 96 dpi, for the editor's layout math and the thumbnail's scale.
- `pageBoxStyle`: the page's width and padding, for quick look and the thumbnail.
- `pageStylesheet`: the `@page` rule, the page box and its print reset for a selector, for the editor's page with browser print and the export's page with the PDF.
- `pageTwips`: twips, for today's docx and the writer's `w:pgSz` and `w:pgMar`.

Every call site passes `DEFAULT_PAGE_SETUP`. No prop is threaded through components until a document can carry its own setup, so nothing carries a value that never varies.

When a document gets its own page size and margins, the setup lives in its Y.Doc, in a `page` map beside the content. That is Yjs state, so no database migration. `readEigendocFromDoc` returns it with the content. The editor reads it from the live document. The export hands it to `pageStylesheet` and the docx writer. The eigendoc text preview (`TextPreviewResult` in `packages/lib/src/types/preview.ts`) carries it beside `body`, so quick look and the thumbnail size the page from the document instead of a constant. The markdown, plaintext and code previews keep the default page; they aren't documents. Offsets of positioned images are relative to their paragraph ([PROPOSAL_DOCS_POSITIONED_IMAGES.md](PROPOSAL_DOCS_POSITIONED_IMAGES.md)), so a margin change moves them with the text.

### Export: one writer from the ProseMirror JSON

The writer lives beside the HTML renderer in `apps/api/src/lib/export/doc/` and runs in the transform Worker as today. It takes the JSON `readEigendocFromDoc` returns, the prepared media and the comment threads, and assembles the package with `writeZip` (`apps/api/src/lib/core/zip.ts`). html-to-docx and its entry in `apps/api/src/lib/export/modules.d.ts` go.

The XML is written by hand, through small string helpers and the one escape module, `@workspace/lib/xml`. The spike wrote the same document both ways: 221 lines by hand against 160 with the `docx` npm package (9.8.1), but `docx` adds 14.6 MB installed (8.85 MB of its own, `@types/node` as a runtime dependency, a second JSZip), and it falls short where this writer needs it: it embeds only `w:embedRegular` and never sets `w:embedTrueTypeFonts`, its list restart overrides level 0 only, and `tableHeader: false` writes `<w:tblHeader w:val="off"/>`, which mammoth reads as a header row. By hand the package came out at 75.6 KB in 7 parts, against 82.9 KB in 20. Both rendered correctly in LibreOffice 26 and Quick Look: marks, a nested list, a list starting at 3, merged cells, an image, the 2 cm margin. Every XML read in the repo goes through `Bun.XML.parse` with `{ compact: false }`, behind `parseXml` in `apps/api/src/lib/core/xml.ts`. That tree keeps sibling order exactly (733,367 elements over 45 docx files); the default compact shape groups same-named siblings and reorders them, so it isn't used. Tests parse every generated part with it, and the reader reads the docx with it.

docx joins xlsx as a format with its own writer, so EXPORT.md's rule becomes "every format but xlsx, docx and SVG is one HTML document". The cost is a second renderer for docs. A test keeps the two in step: it walks every node and mark in `getSchema(getDocExtensions({ lowlight }))` and fails when the writer has no mapping for one, so a new node can't silently vanish from docx.

| Eigen | OOXML |
|---|---|
| Paragraph, alignment | `w:p`, `w:jc` |
| Heading 1 to 6 | `Heading1` … `Heading6` styles; sizes in half-points from the `rem` values in `eigen-prose.css` (root 16 px); `h5` and `h6` have no rule there and take the body size |
| Bold, italic, underline, strike, sub, sup | `w:b`, `w:i`, `w:u`, `w:strike`, `w:vertAlign` |
| Small | `w:sz` of 18 half-points: `eigen-prose.css` sets `0.75rem`, 9 pt wherever it sits |
| Inline code | a `Code` character style in JetBrains Mono |
| Font family | `w:rFonts` with the `EIGEN_FONTS` name |
| Color | `w:color` |
| Highlight | `w:shd` fill (the multicolor highlight takes any color; `w:highlight` knows sixteen) |
| Link | `w:hyperlink` with an external relationship |
| Bullet, ordered, nested list | `numbering.xml`: one `w:abstractNum` per list with the start in its level, a `w:num` pointing at it, `w:ilvl` for depth (Apple's renderer ignored a shared abstract definition with a start override). Built: one per ordered list, while bullet lists at one indent share one, which keeps `numbering.xml` small, and a bullet has no counter to restart |
| Task item | a `w14:checkbox` content control with its checked state |
| Table | `w:tblGrid` from `colwidth`, `w:gridSpan`, `w:vMerge`, `w:tblHeader` on a row whose cells are all header cells, borders as the editor draws them |
| Figure | `wp:inline` with `wp:extent` from `width` and the image's ratio; caption as a paragraph in Word's `Caption` style; wrap layouts as a borderless floating one-cell table holding the image and its caption (built so instead of `wp:anchor` + `wrapSquare`: the one wrap that keeps the caption under the image in every reader) |
| Code block | one paragraph per line in a `Code Block` style, lowlight's token colors as run colors |
| Blockquote | a `Quote` style with a left border |
| Horizontal rule | an empty paragraph with a bottom border |
| Page break (new) | `w:br w:type="page"` |
| Comment mark | `w:commentRangeStart`, `w:commentRangeEnd`, `w:commentReference`, see § Comments |

**Page and type.** `w:pgSz` and `w:pgMar` in `w:sectPr` come from `pageTwips` (§ One page setup): A4 is 11906 × 16838 twips, 2 cm is 1134. The writer sets `w:orient="landscape"` when the width exceeds the height, and keeps a 0 margin at 0. html-to-docx does neither: its normalizer turns a 0 margin into 1440 twips and never passes the orientation on. `styles.xml` `w:docDefaults` take the editor's body, Inter at 11 pt with line height 1.5, which `eigen-prose.css` sets and `PRINT_EXTRAS` repeats. The export already imports `eigen-prose.css` as text and flattens it (`flattenEigenProseCSS` in `transform.ts`), so the writer reads these sizes (and the heading and small sizes above) from that same parsed CSS: one source, no copy to drift. The repeat in `PRINT_EXTRAS` goes. Built: every style's line is an `auto` multiple, the CSS pitch divided by the font's own line height from its OS/2 table, and a paragraph all in one other family is rescaled by that family's, so each font keeps the editor's pitch; Google Docs reads an `atLeast` line as single.

**Fonts are embedded.** The document keeps Eigen's font names, and the writer embeds the fonts the document uses, so a reader that honours embedded fonts shows the editor's typography exactly. Word on Windows and on Mac and LibreOffice honour them. A reader that ignores them falls back by family, so each font's `fontTable.xml` entry carries its `w:family` (swiss, roman, modern, script) and panose. Google Docs ignores embedded fonts, but Inter, Source Serif 4 and JetBrains Mono are Google Fonts, so it will likely show them by name anyway.

The details:

- Word does not handle variable fonts, so the writer needs static TrueType files: Regular, Bold, Italic and Bold Italic per family, as Word embeds them (`w:embedRegular`, `w:embedBold`, `w:embedItalic`, `w:embedBoldItalic`). The app only ships variable `woff2`. The static files come from each font's upstream release (Inter v4.1, Source Serif 4 4.005R at its Text optical size, JetBrains Mono v2.304) and live beside the variable ones in `packages/ui/src/assets/fonts/<family>/`, which `apps/api/src/lib/export/fonts.ts` already imports from. Excalifont has no upstream TTF release, so its TTF is converted from its official woff2, which is byte-identical to the repo's; it has a Regular only.
- Word has four slots per family. The editor's bold is 600 (`font-weights.css`), so each family's Bold slot embeds the static 600 file and the writer writes `w:b` where the editor draws 600. Built: Inter's and JetBrains Mono's 600 files, renamed Bold, fill their Bold and Bold Italic slots; Source Serif 4's slots hold its upstream 700s. Headings and header cells, medium in the editor, sit at Regular in Word. No extra family names, so import maps the fonts back by name and Google Docs, which ignores embedded fonts, still finds them.
- Each font is obfuscated as the spec requires: the first 32 bytes are XORed with a GUID key, stored as `word/fonts/fontN.odttf` and referenced with `w:fontKey`. `settings.xml` sets `w:embedTrueTypeFonts`.
- Only the families and styles a document uses are embedded, whole, not subset, so the reader can still type new characters. Zipped, all four styles together weigh 818 KB for Inter, 400 KB for Source Serif 4 and 528 KB for JetBrains Mono, and Excalifont's Regular 80 KB: 1.83 MB for every font. A typical doc (Inter regular and bold, plus inline code) carries about 530 KB.
- All four fonts are under the SIL Open Font License (Excalifont's is `packages/ui/src/assets/fonts/excalifont/OFL.txt`), which allows embedding. Every static file has `fsType` 0 (installable), except Excalifont at 0x0008 (editable); both allow embedding in an editable document.

**Images are the original bytes.** A docx is an editable source: a reader may crop an image, enlarge it or save it out, so the preview's quality loss matters more than in a PDF. A docx export takes each media child's original bytes when Word reads the format (PNG, JPEG, GIF). Other formats (WebP, HEIC, TIFF, …) are converted at full size, PNG for a lossless source and JPEG for a photo. An SVG goes in as `asvg:svgBlip` with a PNG fallback, which is how Word writes one. The conversion goes through the existing thumbnail Worker (`apps/api/src/lib/shared/thumbnail-worker.ts`), the only place sharp loads, so no image is decoded on the event loop ([DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md)). Its protocol already takes `format: 'jpeg' | 'png'` and a `maxSize`, and returns the source's `width` and `height`. The writer needs the ratio for `wp:extent` (the figure stores only its width), so `TransformMedia` (`apps/api/src/lib/document/transform/protocol.ts`), which carries no dimensions today, gains them. For a format Word reads, they come from the same Worker's metadata, or from the image header. An image above 4096 px on the long side is scaled down to 4096, still about 600 dpi across the A4 column, so thirty phone photos don't push a docx past the import limit. An export that still exceeds the limit warns on export (a `TransformWarning`), rather than failing on import.

Built instead, the rest deferred by the owner on 2026-10-08: every raster image is re-encoded from its source in the thumbnail Worker, PNG for a lossless source and JPEG for the rest, at most 2560 px on the long side, and an SVG goes in as `asvg:svgBlip` with a PNG fallback the transform Worker draws from the sanitized SVG. No original bytes, no 4096 px scaling, no size warning, and the PDF still takes the screen preview.

The PDF keeps the 2560 px cap: on A4 with 2 cm margins that is about 380 dpi across the text column and 310 dpi across the whole paper, above the 300 that print needs. It takes its images through the same Worker conversion instead of the screen preview: PNG for a lossless source, JPEG for a photo, the two formats WeasyPrint embeds as they are.

**Comments.** The writer exports the open threads, not the resolved ones. Each card becomes a Word comment with its author's name, initials and date; its replies become replies (`commentsExtended.xml` threads them with `w15:paraIdParent`, as Word 2013 and later do). The card's title and description are in the Y.Doc, which the Worker already has. The rest is main-thread data, prepared beside the media and passed to the Worker as plain values: whether a thread is open lives only in its `comments.db` index row (`CommentEntry.status`, `packages/lib/src/types/chat.ts`; read through `openCommentIndex`, `apps/api/src/lib/chat/comment-index.ts`), the replies are in the container's chat (`apps/api/src/lib/document/chat.ts`, as the search index reads them), and the card's `creator` and each reply's `authorEmail` are emails, so the names and initials come from a user lookup. An anchor on a figure (`commentCardId`) wraps the figure's run.

### Import: our own reader

Built in phase 3. Bare mammoth dropped alignment, color, fonts, highlight, underline, image widths and list starts (§ What survives today). Reading them through mammoth meant a style map, a pass over its document model, a text scanner that rewrote `document.xml` with synthesized styles, an HTML pass and DOMPurify. A reader from `document.xml` straight to ProseMirror JSON needs none of that, and `parseXml` keeps the mixed sibling order such a reader depends on. A spike read the corpus both ways, the owner chose the reader (Decision 17), and the gate in § The corpus measured it against mammoth on files neither had seen.

How it works lives in the domain docs. What the reader keeps and drops, its images, warnings, errors and bounds: [EXPORT.md § A docx import replaces the document](../EXPORT.md#a-docx-import-replaces-the-document) and [§ Zip guards run before the parser inflates anything](../EXPORT.md#zip-guards-run-before-the-parser-inflates-anything). Page breaks and blank lines: [DOCS.md § A Word page break splits its paragraph on import](../DOCS.md#a-word-page-break-splits-its-paragraph-on-import). Fonts: [TYPOGRAPHY.md § Foreign fonts map onto the bundled ones](../TYPOGRAPHY.md#foreign-fonts-map-onto-the-bundled-ones). The code is `apps/api/src/lib/import/doc/`; the OOXML vocabulary reader and writer share is `apps/api/src/lib/core/ooxml.ts`, and the writer's look values the reader recognises are `apps/api/src/lib/export/doc/looks.ts`.

### Schema: a page break

Built (phase 2). A block node `pageBreak`, inserted from the toolbar, the narrow toolbar's Insert menu or Mod-Enter, drawn on screen as a labeled dashed rule, `break-after: page` in print and the PDF, a Word page break at the docx's top level, and read back from one. No migration.

### The corpus

To decide what else to support, we collect real docx files and audit them:

- Sources: documents we make ourselves in Word, LibreOffice and Google Docs, and freely licensed ones (government forms, templates, theses). Files that can't be redistributed stay out of the repo; the audit reports on them without committing them.
- `apps/api/src/scripts/docx-audit.ts` runs the importer on each file and, beside it, counts the OOXML elements the file contains (`w:footnoteReference`, `m:oMath`, `w:fldSimple`, `w:sdt`, `w:ins`, `w:del`, `w:hdr`, `w:sectPr`, `w:tab`, `wp:anchor`, …) and which ones reached the imported doc. The output is a table: element, files containing it, occurrences, kept or lost.
- Built: the importer is a module passed with `--importer` (the reader's `from-docx.ts` by default) and runs in a Worker under a time cap, as does reading the source, so a crash or hang is a result and every importer is measured by the same code. Beside the element table it compares features both sides, what Word shows with the style chain resolved against what the imported JSON holds: what the import kept, and what it invented, such as a mark on words Word doesn't mark. `compare` sets two runs side by side. Its header has the usage; `apps/api/src/test/scripts/docx-audit.test.ts` pins the counting, and holds the writer's own docx to the doc it was written from.
- The table goes into this proposal and is updated as the corpus grows. Every candidate for schema growth (headers and footers, footnotes, tables of contents, equations, font size, line spacing, indent, cell shading, sections) gets its row with the counts behind it, and is decided on those.
- The files we make ourselves become fixtures for the import tests. Nine small files, none GPL and none a bug-tracker upload, are committed with their sources and licenses in `apps/api/src/test/fixtures/docx/SOURCES.md`.

#### The gate: the reader against mammoth

Before mammoth left, the reader and a frozen copy of the mammoth importer ran through the same audit on three sets. The tuned set is 172 files: 154 public ones (Apache POI 53, LibreOffice 24, Zenodo 23, GOV.UK 16, mammoth 14, docx4j 10, pandoc 8, pydocx 6), 14 of our own exports re-saved by Google Docs and Word for the web, the owner's three files and one fresh export. The held-out set is 113 of the public files, ones the first reader spike was never tuned on. The fresh set decided: 100 files drawn by seed from about 1,560 public downloads outside both sets, stratified so real documents are more than half (GOV.UK 30, Zenodo 25, LibreOffice 15, Apache POI 10, docx4j 10, pandoc 5, pydocx 5). Its list was kept from the implementers.

| Fresh set, 100 files | mammoth | reader |
|---|---:|---:|
| Text kept (of 210,135 words) | 99.91% | 99.98% |
| Crashes | 1 | 1, the same file |
| Import time | 4.5 s | 1.6 s |
| Heading 1 (315) | 43.8% | 87.3% |
| Numbered headings (101) | 0% | 96.0% |
| Font family (65,919 words) | 0% | 100% |
| Ordered lists not starting at 1 (290) | 0% | 97.2% |
| Ordered item numbers (1,282) | 71.9% | 99.9% |
| Tables with column widths (195) | 0% | 100% |
| Images with a width (137) | 0% | 100% |
| Page breaks (296) | 84.5% | 100% |
| Centered paragraphs (389) | 0% | 99.7% |
| Underline (622 words) | 0% | 45.3% |
| Text color (38,988 words) | 0% | 11.3% |

Every other feature row came out at or above mammoth's, but nested list items: 19.6% against 21.3%, because the reader nests an item where Word draws its number and the audit counts by list level. Underline and text color are low in four files. One draws its links in Word's link look, which the reader leaves to the link and the audit counts as underline and color; three write their colors with a leading `#`, which `ST_HexColor` doesn't allow and the reader refuses. On the tuned and held-out sets the reader kept 100.0% of the text against mammoth's 98.8% and 98.4%, with one crash against mammoth's three each, in 3.5 s against 10.4 s and 2.1 s against 6.1 s. What the reader invents was held to at most 5% of a row's source, or 10. On the fresh set four rows passed only with a reason each: Word's heading levels 7 to 9 import as H6, a checkbox glyph opens a task item, a shaded first row is a header row, and nesting follows where Word draws a number, not its list level. The runs are in `.superpowers/docx-import/audit/` (`v3-*`, `v3b-*`), which is not committed.

## Phasing and effort

| Phase | Work | Days |
|---|---|---|
| 0 | One page setup: the type, its derivations, every surface moved onto it, the PDF at 2 cm, File → Page setup… | built |
| 1 | Spike: a few nodes written by hand and with the `docx` npm package; the rewrite before mammoth and its carriers; the embedded font sizes | done |
| 1 | Writer: package, styles, page, paragraphs, marks, lists, tables, figures, code, quotes, rules, the schema-coverage test, until Word opens it without a repair prompt | built |
| 1 | Original images with their sizes, large ones scaled down, the size warning, SVG with a fallback | built as PNG or JPEG from the source, SVG with a fallback; the rest deferred 2026-10-08 |
| 1 | Embedded fonts: static files, obfuscation, font table | built |
| 1 | Comments with replies: `readCards` carved out, the messages query, the index and user reads, the description as text, the parts in the Worker | 2–2.5, if the owner keeps them |
| 2 | Page break node in the schema, editor, HTML/PDF and docx | built |
| 3 | Corpus, audit script, first table | built |
| 3 | Decide: our own reader or mammoth plus the scanner, a spike on the corpus | done: our own reader |
| 3 | Import: our own reader and zip, the shared font map, the input bounds, the gate against mammoth | built |
| all | Tests; EXPORT.md (its one-HTML-document rule); DOCS.md (the importer passes `lowlight`); help center | built |

Phase 1 replaced the exporter, which closed its two bugs (WebP parts, deleted small text), and html-to-docx is removed.

Comments, if the owner keeps them, take 2 to 2.5 days.

The tests: the round trip (export, import, compare the ProseMirror JSON) for a doc with every feature; XML assertions on the generated parts; imports of Word-, LibreOffice- and Google-Docs-made fixtures; the schema-coverage test. A docx can't be opened in Word on CI, so the browser-verification pass opens the exports in LibreOffice headless and, by hand, in Word, and reads the result.

## Risks

- **A second renderer.** Every new docs node now needs a docx mapping. The schema-coverage test makes forgetting one a failure, not a silent loss.
- **Word is strict.** A package Word does not like opens with a repair prompt. Real exports are opened in LibreOffice, in Quick Look and, by hand, in Word, not only in parsers.
- **Word files from the wild.** Our own reader meets what mammoth's years of fixes handled. The gate measured it against mammoth on files neither had seen, a block the schema refuses keeps its text as paragraphs, and every input is bounded, so a hostile file is a 413 and not an out-of-memory in the process every Home shares.
- **File size and the import limit.** Embedded fonts and original images make a docx larger than today's, and an export must stay importable: imports are bounded by the server's upload limit (`maxUploadSizeMB`, 35 MB by default, `apps/api/src/lib/config/server-settings.ts`). The fonts cost about 530 KB for a typical doc and 1.83 MB at most. Images above 4096 px are scaled down, and an export still over the limit warns.

## Related

- [PROPOSAL_DOCS_POSITIONED_IMAGES.md](PROPOSAL_DOCS_POSITIONED_IMAGES.md): its docx phases (front and behind images as `wp:anchor` with `wrapNone`, and reading anchors on import) build on this writer and reader.
- Per-document page size and margins come later, on top of § One page setup.

## Decisions

1. Write the docx ourselves; html-to-docx goes. (Owner, 2026-10-06.)
2. Keep Eigen's font names and embed the fonts. (Owner, 2026-10-06.)
3. Original image bytes in the docx; the PDF keeps the 2560 px preview. (Owner, 2026-10-06; deferred by the owner on 2026-10-08: the docx takes PNG or JPEG made from the source.)
4. A4 with 2 cm margins. (Owner, 2026-10-06.)
5. Export open comment threads as Word comments; import Word comments later. (Owner, 2026-10-06.)
6. Export, edit in Word, import again is a supported workflow. (Owner, 2026-10-06.)
7. The schema gains a page break; anything else waits for the corpus. (Owner, 2026-10-06.)
8. Word's Title becomes H1, Subtitle a paragraph, Quote a blockquote. H1 exports as Heading 1. (Owner, 2026-10-06.)
9. The writer emits the XML by hand with JSZip, through the one escape module `@workspace/lib/xml`; no `docx` package. Every XML read goes through `Bun.XML.parse` with `{ compact: false }` behind `apps/api/src/lib/core/xml.ts`, which refuses a DOCTYPE before parsing and maps parse errors to 400; the compact shape isn't used. Tests parse every generated part with it, and it is the scanner's test oracle. (Owner, 2026-10-06; reworded 2026-10-07. The writer zips with our own `writeZip` since Decision 21, and the reader in Decision 17 has no scanner.)
10. The rewrite before mammoth is a text scanner that inserts synthesized styles; no parse and rebuild. (Owner, 2026-10-06; superseded by Decision 17.)
11. Column widths ride a synthesized table style, list numbers a synthesized list-item paragraph style. (Owner, 2026-10-06; superseded by Decision 17.)
12. Embed the fonts a document uses, per style used, whole: about 530 KB for a typical doc, 1.83 MB for all four families. (Owner, 2026-10-06.)
13. Today's exporter keeps its two bugs; phase 1 replaces it. (Owner, 2026-10-06.)
14. Images above 4096 px on the long side are scaled down, and an export that still exceeds the import limit warns on export. (Owner, 2026-10-06; deferred by the owner on 2026-10-08.)
15. The PDF takes its images through the docx's media path, capped at 2560 px: PNG for a lossless source, JPEG for a photo. WeasyPrint passes PNG and JPEG through and decodes anything else to PNG, so today's lossy WebP preview only costs quality. (Owner, 2026-10-06; deferred by the owner on 2026-10-08.)
16. Each family's Bold slot embeds the static 600 file, the editor's bold; medium headings sit at Regular in Word. (Owner, 2026-10-06; built for Inter and JetBrains Mono as their 600s renamed Bold, Source Serif 4 keeping its 700.)
17. Our own reader replaces mammoth: WordprocessingML straight to eigendoc JSON, with no HTML, DOMPurify or JSDOM in the import. (Owner, 2026-10-09.)
18. Empty paragraphs import as blank lines, except a run of them that ends at a page break, a page-breaking paragraph or a section break that starts a page. (Owner, 2026-10-09.)
19. A page break inside a list item stays in the item, and the list keeps counting. (Owner, 2026-10-09.)
20. The body font: a foreign font of Eigen's body category (sans-serif, so Inter) gets no mark; a serif or monospace one gets its bundled font's mark (Source Serif 4, JetBrains Mono) on every run; a font of unknown category gets none. A foreign monospace run inside a proportional body gets the JetBrains Mono mark too, not `code`, which only a code style or the writer's code look gives. (Owner, 2026-10-09.)
21. The zip is our own reader and writer (`apps/api/src/lib/core/zip.ts`) in the docx paths: at most 10,000 entries and 200 MB declared, 413 above. xlsx keeps JSZip until a closing study weighs replacing ExcelJS. (Owner, 2026-10-09. Built: the xlsx import reads through `openZip` too and hands ExcelJS a stored re-pack, while ExcelJS and the xlsx export still use JSZip.)
22. At most 16 MB of parsed XML per import, counted on declared sizes before anything inflates, and at most 750,000 tags; 413 above either. The largest `document.xml` in the corpus is 12.6 MB and 611,000 tags. (Owner, 2026-10-09.)
23. A WMF or EMF picture is kept under its real name (`image-3.wmf`): the editor shows a broken image with its alt text, which the user can delete, and the exports leave it out. Nothing on the server converts either. (Owner, 2026-10-09.)
24. A code block's language rides a hidden paragraph style per language, id `CodeBlock-<lang>`, name `Code Block (<lang>)`, based on `CodeBlock`, `w:semiHidden` without `w:unhideWhenUsed`. Google Docs drops it. (Owner, 2026-10-09.)
25. `dingbat-to-unicode` is a direct dependency, for Symbol, Wingdings and Webdings in `w:sym`. (Owner, 2026-10-09.)
26. Committed fixtures are small files with no GPL license and no bug-tracker upload, each listed with its source and license. (Owner, 2026-10-09.)
27. All caps and small caps are a `caps` attribute of the `textStyle` mark, with toolbar buttons, written and read as `w:caps` and `w:smallCaps`. (Owner, 2026-10-09.)
28. eigendoc needs no backward compatibility; the goal is parity with Word and Google Docs. A docx property with no home in the schema is a candidate to add, not a look to drop without a trace. (Owner, 2026-10-09.)
