# Charts

> **TLDR:** A chart is one stored description, a `ChartSpec`: its type, titles, legend, axes, colors and data. One pure layout turns it into ordinary canvas elements plus lines of text, and one painter draws those as plain SVG, so a chart looks the same live, in a preview and in every export. The spec, its reader and the layout are `packages/lib/src/charts/` with the types in `packages/lib/src/types/chart.ts`; the canvas kind and its painter are `packages/lib/src/vector/kinds/chart.ts` and `chart-render.ts`; the shared editor and the Edit data dialog are `packages/ui/src/components/charts/`.

A chart is a column, bar, line or pie chart, in Google's and Excel's names: a column chart has vertical bars, a bar chart horizontal ones. Its `ChartSpec` holds the presentation (title, legend position, axis titles, value-axis min and max, gridlines, stacking, colors) and the data: categories along one axis and one or more series of values. The spec is stored as a JSON string wherever a chart lives. The one place it lives is the `chart` field of a canvas element of kind `chart`, in Vector and Slides ([CANVAS.md](CANVAS.md)). Insert → Chart places one with Google's sample data, the properties panel edits its presentation, and Edit data its numbers ([§ One chart editor edits a spec](#one-chart-editor-edits-a-spec-and-the-host-writes-it)).

The data is inline or a range. Inline data is the numbers themselves, inside the spec. Range data names cells of a sheet (a `CellRangeRef`: sheet id, first and last row, first and last column), which only a sheet can resolve. A canvas has no sheet, so it draws only inline data.

The layout, `layoutChart`, takes the spec, the resolved data, a box and a paint, and returns shapes and labels in the box's own coordinates. The shapes are real canvas elements: rectangles for bars and legend swatches, lines for gridlines, baselines and line series, ellipses for markers and the pie kind for slices. The labels are lines of text with a position, font, size, weight, color and turn. The painter, `renderChartSvg`, draws the shapes through their own kinds and the labels as SVG `<text>`.

The sections cover the spec and its reader, how a canvas stores a chart, the layout, the painter, the paint, converting a chart to shapes, the text widths and the limits. Three things in them surprise people:

