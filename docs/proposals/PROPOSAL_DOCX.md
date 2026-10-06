# Proposal: docx that keeps what the editor shows

This proposal replaces the docs app's docx export with a writer of our own, and extends the docx import so a document survives a trip through Word.

**Status:** proposed, not built. [ROADMAP.md](../ROADMAP.md) keeps its row. What it says about the code was true on 2026-10-06, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it. The feature table below was measured that day: a doc using every schema feature, exported through the real code, unzipped, and imported again.

> **TLDR**: Today a doc's docx is the export HTML fed to `@turbodocx/html-to-docx`, and a docx import runs mammoth. The structure survives both ways (headings, bold, italic, links, nested lists, merged cells), but almost every visual property is lost, and the export has two bugs: its WebP images make the package invalid, and text marked small is deleted. This proposal writes the docx ourselves from the ProseMirror JSON, the way xlsx is already written from the workbook and not from HTML. The writer emits `document.xml`, `styles.xml`, `numbering.xml`, `comments.xml` and the image and font parts with JSZip, which the repo already uses. The document keeps Eigen's font names and embeds the fonts, so Word and LibreOffice show the editor's typography. Paper is A4 with 2 cm margins, as in the editor. Images go in as their original bytes. Open comment threads become Word comments. On import, mammoth stays, with a style map and a pass that reads what mammoth drops, so export, edit in Word, import again keeps everything Eigen can hold. The schema gains a page break. A corpus of real docx files, audited by a script, decides what else the schema should learn. html-to-docx (6.7 MB, and axios with it) leaves the Worker. No new API route, no database migration. About 17 to 22 working days.

## Goals

1. A docx opened in Word or LibreOffice looks like the document in the editor: fonts, sizes, spacing, paper, tables, images, code, lists.
2. Export, edit in Word, import again keeps everything the eigendoc schema can represent. This round trip is the main test.
3. A docx made elsewhere imports with its alignment, colors, fonts, highlights, image sizes and list numbering.
4. Open comments travel to Word as Word comments.
5. A measured list of what real docx files contain that Eigen can't hold yet, so schema growth is decided on evidence.

## Non-goals

- Replacing mammoth. Word files from the wild are messy, and mammoth handles much of that. We add to it instead.
- Importing Word comments as Eigen threads. A Word comment's author is a name, not an Eigen user, and that needs its own design. Later.
- Headers, footers, footnotes, tables of contents, equations, tracked changes, sections. They go on the corpus list (§ The corpus), not into this proposal.
- Font size, line spacing, indents and cell shading as schema features. Those are editor decisions. Until they exist, import keeps the text and drops the style.
- pptx. That is its own row in [ROADMAP-POST-1.md](../ROADMAP-POST-1.md).

## Current state

**Export goes through HTML.** `renderEigendocExport` (`apps/api/src/lib/export/doc/transform.ts`) renders the doc to the export HTML, and for docx feeds it to `@turbodocx/html-to-docx` 1.22.2 with only a title and 1440-twip (1 inch) margins. The library picks US Letter. It runs in the transform Worker and loads lazily ([EXPORT.md](../EXPORT.md)). EXPORT.md's rule "every format but xlsx and SVG is one HTML document" holds docx inside the HTML path today.

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
| Page size and margins | US Letter, 1 inch | L |
| Page break | n/a | L, the words either side are glued together |
| Footnotes | n/a | D, a `[1]` link and a list at the end |
| Equations, simple fields (TOC) | n/a | L, the text is dropped |

## Design

### One page setup

The page is spelled in six places today, and they already disagree:

| Where | What it spells |
|---|---|
| `packages/lib/src/docs/eigendoc/index.ts` | `A4_WIDTH_PX` and `PAGE_MARGIN_PX`, at 96 dpi |
| The editor's page (`apps/docs/src/components/docs/editor.tsx`) | `w-[210mm] p-[2cm]` |
| Quick look (`packages/ui/src/components/drive/file-preview.tsx`) | `p-[2cm] w-[210mm]` |
| The Drive thumbnail (`packages/ui/src/components/drive/drive-preview.tsx`) | `A4_WIDTH_PX` and a literal `'2cm'` |
| The export's screen page (`PRINT_EXTRAS`) | `.page { width: 210mm; padding: 2cm }` |
| The PDF (`PRINT_EXTRAS`) | `@page { size: A4; margin: 2.5cm }` |

