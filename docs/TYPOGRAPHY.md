# Typography and Self-Hosted Fonts

> **TLDR:** Four self-hosted font families (Inter, Source Serif 4, JetBrains Mono, Excalifont) ship as woff2 files in `packages/ui/src/assets/fonts/`, declared in `packages/ui/src/styles/fonts.css`, with no external CDN. `EIGEN_FONTS` (`packages/lib/src/constants/fonts.ts`) is the one list the pickers read. Its order is load-bearing, since a sheet cell can store a font as an index into it. Docs and the canvas store a font's name, never a CSS stack. A new font touches six places, because the canvas metrics, the export and the licenses page keep lists of their own.

This doc governs the fonts every app, editor and export uses, and the weight scale of the UI. Read it before you add a font, change a weight or touch how an editor stores a font choice. A font choice is part of a document: a doc's text, a sheet cell and a canvas text box each store theirs in the document's Yjs data ([COLLAB.md](COLLAB.md)), and an export embeds the same faces ([EXPORT.md](EXPORT.md)). So the font list is a stored format as much as a menu, and most of its rules follow from that.

## Four families ship with the app

| Font | Category | Weights | Italic | Role |
|---|---|---|---|---|
| Inter | Sans-serif | 100 to 900, variable | Yes | The UI, prose, and the default in docs and sheets |
| Source Serif 4 | Serif | 200 to 900, variable | Yes | A picker choice |
| JetBrains Mono | Monospace | 100 to 800, variable | No | Code blocks and inline code |
| Excalifont | Hand-drawn | 400 only | No | The canvas default |

The files are Vite assets, so they are hashed and cached like any other. Nothing loads from a font CDN: a self-hosted server makes no request to a third party to render text. Every face uses `font-display: swap`, so text shows at once in the fallback and swaps when the font arrives.

All four are licensed under the SIL Open Font License (OFL 1.1). The license asks that it travels with the font, so each font folder carries its `OFL.txt`, and the /licenses page of the index app lists every font.

## CSS tokens name each category

`globals.css` imports `fonts.css` and defines one token per category: `--font-sans`, `--font-serif`, `--font-mono` and `--font-hand`, each the bundled family followed by system fallbacks. They give the Tailwind utilities `font-sans`, `font-serif`, `font-mono` and `font-hand`. `eigen-prose.css` sets body text in `--font-sans` and code in `--font-mono`, so prose follows the tokens too.

## The weight scale is lighter than Tailwind's

One `@theme` block in `font-weights.css`, which `globals.css` imports, sets `--font-weight-medium` to 450, `--font-weight-semibold` to 525 and `--font-weight-bold` to 600. So `font-bold` renders at 600, not 700. The body and the prose headings read these tokens, so the whole scale is tuned in that one block: Heading 1 to 4 are medium, and Heading 5 and 6 take the body's normal weight, as in Google Docs, where they are body-sized and grey, and 6 is italic, so an italic mark in it draws upright. The title and subtitle are paragraphs and keep the body's weight, as Google's do. The variable faces render the in-between weights exactly on screen. The doc export reads the same file and writes each weight `eigen-prose.css` reads through `var()` as its value, rounded to the nearest multiple of 100 because WeasyPrint accepts nothing else, so Heading 1 to 4 print at 500, Heading 5 and 6 at 400 and bold at 600.

## The registry's order is load-bearing

`EIGEN_FONTS` holds each font's name, CSS stack, category and weights. Each category has exactly one font. A foreign font maps to its category's bundled font (`bundledFontOfCategory`), the first entry of that category, so a second font in a category would never be picked by an import or a paste. Its order matters for two reasons:

- A sheet cell's `ff` may be an index into the list rather than a name: the editor's default cell stores `0`. Reordering or inserting changes the font of every stored index, so **a new font goes at the end**.
- `EIGEN_FONTS[0]` is the default font in docs and sheets: `DOCUMENT_FONT` names it for docs, `SHEET_DEFAULT_FONT` (`packages/lib/src/sheets/fonts.ts`) for sheets. The canvas has its own default, `DEFAULT_FONT_FAMILY` (Excalifont), in `packages/lib/src/vector/types.ts`.

## Docs and the canvas store a font name, never a CSS stack

