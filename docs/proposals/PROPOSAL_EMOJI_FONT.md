# Proposal: every emoji in Eigen draws in Noto Emoji

This proposal bundles Google's monochrome Noto Emoji as the one emoji font of every Eigen surface: the web apps, the sheet grid, the PDF, the HTML download and a drawing's SVG. An emoji then looks the same on every device and in every file Eigen writes, and a PDF stops printing empty boxes.

**Status:** not built, proposed. [ROADMAP.md](../ROADMAP.md) has its row at the top of P1. The owner chose monochrome Noto Emoji over a color emoji font, and the same font in the web apps as in the exports, on 2026-10-30 ([§ Decisions](#decisions)). The new npm package in phase 2 needs the owner's yes before it is built ([§ Open questions](#open-questions)). What this proposal says about the code was true on 2026-10-30, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: Eigen bundles no emoji font, so an emoji draws in whatever the reader's system has: Apple's on a Mac, Segoe's on Windows, and nothing at all in the PDF, because the Docker image has no system fonts. This proposal adds Noto Emoji (OFL 1.1, black and white, variable weight) as the last bundled family of every font stack, before the system fallbacks. Every app draws it from a 1.05 MB WOFF2, like every other bundled face, and a browser downloads it only for a page that shows an emoji, through `unicode-range`. The PDF embeds it whenever a document has an emoji, and WeasyPrint keeps only the glyphs it prints, so an emoji adds about 8 KB to a PDF. The HTML download and the SVG download embed a subset of the emoji they draw, about 2 KB per emoji, cut by HarfBuzz's subsetter from a TTF copy of the same font, which only the subsetter reads. No stored format changes and no database migration. Phase 1, the web apps and the PDF, is about three days; phase 2, the subsets, about two to three.

## Goals

1. An emoji draws in the same glyph in Docs, Sheets, Slides, Vector, Stickies, Chat, Mail's own UI and every other web app, on every operating system.
2. The PDF, the HTML download, a drawing's SVG download and the server's SVG previews draw it in the same glyph, with no system font needed.
3. A file Eigen writes grows only by the emoji it draws, not by the whole font.
4. A page or file with no emoji loads and embeds nothing new.

## Non-goals

- Color emoji. The owner prefers the black-and-white look ([§ Decisions](#decisions)). Noto Color Emoji is also 25 MB, and WeasyPrint draws no COLRv1 glyphs.
- Skin tones, gendered variants and flags as separate glyphs. Noto Emoji draws a skin-toned emoji as its default figure and a flag as its letters in a frame (🇳🇱 as "NL").
- The docx and pptx downloads. Word and PowerPoint draw an emoji the run's font lacks in their own emoji font, and the docx embeds each face whole so the reader can type ([EXPORT.md § The docx embeds the faces a doc uses](../EXPORT.md#the-docx-embeds-the-faces-a-doc-uses-its-600s-in-the-bold-slot)), which would add 2 MB to every docx with an emoji.
- A mail Eigen sends. The recipient's mail client picks its own fonts.
- An emoji picker. Eigen has none today; one would inherit the font stack.

## Current state

**No surface names an emoji font.** The four `--font-*` tokens in `packages/ui/src/styles/globals.css` and each `family` in `EIGEN_FONTS` (`packages/lib/src/constants/fonts.ts`) end in system fallbacks, so an emoji draws in the system's emoji font. No code names Apple Color Emoji, Segoe UI Emoji or Noto Color Emoji.

**The PDF prints empty boxes.** WeasyPrint draws from the `@font-face` rules the export embeds (`export/fonts.ts`, [EXPORT.md § Every format but xlsx, docx and pptx is one HTML document](../EXPORT.md#every-format-but-xlsx-docx-and-pptx-is-one-html-document)) and then from fontconfig's system fonts. The API image installs none (`docker/api/Dockerfile`), so a character no bundled face has prints as a box. Inter happens to draw ❤ ⚠ ✓ ★ → itself, as text glyphs. A developer's Mac fills the gap from Apple Color Emoji, so the gap shows only in Docker.

**The SVG download leaves emoji to the reader.** EXPORT.md lists it as an accepted limit: an emoji names the run's family list, so the reader draws it in its own emoji font ([EXPORT.md § A drawing downloads its own SVG and prints as layers](../EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers)).

**The sheet grid draws text on a `<canvas>`.** `getFontSet` (`packages/sheet/src/state/modules/text.ts`) builds the `ctx.font` string a cell draws with. A canvas does not load a web font by itself: a face that has not been loaded draws in the fallback.

**Faces are embedded whole.** `fontFaceCssOf` and `allFontFaceCss` (`apps/api/src/lib/export/fonts.ts`) base64 each WOFF2 face whole into a `data:` URI, for `exportHtmlDocument` (`export/html-document.ts`) and the server's SVG previews (`preview/svg-media-inline.ts`). `downloadCanvasImage` (`packages/ui/src/components/vector/canvas-image.ts`) fetches each face and does the same in the browser. Nothing subsets a font today.

## Measured

On WeasyPrint 70.0 with fontconfig emptied, as in Docker, one line of 13 emoji (👋 🎉 ✅ ❤️ 👍🏽 👨‍👩‍👧 🇳🇱 ☕ 🚀 ⚠️ 1️⃣ and two more) in regular and bold:

| Emoji font | HTML handed to WeasyPrint | PDF | Render | What prints |
|---|---|---|---|---|
| None, today | 458 KB | 7 KB | 0.3 s | Boxes, but for Inter's ❤ ⚠ ✓ ★ → |
| Noto Emoji whole | 1.8 MB | 15 KB | 1.1 s | Every emoji, bold too |
| Noto Emoji subset to the line | 477 KB | 15 KB | 0.3 s | The same as whole |
| Noto Color Emoji (COLRv1) | 33 MB | 76 KB | 11.4 s | Not pursued |

WeasyPrint subsets every face it writes, so the PDF is the same size either way. Handing it the whole font costs only the 0.7 s it spends parsing 1.4 MB of base64.

| Noto Emoji file | Size |
|---|---|
| Variable TTF, weights 300 to 700 | 1.98 MB (1.23 MB gzipped) |
| The same as WOFF2 | 1.05 MB |
| Static Regular, WOFF2 | 464 KB |
| Subset to the 13 emoji, TTF | 24.7 KB |
| Subset to the 13 emoji, WOFF2 | 14.4 KB |
| Ten unicode-range chunks of 150 code points, WOFF2 | 120 to 263 KB each |

A chunk is large because it keeps every emoji sequence its code points can start, so pre-cut chunks are no substitute for a subset.

## Design

### A WOFF2 to draw with, a TTF to cut subsets from

`packages/ui/src/assets/fonts/noto-emoji/` holds Google's variable font twice, with its `OFL.txt`. Every app and the whole-font PDF embed draw from `NotoEmoji-Variable.woff2`, the same format as every other bundled face and the smallest over the wire (1.05 MB). `NotoEmoji-Variable.ttf` is the subsetter's input only, because HarfBuzz's subsetter reads TrueType but not WOFF2. No page loads it: the server reads it from disk, and the browser fetches it only when it downloads a drawing with an emoji. The variable font keeps bold emoji bold: Eigen's bold is 600 and the font spans 300 to 700.

The family is `Noto Emoji`, one constant beside `EIGEN_FONTS`, never a picker entry and never stored. The `/licenses` page lists it beside the other bundled fonts (`apps/index/scripts/build-licenses.ts`).

### The browser fetches it only for an emoji

`fonts.css` declares the WOFF2 face with a `unicode-range` of the emoji the font draws, without Basic Latin. A browser downloads a face only when a character in its range draws in it, so a page with no emoji fetches nothing. A test derives the range from the font's character map and fails when the two disagree.

Digits, `#` and `*` stay out of the range, so a keycap emoji (1️⃣) draws its digit in the text font and its frame in Noto Emoji. That is the accepted cost of never fetching the font for a digit.

### Every stack ends in it, before the system fonts

`Noto Emoji` goes after the bundled family and before the system fallbacks in the four `--font-*` tokens and in each `EIGEN_FONTS` `family`. Every text font comes first, so a character Inter, Source Serif 4, JetBrains Mono or Excalifont draws keeps its glyph, and only what they lack falls to the emoji font, before the system's. A text-style symbol the text font lacks (☺ ✂) draws in Noto Emoji too, the same glyph everywhere.

`getFontName` and `normalizeFontFamilyMarks` collapse a stored CSS stack to its name by matching the stacks `EIGEN_FONTS` held ([TYPOGRAPHY.md § Docs and the canvas store a font name, never a CSS stack](../TYPOGRAPHY.md#docs-and-the-canvas-store-a-font-name-never-a-css-stack)). They must keep matching the stacks without `Noto Emoji`, or a document from before the change keeps its stack, and a run in it draws its emoji in the system font. A test pins both forms.

### The sheet grid loads the face before it draws an emoji

`getFontSet` ends its family list in `Noto Emoji`. Because a canvas draws an unloaded face in the fallback, the grid calls `document.fonts.load` for `Noto Emoji` with a cell's text the first time it draws a cell with an emoji, and redraws when it resolves, as the browser does for DOM text with `font-display: swap`.

### The PDF and the HTML download embed it when the body has an emoji

`exportHtmlDocument` scans the body it writes for a code point in the emoji range. With none it embeds nothing new. With one it embeds `Noto Emoji`: in phase 1 the whole WOFF2, which WeasyPrint subsets itself, and in phase 2 a subset of the emoji the body holds. The HTML download embeds the same face, so it draws the same glyphs offline.

### The SVGs embed a subset

`downloadCanvasImage` collects the code points of the runs it measured, and the server's SVG preview those of its text. Each embeds a subset of `Noto Emoji` with only those, as `data:font/ttf` since HarfBuzz writes TrueType, beside the faces it embeds today. EXPORT.md's accepted limit for emoji in the SVG download goes.

### One subsetter, in the browser and on the server

`subsetFont(ttf, codePoints)` in `packages/lib`, on a React-free subpath, is the one subsetter. It runs HarfBuzz's subsetter compiled to WebAssembly, from `harfbuzzjs`, and keeps the font's layout features, so a ZWJ sequence (👨‍👩‍👧) and a flag still draw as one glyph. The `.wasm` loads on first use, so an export or a download with no emoji never loads it, and the browser's main bundle doesn't grow. The server's export runs in the transform process ([EXPORT.md § The transform process renders and the main thread prepares](../EXPORT.md#the-transform-process-renders-and-the-main-thread-prepares)), so a subset never blocks the API thread.

## Phases

1. **The web apps and the PDF** (M, about three days). The WOFF2 and its license, the `@font-face` with its `unicode-range` and the test that pins it, the stacks and the collapse test, the sheet grid's font load, and the PDF and HTML download embedding the whole font when the body has an emoji. Update TYPOGRAPHY.md (the bundled fonts and the six places), EXPORT.md and the CHANGELOG. No new package.
2. **Subsets** (M, about two to three days). The TTF, and `subsetFont` on `harfbuzzjs`, used by the HTML download and the PDF, the SVG download and the server's SVG previews. EXPORT.md's emoji limit goes.

## Decisions

- **Monochrome Noto Emoji**, not a color emoji font. (Owner, 2026-10-30.)
- **The web apps draw the same emoji font as the exports**, so an emoji looks the same everywhere in Eigen. (Owner, 2026-10-30.)
- **The apps draw the WOFF2**, like every other bundled face, and the TTF exists only for the subsetter, which cannot read WOFF2. (Owner, 2026-10-30.)

## Open questions

1. **The package.** `harfbuzzjs` 1.6.4, MIT, no dependencies, 1.3 MB unpacked, of which `harfbuzz-subset.wasm` is 684 KB, loaded only when a file with an emoji is written. Needs the owner's yes before phase 2. The alternative is fontTools' `pyftsubset`, already in the WeasyPrint venv: it serves the server only, makes an HTML download need WeasyPrint's Python, and leaves the SVG download embedding the whole WOFF2, 1.4 MB of base64. With `pyftsubset` the TTF copy is not needed, since fontTools reads WOFF2.
2. **Mail's reading pane.** A received message renders in its own frame with its own styles. Check whether the frame inherits the app's stacks; if not, its base stylesheet adds `Noto Emoji` too.

## Risks

- **Download size.** 1.05 MB once per browser, only on a page with an emoji. Chat and comments are where most pages first show one.
- **Coverage.** Noto Emoji covers Unicode Emoji 18.0. A newer emoji falls through to the system font until the bundled file is updated.
- **A text symbol changes look.** A symbol the text fonts lack and the system drew as text, such as ☺, now draws in Noto Emoji's glyph. Everywhere the same, which is the goal.