The docx writer would be the seventh. Instead, one value describes the page, and every surface derives what it needs from it. `PageSetup` and `DEFAULT_PAGE_SETUP` live in `packages/lib/src/docs/eigendoc/page.ts`, exported from the eigendoc barrel the API already imports. The values are in millimetres, because paper is defined in them: `{ width: 210, height: 297, margin: { top: 20, right: 20, bottom: 20, left: 20 } }`. Beside them, one derivation per unit:

- Pixels at 96 dpi for the editor's layout math and the thumbnail's scale, replacing `A4_WIDTH_PX` and `PAGE_MARGIN_PX`.
- `pageBoxStyle(setup)`: the page's width and padding, for the editor's page, quick look, the thumbnail and the export's screen page.
- `pageAtRule(setup)`: the PDF's `@page` rule. This moves the PDF to 2 cm.
- Twips for the docx writer's `w:sectPr` and `w:pgMar`.

Today every call site passes `DEFAULT_PAGE_SETUP`. No prop is threaded through components until a document can carry its own setup, so nothing carries a value that never varies.

When a document gets its own page size and margins, the setup lives in its Y.Doc, in a `page` map beside the content. That is Yjs state, so no database migration. `readEigendocFromDoc` returns it with the content. The editor reads it from the live document. The export hands it to `pageAtRule` and the docx writer. The eigendoc text preview (`TextPreviewResult` in `packages/lib/src/types/preview.ts`) carries it beside `body`, so quick look and the thumbnail size the page from the document instead of a constant. The markdown, plaintext and code previews keep the default page; they aren't documents. Offsets of positioned images are relative to their paragraph ([PROPOSAL_DOCS_POSITIONED_IMAGES.md](PROPOSAL_DOCS_POSITIONED_IMAGES.md)), so a margin change moves them with the text.

### Export: one writer from the ProseMirror JSON

The writer lives beside the HTML renderer in `apps/api/src/lib/export/doc/` and runs in the transform Worker as today. It takes the JSON `readEigendocFromDoc` returns, the prepared media and the comment threads, and assembles the package with JSZip. html-to-docx and its entry in `apps/api/src/lib/export/modules.d.ts` go.

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
| Bullet, ordered, nested list | `numbering.xml`: one abstract definition per kind, a `w:num` per list with a start override, `w:ilvl` for depth |
| Task item | a `w14:checkbox` content control with its checked state |
| Table | `w:tblGrid` from `colwidth`, `w:gridSpan`, `w:vMerge`, `w:tblHeader` on a row whose cells are all header cells, borders as the editor draws them |
| Figure | `wp:inline` with `wp:extent` from `width` and the image's ratio; caption as a paragraph in Word's `Caption` style; wrap layouts as `wp:anchor` + `wrapSquare` |
| Code block | one paragraph per line in a `Code Block` style, lowlight's token colors as run colors |
| Blockquote | a `Quote` style with a left border |
| Horizontal rule | an empty paragraph with a bottom border |
| Page break (new) | `w:br w:type="page"` |
| Comment mark | `w:commentRangeStart`, `w:commentRangeEnd`, `w:commentReference`, see § Comments |

**Page and type.** `w:sectPr` and `w:pgMar` come from the page setup (§ One page setup): A4 is 11906 × 16838 twips, 2 cm is 1134. `styles.xml` `w:docDefaults` take the editor's body, Inter at 11 pt with line height 1.5, which `eigen-prose.css` sets and `PRINT_EXTRAS` repeats. The export already imports `eigen-prose.css` as text and flattens it (`flattenEigenProseCSS` in `transform.ts`), so the writer reads these sizes (and the heading and small sizes above) from that same parsed CSS: one source, no copy to drift. The repeat in `PRINT_EXTRAS` goes.

