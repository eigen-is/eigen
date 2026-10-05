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

One `@theme` block in `globals.css` sets `--font-weight-medium` to 450, `--font-weight-semibold` to 525 and `--font-weight-bold` to 600. So `font-bold` renders at 600, not 700. The body and the prose headings read these tokens, so the whole scale is tuned in that one block. The variable faces render the in-between weights exactly.

## The registry's order is load-bearing

`EIGEN_FONTS` holds each font's name, CSS stack, category and weights. Each category has exactly one font. xlsx import picks the bundled font by category (`BUNDLED_FONT_BY_CATEGORY`), and a second font in a category would take its imports over, since the last entry wins. Its order matters for two reasons:

- A sheet cell's `ff` may be an index into the list rather than a name. `packages/sheet/src/state/modules/fonts.ts` derives `FONT_ARRAY` and `FONT_INDEX_BY_NAME` (lowercased name to index) from `EIGEN_FONTS`, and a paste into a sheet stores such an index. Reordering or inserting changes the font of every stored index, so **a new font goes at the end**.
- `EIGEN_FONTS[0]` is the fallback font in docs and sheets. There is no separate default-font constant for them. The canvas has its own default, `DEFAULT_FONT_FAMILY` (Excalifont), in `packages/lib/src/vector/types.ts`.

## Docs and the canvas store a font name, never a CSS stack

The name expands to CSS only where it renders. A sheet cell is looser: it stores a name or an index.

- The canvas reader accepts only a name from `EIGEN_FONT_NAMES` and falls back to its default (`fontFamily` in `packages/lib/src/vector/kinds/read-fields.ts`). The name ends up in a CSS declaration list, where a stray `;` would open a declaration of the writer's choosing.
- The docs `textStyle` mark stores a name, and its node (`packages/lib/src/docs/eigendoc/nodes/font-family.ts`) renders it through `fontNameToCss` (`packages/lib/src/constants/fonts.ts`). A value that is already a stack passes through unchanged, and `normalizeFontFamilyMarks` in the docs editor collapses it to its name on an editable load. `getFontName` does the reverse lookup for paste and import.
- `getFontFamily` wraps an unknown name as `'<name>', sans-serif`. `fontNameToCss` must not wrap, or a stored stack would be wrapped twice.

## Foreign fonts map onto the bundled ones

Only the bundled faces are embedded in an export, so a font Eigen doesn't ship would render in the browser's generic family and print differently. xlsx import maps a cell's Office font (Calibri, Arial, Times New Roman and the like) to the bundled font of the same category, and leaves `ff` unset for one it doesn't know (`FONT_CATEGORY_MAP` in `apps/api/src/lib/import/sheets/from-xlsx.ts`). Pasted HTML in docs does the same for common desktop fonts (`transformPastedHTML` in `apps/docs/src/components/docs/editor.tsx`).

## One picker serves every app

`FontPicker` (`packages/ui/src/components/media/font-picker.tsx`) lists `EIGEN_FONTS`, each item previewed in its own face. The docs toolbar and the sheets format toolbar use it directly. The canvas uses it through `FontRow` (`packages/ui/src/components/properties-panel/`) in the rich-text and arrow property sections. A new registry entry shows up in all of them.

## A new font touches six places

The registry drives the pickers and the sheet lists. The other places keep their own list of faces, so a new font touches six:

1. The woff2 files and the font's `OFL.txt` in `packages/ui/src/assets/fonts/<font-name>/`.
2. Its `@font-face` rules in `fonts.css`.
3. The entry in `EIGEN_FONTS`, appended at the end.
4. `FONT_METRICS` in `packages/lib/src/vector/font-metrics.ts`. The canvas places SVG text baselines from each face's vertical metrics, and an unknown font gets Excalifont's.
5. `FONT_FILES` in `apps/api/src/lib/export/fonts.ts`. Exports embed the faces as base64 `@font-face` rules ([EXPORT.md](EXPORT.md)), and a font missing there prints in a fallback. `apps/api/src/test/export/fonts.test.ts` fails when it and `fonts.css` disagree.
6. The `FONTS` list in `apps/index/scripts/build-licenses.ts`, which the /licenses page reads. A bundled font is not a package, so the license build does not find it on its own.

A `--font-*` token in `globals.css` is needed only when the font fills a new category.

## See also

- [EXPORT.md](EXPORT.md): how exports embed the fonts
- [SHEETS.md](SHEETS.md): the sheet engine that stores `ff`