- A canvas keeps a chart's spec exactly as stored, even one that doesn't parse ([§ A canvas keeps the spec as stored](#a-canvas-keeps-the-spec-as-stored-and-draws-a-placeholder-for-one-it-cant-draw)).
- A chart's labels are SVG text, never rich text, because WeasyPrint ignores `foreignObject` ([§ The painter draws each shape with its own kind](#the-painter-draws-each-shape-with-its-own-kind-and-the-labels-as-svg-text)).
- Label widths come from a committed table, not from a browser ([§ Text widths come from a committed table](#text-widths-come-from-a-committed-table-generated-from-the-bundled-fonts)).

## parseChartSpec is the one reader of a stored chart

Everything that reads what a stored chart says goes through `parseChartSpec` (`packages/lib/src/charts/spec.ts`), because a stored chart is written by any collaborator or any imported file. It takes the stored string, so the byte limit is measured on what peers store. Broken structure (no type, no data, a series that is not a list, a range outside Excel's grid) or a hard limit returns `null`. A broken or missing presentation field reads its default instead, so a field added to the type later never turns a chart stored before it into a placeholder. Text is cut to 200 characters and loses what XML can't hold, because every label ends up in SVG.

The same module owns the palette (`CHART_PALETTE`, twelve colors ordered so neighbors stay apart for colorblind readers) and Google's sample chart, `sampleChartSpec`, which a new canvas chart starts from.

## Hard limits bound what every peer lays out

Every peer lays out and paints whatever is stored, so the limits bound one chart's cost. They are constants in `charts/spec.ts`.

| Limit | Value | Over it |
|---|---|---|
| Serialized spec | 64 KiB | the spec reads as `null` |
| Series | 32 | `null` |
| Points (all inline values, or categories) | 2,000 | `null` |
| One label | 200 characters | cut |
| Inline data the Edit data grid edits | 12 series, 200 categories and 2,000 cells | `exceedsInlineGridLimits` answers true, and the grid opens read-only |

## A canvas keeps the spec as stored, and draws a placeholder for one it can't draw

The chart kind's `read` keeps the `chart` string as it came, never re-serialized from the parsed spec. Only a string over 64 KiB reads as `''`. The reader's repairs live only in the scene anyway ([CANVAS.md § The reader is the trust boundary](CANVAS.md#the-reader-is-the-trust-boundary)), but a parse-and-rewrite would turn a spec this build can't read, such as one with a field from a newer build, into its defaults the next time anyone writes the field. Kept as stored, it stays recoverable.

A spec that doesn't parse, and a spec with range data, draws a placeholder: a dashed box in the gray a picture with no file draws, and one centered line, "This chart can't be shown", ellipsized to the box or left out when the box is too small. `layoutChartMessage` lays that line out the way the layout's own messages are laid out.

## A chart is laid out as canvas elements plus labels

`layoutChart` (`charts/layout.ts`) is pure and synchronous, so the server and the live canvas run the same code. Its shapes are the canvas's own element types rather than a chart-only drawing, so a bar paints exactly as a rectangle with the same fields, with the host's roughness and hatch. Each shape's id is `${chartId}:${key}` (`c1:bar:0:2`, `c1:gridline:3`), which keeps the ids and every id derived from them unique on a page, and its seed is derived from the chart's seed and the key, so the jitter is the same on every redraw and differs per shape.

Shapes come in paint order: background, gridlines, bars or slices, lines, markers, baseline, legend swatches. Every shape has opacity 100 except the gridlines, which are faint. The chart's own opacity is its layer's, as for every element.

A label's `y` is the top of its line, not its baseline, so a renderer adds its font's baseline offset and a text box could take it as its top. A turned label turns about `(x, y)`.

The look is Google's defaults: text scaled to the box, title on top in bold, legend on top for column, bar and line and none for a pie, light gridlines, no tick marks, zero-based bars. Value ticks come from a port of d3-array's tick algorithm (`charts/ticks.ts`), spaced by pixels. Category labels turn -45° when upright ones would touch, then ellipsize. A pie labels each slice of 5% or more with its name and share, beside the slice and without leader lines. No data, a pie with a negative value or a box too small for a plot draws one centered message instead. `packages/lib/src/test/charts/layout.test.ts` pins each of these.

## The painter draws each shape with its own kind and the labels as SVG text

`renderChartSvg` (`vector/kinds/chart-render.ts`) wraps each shape in its own translate group and calls that kind's `render`, so a chart's bar and a drawn rectangle with the same fields are the same SVG by construction. It imports the four shape kinds one by one: the registry imports the chart kind, so reaching the shapes through `ELEMENT_KINDS` would be an import cycle.

The labels go through `svgTextLine` (`vector/kinds/render-utils.ts`), the one helper that turns a line of text into SVG `<text>`; an arrow's label draws through it too. Plain SVG text is what lets a chart print: WeasyPrint ignores `foreignObject`, so rich text would vanish from a PDF. A bold label is drawn at weight 600, the weight of Inter's and JetBrains Mono's bundled bold faces.

A document or a sheet has no element to take a paint from, so it draws through `renderChartSpecSvg` (`@workspace/lib/vector`, safe on the server): the same painter in one constant paint, `FLAT_CHART_PAINT` (`charts/layout.ts`), which neither stores. That is Google's flat look: Inter, near-black text, a mid gray for the baseline and the faint gridlines, line width 2 (Google's series width, and a bar grows only 1px a side), roughness 0, solid marks and no background, so the chart sits on the page. It takes the parsed spec, `null` drawing the placeholder, and for a sheet the resolved range data or why there is none: `'ref'` draws `#REF!` and `'too-many-points'` draws "Too much data for a chart", one centered line without the dashed box. Inline data needs nothing passed; range data with nothing passed draws the placeholder. It returns a complete `<svg>` the size of the box, which a document's HTML inlines and a sheet overlays.

So previews and exports need nothing for charts. The SVG download, the PDF page, a deck's HTML and the preview all draw the chart through the kind, and the export sanitizer keeps every shape and label; `apps/api/src/test/export/chart-export.test.ts` proves it. The SVG download embeds the chart's font, which `sceneFontFamilies` picks up from the kind's `fontFamily` field, but only for a chart with search text: a placeholder chart, or one with no title, series names or categories, adds no font, so its labels fall back to the viewer's fonts unless another element embeds the same one. The live canvas loads nothing extra: the app's `@font-face` rules load a face the first time SVG text uses it.

## The element's own paint is the chart's paint

A canvas chart takes its `ChartPaint` from its element, so it follows its host's style table like any shape: rough and hatched in Excalifont in Vector, flat and solid in Inter in Slides.

| Element field | What it paints |
|---|---|
| `fill` | The background, always solid; its hatch style is the bars' and slices' fill style |
| `strokeColor`, `strokeStyle` | The axes and gridlines, not a border |
| `strokeWidth` | Every shape's line: the axes and gridlines, bar and legend-swatch outlines, slice edges, series lines and markers |
| `fontFamily`, `color` | Every label |
| `roughness`, `seed` | Every shape |

Series and slice colors are in the spec, stored when the chart is made. A pie draws its slice edges in the background's color when it has a solid one, so slices read as separate.

## Convert to shapes unpacks the painter's own layout

Convert to shapes, a row in the canvas object menu and a button in the chart's panel section for a selection of one chart that draws, replaces the chart with what it draws. `chartToElements` (`vector/kinds/chart-convert.ts`) reads the same layout the painter draws (`chartLayout` in `chart-render.ts`), so each converted shape is the element that drew it: same kind, fields and seed, so no jitter or hatch rerolls. Each shape's center turns about the chart's center, the chart's angle is added to its own, and its opacity is multiplied by the chart's. Each label becomes a rich-text box in the label's font, sized by `measureLabel` plus half an em of slack, since its kerning-free width can run short and a wrapped label would take two lines, one line high at the font's own line height so the baseline lands where the SVG text put it, and aligned by its anchor. A turned label turns about its anchor but an element turns about its center, so the box's center is turned instead. A chart that draws its placeholder converts to nothing, and the row is hidden. The kind answers through `toShapes`, read by `convertToShapes`, so the menu never asks for a chart by type.

`replaceElementInDoc` (`packages/ui/src/components/vector/hooks/element-writes.ts`) deletes the chart and writes the shapes in one transaction, at keys between the chart's index and the next one above it, so they keep the chart's place in the stacking order. Both run it through `convertElementToShapes` as one sealed undo step, so one ⌘Z brings the chart back, and selects the shapes, since the canvas has no groups to put them in. An arrow bound to the chart keeps its endpoints and loses its binding, as on a delete. The action is one way and has no ⌘K entry, because the palette has no canvas element actions.

The converted labels are rich text, each its own layer. The live canvas, a preview and the PDF mount a rich-text layer as HTML, so they draw the labels, but the SVG download wraps rich text in `foreignObject`, which some SVG viewers don't draw. That is every rich-text box's limitation, not the chart's.

## One chart editor edits a spec, and the host writes it

`ChartEditor` (`packages/ui/src/components/charts/`) is Google's Customise rows over one `ChartSpec`: type, stacking, titles, legend, the value axis's min, max and gridlines, and a color per series or per pie slice. It takes a spec and hands back the next one, and knows nothing of where the chart lives, so any surface that stores a spec can mount it. On a canvas the chart kind's panel section is this editor, shown for exactly one selected chart, because a spec doesn't merge across charts the way a color does. Each change is one write of the element's `chart` field, the whole spec serialized.

A typed title writes on every keystroke inside the host's gesture (`PropertyGestureContext`), so the title is one undo step and peers see it as it is typed. A bar chart lies on its side, so its Horizontal axis rows edit the value axis and its Vertical axis rows the category axis. A min at or past the max is not written, because the reader would drop both and the field would snap back. Markers and smooth lines are in the spec and the layout but not in the editor, as on Google's insert surface.

## Edit data is a grid over inline data, and Save is one write

`ChartDataDialog` shows inline data as a grid: categories down the first column, series across the first row. It edits a draft, so Save is one write of the spec and one undo step, and Cancel leaves the chart as it was. A cell keeps what was typed, so a value that isn't a number stays on screen, flagged, and Save waits for it. Tab-separated text pasted into a cell fills the grid from that cell and grows it, the way a spreadsheet range pastes. A new series takes the next palette color, and each row carries its pie slice's color, so removing a row takes that color with it.

The grid stops at 12 series, 200 categories and 2,000 cells in total, since a full 12 × 200 grid would be past the 2,000-point limit that makes a spec unreadable (`fitsInlineGrid`). A chart past those limits, such as an imported one, opens read-only as a plain table rather than as thousands of inputs. On a canvas the dialog opens from the panel's Edit data button and from a double-click on the chart ([CANVAS.md § A kind is one registry entry](CANVAS.md#a-kind-is-one-registry-entry)).

## Text widths come from a committed table generated from the bundled fonts

The layout needs a label's width to reserve room for the value-axis labels, the legend and turned or ellipsized category labels, and it runs where there is no DOM. `measureLabel` (`vector/text-width.ts`) sums advance widths from `vector/text-width-data.ts`: one table per Eigen font, regular and bold, for Basic Latin and Latin-1, with an em fallback for every other character. It ignores kerning, so it runs slightly off a browser's measurement, which is why widths only reserve room and placement goes through `text-anchor`.

The table is generated from the static TTFs a docx embeds: `bun apps/api/src/scripts/chart-text-widths.ts`, rerun after a font changes. Inter's and JetBrains Mono's bold TTFs are weight 600, the weight a bold label draws at. Source Serif's is 700, so its bold widths run slightly wide of the 600 the app's variable face draws, which only reserves extra room. Excalifont has only a regular face, so its bold width is its regular width and the browser fakes the bold. The demo seeder sizes its labels with the same function.

## See also

- [CANVAS.md](CANVAS.md): kinds, the reader, layers, and the pie kind a chart's slices are
- [EXPORT.md](EXPORT.md): the compositor and WeasyPrint's rules for a layer's SVG
- [ARCHITECTURE.md § Backend imports of lib](ARCHITECTURE.md#backend-imports-of-lib): `charts` is a BE-safe subpath