**Fonts are embedded.** The document keeps Eigen's font names, and the writer embeds the fonts the document uses, so a reader that honours embedded fonts shows the editor's typography exactly. Word on Windows and on Mac and LibreOffice honour them. A reader that ignores them falls back by family, so each font's `fontTable.xml` entry carries its `w:family` (swiss, roman, modern, script) and panose. Google Docs ignores embedded fonts, but Inter, Source Serif 4 and JetBrains Mono are Google Fonts, so it will likely show them by name anyway.

The details:

- Word does not handle variable fonts, so the writer needs static TrueType files: Regular, Bold, Italic and Bold Italic per family, as Word embeds them (`w:embedRegular`, `w:embedBold`, `w:embedItalic`, `w:embedBoldItalic`). The app only ships variable `woff2`. The static files come from each font's upstream release and live beside the variable ones in `packages/ui/src/assets/fonts/<family>/`, which `apps/api/src/lib/export/fonts.ts` already imports from.
- Each font is obfuscated as the spec requires: the first 32 bytes are XORed with a GUID key, stored as `word/fonts/fontN.odttf` and referenced with `w:fontKey`. `settings.xml` sets `w:embedTrueTypeFonts`.
- Only the families and styles a document uses are embedded, whole, not subset, so the reader can still type new characters. That costs a few hundred KB per style; the exact sizes are measured in phase 1.
- All four fonts are under the SIL Open Font License (Excalifont's is `packages/ui/src/assets/fonts/excalifont/OFL.txt`), which allows embedding.

**Images are the original bytes.** A docx is an editable source: a reader may crop an image, enlarge it or save it out, so the preview's quality loss matters more than in a PDF. A docx export takes each media child's original bytes when Word reads the format (PNG, JPEG, GIF). Other formats (WebP, HEIC, TIFF, …) are converted at full size, PNG for a lossless source and JPEG for a photo. An SVG goes in as `asvg:svgBlip` with a PNG fallback, which is how Word writes one. The conversion goes through the existing thumbnail Worker (`apps/api/src/lib/shared/thumbnail-worker.ts`), the only place sharp loads, so no image is decoded on the event loop ([DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md)). Its protocol already takes `format: 'jpeg' | 'png'` and a `maxSize`, and returns the source's `width` and `height`. The writer needs the ratio for `wp:extent` (the figure stores only its width), so `TransformMedia` (`apps/api/src/lib/document/transform/protocol.ts`), which carries no dimensions today, gains them. For a format Word reads, they come from the same Worker's metadata, or from the image header.

The PDF keeps the 2560 px preview: on A4 with 2 cm margins that is about 380 dpi across the text column and 310 dpi across the whole paper, above the 300 that print needs.

**Comments.** The writer exports the open threads, not the resolved ones. Each card becomes a Word comment with its author's name, initials and date; its replies become replies (`commentsExtended.xml` threads them with `w15:paraIdParent`, as Word 2013 and later do). The card's title and description are in the Y.Doc, which the Worker already has. The rest is main-thread data, prepared beside the media and passed to the Worker as plain values: whether a thread is open lives only in its `comments.db` index row (`CommentEntry.status`, `packages/lib/src/types/chat.ts`; read through `openCommentIndex`, `apps/api/src/lib/chat/comment-index.ts`), the replies are in the container's chat (`apps/api/src/lib/document/chat.ts`, as the search index reads them), and the card's `creator` and each reply's `authorEmail` are emails, so the names and initials come from a user lookup. An anchor on a figure (`commentCardId`) wraps the figure's run.

### Import: mammoth plus what it drops

mammoth stays. Three additions:

1. **A style map.** `u => u`; `p[style-name='Title'] => h1:fresh`; `p[style-name='Subtitle'] => p:fresh`; `p[style-name='Quote'] => blockquote > p:fresh`; our own `Code Block` style back to a code block; `highlight => mark`; `br[type='page']` to the page break node. The importer's schema gets `lowlight`, so it has a code block. mammoth already turns a Word checkbox content control into `<input type="checkbox">`; the HTML pass turns that into a task item.
2. **mammoth's document model.** `transformDocument` sees each paragraph and run before conversion, and mammoth 1.12.2 reads alignment, font, size and highlight into it. Those become class names the style map passes through, and a pass over the HTML turns the classes into the attributes the schema parses. No order matching.
3. **What mammoth doesn't read at all**: text color, column widths, image extents and anchors, list start numbers. Lining up mammoth's output with the XML afterwards, by element order, is fragile. Rewriting `word/document.xml` before mammoth avoids it. A run with a `w:color` gets a synthesized character style (declared in `styles.xml`), and a style map built at runtime turns it into a class, the same path as step 2. A drawing's extent and anchor ride its `wp:docPr` `descr` beside the real alt text: mammoth hands `descr` to `convertImage` as `altText`, and the callback reads the values and restores the alt text. Column widths and list starts need a carrier of their own; the phase 1 spike settles which. The rewrite covers the footnote, comment and text-box parts as well. It must not damage the XML: a full parse and rebuild (even with `fast-xml-parser`'s `preserveOrder`) risks mixed-content order, `xml:space="preserve"`, entities and namespace prefixes, and a damaged part makes mammoth drop runs without an error. The spike compares that with a text-level insertion of the synthesized `w:rStyle` inside `w:rPr`.

