# Proposal: one way to draw emoji, CJK and math, the same in the apps and every export

This proposal gives Eigen one set of fallback fonts for the characters its text fonts lack: Noto Emoji for emoji, Noto Sans CJK for Chinese, Japanese and Korean, and a math font for equations. Every bundled face, the text faces included, is cut once into `unicode-range` slices. The browser fetches only the slices a page draws, and every export embeds only the slices its document touches. So a document looks the same in Docs, on the sheet grid, on a canvas, in the PDF and in the HTML download, and a file Eigen writes stops carrying whole fonts.

**Status:** approved 2026-11-01. Phases 0 to 3 are built, on branch `fonts-fallback`; [TYPOGRAPHY.md](../TYPOGRAPHY.md) and [EXPORT.md](../EXPORT.md#an-export-embeds-only-the-font-slices-its-text-draws) describe the code as it is. It supersedes `PROPOSAL_EMOJI_FONT.md` (2026-10-30) and `PROPOSAL_MATH_FONTS.md` (2026-10-29) and keeps their owner decisions ([§ Decisions](#decisions)). [ROADMAP.md](../ROADMAP.md) has a row for what the built phases leave open, [DOCS-TODO.md](../DOCS-TODO.md) the per-doc math font (phase 5), and [ROADMAP-POST-1.md](../ROADMAP-POST-1.md) the Japanese and Traditional Chinese forms (phase 4). Each phase names the owner's yeses it needs ([§ Phases](#phases), [§ Open questions](#open-questions)). What this proposal says about the code was true on 2026-11-01 as far as a read could tell; verify each claim before building on it.

> **TLDR**: Eigen bundles no emoji or CJK font, so those characters draw in whatever the system has: Apple's fonts on a Mac, Segoe's on Windows, and in the API image Droid Sans Fallback for Chinese and Japanese, boxes for Korean and for most emoji. Equations draw in three different fonts across the editor, the PDF and the HTML download. Every HTML download is 98 to 99% whole base64 fonts: 1.16 MB for a short doc, 1.0 MB for a sheet or deck. This proposal makes slices the one form of every bundled face. One vendoring script cuts each face once into `unicode-range` slices on Google Fonts' ranges and writes the WOFF2 files, the `@font-face` CSS and the range data. The browser loads them lazily. Every export embeds the slices whose range meets the document's code points, chosen by one lib function the server and the browser share. WeasyPrint picks among them by `unicode-range` and subsets the PDF as it does today, once a small shim in our render script keys its PDF fonts by file. Emoji draw monochrome in the text color on every surface, from one form of Noto Emoji. One TypeScript builder spells every stack, and the CSS tokens are literals a drift test checks against it. No Python in the HTML download, no font the PDF needs in the Dockerfile, no database migration, no new npm package. Six phases, about five weeks.

## Goals

1. An emoji, a Chinese or Korean character and an equation draw in the same glyphs in every app (the DOM, the sheet grid, the canvas), in the PDF, in the HTML download and in the SVGs, on every OS and in Docker. Japanese and Traditional Chinese forms follow in a later phase.
2. An export embeds only the slices it draws. Every HTML download shrinks, not only those with an emoji.
3. A page fetches only the slices it draws. A page without an emoji or CJK character fetches nothing new.
4. One representation of a face (its slices), one stack builder, one way the browser loads, one function that picks what an export embeds. Another fallback font is a registry entry and a rerun of one script.

## Non-goals

- **Color emoji.** The owner chose monochrome Noto Emoji, and the evidence backs it. The emoji slices carry a color table only to paint each glyph in the text color, so that the browsers draw them instead of the system's color emoji ([§ Emoji stay monochrome](#emoji-stay-monochrome)).
- **An exact cut per export, for now.** A cut to the document's code points is smaller than its slices, but it needs a subsetter at export time and a second form of each face. Its numbers stay as the cost of not doing it ([§ What slices cost against an exact cut](#what-slices-cost-against-an-exact-cut)).
- **Fallback fonts in the Office files.** The docx embeds the Eigen text faces whole so a reader can type in them ([EXPORT.md § The docx embeds the faces a doc uses](../EXPORT.md#the-docx-embeds-the-faces-a-doc-uses-its-600s-in-the-bold-slot)). Word, PowerPoint and Excel fall back to their own emoji, CJK and math fonts (Segoe UI Emoji or Apple Color Emoji, Yu Gothic or Microsoft YaHei, Cambria Math), which is what a reader who edits the file needs. Which font Word picks is unverified.
- **A picker entry or a stored name.** A fallback font is never offered, never written in a document and never one of `EIGEN_FONTS`, whose order is load-bearing for sheets ([TYPOGRAPHY.md § The registry's order is load-bearing](../TYPOGRAPHY.md#the-registrys-order-is-load-bearing)).
- **`:lang()` and a language per element.** v1 draws one CJK region for Han ([§ CJK](#cjk)).
- **A serif CJK face.** Source Serif 4 text gets the sans CJK face. Noto Serif CJK would double the CJK assets.
- **Other scripts** (Arabic, Hebrew, Indic, Thai). The registry takes them later the same way.
- **Math letters as text.** A 𝑥 typed outside an equation is in no fallback's coverage, so it falls to the system font as today.
- **A mail Eigen sends.** The recipient's client picks its fonts.

## Current state

**No surface names an emoji or CJK font, and seven places spell a stack.** The `--font-*` tokens in `packages/ui/src/styles/globals.css`; each `family` in `EIGEN_FONTS` (read through `getFontFamily` and `fontNameToCss`); `FONT_STACK_SANS` and `FONT_STACK_MONO` in `apps/api/src/lib/document/font-stacks.ts`; the sheet's literals; the `font-family` fallback in `packages/ui/src/components/shadow-content.tsx`; the `math` rule in `packages/ui/src/styles/eigen-prose.css`, `"STIX Two Math", math`; and `buildCellStyle` in `apps/api/src/lib/export/sheets/render.ts`, which writes `font-family:${q}${name}${q},sans-serif` for every cell with an `ff`. Most text gets a TypeScript-built literal, not a token: a doc's Normal through `getFontFamily` in `normalStyleProperties` (`packages/lib/src/docs/eigendoc/normal-style.ts`), every mark through `fontNameToCss`, every canvas label through `getFontFamily`. No `@font-face` in `packages/ui/src/styles/fonts.css` has a `unicode-range`.

**The sheet grid names system CJK fonts and never waits for a face.** `getFontSet` (`packages/sheet/src/state/modules/text.ts`) ends every canvas font in `FALLBACK_FAMILIES`: Helvetica Neue, Helvetica, Arial, PingFang SC, Hiragino Sans GB, Heiti SC, Microsoft YaHei, WenQuanYi Micro Hei. `getFontStyleByCell` (`state/modules/cell.ts`), the runs `inline-string.ts` writes and the sheet's font menu (`components/MenuBar/format-menu.tsx`) spell `'<name>', sans-serif` instead. So one cell has three fallback chains: the grid's, the cell editor's and the export's. Nothing in `packages/sheet` uses `document.fonts`. `textHeightCache` in `text.ts` is never cleared, so a height measured before a face loaded stays, a standing bug.

**Some measurements are stored, so a redraw won't heal them.** When a cell that wraps commits, `cell.ts` measures it on the canvas (`getCellTextInfo`) and writes `cfg.rowlen[r]`, which syncs to peers and reaches every export. A height measured in the fallback is stored for good. On a canvas, `loadVectorFont` and `isVectorFontLoaded` (`packages/ui/src/components/vector/text-measure.ts`) call `document.fonts.load` and `check` with the font alone, which tests a space. `text-overlay.tsx` loads the font when the editor opens, before any text exists. `healLabelWidth` (`canvas-editor.tsx`) is the one caller that holds the label's text, and it does not pass it.

**Printing doesn't wait for fonts.** `printElement` (`packages/ui/src/lib/printElement.ts`) clones the document and calls `window.print()` after a fixed 450 ms.

**The API image's PDF draws what happens to be installed.** WeasyPrint falls back to fontconfig. Measured in image `api:0.4.1`: the seven Eigen TTFs, DejaVu (a fontconfig dependency), URW base35, and `fonts-droid-fallback` with `fonts-noto-mono`, which arrive through a recommends chain, libvips → ImageMagick → ghostscript (`libgs10-common`), because `docker/api/Dockerfile` installs without `--no-install-recommends`. So Chinese and Japanese print in Droid Sans Fallback, Korean prints as boxes, 😀 prints in DejaVu Sans and 👍 🎉 ✅ 🚀 print as boxes. A Mac dev PDF of the same document draws Apple's fonts and weighs 537 KB against the image's 13.7 KB, so a dev PDF is no evidence of production. What CI's runner falls back to was not checked. The image's HarfBuzz is 10.2 (`libharfbuzz-subset0`, measured).

**Three docs are wrong about that.** The comment above `LINE_HEIGHT` in `apps/api/src/lib/export/sheets/render.ts` and the sheets paragraph of [EXPORT.md](../EXPORT.md#a-sheet-export-recalcs-and-xlsx-carries-cells-charts-and-pictures) say a CJK character takes Noto Sans CJK's line of 1.45; production has no Noto Sans CJK and takes Droid Sans Fallback's 1.309. EXPORT.md's paragraph on SVG fallbacks and the Dockerfile's comment say the image has only DejaVu and URW's.

**The HTML download is almost all font bytes.** `exportHtmlDocument` (`apps/api/src/lib/export/html-document.ts`) embeds whole WOFF2 faces as base64 (`fontFaceCssOf`, `export/fonts.ts`): the required `cssFamilies` its caller's stylesheet draws in, plus each Eigen family the sanitized body names. A doc passes its Normal font and, with code, the monospace (`proseFamilies`, `export/doc/transform.ts`); `sheetsHtmlDocument` (`export/sheets/render.ts`) and `canvasHtmlDocument` (`export/canvas/transform.ts`, slides and drawings) pass Inter. So the golden sheet is 998,258 bytes and the golden deck 1,002,045, nearly all of it Inter's two variable faces. No export embeds STIX Two Math, an emoji or a CJK face. The same HTML goes to WeasyPrint, which subsets on its own (`full_fonts` off, HarfBuzz's subsetter), so the PDF is lean but WeasyPrint parses about 1 MB of base64 for every sheet or deck it prints.

**An equation draws in a different font on each surface.** The editor, quick look and thumbnails draw native MathML in STIX Two Math, the whole 552 KB face. The PDF draws MathJax 4 SVG paths in New Computer Modern (`mathmlToSvg`, `export/math-svg.ts`, `@mathjax/mathjax-newcm-font` through `@mathjax/src`). The HTML download names STIX but embeds no face. Word draws Cambria Math, because the docx writes no math font (`settingsXml`, `export/doc/docx/package.ts`).

**The SVG download and the SVG previews pick faces by a stack's first family.** `canvasImageFaces` (`packages/lib/src/vector/canvas-image.ts`) takes `getFontName` of each run's computed stack, and `downloadCanvasImage` (`packages/ui/src/components/vector/canvas-image.ts`) fetches each face from `bundledFontUrl` and embeds it whole. `injectFontFaces` (`apps/api/src/lib/preview/svg-media-inline.ts`) embeds `fontFaceCssOf(usedEigenFonts(svg))` the same way. A fallback family later in a stack is never embedded; EXPORT.md lists emoji as an accepted limit there ([§ A drawing downloads its own SVG](../EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers)).

**The Office files name fonts.** The docx writes the Eigen family in all four `w:rFonts` slots (`rPrXml`, `export/doc/docx/runs.ts`) and embeds the static TTFs whole. The pptx names the family in `a:latin`, `a:ea` and `a:cs` and embeds nothing. The xlsx names fonts.

**The CSP rules out a font CDN.** The apps send `font-src 'self' data:` (`buildContentSecurityPolicy`, `vite.security-headers.ts`) and exports `font-src data:` (`EXPORT_CSP`, `export/sanitize.ts`). Everything here is self-hosted, so neither changes.

## Measured

Measured on 2026-11-01: fontTools 4.68 and HarfBuzz 15 on a Mac, WeasyPrint 70.0 locally and in the API image 0.4.1, canvas tests in Playwright's Chromium 151, Firefox 157 and WebKit 26.5. "Quoted" sizes come from the GitHub or npm APIs without a download.

**Exports today**, from the golden fixtures (`apps/api/src/test/fixtures/golden-documents.ts`), in bytes:

| Export | HTML | of which font base64 | Faces | PDF |
|---|---|---|---|---|
| Doc, golden | 1,158,729 | 1,138,304 | 3 | 25,109 |
| Doc, all features | 2,277,945 | 2,242,420 | 6 | 79,765 |
| Doc with CJK, emoji, an equation | 1,005,348 | 986,960 | 2 (Inter's two) | 13,729 in the image, 536,641 on a Mac |
| Sheets, golden | 998,258 | 986,960 | 2 (Inter's two) | 16,628 |
| Deck, golden | 1,002,045 | 986,960 | 2 (Inter's two) | 12,265 |

**Emoji**, WOFF2 bytes. e3 is 😀👍🎉; e7 adds 👩‍💻 🇳🇱 👍🏽 ❤️, and every sequence stays one glyph after a cut.

| Font | Format | Whole | e3 cut | e7 cut |
|---|---|---|---|---|
| Noto Emoji, variable 300 to 700 | glyf | 1,051,800 | 3,604 | 8,028 |
| Noto Color Emoji | COLRv1 | 1,996,800 | 3,216 | 8,992 |
| Noto Color Emoji | CBDT | 9,559,404 | 8,944 | 31,396 |
| Twemoji Mozilla 0.7.0 (2022) | COLRv0 | 492,548 | 1,392 | 3,188 |

Google Fonts serves Noto Emoji as 11 static slices, 526 KB in all, 3.9 to 112 KB each, median 51 KB; the slice with 😀 and 👍 is 70 KB. U+200D sits in 7 of the 11 and U+FE0F in 9. One slice also holds `#`, `*`, the digits, U+20E3 and the CJK symbols U+3030, U+303D, U+3297 and U+3299. In the published ranges every RGI sequence, keycaps aside, has all its code points in some one slice, but 92 base code points repeat across slices (❤ sits in 3, 🔥 🎉 ♀ ♂ ➡ in 2), so 1,492 sequences also have a base in another slice, and the engine's pick of slice decides. With the rules in Google's order WebKit breaks ❤️‍🔥 into ❤ and 🔥; in reverse order Firefox breaks 270 sequences. 👪 U+1F46A is in the font but in no published range, and one of the 11 slices is empty against the google/fonts file.

| Emoji format | Chromium canvas | Firefox canvas | WebKit canvas | WeasyPrint 70 in the image |
|---|---|---|---|---|
| COLRv1 | color | color | blank | blank: needs HarfBuzz 13, the image has 10.2 |
| COLRv0 | color | color | color | blank, same reason |
| OT-SVG | blank | color | color | drawn as an image |
| CBDT | color | font rejected | font rejected | drawn as an image |
| Monochrome glyf | drawn | drawn | drawn | drawn |

**Emoji sequences**, of the 2,700 RGI multi-code-point sequences whose code points Noto Emoji maps, drawn as one Noto glyph with the stack `Inter, <emoji family>`, each checked against what HarfBuzz shapes in the whole font:

| Emoji font | Chromium | Firefox | WebKit |
|---|---|---|---|
| Whole Noto Emoji | 1,520 (1,180 in the system font) | 235 (2,465 system) | 2,388 (312 broken) |
| Google's ranges, Google's order | 1,520 (1,180 system) | 234 (2,465 system, 1 broken) | 2,387 (299 broken, 14 system) |
| Closed slices ([§ One registry, coverage by rule](#one-registry-coverage-by-rule)), either order | 1,520 (1,180 system) | 235 (2,465 system) | 2,388 (312 broken) |
| Closed slices with a color table in the text color, either order | 2,700 | 2,700 | 2,388 (312 broken) |

Chromium draws the system's color emoji for every sequence with VS16, and Firefox also for flags, tag flags, skin tones and most emoji-presentation sequences. Both do so with the whole font, so it is not slicing; a color table in the text color, +0.5% bytes, makes both draw Noto ([§ Emoji stay monochrome](#emoji-stay-monochrome)). WebKit's 312 are the 12 keycaps and the ZWJ sequences holding a text-default character plus VS16 (the couples, ❤️‍🔥, ❤️‍🩹, ⛹️‍♀️, 🏃‍♀️‍➡️ and others), the same with the whole font. With the digits repeated in the keycap slice and Inter first, Chromium and Firefox with the color table, and WeasyPrint, draw Noto's keycap whole, and a plain digit stays in Inter.

**CJK.** Google Fonts' slices, WOFF2:

| Region | Slices | Regular, all slices | Median slice | Variable 400 to 700, all slices |
|---|---|---|---|---|
| Simplified Chinese (SC) | 101 | 2.41 MB | 26 KB | 4.50 MB |
| Korean (KR) | 124 | 1.87 MB | 12 KB | 3.51 MB at 100 to 900 |
| Japanese (JP) | 124 | 2.94 MB | 13 KB | 5.47 MB |
| Traditional Chinese (TC) | 108 | 2.30 MB | 22 KB | not measured |

The most frequent Han share slices: 一 的 中 sit in one 41 KB SC slice. SC and KR each ship Latin, Latin Extended, Cyrillic and Vietnamese slices besides their CJK ones. The SC files (static Regular and the variable TTF) map all 86 hiragana, 90 katakana and 43 Bopomofo and no Hangul; KR maps all 11,172 Hangul syllables (fontTools cmaps).

**Our slices**, WOFF2 bytes, cut on Google's ranges by the coverage rule ([§ One registry, coverage by rule](#one-registry-coverage-by-rule)):

| Face | Slices | All slices | Named slice | Google's, for comparison |
|---|---|---|---|---|
| Inter normal, every axis | 7 | 380,544 | latin 104,248 | latin 48,432 (weight axis only, a newer Inter) |
| Inter italic, every axis | 7 | 414,524 | latin 114,608 | |
| Noto Emoji, closed, weights 400 to 700 | 10 | 778,272 | 😀 65,280; 👍 128,392 | static: 525,780; 😀👍 69,648 |
| Noto Sans SC, 100 to 900, no `dlig` | 88 | 4,339,564 | 一的中 61,728 | static Regular: 2,410,336; 一的中 41,328. Variable 400 to 700: 4,499,060 |
| Noto Sans KR, 100 to 900, no `dlig` | 86 | 1,608,940 | Hangul only, as the rule hands Han to SC | static: 1,867,940. Variable: 3,506,124 |

The SC row has no extra slice yet for the 18,106 characters of its font outside Google's ranges. The emoji face with its whole 300 to 700 axis is 2.15 times Google's static slices; at 400 to 700, which holds every weight Eigen draws (400, 450, 525 and 600), it is 27% smaller. The color table adds 0.5%. SC's `dlig` (discretionary ligatures, off by default in CSS) pulls in whole ligature glyphs: the 一的中 slice is 107,932 bytes with every feature. Cutting CJK to 400 to 700 saves only 6%, so CJK keeps its whole axis. A page of Chinese (800 characters) touches 21 SC slices, 1.20 MB; eight short words touch 7, 382 KB. All 281 generated WOFF2 load in Chromium, Firefox and WebKit, the color-table copies included; the 400 to 700 emoji cut was not among them.

**The generated CSS**, one rule per slice: 218 rules (text faces 32, emoji 10, SC 88, KR 86, Excalifont and the math font one each), 139,934 bytes, 40,857 gzipped, 23,807 brotli. Without SC and KR it is 44 rules, 3,415 bytes gzipped: the Han and Hangul slices are frequency sets with long range lists. Today's `fonts.css` is 1,587 bytes.

**Math**, cut to the quadratic formula and Euler's identity (27 code points). The MATH table and every stretchy variant and assembly survive a cut.

| Font | Whole WOFF2 | Cut WOFF2 | License |
|---|---|---|---|
| STIX Two Math 2.13 (bundled) | 551,908 | 11,828 | OFL |
| New Computer Modern Math | 670,964 | 14,064 | GUST |
| Latin Modern Math | 387,484 | 11,040 | GUST |
| Libertinus Math | 379,340 | 7,420 | OFL |

MathJax 4.1.3 font packages, unpacked: `@mathjax/mathjax-newcm-font` 49 MB (installed), `@mathjax/mathjax-stix2-font` 17.3 MB.

**Canvas and font loading**, the same in all three engines: setting `ctx.font` fetches nothing. `measureText` and `fillText` start the fetch of a `unicode-range` face their text needs, but measure and draw the fallback until it has loaded (a width of 40.0 became 50.8 after the load). A face whose range misses the text is never fetched. A `ctx.font` family list of ranged faces falls back per glyph. One trap: a fontTools WOFF2 of an OT-SVG font was rejected by Chromium and Firefox, so every generated WOFF2 is checked in each browser.

**WeasyPrint picks slices by `unicode-range`, but keys a PDF font by its description.** `FontConfiguration.add_font_face` (`weasyprint/text/fonts.py`) writes a face's ranges into a fontconfig `charset` for that face, and in the image WeasyPrint 70 picks among one family's slices by range. But it keys each PDF font by its Pango description (family, style, weight, variations), not its file: `get_pango_font_key` in `weasyprint/pdf/stream.py` hashes the description, and `Font.hash` in `pdf/fonts.py` is the md5 of the description string. So the first slice's file is subset and embedded with every slice's glyph IDs, and Chinese, Korean, IPA and emoji print as other characters. Keyed by file, every glyph prints right and every sequence whole ([§ Every export embeds the slices it touches](#every-export-embeds-the-slices-it-touches)). Pango picks a face per character, not per cluster, so a sequence holds only when its code points sit in one slice: with the skin tones repeated across slices, 👍🏽 printed as 👍 and a swatch. Embedding the 37 SC slices of a 15-page Chinese article adds 2 to 2.5 s to a render that takes 0.5 to 0.7 s with no `@font-face`.

## Design

### Slices are the one form of every face

One vendoring script, `scripts/fonts/build-font-slices.ts`, cuts every bundled face once into slices on Google Fonts' ranges: Inter (seven ranges, Latin to Vietnamese), Source Serif 4 and JetBrains Mono on the ranges Google serves for each, Noto Emoji, and each CJK region on its own. The ranges come from a committed snapshot of Google's css2 CSS, ranges only, with the fetch date and the user agent, and the script reads the snapshot, never the network. That CSS is what Google serves and the one source that covers every face: `nam-files` has no emoji ranges, and its SC strategy is not what Google serves. Published ranges are not cut to a font's cmap, hence the rule's "∩ cmap" ([§ One registry, coverage by rule](#one-registry-coverage-by-rule)).

Four faces leave Google's slicing. Noto Emoji is cut closed, so no sequence spans two slices, and to weights 400 to 700 first, 27% smaller with every weight Eigen draws. SC gets one more slice for the 18,106 characters of its font that Google's ranges leave out, and a coverage code point in no published range, such as 👪, joins a slice. Excalifont (52 KB) and the math font stay one slice each, the math font because a formula's stretchy variants must sit in the face that lays it out. Variable faces stay variable, so one slice draws every weight, Eigen's 600 bold included.

The script shells out to fontTools (`pyftsubset`, and its instancer for the emoji's weights) from a local venv, at vendoring time only, so the repository gains no dependency, and reruns only when a font is updated. The CJK cut names its layout features: every one but `dlig`, which is off by default in CSS and nearly doubles a slice, and which `pyftsubset` can't drop after `'*'`. The emoji cut adds a color table that paints in the text color ([§ Emoji stay monochrome](#emoji-stay-monochrome)). It writes three things:

- the WOFF2 slices, flat in each font's folder under `packages/ui/src/assets/fonts/<font>/`, so `bundledFontUrl`'s `import.meta.glob('../../assets/fonts/*/*.*.woff2')` maps each slice to its hashed Vite URL, and no whole face, which has no label in its name, is emitted;
- the `@font-face` CSS, one rule per slice with its `unicode-range` and `font-display: swap`, which replaces the hand-written `fonts.css`;
- the range data, `FONT_SLICES` in `packages/lib/src/constants/font-slice-data.gen.ts`, React-free: per slice its family, style, weight range, file and `unicode-range`, which `font-slices.ts` reads.

For a fallback font the script fetches the pinned source (URL and SHA-256 in the script). For a text face its input is the WOFF2 the repository has today. Each generated WOFF2 is loaded once in Chromium, Firefox and WebKit before it is committed.

The range data is 370 slices: what a face maps outside Google's ranges is cut into chunks of at most 40 KB, 60 KB for SC, so SC's extra slice is 127 chunks, while KR's rest, the conjoining jamo, stays one 183 KB slice, as jamo compose a syllable only inside one font. More come once Japanese and Traditional Chinese ship. Only the server and the browser's SVG download import it, the download on demand; `constants/fonts.ts`, which every app loads through `getFontFamily`, does not.

### One registry, coverage by rule

`FALLBACK_FONTS` in `packages/lib/src/constants/fonts.ts`, beside `EIGEN_FONTS`: the family and kind of each fallback. The backend imports it through the `constants` subpath ([ARCHITECTURE.md § Package boundaries](../ARCHITECTURE.md#package-boundaries)).

| Entry | Kind | Family | Coverage |
|---|---|---|---|
| Emoji | `emoji` | Eigen Emoji: Noto Emoji, variable 400 to 700, with a color table in the text color | Extended_Pictographic but © ® ™, and the components U+200D, U+FE0F, U+20E3, the skin tones, the regional indicators and the tag characters; of Basic Latin only `#`, `*` and the digits, repeated in the keycap slice |
| Chinese | `cjk` | Noto Sans SC | Han with Extension A and the compatibility ideographs, kana, Bopomofo, CJK Symbols and Punctuation, Halfwidth and Fullwidth Forms, Enclosed CJK, CJK Compatibility |
| Korean | `cjk` | Noto Sans KR | Hangul syllables and Jamo |
| Math | `math` | the editor's math font ([§ Math](#math)) | none in a stack: only the `math` rule names it |

The sources overlap: Extended_Pictographic holds U+3030, U+303D, U+3297 and U+3299 and symbols the text faces have, the CJK regions ship Latin slices, and Google's Latin range for Inter spans U+2000 to U+206F, U+200D included. So each slice's declared range is its published range ∩ its font's cmap ∩ its kind's coverage, minus what an earlier kind claims, in the order emoji, CJK, text faces. The four CJK symbols draw in Eigen Emoji, a CJK font never draws Latin, and no text face claims U+200D (the bundled Inter maps none anyway). The emoji kind takes 24 code points Inter maps (‼ ⁉ ↔ ▶ ⚠ ❤ and others). Only © ® ™ go back to the text faces: every text face maps them and no RGI sequence holds them, while ❤ sits in 199. The rest draw in Eigen Emoji in body text too.

**The emoji slices are cut closed.** Google's emoji ranges repeat 92 base code points across slices, so whether a sequence holds depends on the order of the rules in WebKit, Firefox and Pango ([§ Measured](#measured)). The script joins the base code points that share an RGI sequence into groups, moves each group whole to the slice that holds most of it, and keeps the skin tones in one slice. Within the emoji family only the components (U+200D, U+FE0F, U+20E3, the tags) then repeat, as Google repeats them, and `#`, `*` and the digits sit in the keycap slice as well as in the text faces, as Google has them. The planner throws at vendoring time when an RGI sequence still spans two slices (`closeSequences` in `scripts/fonts/plan-slices.ts`), and `packages/lib/src/test/constants/font-slices.test.ts` checks that ranges of different families are disjoint but for those keycap bases, and that within an emoji or CJK face only the components repeat. Nothing checks the chunks a heavy rest is cut into afterwards; the emoji's rest is one emoji today. So the order of the fallbacks in a stack never decides a glyph, and the text face, first in every stack, keeps a plain digit.

**A keycap draws whole, but not in WebKit.** Chromium, Firefox and WeasyPrint draw Noto's 1️⃣ whole from the keycap slice and a plain 1 in the text face. WebKit draws 1️⃣ as a 1 and a lone keycap frame, and it breaks the ZWJ sequences that hold a text-default character plus VS16, such as the couples, ❤️‍🔥 and 🏃‍♀️‍➡️: 312 of the 2,700 RGI sequences Noto Emoji maps, the 12 keycaps included. It does the same with the whole font, so it is how WebKit treats an emoji font that isn't the system's, not the slicing. It stays a documented limit.

A symbol no rule names (→, a box-drawing line, ①) stays with the text font and then the system, as today.

### One stack builder

One builder in `constants/fonts.ts`, reached through `getFontFamily(name)`, gives every stack: the bundled family, then the fallback families in registry order, then the system fallbacks and the generic family. A name Eigen doesn't bundle comes first, before the stack of the bundled font it maps to, so its digits don't fall to the emoji face's keycap slice. It is the one source:

- `getFontFamily` and `fontNameToCss`, so every doc's Normal, mark, canvas layer, SVG label and `vectorFontString` get it at once.
- `FONT_STACK_SANS` and `FONT_STACK_MONO` (`apps/api/src/lib/document/font-stacks.ts`), and the per-cell family in `buildCellStyle` (`export/sheets/render.ts`).
- The sheet: `getFontSet` puts the builder's stack in `ctx.font`, and `getFontStyleByCell`, `inline-string.ts` and the font menu call `getFontFamily`.
- CSS, which can't import TypeScript: `globals.css` spells the `--font-*` tokens and `--font-math` as literals, and `shadow-content.tsx` and the `math` rule read them. A drift test, `packages/ui/src/test/styles/font-tokens.test.ts`, compares each literal with the builder's stack and prints the line to paste.

`getFontName` and `normalizeFontFamilyMarks` match only a stack's first family, so a stack with the fallbacks collapses to its name as the old one does. A test pins both forms. A pre-canon doc that still stores a whole stack passes through `fontNameToCss` unchanged, so it draws the system fallbacks until an editable load collapses it ([TYPOGRAPHY.md § Docs and the canvas store a font name](../TYPOGRAPHY.md#docs-and-the-canvas-store-a-font-name-never-a-css-stack)).

The sheet's system CJK list (PingFang SC, Hiragino Sans GB, Heiti SC, Microsoft YaHei, WenQuanYi Micro Hei) went with the CJK slices.

### The browser fetches slices

The DOM surfaces get lazy loading from the browser: Docs, Stickies, Chat, Mail's own UI, the canvas layers, quick look and the thumbnails. Text a page draws in Inter's Latin fetches one slice, an emoji one Eigen Emoji slice, a page of Chinese a few dozen SC slices. Our variable slices are up to 1.8 times Google's static ones ([§ Measured](#measured)). What a canvas or a print measures needs a wait:

- **The sheet grid** listens to `document.fonts`' `loadingdone`, clears `measureTextCache` and `textHeightCache`, and redraws whole. Drawing a cell starts its slice's fetch on its own (measured). A commit must stay synchronous and one undo step, so it can't await a load; instead the cell editor and the formula bar load the cell's font for the text as it is typed (`loadCellFont`), and the commit that writes `cfg.rowlen` measures the real face ([SHEETS.md](../SHEETS.md#the-grid-redraws-whole-when-a-font-slice-loads)).
- **The canvas measurer**: `loadVectorFont` and `isVectorFontLoaded` take the text, `text-overlay.tsx` loads again with the text at commit, and `healLabelWidth` passes the label's text.
- **Printing**: `printElement` awaits `document.fonts.ready` after the clone instead of a fixed 450 ms, and the copy's images, 3 s at most.
- **The SVG download**: `downloadCanvasImage` already awaits `document.fonts.ready` after its layout, so the slices its text needs have loaded before it reads the characters' boxes.

### Every export embeds the slices it touches

One function in `font-slices.ts`, `slicesFor(codePoints, families)`, answers the slices of those families whose range meets the code points. The server and the browser call it, so every export picks the same way:

- **The HTML download** and the HTML handed to WeasyPrint: `exportHtmlDocument` takes the code points from the body it wraps and embeds the slices `slicesFor` picks, as `data:` URIs.
- **The server's SVG previews**: `injectFontFaces` takes the code points of the SVG's text.
- **The browser's SVG download**: `downloadCanvasImage` takes each run's code points and family, fetches each slice from `bundledFontUrl` and embeds it.

The code-point set is the document's text, each letter's other case (CSS caps), printable ASCII always, and what the export's CSS draws itself: list markers, roman numerals, leaders, page and footnote numbers. The families are the ones the export uses (a doc by `usedFamilies`, a sheet by its cells' fonts, a canvas by its elements'), plus every fallback family and, where the body has a `<math>`, the math font. `slicesFor` ignores the components: U+200D, VS16, the tags and U+20E3 never select a slice on their own, or every emoji slice is embedded (10 slices and 1.07 MB on a mixed page, against 6 and 460 KB). The keycap digits select the keycap slice only beside U+20E3. The server reads a slice from its repository path, which the image has through `COPY . .` (the API runs from source), with `Bun.resolveSync` through the UI package's one `./assets/fonts/*` export.

WeasyPrint gets the same slices with their `unicode-range`, picks among them by range and subsets the PDF as it does today. WeasyPrint 70 keys a PDF font by its Pango description, not its file, so on its own it prints every slice of a family with the first slice's glyphs ([§ Measured](#measured)). A shim of about 12 lines in `apps/api/src/lib/export/weasyprint-render.py` keys fonts by file: it wraps `get_pango_font_key` in `weasyprint.pdf.stream` with the md5 of the face's blob, suffixes `Font.hash` and the font's name with the file's md5, and sets `Font.colr` to false so the emoji print their outlines. It reaches into WeasyPrint the way `band_margins` in the same file already does. A test renders Chinese, Korean, bold and emoji slices of one family and checks the glyphs printed, so an upgrade that breaks the shim fails loudly. An upstream WeasyPrint issue is drafted for the owner's review. So the PDF draws the app's glyphs from the slices in the HTML, and no font the PDF needs goes into the Dockerfile.

The build found three more things the shim and the slices carry ([EXPORT.md](../EXPORT.md#weasyprint-prints-the-slices-through-a-shim-in-its-render-script)). The shim digests each face once per render, as `add_font` asks for a key on every text box. It gives each slice file a fontconfig font version of its own, because the slices of one family tie in fontconfig's sort, and on macOS and musl, whose sort is not stable, Pango skipped a slice and printed `.notdef`. And every slice file holds the space and the no-break space without declaring them, because Pango keeps a space between two Chinese words in their font and printed a missing glyph half an em wide where the slice had none.

### What slices cost against an exact cut

| Case | Embedded slices | Exact cut |
|---|---|---|
| A lone emoji | its slice, 65 KB for 😀, 128 KB for 👍 | about 4 KB |
| One Chinese word | about 62 KB | about 4 KB |
| Inter's Latin, variable | about 104 KB | about 72 KB |
| One equation | the whole math face, 671 KB | about 14 KB |
| A typical download, estimated | about 305 KB for a sheet or deck, 375 KB for the golden doc, which embeds Inter's italic Latin too | about 100 KB |

Against about 1.0 MB for a sheet or deck and 1.16 MB for the golden doc today. The table counts WOFF2 bytes; base64 adds a third. A later optional step can cut the touched slices exactly at export time, with the slices themselves as input, so there is still one form of each face. It would need a subsetter on the export path, the step this proposal drops.

### CJK

Han unification gives one code point regional forms: 骨 or 直 draw differently in Chinese, Japanese and Korean type. v1 draws all Han in one default region, Simplified Chinese, and Hangul in Korean. Han and Hangul are disjoint, so their order in a stack doesn't matter. SC maps every kana and Bopomofo, so Japanese draws in SC's kana and Chinese forms until a region choice exists.

**Why no `:lang()`**: `--font-sans` resolves its `var()` at `:root`, so an element's `:lang(ja)` can't reorder a stack it inherits; most text gets a TypeScript-built literal, not a token; the apps and every export write `lang="en"`; and a canvas has no `:lang()`.

**Japanese and Traditional Chinese, later**: a heuristic at the document's root, kana → Japanese, Bopomofo → Traditional Chinese, computed from the text and never stored, puts that region first in the builder's stack. It needs the JP and TC slices and the owner's word ([§ Open questions](#open-questions) 5).

### Math

The claim is the same glyphs, not the same layout: native MathML in the browser and MathJax SVG in the PDF still differ in spacing, stretchy assembly and line breaking.

- **Editor, panel, quick look, thumbnails**: native MathML in the math font, the whole face, fetched only where a `<math>` draws, as today.
- **HTML download**: the math face, embedded where the body has a `<math>`. This closes "What equations still lack" (4) in [DOCS-TODO.md](../DOCS-TODO.md).
- **PDF**: MathJax 4 SVG paths in the font of the MathJax font package.
- **Word**: Cambria Math, no change. Word draws math only in an installed font with a MATH table.

Two ways to make the PDF and the editor draw the same glyphs ([§ Open questions](#open-questions) 3): (a) the editor's default becomes New Computer Modern Math (671 KB WOFF2, GUST, already allowed), with no new package, and the PDF stays as it is; (b) the editor keeps STIX Two Math and the PDF adds `@mathjax/mathjax-stix2-font` (17.3 MB unpacked, server only). This proposal recommends (a) for v1; the per-doc math font needs one MathJax package per extra face anyway.

**A math font per doc** is a later phase, unchanged from `PROPOSAL_MATH_FONTS.md` but for its registry: the proposed `EIGEN_MATH_FONTS` (New Computer Modern Math, STIX Two Math, Fira Math) become the registry's `math` entries, each one slice. A doc stores the name in one `mathFont` key in its `style` map (`STYLE_ROOT`, `normal-style.ts`), apart from `NormalStyle`, read by one `readMathFont` that answers a listed name or the default. `normalStyleProperties` sets `--math-font` beside the `--doc-*` properties, and the `math` rule reads `var(--math-font, var(--font-math))`. `mathmlToSvg(mathml, font)` keeps one MathJax document per font. A docx import reads `m:mathPr`'s `m:mathFont` from `settings.xml`, and Cambria Math leaves the key empty. A future canvas equation stores `mathFont` on its element.

### Emoji stay monochrome

Every surface draws one form of the emoji slices, monochrome in the text color: Noto Emoji's outlines with a COLRv0 table whose one layer per glyph is the glyph itself in palette entry 0xFFFF, the text color. The table is there because Chromium and Firefox skip a font without one for VS16 sequences, flags and skin tones and draw the system's color emoji, even with the whole font: of the 2,700 RGI sequences Noto Emoji maps, Chromium draws 1,180 and Firefox 2,465 in the system's font. With the table both draw all 2,700 in Noto, in the CSS `color`, for 0.5% more bytes. WeasyPrint 70 with the image's HarfBuzz 10.2 prints a COLR face blank, so the shim turns its color path off and it prints the outlines ([§ Every export embeds the slices it touches](#every-export-embeds-the-slices-it-touches)).

The CSS family is "Eigen Emoji", never exactly "Noto Emoji": fontconfig gives that name an emoji alias, and in WeasyPrint it then takes the ASCII digits from Inter.

Real color stays out. The owner chose monochrome Noto Emoji on 2026-10-30, and the measurements back it: only outlines draw the same on all three canvases and in the PDF. WeasyPrint 70 draws COLR only with HarfBuzz 13 or later, and the image has 10.2. Safari draws no COLRv1. Firefox and Safari reject CBDT. Chrome's canvas draws no OT-SVG. Every color font tested has empty outlines in its base glyph, so an engine that lacks its format draws nothing at all. Revisit when the image's HarfBuzz reaches 13.

### The image's own fallbacks

Once Eigen's slices cover CJK and emoji, the image's Droid Sans Fallback and Noto Mono only make production draw differently from dev and CI. `--no-install-recommends` in `docker/api/Dockerfile` drops that recommends chain, so every environment draws the same. It is an apt change and needs the owner's yes ([§ Open questions](#open-questions) 4). librsvg's PNG fallbacks in Office files and uploaded-SVG thumbnails still draw from fontconfig, and sharp's libvips reads no WOFF2. So the image decompresses the SC and KR slices to TTF as it builds, with the fontTools already in WeasyPrint's venv, and registers them with fontconfig. The image also has no Debian libvips or ImageMagick, which sharp, bundling its own libvips, never used.

### Coordination

The branch `sheets-120fps` reworked the sheet canvas renderer (`packages/sheet/src/state/canvas.ts`, `state/render/*`, `components/Sheet/index.tsx`). Once it merged, this program built the grid's `loadingdone` redraw and the typed-text load itself ([§ The browser fetches slices](#the-browser-fetches-slices)).

## Phases

0. **Spike and quick win** (S), done. The spike measured our slices, sequences across slices in three engines and in WeasyPrint, and the generated CSS ([§ Measured](#measured)). The quick win: every export passes the families its stylesheet draws in, so the golden sheet and deck dropped from 2.25 MB to about 1.0 MB. Its doc fixes (the `LINE_HEIGHT` comment, EXPORT.md's sheets and SVG-fallback paragraphs, the Dockerfile comment) go with phases 1 to 3, and clearing `textHeightCache` went with the grid's redraw.

Phases 1 to 3 are built, together, on branch `fonts-fallback`.

1. **Text faces sliced, exports embed touched slices** (M, about four days). The vendoring script and its css2 range snapshot, `font-slices.ts` and `slicesFor`, the generated `fonts.css`, the text faces' slices, every export path above embedding slices, and the WeasyPrint shim with its glyph test. Yes: the committed slices (question 1).
2. **Emoji and math through the registry** (L, seven to ten days). `FALLBACK_FONTS`, the builder in all seven places, the token literals and their drift test, the closed emoji slices in their one color-table form, the math font through the registry, the measurer's text, `printElement`, the three-engine check of every slice, the licenses page (`apps/index/scripts/build-licenses.ts`), TYPOGRAPHY.md, EXPORT.md, DOCS.md and the CHANGELOG. The grid's `loadingdone` redraw and the typed-text load came after the `sheets-120fps` work merged ([§ Coordination](#coordination)). Yes: the emoji slices (question 1) and the math option (question 3).
3. **CJK: SC and KR** (M, about three days). The two region entries and their slices, SC's extra slice, the sheet's system CJK list removed, `LINE_HEIGHT`'s comment restated for Noto Sans CJK. Yes: the CJK slices (question 2). Then `--no-install-recommends` (question 4).
4. **Japanese and Traditional Chinese** (M, about three days). The root-level script heuristic, the JP and TC slices. Yes: question 5 and the slices.
5. **A math font per doc** (M, about four days). As in [§ Math](#math). Yes: the stored format and each MathJax font package (question 6), and the owner's call on the picker's place.

## Tests that move

- About ten test files pin a stack as an expected output, among them `normal-style.test.ts`, `doc-page-box.test.tsx`, `editor.test.tsx`, `paste.test.ts`, `doc-export.test.ts`, `prose-css.test.ts`, `inline-string.test.ts`, `format-toolbar-editing.test.tsx` and `packages/lib/src/test/constants/fonts.test.ts`. Find the rest with `git grep -E "'(Inter|Source Serif 4|JetBrains Mono|Excalifont)', ?(sans-serif|serif|monospace|cursive)"` and a grep for `FONT_STACK_` and `system-ui` in the test folders.
- `apps/api/src/test/export/fonts.test.ts` and the drift test in `packages/ui/src/test/components/vector/canvas-image.test.ts`, which compare `fonts.css` with `FONT_FACES` and then compare the generated CSS with the range data.
- The CI PDF pixel tests (`sheets-pdf.test.ts`, `canvas-pdf.test.ts`) and every test that measures an HTML export of the golden fixtures.

## Decisions

- **Monochrome Noto Emoji**, not a color emoji font. (Owner, 2026-10-30.)
- **The apps draw the same emoji font as the exports**, so an emoji looks the same everywhere in Eigen. (Owner, 2026-10-30.)
- **The apps draw WOFF2**, like every other bundled face. The slices are WOFF2. (Owner, 2026-10-30.)
- **The math font is stored with the document**, chosen from Eigen's own list. (Owner, 2026-10-29.)
- **Fonts under the GUST Font License are fine** to ship beside the OFL ones. (Owner, 2026-10-29.)
- **Commit the slices of every face to git.** fontTools runs from a local venv, only when the vendoring script reruns, and enters no `package.json`, Dockerfile or CI image. (Owner, 2026-11-01.)
- **CJK ships as variable fonts, Simplified Chinese and Korean now.** (Owner, 2026-11-01.)
- **Han draws in Simplified Chinese** by default. (Owner, 2026-11-01.)
- **New Computer Modern Math becomes the editor's default math font**, option (a), so the editor draws the PDF's glyphs. No `@mathjax/mathjax-stix2-font`. (Owner, 2026-11-01.)
- **`--no-install-recommends` in `docker/api/Dockerfile`**, after the CJK phase, once what librsvg and libvips need is checked. (Owner, 2026-11-01.)
- **Japanese and Traditional Chinese detection waits**, as a backlog row. (Owner, 2026-11-01.)
- **A math font per doc (`mathFont`) waits.** This program changes no stored format. (Owner, 2026-11-01.)
- **Emoji are monochrome Noto Emoji**, reconfirmed. (Owner, 2026-11-01.)
- **No `harfbuzzjs`.** (Owner, 2026-11-01.)
- **Mail's reading pane keeps a message's own inline fonts**, so its emoji and CJK draw in the system's fonts. (Owner, 2026-11-01.)
- **WeasyPrint keys PDF fonts by file, through a shim in our `weasyprint-render.py`** of about 12 lines: it wraps `get_pango_font_key` with the md5 of the face's blob, suffixes `Font.hash` and the name with the file's md5, and sets `Font.colr` to false. A test renders Chinese, Korean, bold and emoji slices of one family and checks the glyphs printed, so an upgrade that breaks it fails loudly. An upstream WeasyPrint issue is drafted for the owner's review, never posted by an agent. Rejected: per-slice family names in the PDF's HTML only, per-slice names everywhere, and a patched system package. (Owner, 2026-11-01.)
- **One color-table form of the emoji slices everywhere**, the apps, the PDF and the HTML download: a COLRv0 "foreground" copy that paints in the text color, so emoji are monochrome in the text color on every surface. The CSS family is "Eigen Emoji", never exactly "Noto Emoji". Rejected: two forms (+1.08 MB in git), and the system's color emoji for VS16, flags and skin tones in Chromium and Firefox. (Owner, 2026-11-01.)
- **Of the symbols Inter has, only © ® ™ go back to the text faces.** ❤ stays with the emoji font, as it is in 199 RGI sequences. (Owner, 2026-11-01.)
- **Seven implementation rulings.** Google's ranges come from a committed css2 snapshot. The emoji slices are cut closed, so no sequence spans two. The emoji keep weights 400 to 700. The CJK slices drop `dlig`. `slicesFor` ignores the joiner, VS16, the tags and U+20E3. SC gets an extra slice for the 18,106 characters Google's ranges leave out. WebKit's 312 broken sequences, the same with the whole font, are a documented limit. (Owner, 2026-11-01.)

## Open questions

The owner answered all eight on 2026-11-01, each as recommended, and the three the spike raised ([§ Decisions](#decisions)). The eight stay here for their sizes and alternatives.

1. **Commit the WOFF2 slices of every face** (phases 1 and 2). Size: the text faces' slices, about the 1.7 MB of their whole WOFF2s; Noto Emoji's slices 778 KB at weights 400 to 700 (Google's static ones are 526 KB). Pulls in: binaries in git, rewritten on a font update, and fontTools from a venv when the script runs. Simpler: fetch them at build time, which needs the network in every build. Recommended: commit, as every bundled font is.
2. **Commit the CJK slices, variable or static** (phase 3). Size, variable: SC 4.34 MB in 88 slices plus its extra slice, KR 1.61 MB (Hangul only), JP 5.47 MB as Google serves it and TC later. Static Regular instead: SC 2.41 MB, KR 1.87 MB, but 600 draws as a faked bold, and adding Bold doubles it. Pulls in: about 6 MB of binaries for SC and KR, and every CJK page fetches its slices. Simpler: keep the system's CJK fonts. Recommended: variable, SC and KR now.
3. **The math font** (phase 2). (a) New Computer Modern Math as the editor's default: 671 KB, no package, the PDF as today, but the editor's equations change look. (b) Keep STIX Two Math and add `@mathjax/mathjax-stix2-font`: 17.3 MB unpacked, server only, a package yes. Simpler: leave the PDF in New Computer Modern and the editor in STIX. Recommended: (a).
4. **`--no-install-recommends` in `docker/api/Dockerfile`** (after phase 3). Size: drops Droid Sans Fallback, Noto Mono and ghostscript's other recommends from a 2.78 GB image. Pulls in: a check that libvips, ffmpeg and Pango keep what Eigen uses, and librsvg's PNG fallbacks lose CJK. Simpler: keep the recommends, so production differs from dev and CI. Recommended: yes, once Eigen's slices cover CJK and emoji.
5. **The Japanese and Traditional Chinese heuristic** (phase 4). Size: M, plus JP 5.47 MB and TC slices. Pulls in: a guess from the text that can be wrong for a document mixing scripts; nothing stored. Simpler: SC forms for all Han, as v1 draws. Recommended: build it when a user asks for Japanese.
6. **The per-doc `mathFont` key** (phase 5). Size: M, a stored format, and one MathJax font package per extra face (`@mathjax/mathjax-fira-font` is 16 MB). Pulls in: the style-map key, `readMathFont`, a picker whose place is open, and whether Word draws an embedded math font. Simpler: one math font for every doc. Recommended: wait until a user asks.
7. **`harfbuzzjs`** (no phase). 1.3 MB unpacked, a 684 KB wasm, MIT. It would cut in the browser or for the exact-cut step. Simpler: slices, which need no subsetter. Recommended: no; no phase needs it.
8. **Mail's reading pane.** A message's own inline `font-family` skips the tokens, so its emoji and CJK draw in the system's fonts. Size: S to append the builder's fallbacks to every stack a message spells, which rewrites sender CSS. Simpler: accept it. Recommended: accept it.

## Risks

- **Sequences in WebKit.** WebKit breaks 312 of the 2,700 RGI sequences, the keycaps and the ZWJ sequences that hold a text-default character plus VS16, with the whole font as with the slices. The closed slices break nothing more in any engine.
- **The shim reaches into WeasyPrint.** An upgrade can move `get_pango_font_key` or `Font`, and the PDF then prints wrong characters, not boxes. The glyph test fails first.
- **A color-table glyph under other paint.** How an emoji draws under `-webkit-text-stroke`, a gradient fill or `background-clip: text` is unchecked.
- **Canvas flash.** A cell or label draws in the system font until its slice arrives, then redraws, as DOM text does with `swap`.
- **CSS size.** 370 `@font-face` rules ship in every app's stylesheet, the index app's included: about 253 KB, 62 KB gzipped, more with every region. Without CJK they are 68 rules, about 6 KB gzipped.
- **Downloads larger than a cut.** A CJK document embeds dozens of slices. The doc with CJK, emoji and an equation grows from 1.0 MB to about 1.5 MB, as it now embeds what printed as boxes, and the whole math face is 0.9 MB of that as base64. WeasyPrint parses them all, 2 to 2.5 s more for 37 SC slices; its PDF stays subset.
- **Line heights move.** Where a CJK character prints, its line becomes Noto Sans CJK's instead of Droid Sans Fallback's, so a sheet's PDF can print more pages than `printedPages` charged, as its comment says.
- **Coverage.** Noto Emoji covers Unicode Emoji 18.0; a newer emoji falls to the system font until the script reruns.
- **A text symbol changes look.** A symbol in the emoji coverage draws in Eigen Emoji everywhere, which is the goal: ☺, which the text font lacks, and ‼ ↔ ▶ ❤, which Inter has. Only © ® ™ stay in the text face.

## Options compared

| Option | Why not |
|---|---|
| System fonts only, as today | Differs per OS, and the API image prints boxes for Korean and most emoji |
| Whole fallback fonts in the browser | A CJK face is 6 to 16 MB per page, the emoji face 1 MB |
| A font CDN | The CSP allows only `'self'` and `data:`, and every self-hosted install would call a third party |
| An exact cut per export with fontTools | Python in the HTML download, a cut cache for previews and source fonts in the image: a second form of each face for about 100 KB less per download |
| `harfbuzzjs` for the exports, as `PROPOSAL_EMOJI_FONT.md` proposed | A new package and a second subsetter, where slices need none |
| `:lang()` per region | Can't reach the TypeScript-built stacks or a canvas, and every page says `lang="en"` |
| Color emoji | Blank in WebKit or in the PDF for every real color format; the emoji's color table only paints the text color ([§ Emoji stay monochrome](#emoji-stay-monochrome)) |
