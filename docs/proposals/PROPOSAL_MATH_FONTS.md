# Proposal: a document chooses the font its equations draw in

This proposal lets a doc choose the typeface of its equations from a short list of math fonts, and gets every surface to draw the same one: the editor, the PDF, the HTML download and the previews. The same list and the same reader serve Slides and Vector when they get equations.

**Status:** not built, proposed. [DOCS-TODO.md](../DOCS-TODO.md) has its row under Features. The owner decided on 2026-10-29 that Eigen stores the math font with the document and that fonts under the GUST Font License are fine to ship ([§ Decisions](#decisions)). The stored format and each MathJax font package still need the owner's yes before they are built ([§ Open questions](#open-questions)). What this proposal says about the code was true on 2026-10-29, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: Every equation draws in STIX Two Math, set by one CSS rule, and the PDF draws them in New Computer Modern, because it renders through MathJax, which brings its own font. This proposal adds one list of math fonts, `EIGEN_MATH_FONTS`, apart from the text fonts, with three entries: STIX Two Math, New Computer Modern Math and Fira Math. A document stores the name, never a CSS stack, and one reader accepts only names on the list. A doc keeps it as one `mathFont` key in its style map, beside the Normal text, as Word keeps one math font per document. A future canvas equation keeps it on the element, as a canvas text box keeps its font. One CSS variable carries it to the `math` rule, and the PDF picks the matching MathJax font. No database migration. Phase 1, the PDF in STIX Two Math, is about half a day; phase 2, the choice in Docs, about four days.

## Goals

1. An equation draws in the same font in the editor, the Equation panel, quick look, the Drive thumbnail, the HTML download and the PDF.
2. A doc's owner can switch all of its equations between a classic serif, the LaTeX look and a sans-serif, in one place.
3. Slides and Vector reuse the list, the reader and the drawing path when they get an equation element, with nothing to redesign.
4. A document never stores a CSS stack, so a peer can't write one into the page's CSS.

## Non-goals

- A font per equation in a doc. Word has one math font per document, Google Docs none, and nobody mixes math fonts on one page. A per-equation font means touching every equation to change a doc's look.
- Text fonts for math. Math layout needs an OpenType MATH table, which Inter and Source Serif 4 don't have. Upright text inside an equation (`\text{…}`) keeps drawing in the math font.
- The math font in the Word download. Word draws math only in a font installed on the reader's machine, in practice Cambria Math ([§ Word](#word-keeps-its-own-math-font)).
- An equation element on the canvas. That is a design of its own; this proposal only fixes the field it stores and the path it draws through.

## Current state

**One CSS rule draws every equation.** `eigen-prose.css` sets `math { font-family: "STIX Two Math", math; }`, and `fonts.css` declares the face from `packages/ui/src/assets/fonts/stix-two-math/` (OFL, 552 KB woff2). It is no `EIGEN_FONTS` name and no `FONT_FACES` entry, and the `/licenses` page lists it beside the text fonts ([DOCS.md](../DOCS.md#every-equation-draws-in-stix-two-math-with-css-for-what-chrome-leaves-out)).

**The PDF draws a different font.** WeasyPrint draws no MathML, so `mathmlToSvg` (`apps/api/src/lib/export/math-svg.ts`) turns each equation into SVG paths with MathJax 4. MathJax uses its default font, New Computer Modern, from `@mathjax/mathjax-newcm-font`, which `@mathjax/src` depends on. So a PDF's equations look different from the editor's.

**The HTML download embeds no math font.** `fontFaceCssOf` (`apps/api/src/lib/export/fonts.ts`) embeds only `FONT_FACES`, so an HTML download draws equations in the reader's own math font ([DOCS-TODO.md](../DOCS-TODO.md), "What equations still lack" (4)).

**A doc already keeps its look in a style map.** The root `Y.Map` named `style` (`STYLE_ROOT`, `packages/lib/src/docs/eigendoc/normal-style.ts`) holds the Normal text's font, size, spacing and colour, one key each. `readNormalStyle` reads it to known values, and `normalStyleProperties` hands it to `eigen-prose.css` as `--doc-*` custom properties on the editor's `[data-document]`, the previews' page and the exports' `.page`. The root is in the doc's `yjsRoots`, so undo and version restore take it along ([DOCS.md](../DOCS.md#a-doc-stores-its-normal-text-in-a-style-map-beside-its-page)).

**The canvas stores a font per element.** A rich-text box stores an `EIGEN_FONTS` name in `fontFamily`, and `read-fields.ts` accepts only a name on the list ([TYPOGRAPHY.md](../TYPOGRAPHY.md#docs-and-the-canvas-store-a-font-name-never-a-css-stack)). Neither Slides nor Vector has an equation today.

**Word gets no math font.** `settingsXml` (`apps/api/src/lib/export/doc/docx/package.ts`) writes no `m:mathPr`, so Word draws in its default, Cambria Math. `@workspace/math` ignores `m:mathPr` on purpose: the tree has no slot for document-wide settings ([MATH.md](../MATH.md)).

**MathJax ships a font package per typeface.** Each is Apache-2.0 for MathJax's data and carries the font's own license for the glyphs. Sizes on npm at 4.1.3, unpacked: `mathjax-stix2-font` 17 MB, `mathjax-fira-font` 16 MB, `mathjax-modern-font` (Latin Modern) 19 MB, `mathjax-newcm-font` 49 MB (installed already). They are server-side only: the API build keeps `@mathjax/src` external.

## Design

### One list of math fonts

`EIGEN_MATH_FONTS` in `packages/lib/src/constants/fonts.ts`, apart from `EIGEN_FONTS`:

| Name | Look | License | Web font | MathJax package |
|---|---|---|---|---|
| STIX Two Math | Times-like serif, the default | OFL | bundled today | `@mathjax/mathjax-stix2-font` (new) |
| New Computer Modern Math | The LaTeX look | GUST Font License | new woff2 | `@mathjax/mathjax-newcm-font` (installed) |
| Fira Math | Sans-serif, beside Inter | OFL | new woff2 | `@mathjax/mathjax-fira-font` (new) |

Each entry holds its name, its CSS stack and its MathJax font. New Computer Modern Math is the LaTeX choice over Latin Modern Math because the PDF already draws it, so it needs no new MathJax package.

It is a list of its own, not more `EIGEN_FONTS` entries. A text font picker must not offer a math font, a math picker must not offer Inter, and `EIGEN_FONTS`' order is load-bearing for sheets. The order of the math list isn't: a document stores the name. The default is the first entry, `DEFAULT_MATH_FONT`.

`readMathFont(value: unknown): string` is the one reader: a name on the list, or the default. Every surface that reads a stored math font calls it, as `readNormalStyle` reads the text font.

The two new web fonts follow [TYPOGRAPHY.md § A new font touches six places](../TYPOGRAPHY.md#a-new-font-touches-six-places), minus the parts only text fonts need (`FONT_METRICS`, `lineHeight`, the docx's static faces). Their faces join `FONT_FACES` and `FACE_PATHS`, so `fontFaceCssOf` can embed them in an HTML download. Their license files go in their folders (`OFL.txt`, and the GUST Font License text for New Computer Modern), and the `/licenses` page lists all three. TYPOGRAPHY.md stops saying every bundled font is OFL.

### Where a document stores it

**A doc** stores one `mathFont` key in its style map. It is a key of its own, read by `readMathFont`, not a field of `NormalStyle`: it is not part of Normal text, and Format › Paragraph styles › Update 'Normal text' to match leaves it alone. An empty key draws STIX Two Math, so every existing doc looks as it does today. Undo and version restore cover it already, through the style root. An older build ignores the key and draws STIX Two Math, which loses nothing. An equation pasted into another doc takes that doc's font, since the MathML holds none.

**A canvas equation**, when it exists, stores `mathFont` on its element, read by `readMathFont` in `read-fields.ts`, as a text box's `fontFamily` is. The canvas has no document-wide text settings, and a slide's equation may sit beside text in any font.

### One way to draw it

**In the browser**, the `math` rule becomes `font-family: var(--math-font, "STIX Two Math"), math`. The doc sets `--math-font` beside the `--doc-*` properties, where `normalStyleProperties` already reaches the editor, the previews and the exports, and only when it is not the default, as those are. The Equation panel's preview sits outside `[data-document]` and sets the same variable from the style map. A canvas equation's layer sets it from its element, in the live canvas and the server compositor alike.

**In the PDF**, `mathmlToSvg(mathml, font)` keeps one MathJax document per math font, loaded on first use as today. MathJax's SVG output takes a font through its font data class; check the exact option against MathJax 4's docs when building it. The doc export passes the doc's `readMathFont` value. A drawing's SVG download, which has to draw an equation without a browser, would use the same function.

**In the HTML download**, the export embeds the doc's math font face beside its text fonts. This closes "What equations still lack" (4).

### Word keeps its own math font

A docx export writes no math font: Word draws math only in an installed font with a MATH table, and a reader without STIX Two Math gets Cambria Math however the file names it. Whether Word draws an embedded math font (`w:embedTrueTypeFonts` is on already) is open question 4. A docx import reads `m:mathPr`'s `m:mathFont` from `settings.xml` in the doc reader, not in `@workspace/math`: one of the three names becomes the doc's `mathFont`, and anything else, Cambria Math included, leaves the key empty.

## Phases

1. **The PDF draws STIX Two Math** (S, about half a day). Add `@mathjax/mathjax-stix2-font`, give `mathmlToSvg` its font, and update DOCS.md, which names the PDF's font as a gap. No stored-format change.
2. **A doc chooses its math font** (M, about four days). The list and its reader, the two web fonts and their licenses, the style map key, the CSS variable on every surface, the PDF per font, the HTML embed, the docx import, the picker, tests, a help-center line in `docs/equations` and a CHANGELOG entry. Adds `@mathjax/mathjax-fira-font`.
3. **Slides and Vector** (with the canvas equation element). The `mathFont` field and its reader. Everything else comes from phase 2.

## Decisions

- **Eigen stores the math font** with the document, chosen from its own list, rather than leaving it to the reader's browser. (Owner, 2026-10-29.)
- **Fonts under the GUST Font License are fine** to ship beside the OFL ones. It is the LaTeX Project Public License 1.3c with a request, not binding, to rename a changed font. (Owner, 2026-10-29.)

## Open questions

1. **The stored format.** A `mathFont` key in a doc's style map, and the same field on a future canvas equation element. Needs the owner's yes.
2. **The packages.** `@mathjax/mathjax-stix2-font` in phase 1 and `@mathjax/mathjax-fira-font` in phase 2, each about 16 to 17 MB unpacked on the server and in the Docker image. Each needs the owner's yes. Without them, the editor could switch its default to New Computer Modern Math instead, which the PDF draws already.
3. **Where the picker sits.** A Font row in the Equation panel that says it applies to the whole document, as Word's equation options do, or an item under Format. A product choice for the owner.
4. **Word and an embedded math font.** Check in Word desktop and Word for the web whether an embedded STIX Two Math draws an equation. If it does, the docx writes `m:mathFont` and embeds the face.

## Risks

- **Download size.** The two new web fonts add a few hundred KB each, but a browser fetches a face only when a page uses it, so a doc in STIX Two Math loads nothing new.
- **Metrics drift.** The browser and MathJax lay out the same font a little differently, as today, but no longer in two different fonts.
- **A missing glyph.** A character a font lacks falls back to the browser's `math` font in the editor and to MathJax's default in the PDF. STIX Two Math has the widest coverage, which is one reason it stays the default.