Eigen's own fonts map back by name through `EIGEN_FONTS`. A foreign font (Calibri, Arial, Times New Roman, …) maps to the bundled font of its category, as xlsx import and docs paste already do ([TYPOGRAPHY.md § Foreign fonts map onto the bundled ones](../TYPOGRAPHY.md#foreign-fonts-map-onto-the-bundled-ones)). Those two have their own copies of the map (`FONT_CATEGORY_MAP` in `apps/api/src/lib/import/sheets/from-xlsx.ts`, `transformPastedHTML` in the docs editor), so docx import would be the third. The xlsx form is the better one: a font name maps to a category, and `BUNDLED_FONT_BY_CATEGORY` picks the bundled font for it. Both move into `packages/lib/src/constants/fonts.ts` beside `EIGEN_FONTS`, and all three read them; the editor's copy, which maps names straight to CSS stacks, unifies onto that. A font of no known category is dropped and the text takes the document font. An image gets its width from `wp:extent`.

### Schema: a page break

The one schema addition here. A block node `pageBreak`, inserted from the editor's Insert menu, drawn in the editor as a dashed rule with a label, rendered in the HTML and PDF export as `break-after: page`, written to docx as a page break, and read back from one. Additive; stored docs don't have it. No migration.

### The corpus

To decide what else to support, we collect real docx files and audit them:

- Sources: documents we make ourselves in Word, LibreOffice and Google Docs, and freely licensed ones (government forms, templates, theses). Files that can't be redistributed stay out of the repo; the audit reports on them without committing them.
- `apps/api/src/scripts/docx-audit.ts` runs the importer on each file and, beside it, counts the OOXML elements the file contains (`w:footnoteReference`, `m:oMath`, `w:fldSimple`, `w:sdt`, `w:ins`, `w:del`, `w:hdr`, `w:sectPr`, `w:tab`, `wp:anchor`, …) and which ones reached the imported doc. The output is a table: element, files containing it, occurrences, kept or lost.
- The table goes into this proposal and is updated as the corpus grows. Every candidate for schema growth (headers and footers, footnotes, tables of contents, equations, font size, line spacing, indent, cell shading, sections) gets its row with the counts behind it, and is decided on those.
- The files we make ourselves become fixtures for the import tests.

## Phasing and effort