The name expands to CSS only where it renders. A sheet cell is looser ([§ A sheet cell's font has one decoder](#a-sheet-cells-font-has-one-decoder)).

- The canvas reader accepts only a name from `EIGEN_FONT_NAMES` and falls back to its default (`fontFamily` in `packages/lib/src/vector/kinds/read-fields.ts`). The name ends up in a CSS declaration list, where a stray `;` would open a declaration of the writer's choosing.
- The docs `textStyle` mark stores a name, and its node (`packages/lib/src/docs/eigendoc/nodes/font-family.ts`) renders it through `fontNameToCss` (`packages/lib/src/constants/fonts.ts`). A value that is already a stack passes through unchanged, and `normalizeFontFamilyMarks` in the docs editor collapses it to its name on an editable load. `getFontName` does the reverse lookup for paste and import.
- `getFontFamily` wraps an unknown name as `'<name>', sans-serif`. `fontNameToCss` must not wrap, or a stored stack would be wrapped twice.

## Foreign fonts map onto the bundled ones

Only the bundled faces are embedded in an export, so a font Eigen doesn't ship would render in the browser's generic family and print differently. One map sends a foreign font (Calibri, Arial, Times New Roman and the like) to the bundled font of the same category: `bundledFont` in `packages/lib/src/constants/fonts.ts`, over the map that module keeps. Four readers share it: the xlsx import, which sets the font as a cell's `ff`; the docx reader (`apps/api/src/lib/import/doc/docx-fonts.ts`); and the pastes in docs (`cleanPastedHTML` in `apps/docs/src/components/docs/paste.ts`) and sheets (`packages/sheet/src/state/events/paste.ts`). A paste reads a CSS stack, so it maps the first family of the stack the map knows (`bundledFontOfStack`), as Google Docs writes `Georgia,serif`, Word `"Times New Roman",serif` and a copy from Eigen a bundled font's own stack. A font the map doesn't know gives a sheet cell no `ff`, so it draws in the sheet default.

A doc's text draws without a mark in its Normal font, the document font `DOCUMENT_FONT` (Inter) unless the doc's Normal names another ([DOCS.md](DOCS.md#a-doc-stores-its-normal-text-in-a-style-map-beside-its-page)). A paste gives the Normal's font no mark and every other bundled font, Inter included, its `textStyle` mark (`cleanPastedHTML`, which reads the Normal at paste time). A docx import takes the file's body font as the Normal's, so its body runs carry no font mark: a Word file set in Calibri imports in Inter, one set in Times New Roman in Source Serif 4, and a run in Arial in a Times file gets the Inter mark. A font that maps to nothing draws in Inter, a mark where the Normal is another font. A run in a foreign monospace font, Courier New in a sentence, gets the JetBrains Mono mark and stays prose. Only a code style or the editor's code look on a light grey makes a run inline code, because a grey chip on every Courier run would invent code the author never marked.

## A sheet cell's font has one decoder

A cell's `ff` is an index into `EIGEN_FONTS` or a font name, and a rich-text run edited in the cell stores its lowercased CSS stack. `cellFontName` (`packages/lib/src/sheets/fonts.ts`) turns any of them into a name: the editor's canvas and toolbar, the HTML export and the xlsx writer all call it, so a cell can't draw in one font and export in another. A numeric string is a name, not an index. A cell with no `ff` draws in `SHEET_DEFAULT_FONT`, Inter, at `SHEET_DEFAULT_FONT_SIZE`, 10 pt.

## The xlsx export makes Inter the workbook's default font

ExcelJS writes Calibri as the workbook's default font, the first font of `styles.xml`, which a cell with no font of its own draws in. So `to-xlsx.ts` rewrites that font to the sheet default, and the file opens in the font Eigen drew. Every font the writer writes names its face and size, and a bundled face its `<family>` number (1 serif, 2 sans, 3 mono, 4 script), so a reader without Inter substitutes a face of the same kind.

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
2. Its `@font-face` rules in `fonts.css`.
3. The entry in `EIGEN_FONTS`, appended at the end, with its single line (`lineHeight`), `(usWinAscent + usWinDescent) / unitsPerEm` of its Regular, which `fonts.test.ts` checks against the TTF. The editor's paragraph line, the docx writer and reader and the canvas read it through `fontLineHeight`.
4. `FONT_METRICS` in `packages/lib/src/vector/font-metrics.ts`. The canvas places SVG text baselines from each face's vertical metrics, and an unknown font gets Excalifont's. A face's line there is its `EIGEN_FONTS` line, but Excalifont's, which the canvas draws at Excalidraw's 1.25 under the face's 1.26, the line every drawing's text is laid out at. The widest digit there sizes a sheet's xlsx column unit.
5. `FONT_FACES` in `packages/lib/src/constants/fonts.ts`, each woff2 face by its path under `assets/fonts/`, and its bundled path in `FACE_PATHS` and its static faces in `DOCX_FONT_FILES` (`apps/api/src/lib/export/fonts.ts`). Exports and a drawing's downloaded SVG embed the faces as base64 `@font-face` rules ([EXPORT.md](EXPORT.md)), and a font missing there prints in a fallback; the docx embeds the static faces, keyed by the font's name ([EXPORT.md](EXPORT.md#the-docx-embeds-the-faces-a-doc-uses-its-600s-in-the-bold-slot)). `apps/api/src/test/export/fonts.test.ts` fails when the exported faces and `fonts.css` disagree, when `DOCX_FONT_FILES` misses a font, or when a face names another family, and pins the count of faces, so a new face updates the test too; `packages/ui/src/test/components/vector/canvas-image.test.ts` fails when `FONT_FACES` and `fonts.css` disagree.
6. The `FONTS` list in `apps/index/scripts/build-licenses.ts`, which the /licenses page reads. A bundled font is not a package, so the license build does not find it on its own.

A `--font-*` token in `globals.css` is needed only when the font fills a new category.

## See also

- [EXPORT.md](EXPORT.md): how exports embed the fonts
- [SHEETS.md](SHEETS.md): the sheet engine that stores `ff`
- [EXPORT.md](EXPORT.md#a-sheet-export-recalcs-and-xlsx-carries-cells-only): the xlsx writer
