# Typography and Self-Hosted Fonts

> **TLDR:** Eigen bundles every font it draws, with no external CDN: four text families a user picks (Inter, Source Serif 4, JetBrains Mono, Excalifont) and four fallback faces for what those lack (emoji, Chinese, Korean and math). Every face is cut into `unicode-range` slices in `packages/ui/src/assets/fonts/`, so a page loads and an export embeds only the slices its text draws. `EIGEN_FONTS` and `FALLBACK_FONTS` (`packages/lib/src/constants/fonts.ts`) are the lists everything reads, and `getFontFamily` builds every CSS stack from them. Docs and the canvas store a font's name, never a CSS stack.

This doc governs the fonts every app, editor and export uses, and the weight scale of the UI. Read it before you add a font, change a weight or touch how an editor stores a font choice. A font choice is part of a document: a doc's text, a sheet cell and a canvas text box each store theirs in the document's Yjs data ([COLLAB.md](COLLAB.md)), and an export embeds the same faces ([EXPORT.md](EXPORT.md#an-export-embeds-only-the-font-slices-its-text-draws)). So the font list is a stored format as much as a menu, and most of its rules follow from that.

A fallback face is one no user picks: it draws the characters the text faces lack, so an emoji or a Chinese word looks the same on every computer, in the PDF and in the HTML download. A slice is one WOFF2 file of a face that draws a range of characters, as Google Fonts serves its fonts. A canvas measures text in a fallback until the slice that draws it has loaded, which surprises people ([§ A canvas waits for the slices of its text](#a-canvas-waits-for-the-slices-of-its-text)). The registry's order is load-bearing, since a sheet cell can store a font as an index into it ([§ The registry's order is load-bearing](#the-registrys-order-is-load-bearing)), and a new font touches six places ([§ A new font touches six places](#a-new-font-touches-six-places)).

## Four families ship with the app

| Font | Category | Weights | Italic | Role |
|---|---|---|---|---|
| Inter | Sans-serif | 100 to 900, variable | Yes | The UI, prose, and the default in docs and sheets |
| Source Serif 4 | Serif | 200 to 900, variable | Yes | A picker choice |
| JetBrains Mono | Monospace | 100 to 800, variable | No | Code blocks and inline code |
| Excalifont | Hand-drawn | 400 only | No | The canvas default |

The files are Vite assets, so they are hashed and cached like any other. Nothing loads from a font CDN: a self-hosted server makes no request to a third party to render text. Every face uses `font-display: swap`, so text shows at once in the fallback and swaps when the font arrives.

The text faces and the Noto faces are licensed under the SIL Open Font License (OFL 1.1), and New Computer Modern Math under the GUST Font License. Each license asks that it travels with the font, so each font folder carries its `OFL.txt` or `GUST-FONT-LICENSE.txt`, and the /licenses page of the index app lists every font.

## Four fallback faces draw what the text faces lack

| Family | Kind | Draws |
|---|---|---|
| Eigen Emoji | emoji | Noto Emoji's outlines at weights 400 to 700, monochrome in the text colour |
| Noto Sans SC | cjk | Han, kana, Bopomofo and the CJK symbols and forms, all in Simplified Chinese forms |
| Noto Sans KR | cjk | Hangul syllables and jamo |
| New Computer Modern Math | math | Every equation, and nothing else |

`FALLBACK_FONTS` lists them, and its order is load-bearing: the vendoring script gives a character to the first family whose kind covers it, before any text face, so no two families draw the same character. The keycap bases are the one exception: `#`, `*` and the digits sit in the emoji face's keycap slice as well as in the text faces, so a keycap draws whole. The text faces keep © ® ™, which body text writes often; every other symbol the emoji coverage holds, such as ❤ and ↔, draws in Eigen Emoji even where Inter has it.

The emoji face is Noto Emoji. We add a colour table (COLR, the font table that holds coloured glyphs) with one layer per glyph, and that layer is the glyph in the text colour. Without the table, Chromium and Firefox skip the font for a flag, a skin tone or an emoji followed by VS16 (the invisible mark that asks for the emoji look of a character). They draw the system's colour emoji instead. With the table, every surface draws one monochrome emoji in the CSS `color`. Its family is "Eigen Emoji", never "Noto Emoji", because fontconfig gives that name an emoji alias, and WeasyPrint would then take the digits from another font. The PDF prints its outlines ([EXPORT.md](EXPORT.md#weasyprint-prints-the-slices-through-a-shim-in-its-render-script)).

Han draws in Simplified Chinese forms, Japanese kana included, since one code point has regional forms and the stacks name one region; Japanese and Traditional Chinese forms are a [ROADMAP-POST-1.md](ROADMAP-POST-1.md) row. There is no serif CJK face: Source Serif 4 text gets the sans one. The math face is in no text stack, since only a formula draws in it: one `math` rule in `eigen-prose.css` names `--font-math`, in the editor, the panel and the HTML download, and the PDF draws each equation through MathJax, whose default font is New Computer Modern too ([DOCS.md](DOCS.md#every-equation-draws-in-new-computer-modern-math-with-css-for-what-chrome-leaves-out)).

## Every face is cut into unicode-range slices

A whole face is too much to load for a page or to embed in an export: Noto Sans SC's slices are about 10 MB, and whole faces made the HTML download of a short doc 1.16 MB. So `scripts/fonts/build-font-slices.ts` cuts every face once into slices on the ranges Google Fonts serves for it, from a committed snapshot of Google's CSS, and writes three things: the WOFF2 slices beside each face, `fonts.css` with one `@font-face` rule per slice and its `unicode-range`, and `FONT_SLICES` (`packages/lib/src/constants/font-slice-data.gen.ts`), the same table for code. The browser fetches a slice only when a page draws a character in its range, and `slicesFor` (`packages/lib/src/constants/font-slices.ts`) picks the slices an export or a downloaded image embeds from the same table ([EXPORT.md](EXPORT.md#an-export-embeds-only-the-font-slices-its-text-draws)). The script shells out to fontTools in a local venv and downloads each fallback from a URL pinned by SHA-256, so it is run by hand when a font changes and adds no package; its header comment says how.

The planning half, `scripts/fonts/plan-slices.ts`, decides which characters each slice holds:

- A slice declares its published range, cut to what the font maps, to what its kind covers and to what no earlier family claims.
- The emoji slices are cut closed: every character an RGI sequence (an emoji sequence the Unicode standard lists, such as a flag or a skin tone, or a joined emoji, a ZWJ sequence, where the invisible zero width joiner glues emoji into one picture) joins moves, with all it is joined to, into one slice, and the script stops with an error if a sequence still spans two. Pango and WebKit pick a face per character, so a sequence split over two slices would draw as its parts.
- What a font maps outside every published range goes to a rest slice (the slice that holds every character no published range names), cut in halves until each chunk is under 40 KB, 60 KB for Chinese. Korean's rest stays whole, 183 KB: it holds the conjoining jamo (the Hangul letter parts that stack into a syllable), which compose an old Hangul syllable only inside one font.
- The math face and Excalifont stay one slice each, the math face because a formula's stretchy variants must sit in the face that lays it out.
- The CJK cut drops the `dlig` feature, which CSS leaves off and which would pull whole ligature glyphs into every slice. Variable faces stay variable, so one slice draws every weight.

The generated `fonts.css` is about 253 KB, 62 KB gzipped, in every app's CSS, because `globals.css` imports it ([ROADMAP.md](ROADMAP.md)).

## Every stack comes from one builder

`getFontFamily` in `packages/lib/src/constants/fonts.ts` gives the CSS stack of a font name: the bundled family, then Eigen Emoji, Noto Sans SC and Noto Sans KR, then the system faces of its category and the generic family. A doc's Normal and marks, a sheet's cells on the grid and in the export, a canvas label and the server's stacks all take it, so a character draws in the same face on every surface. The fallback faces' slices draw disjoint characters, so their order in a stack never decides which face draws a glyph. `MATH_FONT_STACK` is the math face, then the browser's own `math`.

## A canvas waits for the slices of its text

A canvas measures and draws a character in the fallback until the slice that draws it has loaded, and only text it draws starts that fetch. A height or a width measured too early is stored in some places, so a canvas whose measure is stored loads the slices of its text first, through `document.fonts.load(font, text)`: the sheet's cell editors as the user types, and the canvas's label editor, `useArrowLabelFit` (`packages/ui/src/components/vector/text-fit.ts`), which measures an arrow label again once its slices load, and `commitPaste` (`packages/ui/src/components/vector/hooks/use-canvas-clipboard.ts`), which measures a pasted text box again once its slices load ([CANVAS.md](CANVAS.md#the-label-cuts-a-hole-in-the-shaft)). The sheet's grid measures only to draw, so it loads nothing: one watcher per page waits on each face's `loaded` promise, and each grid listens to it and redraws once the slices its draw fetched have arrived ([SHEETS.md](SHEETS.md#the-grid-redraws-whole-when-a-font-slice-loads)). Print waits for `document.fonts.ready`, and for its images 3 s at most, since a lazy or stalled image may never decode (`printElement` in `packages/ui/src/lib/print-element.ts`).

The keycap bases sit in the emoji face's keycap slice, so in Chromium and Firefox a `document.fonts.load` of text with a digit also fetches that 53 KB slice, once a session. WebKit doesn't, and drawing a digit fetches it in no browser. It stays, because a keycap must draw whole in Chromium and Firefox.

WebKit draws a few emoji in parts, the same with the whole font as with its slices: a keycap such as 1️⃣ as a digit beside an empty frame, and some joined emoji such as ❤️‍🔥 as a heart and a flame. It also draws no emoji at all in text with a transparent fill and only a stroke, where Chromium and Firefox draw the outline. Both are accepted limits.

## CSS tokens name each category

`globals.css` imports `fonts.css` and defines one token per category: `--font-sans`, `--font-serif`, `--font-mono` and `--font-hand`, each the stack `getFontFamily` gives its bundled family, and `--font-math`, `MATH_FONT_STACK`. CSS can't import the builder, so each token is a literal, and `packages/ui/src/test/styles/font-tokens.test.ts` fails when one drifts from the builder, printing the line to paste. The tokens give the Tailwind utilities `font-sans`, `font-serif`, `font-mono` and `font-hand`. `eigen-prose.css` sets body text in `--font-sans` and code in `--font-mono`, so prose follows the tokens too.

## The weight scale is lighter than Tailwind's

One `@theme` block in `font-weights.css`, which `globals.css` imports, sets `--font-weight-medium` to 450, `--font-weight-semibold` to 525 and `--font-weight-bold` to 600. So `font-bold` renders at 600, not 700. The body and the prose headings read these tokens, so the whole scale is tuned in that one block: Heading 1 to 4 are medium, and Heading 5 and 6 take the body's normal weight, as in Google Docs, where they are body-sized and grey, and 6 is italic, so an italic mark in it draws upright. The title and subtitle are paragraphs and keep the body's weight, as Google's do. The variable faces render the in-between weights exactly on screen. The doc export reads the same file and writes each weight `eigen-prose.css` reads through `var()` as its value, rounded to the nearest multiple of 100 because WeasyPrint accepts nothing else, so Heading 1 to 4 print at 500, Heading 5 and 6 at 400 and bold at 600.

## The registry's order is load-bearing

`EIGEN_FONTS` holds each font's name, category and single line; `getFontFamily` builds its CSS stack. Each category has exactly one font. A foreign font maps to its category's bundled font (`bundledFontOfCategory`), the first entry of that category, so a second font in a category would never be picked by an import or a paste. Its order matters for two reasons:

- A sheet cell's `ff` may be an index into the list rather than a name: the editor's default cell stores `0`. Reordering or inserting changes the font of every stored index, so **a new font goes at the end**.
- `EIGEN_FONTS[0]` is the default font in docs and sheets: `DOCUMENT_FONT` names it for docs, `SHEET_DEFAULT_FONT` (`packages/lib/src/sheets/fonts.ts`) for sheets. The canvas has its own default, `DEFAULT_FONT_FAMILY` (Excalifont), in `packages/lib/src/vector/types.ts`.

## Docs and the canvas store a font name, never a CSS stack

The name expands to CSS only where it renders. A sheet cell is looser ([§ A sheet cell's font has one decoder](#a-sheet-cells-font-has-one-decoder)).

- The canvas reader accepts only a name from `EIGEN_FONT_NAMES` and falls back to its default (`fontFamily` in `packages/lib/src/vector/kinds/read-fields.ts`). The name ends up in a CSS declaration list, where a stray `;` would open a declaration of the writer's choosing.
- The docs `textStyle` mark stores a name, and its node (`packages/lib/src/docs/eigendoc/nodes/font-family.ts`) renders it through `fontNameToCss` (`packages/lib/src/constants/fonts.ts`). A value that is already a stack passes through unchanged. `getFontName` does the reverse lookup for paste, import and export.
- `getFontFamily` puts an unknown name before the stack of the bundled font it maps to, else Inter's, as `'Bell MT', 'Inter', …`: the emoji face holds the digits, `#` and `*` for its keycaps, so a font the browser lacks must not fall straight to it. `fontNameToCss` must not wrap, or a stored stack would be wrapped twice.

## Foreign fonts map onto the bundled ones

Only the bundled faces are embedded in an export, so a font Eigen doesn't ship would render in the browser's generic family and print differently. One map sends a foreign font (Calibri, Arial, Times New Roman and the like) to the bundled font of the same category: `bundledFont` in `packages/lib/src/constants/fonts.ts`, over the map that module keeps. Four readers share it: the xlsx import, which sets the font as a cell's `ff`; the docx reader (`apps/api/src/lib/import/doc/docx-fonts.ts`); and the pastes in docs (`cleanPastedHTML` in `apps/docs/src/components/docs/paste.ts`) and sheets (`packages/sheet/src/state/events/paste.ts`). A paste reads a CSS stack, so it maps the first family of the stack the map knows (`bundledFontOfStack`), as Google Docs writes `Georgia,serif`, Word `"Times New Roman",serif` and a copy from Eigen a bundled font's own stack. A font the map doesn't know gives a sheet cell no `ff`, so it draws in the sheet default.

A doc's text draws without a mark in its Normal font, the document font `DOCUMENT_FONT` (Inter) unless the doc's Normal names another ([DOCS.md](DOCS.md#a-doc-stores-its-normal-text-in-a-style-map-beside-its-page)). A paste gives the Normal's font no mark and every other bundled font, Inter included, its `textStyle` mark (`cleanPastedHTML`, which reads the Normal at paste time). A docx import takes the file's body font as the Normal's, so its body runs carry no font mark: a Word file set in Calibri imports in Inter, one set in Times New Roman in Source Serif 4, and a run in Arial in a Times file gets the Inter mark. A font that maps to nothing draws in Inter, a mark where the Normal is another font. A run in a foreign monospace font, Courier New in a sentence, gets the JetBrains Mono mark and stays prose. Only a code style or the editor's code look on a light grey makes a run inline code, because a grey chip on every Courier run would invent code the author never marked.

## A sheet cell's font has one decoder

A cell's `ff` is an index into `EIGEN_FONTS` or a font name, and a rich-text run edited in the cell stores its lowercased CSS stack. `cellFontName` (`packages/lib/src/sheets/fonts.ts`) turns any of them into a name: the editor's canvas and toolbar, the HTML export and the xlsx writer all call it, so a cell can't draw in one font and export in another. A numeric string is a name, not an index. A peer writes `ff`, and the name reaches CSS, so a name holding `;`, `(`, a quote, a backslash or a control character is none, and the cell draws in the default. A cell with no `ff` draws in `SHEET_DEFAULT_FONT`, Inter, at `SHEET_DEFAULT_FONT_SIZE`, 10 pt.

## The xlsx export makes Inter the workbook's default font

The xlsx writer writes the sheet default as the workbook's default font, the first font of `styles.xml`, which a cell with no font of its own draws in, so the file opens in the font Eigen drew. It names no colour, so text is automatic: the import gives every cell of a format that font whole, and a colour there would read back as one the cell picked. Every font the writer writes names its face and size, and a bundled face its `<family>` number (1 serif, 2 sans, 3 mono, 4 script), so a reader without Inter substitutes a face of the same kind.

The default font is also the unit of a column width: an xlsx width counts the file's own default font's widest digit (ECMA-376 Part 1 § 18.3.1.13). `SHEET_DEFAULT_DIGIT_WIDTH` derives Inter's from `FONT_METRICS` at 10 pt, 9 px. The writer converts through it, and so does the importer for a file whose default font is Inter, so an export's widths survive the round trip to the pixel. Any other file converts through Excel's digit for its default font and size, so an Excel column keeps the pixels it has in Excel ([SHEETS.md](SHEETS.md#some-xlsx-round-trip-drifts-are-decisions)).

## The docx reader picks a font per script and falls back on the font table

Word gives a run four faces and draws each character in the one for its script: `w:ascii` for ASCII, `w:hAnsi` for the rest of Latin, Greek and Cyrillic, `w:eastAsia` for East Asian text, and `w:cs` for complex script (Arabic, Hebrew, the Indic scripts, Thai and the like), which has its own bold, italic and size. The reader does the same, so an Arabic word in a Latin sentence gets its own face and look (`byFace` in `docx-fonts.ts`). A theme font resolves through the file's theme, and its complex-script and East Asian faces through the script of the run's language.

A name the map doesn't know falls back on its entry in the file's `fontTable.xml`: a fixed pitch is monospace, and a variable pitch is serif for the family `roman` and sans-serif for `swiss`. Anything else maps to nothing, and the text draws in the document font. The family counts only beside a variable pitch, because Word writes `roman` with the default pitch for a font it has no metrics for. The corpus audit (`apps/api/src/scripts/docx-audit.ts`) imports this rule to count the words Word draws in a bundled font.

## One picker serves every app

`FontPicker` (`packages/ui/src/components/media/font-picker.tsx`) lists `EIGEN_FONTS`, each item previewed in its own face. The docs toolbar and the sheets format toolbar use it directly. The canvas uses it through `FontRow` (`packages/ui/src/components/properties-panel/`) in the rich-text and arrow property sections. A new registry entry shows up in all of them.

## A size is pt on a page and px on a drawing

Docs, Sheets and Slides show and take a font size in pt, on the half-point grid and the 1 to 400 pt range of `readFontSize` and `snapFontSize` (`packages/lib/src/constants/fonts.ts`), through the one `FontSizeStepper` with 1 pt steps, as Google's apps do. A doc and a sheet store pt. The canvas stores px, because Slides and Vector share it and a drawing has no page: a deck converts at its own physical width ([SLIDES.md](SLIDES.md#a-deck-has-a-physical-width-so-its-text-sizes-read-in-pt)), and a drawing shows whole px. Showing a size never rewrites it.

## A new font touches six places

The registry drives the pickers and the sheet lists. The other places keep their own list of faces, so a new font touches six:

1. The woff2 files, the static TrueType faces the docx embeds and the font's `OFL.txt` in `packages/ui/src/assets/fonts/<font-name>/`.
2. A rerun of `scripts/fonts/build-font-slices.ts`, which cuts the face into slices and writes them, `fonts.css` and `FONT_SLICES`.
3. The entry in `EIGEN_FONTS`, appended at the end, with its single line (`lineHeight`), `(usWinAscent + usWinDescent) / unitsPerEm` of its Regular, which `fonts.test.ts` checks against the TTF. The line of a doc's Normal and of a run with a font mark, and the canvas, read it through `fontLineHeight`.
4. `FONT_METRICS` in `packages/lib/src/vector/font-metrics.ts`. The canvas places SVG text baselines from each face's vertical metrics, and an unknown font gets Excalifont's. A face's line there is its `EIGEN_FONTS` line, but Excalifont's, which the canvas draws at Excalidraw's 1.25 under the face's 1.26, the line every drawing's text is laid out at. The widest digit there sizes a sheet's xlsx column unit.
5. `FONT_FACES` in `packages/lib/src/constants/fonts.ts`, each woff2 face by its path under `assets/fonts/`, which the vendoring script reads to cut it, and its static faces in `DOCX_FONT_FILES` (`apps/api/src/lib/export/doc/docx/fonts.ts`). Exports and a drawing's downloaded SVG embed the slices as base64 `@font-face` rules ([EXPORT.md](EXPORT.md#an-export-embeds-only-the-font-slices-its-text-draws)); the docx embeds the static faces, keyed by the font's name ([EXPORT.md](EXPORT.md#the-docx-embeds-the-faces-a-doc-uses-its-600s-in-the-bold-slot)). `apps/api/src/test/export/fonts.test.ts` fails when an embedded slice and `fonts.css` disagree or when `DOCX_FONT_FILES` misses a font; `packages/ui/src/test/components/vector/canvas-image.test.ts` fails when `FONT_FACES`, `FONT_SLICES` and `fonts.css` disagree.
6. The `FONTS` list in `apps/index/scripts/build-licenses.ts`, which the /licenses page reads. A bundled font is not a package, so the license build does not find it on its own.

A `--font-*` token in `globals.css` is needed only when the font fills a new category. A new fallback face is an entry in `FALLBACK_FONTS`, a recipe in the vendoring script and its line on the licenses page.

## See also

- [EXPORT.md](EXPORT.md#an-export-embeds-only-the-font-slices-its-text-draws): how exports embed the fonts
- [proposals/PROPOSAL_FALLBACK_FONTS.md](proposals/PROPOSAL_FALLBACK_FONTS.md): the measurements and rulings behind the fallback faces and the slices
- [SHEETS.md](SHEETS.md): the sheet engine that stores `ff`
- [EXPORT.md](EXPORT.md#a-sheet-export-recalcs-and-xlsx-carries-cells-charts-and-pictures): the xlsx writer