| Phase | Work | Days |
|---|---|---|
| 0 | Fix the two export bugs in the current exporter (convert WebP for docx, render small) | 0.5 |
| 0 | One page setup: the type, its derivations, the six places moved onto it, the PDF at 2 cm | 1 |
| 1 | Spike: a few nodes written by hand with JSZip and with the `docx` npm package, to settle § Open questions 1; the carrier for each value mammoth doesn't read (§ Import, step 3); the embedded font sizes | 1 |
| 1 | Writer: package, styles, page, paragraphs, marks, lists, tables, figures, code, quotes, rules, the schema-coverage test, until Word opens it without a repair prompt | 6–8 |
| 1 | Original images with their sizes, SVG with a fallback | 0.5–1 |
| 1 | Embedded fonts: static files, obfuscation, font table | 1–1.5 |
| 1 | Comments with replies: `readCards` carved out, the messages query, the index and user reads, the description as text, the parts in the Worker | 2–2.5 |
| 2 | Page break node in the schema, editor, HTML/PDF and docx | 1–1.5 |
| 3 | Import: style map, `transformDocument`, the rewrite for what mammoth doesn't read, the shared font map, image width | 2–3 |
| 3 | Corpus, audit script, first table | 1 |
| all | Tests; EXPORT.md (its one-HTML-document rule); DOCS.md (the importer now passes `lowlight`); help center | 1 |

Phase 0's two bug fixes are in html-to-docx code that phase 1 deletes. They are worth half a day only because today's exports are invalid until phase 1 lands. Phase 1 ends with html-to-docx removed.

About 17 to 22 days.

The tests: the round trip (export, import, compare the ProseMirror JSON) for a doc with every feature; XML assertions on the generated parts; imports of Word-, LibreOffice- and Google-Docs-made fixtures; the schema-coverage test. A docx can't be opened in Word on CI, so the browser-verification pass opens the exports in LibreOffice headless and, by hand, in Word, and reads the result.

## Risks

- **A second renderer.** Every new docs node now needs a docx mapping. The schema-coverage test makes forgetting one a failure, not a silent loss.
- **Word is strict.** A package Word does not like opens with a repair prompt. The spike and the browser pass open real exports in Word, not only in parsers.
- **Import matching.** A value mammoth doesn't read must reach the right element of its output. Synthesized styles and the `descr` carrier take most of them, so little depends on order.
- **The rewrite before mammoth.** A damaged `document.xml` loses text without an error. The spike picks the rewrite technique, and the round trip and the corpus catch any loss.
- **File size and the import limit.** Embedded fonts and original images make a docx larger than today's, and an export must stay importable: imports are bounded by the server's upload limit (`maxUploadSizeMB`, 35 MB by default, `apps/api/src/lib/config/server-settings.ts`). Phase 1 measures the fonts. § Open questions 2 decides how large originals stay under the limit.

## Related

- [PROPOSAL_DOCS_POSITIONED_IMAGES.md](PROPOSAL_DOCS_POSITIONED_IMAGES.md): its docx phases (front and behind images as `wp:anchor` with `wrapNone`, and reading anchors on import) build on this writer and the import rewrite.
- Per-document page size and margins come later, on top of § One page setup.

## Decisions

1. Write the docx ourselves; html-to-docx goes. (Owner, 2026-10-06.)
2. Keep Eigen's font names and embed the fonts. (Owner, 2026-10-06.)
3. Original image bytes in the docx; the PDF keeps the 2560 px preview. (Owner, 2026-10-06.)
4. A4 with 2 cm margins. (Owner, 2026-10-06.)
5. Export open comment threads as Word comments; import Word comments later. (Owner, 2026-10-06.)
6. Export, edit in Word, import again is a supported workflow. (Owner, 2026-10-06.)
7. The schema gains a page break; anything else waits for the corpus. (Owner, 2026-10-06.)
8. Word's Title becomes H1, Subtitle a paragraph, Quote a blockquote. H1 exports as Heading 1. (Owner, 2026-10-06.)

## Open questions

1. **By hand or with the `docx` package.** The subset is small and JSZip is already here, which argues for writing the XML ourselves. The `docx` package would handle numbering and relationships. The phase 1 spike decides.
2. **Very large originals.** Thirty phone photos at full size can push a docx past the import limit, which breaks the supported round trip. Recommended: scale images above 4096 px on the long side (still about 600 dpi across the A4 column), and if an export still exceeds the limit, warn on export rather than fail on import.
3. **Lossless sources in the PDF.** The preview is lossy WebP at quality 85, so a PNG screenshot or diagram gets slight artifacts in the PDF. Encode the PDF copy of a lossless source losslessly?
