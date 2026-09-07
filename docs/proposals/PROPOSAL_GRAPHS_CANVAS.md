# Proposal: Charts on the Canvas Engine

> **TLDR**: A chart is one native canvas element kind, `chart`, whose body is drawn by the existing roughjs painter from a small pure layout module (scales, ticks, arcs) over a validated table with durable row and column ids. Vector and slides get the kind directly. Docs and sheets embed the same renderer as a figure without changing their document or grid models. An arrow binds to a mark by id, and docking reuses today's box-plus-outline machinery with the mark's box substituted for the element's, so no second docking algorithm exists. Start with bar, line and pie, snapshot data only. Live sheet ranges come after row identity exists, in a separate phase. Learn from mature tools the way the canvas learned from Excalidraw: port their rules and tests (Excalidraw's own spreadsheet-to-chart parser and label layout, d3's tick and band rules, Plot's scale defaults, ECharts' table-plus-encode split), do not embed their runtimes. No Vega, no Recharts: the constraints the engine imposes (sync, DOM-free, deterministic in a Bun Worker) leave nothing of those libraries worth adapting.

**Status:** Proposed, not implemented. Facts below were checked against the repository on 2026-09-07. This supersedes the architecture in [PROPOSAL_GRAPHS.md](PROPOSAL_GRAPHS.md), which predates the canvas engine; its data-first stance and small initial chart vocabulary carry over, its rendering and host integration do not. "Graphs" here means data charts, not node/edge diagrams.

## 1. What the original proposal got right and wrong

Keep from the original: a shared editor for every app, bar/line/pie first, structured data rather than pixels, explicit chart dimensions, snapshot-first cross-app copy, and explicit empty/invalid states.

| Finding | Evidence | Consequence |
|---|---|---|
| Recharts draws through React and its own styling layer. | `kinds/render-utils.ts` draws every canvas shape through `RoughGenerator`, `baseRoughOptions` and `drawableToSvg`; `sceneToSvg` runs verbatim in the API transform Worker because it is DOM-free. | A React chart cannot run in the Worker, so it would be missing from every preview and export. It also cannot share the hatch/gradient/seed painter, so a chart never looks like the shapes around it. |
| The slides design (`SlideObject`, `use-deck.ts`, `ReadOnlySlideObject`) no longer exists; vector is absent. | Slides is `CanvasEditor` in frame mode over the shared kind registry ([SLIDES.md](../SLIDES.md), [CANVAS.md](../CANVAS.md)). | One kind serves both canvas apps. |
| Columns are display names, rows are anonymous arrays. | `columns: string[]`, `rows: (string\|number\|null)[][]`, series keyed by column name. | A renamed header or reordered row silently retargets anything bound to it. Ids must exist before arrows do. |
| Arrow bindings dock to a whole element. | `Binding = { elementId, fixedPoint }` (`vector/types.ts`, not exported); `boundEndpoint` in `geometry.ts` intersects the kind's single `outline`. `OutlineShape` is `rounded \| polygon \| ellipse \| polyline`. | Mark-level docking needs a sub-target seam and a sector outline. |
| The sheet overlay reinvents move/resize at z-index 250/300. | `ImgBoxs/index.tsx` already uses `ObjectTransform`; the active image sits at z-index 20, inactive at 19. | Reuse the image overlay path. |
| Floating images are only half persisted today. | `images` lives on the editor-state `Sheet` (`packages/sheet/src/state/types.ts`), rides the op pipeline through the `images → insertedImgs` mirror in `state/utils/patch.ts`, and survives the snapshot only because `encodeSheetsSnapshot` spreads `...rest`. Lib's `Sheet` has no `images` field and `readSheetsFromDoc` never sees them, so previews and exports drop every floating image. | Charts must be a typed field on the wire, not a second untyped passenger. The image gap is a broken window to fix alongside (ROADMAP row). |
| Docs integration copies a retired `ResizableImage` pattern. | The shared `FigureNode` (`packages/lib/src/docs/eigendoc/nodes/figure.ts`) is an inline atom with `layout: block \| wrap-left \| wrap-right`; `renderFigureNode` in `export/doc/render.ts` is reused by the eigendoc preview; the app view uses `ObjectTransform`. | A chart node follows the figure path and gets placement, export, preview and search for free. |
| "SVG prints well; no special handling." | DOCX goes through `@turbodocx/html-to-docx` from base64-image HTML; the XLSX exporter (`export/sheets/to-xlsx.ts`) writes no images at all; PDF is WeasyPrint over sanitized HTML. | DOCX and XLSX need an explicit flattened-image path or a declared gap. |
| A 200 ms debounced `onChange` is the live-data contract; ranges never adjust on insert; "matches Google Sheets". | Formula dependents, peer ops, undo, sort and structural edits all change chart inputs; a preview renders with no workbook open. The Google Sheets claim is unverified. | Live data needs its own consistency contract (§7). Range rules are stated as Eigen rules. |
| The JSON scalar has no conflict policy. | Same shape as rich text's `html`: whole-value last-writer-wins. | State it, and stop a stale editor draft from overwriting a peer's edit. |
| Table access and SVG export sit in the polish phase; live-link phase numbers disagree between sections. | Phase 5 in the TLDR, phase 6 in the body. | The first release is a complete static slice including table access and output. |

The original's library size and animation comparisons measure nothing in this repository and should not drive the decision.

## 2. Decision: one native kind, pure layout, the existing painter

| Approach | Decision |
|---|---|
| Recharts / Nivo with a canvas-looking theme | Reject. React and DOM in the render path, no Worker rendering, a second set of drawing rules. |
| Vega scenegraph adapted to the painter | Reject. Every constraint the engine imposes (sync `render`, DOM-free, no expressions or loaders, deterministic text width in a Bun Worker, three trusted templates) removes what Vega is for. Vega measures text through a canvas and falls back to estimated widths headless, so browser and Worker layouts diverge by construction. What survives is scales, ticks and arc paths, which are a few hundred lines. Adapting a mutable async dataflow runtime to get those is more code, not less. |
| Render a chart with any library, then "roughen" the SVG DOM | Reject. Depends on library markup and reconstructs geometry after layout. |
| Store SVG as an image | Only as an explicit flattened copy or export. |
| Every mark as its own rectangle/ellipse element | Reject as the model. Marks would drift from their data and a data refresh would become object reconciliation. A later "Convert to shapes" may do this on purpose. |
| **One `chart` kind, pure layout module, derived marks drawn by the shared painter** | **Recommend.** One movable object with meaningful internal attachment targets. |

Layout dependencies: no chart or d3 package is in the tree today, only roughjs. Take `d3-scale` (linear and band scales, nice ticks) and `d3-shape` (arc and line path generators). Both are DOM-free ESM and tree-shake to a few dozen KB. Everything else is Eigen code. If the prototype shows those two are not worth a dependency for bar/line/pie, write the tick and arc math inline; either way the layout module is pure and synchronous.

### Port what mature tools learned, do not adopt their runtimes

The canvas engine got its clean design and years of fixes by porting Excalidraw's rules, not by embedding Excalidraw. Charts should get the same treatment. The previous draft turned "learn from existing chart tools" into "adopt Vega's data model"; that is the opposite of the Excalidraw lesson, and Vega's data model does not even carry what we need (its per-tuple id is a private, non-enumerable symbol assigned on ingest, not document identity). The list below is what to port, source by source, with what to leave behind.

| Source | Port | Leave |
|---|---|---|
| **Excalidraw** `packages/excalidraw/charts/` (bar, line, radar from pasted spreadsheet text) | `tryParseNumber` (sign, currency symbol, thousands separators, trailing `%`); header detection (a first row with no numeric cell); the wide-format rule (more value columns than rows transposes so rows become series); the label slot layout (`CARTESIAN_BASE_SLOT_WIDTH` 44, `CARTESIAN_LABEL_MIN_WIDTH` 28, slot padding, the rotated-label fallback at `CARTESIAN_LABEL_ROTATION`); `GRID_OPACITY` 10; series colours picked from the palette by a seeded offset (`getSeriesColors(count, getColorOffset(seed))`) so two charts on one page differ; its `charts.test.tsx` fixtures as our parser test corpus. Paste-spreadsheet-text-as-chart is the natural creation path on the canvas and should ship in phase 1. | Its storage model: a chart is loose rectangles, lines and text with no data behind them (the "convert to shapes" we reject as the native form). Negative values clamped to zero. Radar, for now. |
| **d3-scale, d3-shape** | Take as dependencies: linear `ticks` (human-readable multiples of powers of ten within the domain), `nice`, `tickFormat` (precision derived from the tick step); band `paddingInner`/`paddingOuter`/`align`/`round`; `arc` with `padAngle` and `cornerRadius`; `pie` with `sort` and `startAngle`; `line` with `defined` for gaps. | Nothing to leave; they are pure functions. |
| **Observable Plot** | Its scale rules: bar domains include zero; band padding defaults to 0.1; band and point scales round to whole pixels; tick count derives from pixel spacing, not a fixed number; tick labels get `textOverflow: ellipsis` or wrap by `lineWidth` with reserved margin. | The DOM renderer and the mark/channel API surface. |
| **ECharts** | The `dataset` + `encode` split: one table, series reference columns by name or index; `seriesLayoutBy` (series in columns or rows, the "switch rows/columns" every spreadsheet user expects); `sourceHeader` auto-detection; pie `avoidLabelOverlap` and label lines as the reference for pie label placement. | zrender, series-specific layout code, DOM-free SSR. |
| **Vega** | The mental model only: data, then scales and encodings, then a scenegraph, then a renderer. Our `layoutChart` is that pipeline in one pure function. | The dataflow runtime, expressions, signals, canvas text measurement. |
| **Excel, Google Sheets** | Chart-from-selection conventions: header row detection, series in columns by default with a rows/columns switch, the "hidden and empty cells" policy (gap, zero or connect, default gap), axis crossing at zero, cell number formats driving tick formats. | Their range-adjustment behaviour is not a spec for ours (§7 states Eigen's rules). |
| **roughViz** | Visual reference for what a sketched chart should look like: hachure per bar, marker size, axis weight. | Its D3 DOM pipeline. |

Each ported rule lands with its test, the way Excalidraw's docking and elbow routing did.

## 3. Rendering architecture

```text
validated ChartDefinition + element box + base style (stroke, roughness, seed, opacity, typography)
                              |
                       layoutChart (pure, sync)
                              |
           marks with ids + boxes + outlines, axes, ticks, labels, legend
                     /                              \
        render (shared roughjs painter)        dock targets (§5)
                     |                              |
               SVG fragment                  arrow endpoints / elbow obstacles
                     \                              /
                        live layer / thumbnail / preview / SVG / HTML / PDF
```

### The kind

`packages/lib/src/vector/kinds/chart.ts`, built with `defineKind` like every other kind. `render(el, ctx)` stays synchronous and DOM-free: it calls `layoutChart` and paints the result. Nothing in the registry contract changes for other kinds. The layout module lives beside it in `packages/lib/src/vector/charts/` (layout, validation, limits, dock targets), and the shared data types in `packages/lib/src/types/chart.ts`.

The painter helpers a chart needs (`renderRoughShape`, `baseRoughOptions`, `fillDefs`, `svgId`, `drawableToSvg`) are internal to `kinds/`, not barrel-exported. That is fine: the chart kind lives in the same folder. Any extraction to share a path painter must leave existing shape SVG byte-identical (acceptance test 1).

React lives in `packages/ui/src/components/charts/`: the wizard, the data table, the preview and the accessible interaction. It never computes scales or draws. The kind's React half (`ELEMENT_KIND_UI`) supplies icon, label and `PanelSection`. Apps only wire insertion, selection and persistence.

Registration is the documented "adding a kind" path plus what a bindable kind needs: `VectorElementType`, the `VectorBindableElement` union, `ELEMENT_KINDS`, `ELEMENT_KIND_UI`, the patch surface in `use-canvas-doc.ts`, and the registry completeness tests. Capabilities: `creation: 'none'` (inserted from the toolbar's Insert menu through the wizard, like an image), `bindable: true`, `silhouette: 'box'`, `fill` (the chart-box background), `strokeStyle`, `corners`.

No painter fetches a sheet, writes Yjs, measures a browser element or starts a timer. Width and height come from the element box before layout.

### Primitives map onto roughjs directly

| Mark | Painter call | Notes |
|---|---|---|
| Bar | `rectangle` with the shape's corner treatment | Same generator choice and small-shape roughness adjustment as a rectangle element, computed on the bar's own dimensions. |
| Line | `linearPath` (sharp) or `curve` (curved edges) | Missing values split the path into runs. |
| Point marker | `ellipse` | Same curve fitting as an ellipse element. |
| Pie slice | `arc(cx, cy, w, h, start, stop, closed = true)` | roughjs already draws a closed arc as a sector, including hatch. A full circle for a single slice is `ellipse`. |
| Axes, ticks, grid | `line` with chart-defined roles | Same stroke options as a line element. |

Marks are temporary drawing records inside one `render` call, never Yjs children.

### Paint semantics

| Concern | Required behaviour |
|---|---|
| Sketch options | Same `baseRoughOptions`: dash handling, multistroke policy, fill weight, hachure gap, vertex preservation, small-shape adjustment. |
| Fill | Series and pie-category fills are canonical `Fill` values (paint plus `hachure \| cross-hatch \| solid \| zigzag`). Changing hatch preserves paint and vice versa, as the panel does for shapes. Gradients use the existing OKLab stops and transparent-stop treatment. |
| Randomness | Each mark's seed derives from the element's persisted `seed` and the mark's stable ids, never from row position, value or render order. Reordering data must not reroll every hatch. |
| SVG references | Gradient and clip ids go through `svgId` scoped by element id plus mark id; references stay in attributes, not CSS `url()`. A thumbnail and the editor showing the same chart do not collide because element ids are already the scope. |
| Opacity | Applied once on the layer by `layerBoxCss`, never per mark. |
| Typography | Plain SVG `<text>` with persisted `fontFamily`, `fontSize` and colour; the kind exposes `fontFamily` so `sceneFontFamilies` collects it for export font embedding. No `foreignObject`. |
| Ownership | The element owns stroke, roughness, seed, opacity, typography and its box `fill` (the background). Series fills live in the definition, keyed by column id or row id. Colours are assigned from the Eigen palette once at creation and persisted, so hiding or reordering never reassigns them. |
| Defaults | A new chart takes the host style table (`VECTOR_STYLE_DEFAULTS` or `SLIDES_STYLE_DEFAULTS`); docs and sheets get one explicit chart preset. Paste never restyles to the destination. Dark mode changes editor furniture only, as with the canvas paper. |

Parity means the same layout, paths and paint options for the same inputs, compared as canonical SVG. It does not promise identical raster pixels across font engines.

### Deterministic text width

`font-metrics.ts` is vertical-only and `text-measure.ts` is DOM-bound, so nothing in lib can measure a label today. Chart labels are derived, so the arrow label's answer (a client-measured `labelWidth` stored in the document) does not apply. Add a build-time advance-width table for the font families the canvas offers, one per family and weight, and a `measureLabel(text, family, size)` in lib that reads it. Browser and Worker then lay out identically. Labels that exceed their slot truncate with an ellipsis by that same measure; the full text stays available in the data table and tooltip.

### Logical dimensions and clipping

Lay out at the element's logical size. A slide thumbnail scales the finished composition; it never recomputes ticks or hides a legend because it is 180 px wide. A user resize recomputes layout, and bound arrows resolve against that same layout in the same preview frame. Tick selection, number formatting and truncation are deterministic and use a pinned `en` locale, never the viewing device's.

Leave explicit padding for labels, strokes and rough overshoot. Clip plotted marks to the plot region, not the whole element, and hit-test with the same clip. A box too small to lay out draws a visible placeholder; a malformed stored definition draws a bounded error placeholder and is preserved untouched for recovery.

## 4. Data model and durable identity

Proposed contract in `packages/lib/src/types/chart.ts` (a sketch, not an exported type yet):

```typescript
type ChartCell = string | number | null;

type ChartColumn = { id: string; label: string; kind: 'category' | 'number'; fill?: Fill };

type ChartTable = {
    columns: ChartColumn[];
    rows: { id: string; values: ChartCell[] }[];
};

type ChartDefinition = {
    v: 1;
    type: 'bar' | 'line' | 'pie';
    title: string;
    table: ChartTable;
    categoryColumnId: string;
    valueColumnIds: string[]; // one for pie
    sliceFills?: Record<string, Fill>; // pie only, keyed by row id
};

type ChartMarkRef = { columnId: string; rowId: string };
```

A series is a numeric column, so a mark is one column id and one row id; there is no separate series id to keep in sync with a column. `Fill` is the existing shared type. Values follow column order; configuration refers to ids. Ids survive relabelling, reordering and edits. Duplicate labels are legal, duplicate ids are not. Row and column ids are allocated once on insertion and never derived from a label or value; undo of a deleted row restores its id.

Expose only implemented types. Do not put scatter, area or stacking in the union and render something else.

On a canvas element the definition rides one JSON scalar field, `chart`, validated in the kind's `read` like `points` or `fill`. Different charts merge independently. Concurrent edits to one chart's definition are whole-value last-writer-wins, the same limitation rich text's `html` has. The wizard edits a local draft that records the base definition; Apply compares the element's current value with that base and offers reload or overwrite instead of silently replacing a peer's newer definition. Apply is one sealed transaction; Cancel writes nothing.

### Numeric behaviour

| Input | v1 behaviour |
|---|---|
| Finite number | Plotted. Negative bars extend below the baseline; a bar scale always includes zero. |
| Missing value or formula error | Preserved as missing with its diagnostic. No zero-height bar; a line breaks at the gap. |
| Zero | Valid data, distinct from missing. A zero bar keeps a baseline attachment point. |
| Pie with a negative value | Data error shown in the editor, not absolute values or silent omission. |
| Pie with zero total | Visible "No data" state; zero slices draw no wedge. |
| Constant series, one point, empty table | Deterministic non-degenerate scale or an explicit empty state; never NaN or Infinity in SVG. |
| Duplicate category labels | Separate rows and marks by row id; no implicit aggregation. |

A line with point markers is the requested "dots on a line". Time axes, scatter, aggregation, stacking and smoothing are later; a future time column carries explicit type semantics rather than sniffing a number format.

## 5. Arrows attached to chart marks

**Now or later?** Both, on purpose. Phase 1 ships the identity (row and column ids allocated at creation and never rebuilt), so every chart made from day one is a valid target later. Phase 2 ships the docking. Nothing in phase 1 has to be migrated for phase 2, and a phase 1 chart with no arrows on it costs nothing extra. Anchoring an arrow to a single bar, a pie slice or a line point is a first-class goal of this proposal, not an afterthought.

### Extend the binding, keep the docking algorithm

Today `boundEndpoint(arrow, end, shape, byId)` takes a bindable element and uses three things from it: its box (`anchorToScene` maps the stored `fixedPoint` proportion into it), its `outline(inflate)` and its gap policy. A mark is exactly those three things at a smaller scale. So the binding grows one optional field and nothing else:

```typescript
type Binding = { elementId: string; fixedPoint: [number, number]; mark?: ChartMarkRef };
```

Introduce a `DockTarget = { box, outline(inflate), silhouette }` derived either from the whole element (today's behaviour, unchanged) or from a resolved mark, and make `boundEndpoint`, `followBindings`, `elbowAnchorScene`, the aim lines and the elbow router's obstacle set take a `DockTarget`. One docking algorithm, one gap policy, one set of tests. No `port` enum is needed: `fixedPoint` is a proportion of the mark's box, so `[0.5, 0]` on a bar is its value-end centre. To keep that meaning through a sign change, a bar's local box is oriented from baseline (`v = 1`) to value end (`v = 0`). Rotation of the chart rotates the mark box with it, as a rotated element already rotates its own.

The chart stays the forward target `elementId`; `arrowsBoundTo` stays a derived reverse index; mark ids are scoped to their chart. Binding to the outer chart box keeps working exactly as a shape binding.

### The registry seam

Add two optional members to `KindSpec`: `dockTargets(el)` returning every current mark's `DockTarget` with its `ChartMarkRef`, and `dockTarget(el, mark)` resolving one reference or `null`. Ordinary kinds omit both and keep their single outline. No chart branches appear in the tools.

`OutlineShape` gains a `sector` variant (centre, radii, start and end angle) with path, containment and intersection in `outline.ts`, used by both the painter and docking, so an arrow meets the wedge the user sees. A full-circle single slice is an `ellipse`. Bars are `rounded` outlines with the chart's corner treatment; point markers are `ellipse`.

| Mark | Default `fixedPoint` at bind time | Outline |
|---|---|---|
| Bar | Value-end centre `[0.5, 0]` in the oriented box | `rounded` |
| Pie slice | Outer arc at the angular midpoint | `sector` |
| Line point | Marker centre; docking backs off to its boundary so the head does not cover the dot | `ellipse` |

Dock against the unjittered outline, as the canvas already does; the rough stroke never changes which mark an arrow targets.

### Lifecycle

| Surface | Change |
|---|---|
| Codec and reader | `parseBinding` accepts the optional `mark`; scope and target kind are validated; an unresolvable mark is preserved, not dropped (unlike a missing element, which still drops to unbound). |
| Tools | `tools/binding.ts`, endpoint drag and point-handle previews carry a `DockTarget` candidate instead of a shape id. Hover highlights the mark and shows its label and value. |
| Geometry | `boundEndpoint`, the far-side aim, `followBindings` and rotation all work on `DockTarget`. Two ends may bind to different marks of one chart. |
| Elbows | The mark's box replaces the chart box as that end's obstacle and heading source; the chart rectangle must not block access to an interior mark. Routing stays axis-aligned, and a rotated mark's normal resolves to a cardinal heading. v1 does not route around other bars or labels; the router considers only bound targets today and keeps that scope. |
| Memoization | `ElementLayer.sameRouteContext` compares only the two bound elements. Any arrow with a `mark` also depends on that chart's `chart` field and box, so the comparison includes them. |
| Read-only rendering | Previews, exports and `FrameView` resolve mark endpoints from the current definition through the same pure pass; stored arrow points are the fallback for an unresolved mark, never authoritative over a resolved one. A remote edit never makes every viewer write corrective geometry. |
| Duplicate, paste, frames | Remap the chart's element id, keep row and column ids, clear references outside the copied set, enforce same-frame bindings. `planElementsPaste` already collects the remaps. |

### Missing targets

Deleting or filtering a row, hiding a column, a missing value or a zero slice can make a valid reference unresolvable. Keep the reference and the last committed endpoint, show an unresolved indicator on the arrow, and offer reattach or detach. Never retarget to the row now at the old index, to a matching label or to the whole chart. If undo or a refresh restores the same id it resolves again. Deleting the chart follows normal dangling-element behaviour. A type change keeps attachments whose column and row still exist. Exports with unresolved annotations render the fallback endpoint and surface a warning.

Overlap resolves deterministically: nearest eligible target, then stable id. Respect the plot clip and the existing screen-space and coarse-pointer tolerances. Ctrl/Cmd still suppresses binding. Click selects the chart, double-click or Enter opens the editor. The data table offers a keyboard path to pick an attachment target; a title and "View data" are first-release requirements because colour and hover alone cannot convey values or targets.

## 6. Hosts

### Vector and slides

Register the kind; `CanvasEditor`, `ElementLayer`, `FrameView`, arrange, comments, search and the clipboard consume it through the registry. `searchText` returns title, labels and column names. One chart is one selection, comment and z-order object; marks are not separate comment anchors in v1.

### Docs

A shared `ChartNode` beside `FigureNode` in `packages/lib/src/docs/eigendoc/nodes/`, with the same inline-atom shape and the same `layout`, width and alignment attributes so every figure placement rule applies unchanged. The definition and the chart's style ride node attributes; the app node view uses the figure view's `ObjectTransform` shell; `renderChartNode` sits beside `renderFigureNode` in `export/doc/render.ts` and is reused by the eigendoc preview. `collectProseMirrorText` already walks the tree, so chart text reaches search once the node exposes it. Test HTML serialization and import so the node survives the server schema and the sanitizer. Reflow scales the figure; it never re-lays out the data.

### Sheets

Add `charts?: SheetChart[]` to lib's `Sheet` (`packages/lib/src/sheets/types.ts`), each `{ id, x, y, width, height, angle, chart, style }` in document pixel coordinates like `Image`. Encode and decode it explicitly in `snapshot-codec.ts`; do not rely on the `...rest` passenger. Ops follow the image path: a `state/modules/chart.ts` sibling of `image.ts`, the same mirror in `patch.ts`, one immer recipe per move, resize or Apply, so collab and undo come from the existing pipeline rather than a second Yjs root. Overlay rendering follows `ImgBoxs` with `ObjectTransform` at the same z-index. `readSheetsFromDoc` returns charts so previews and exports draw them.

"Insert chart from selection" takes a typed snapshot of the current computed values, allocates ids and opens the shared wizard. Label it as a snapshot.

### Annotations in docs and sheets

Not in the first release. Arrows to marks need a scene, and a chart-only "bounded local scene" would be a chart-specific mini canvas editor mounted inside a Tiptap node and inside the sheet overlay. If docs and sheets should carry annotated figures, the right unit is a generic embedded canvas scene (a `CanvasEditor` over an in-memory draft doc, applied as one host transaction) that can hold any elements, chart included. That is its own proposal. Until then a docs or sheets chart is editable through the wizard and annotated in vector or slides.

## 7. Live sheet data: a separate contract

Distinguish inline snapshot, same-workbook range and cross-document range. Cross-document references carry `ownerId`, `mountId`, `pathId` and `sheetId`; a similarly named sheet is never a fallback.

**Same-workbook ranges come after the static slice.** Extract from the committed materialized workbook on the client and from snapshot-plus-replay (`readSheetsFromDoc`) on the server through one pure cell-table adapter over `CellMatrix`. Follow the existing recalculation policy; previews gain no new recalc pass. Derive live data locally rather than having every viewer write a cached definition. Invalidation covers formula dependents, peer batches, undo, sort and filter, structural edits, sheet deletion and snapshot replacement. Rendering and arrow resolution bind to the same revision, so there is no "new bars, old arrows" frame.

### Identity comes before record-following arrows

The grid is positional; [PROPOSAL_SHEETS_YJS_WORKBOOK.md](PROPOSAL_SHEETS_YJS_WORKBOOK.md) describes stable row ids as a direction, not a facility. For record-following bindings, require an explicit unique non-empty key column and derive row ids from it. A key edit is a delete plus insert; duplicate or missing keys suspend affected bindings with a diagnostic. A range without a key still draws a live chart but offers no mark bindings, only the whole-chart box. That beats promising an arrow follows "Alice" while it follows B7.

Range references need insert, delete and move handling in the same op batch as the structural edit, beside the existing row and column machinery, never by rewriting A1 strings in React. Proposed rules: an insert before the range shifts it, inside expands it, immediately after does not; a delete shrinks it, and deleting the whole range or a required column invalidates the source. Ambiguity marks the source unresolved and asks for reselection.

### Cross-document refresh

Start with explicit "Refresh from sheet". A refresh needs read permission on the source and write on the destination, goes through the Drive ACL wrapper and the Home relay, and commits a complete table plus source revision in one edit; a stale response is rejected if the definition changed meanwhile. Failure keeps the previous snapshot and says whether access, deletion or availability caused it. A linked snapshot is a copy: anyone who can read the destination can read those values, and revoking source access cannot retract them. Say so when linking. Automatic refresh is later and needs a designated writer.

## 8. Clipboard, export and limits

**Clipboard.** A native chart, alone or with bound arrows, rides the existing typed `elements` item; `readElementsClipboardItem` runs it through the reader like any record. Docs and sheets produce and consume a chart figure from that same item; never emit a second chart flavour beside it. The clipboard carries the snapshot table. "Copy as SVG" is derived output with embedded fonts, no source references and no hidden table metadata, under [CLIPBOARD.md](../CLIPBOARD.md)'s flavour arbitration so it never double-pastes with the native item.

| Surface | Behaviour |
|---|---|
| Vector and slides live, thumbnail, present | The kind and resolved arrows; the finished scene scales. |
| Docs and sheets live | Same renderer; the host owns placement only. |
| Server previews | Through the existing per-type Workers. Marks count against a per-chart cap; one chart is not a loophole in the 500-element `PREVIEW_MAX_ELEMENTS`. |
| SVG, HTML, PDF | Native paths, text and defs; WeasyPrint over the existing sanitized HTML. Test gradient and clip references. |
| DOCX | Rasterize the same rendered SVG off-thread into the image the converter already accepts; the export notes the flattening. |
| XLSX | The exporter writes no images today. First add ExcelJS `addImage` with anchors for flattened charts; native Excel charts and round-trip import are separate work. If not ready, surface an unsupported-content warning rather than dropping the chart silently. |

**Limits**, one table in `charts/limits.ts`, enforced at the wizard, the reader (so hostile peer and clipboard input meet it) and the API. Provisional: 256 KiB per definition, 2,000 rows, 32 columns, 12 value columns, 2,000 visible marks, 64 KiB label text. Rows times columns can exceed the mark cap; reject explicitly rather than sample. Bound roughjs path generation before drawing, not by an output byte guard after generating a million hatch segments. Stored and pasted JSON is untrusted: validate version, type, finite values, rectangular data, unique ids and references, and escape every label. The validators are the canonical paint and font ones.

**Memoization.** Layout keys on the definition, box size, style and seed; move, pan and zoom reuse it; several arrows to one chart share one layout. Caches stay bounded and per document.

## 9. Delivery order and acceptance

| Phase | Deliverable and gate |
|---|---|
| 0. Prototype | Grouped bars, gapped line with markers and a pie through `layoutChart` plus the existing painter, rendered in the browser and in a real Bun Worker. Gate: canonical SVG parity between the two, the advance-width table works, seeds are reorder-stable, sector docking geometry is exact, and measured cost of `d3-scale` and `d3-shape` versus inline math. |
| 1. Native chart | Validated ids and data, three types, styles, title and data table, SVG output, Insert-menu creation and paste-spreadsheet-text creation in vector and slides (the ported Excalidraw parser with its fixtures). Existing shape SVG unchanged. |
| 2. Mark bindings | `DockTarget`, the `sector` outline, sharp, curved, elbow and pinned arrows following marks through edits, resize, rotate, duplicate and undo; read-only output resolves the same endpoints. |
| 3. Docs and sheets figures | Shared node and static renderer; typed `charts` on the sheet wire and overlay; editable cross-app copy; every output format either renders or declares its gap. Fix the floating-image passenger alongside. This completes the four-app release. |
| 4. Same-workbook live ranges | Batch-aware extraction, key identity, structural handling, remote and undo consistency. |
| 5. Cross-document linking | Permission-checked manual refresh, disclosure, stale-response handling, unlink. |
| Later | Time, scatter, area and stacked charts; embedded canvas scenes for docs and sheets annotations; "convert to shapes"; native Office charts. |

Acceptance exercises real output and behaviour:

1. **Paint parity.** An isolated bar or marker matches the equivalent rectangle or ellipse element across every fill style, gradient, stroke style, roughness and corner setting. Existing shape SVG is byte-identical after any painter extraction.
2. **Determinism.** Reload, reorder, duplicate, thumbnail and export render the same SVG up to instance-scoped ids. Reordering data keeps unchanged marks' seeds.
3. **Attachment.** Rename duplicate labels, reorder rows and columns, flip a bar negative or zero, change pie proportions, move a line point: every arrow still names the same column and row and meets the intended mark.
4. **Lifecycle.** Delete, filter and restore a mark, switch type, delete the chart, duplicate a frame, paste a chart with two arrows, undo and redo. Unresolved state is visible; nothing retargets by index.
5. **Geometry.** Non-uniform resize, rotation, two ends on one chart, curved and multipoint shafts and pinned elbows agree in preview, pointer-up, reload, hit test and export. A settled resolve is idempotent.
6. **Host persistence.** Two clients, offline edits, docs schema reconstruction, sheets snapshot-plus-ops reload, sheet duplicate and delete, version restore. A stale wizard Apply cannot overwrite a peer edit silently.
7. **Formats.** Open real SVG, HTML, PDF, DOCX and XLSX in their consumers and check presence, labels, hatch and gradient appearance, endpoints and declared flattening.
8. **Limits.** Oversized tables, hostile ids, labels and fills, missing fonts, ambiguous keys, revoked permissions and stale refresh responses produce explicit bounded outcomes without losing the stored figure or fetching unauthorized data.

Tests follow the workspace layout: pure chart and binding contracts under `packages/lib/src/test/vector/`, sheet integration under `packages/sheet/src/test/`, preview and export routes under `apps/api/src/test/`. Work runs by [WORKING-METHOD.md](../WORKING-METHOD.md) with independent review and real browser and output verification.

## 10. Decisions to approve

Recommended defaults: one native `chart` kind; a pure sync layout module on `d3-scale` and `d3-shape` with the existing painter, no Vega and no Recharts; rules and tests ported from Excalidraw's chart module, Plot and ECharts rather than any embedded runtime; `mark` as an optional field on the existing binding with `DockTarget` replacing the element in the docking functions; bar, line and pie first; snapshot data first; docs and sheets get the chart figure but not annotations in the first release; an explicit key column before any record-following live binding.

The open scope choices: whether the first release must include same-workbook live ranges, whether chart-only figures satisfy docs and sheets or an embedded canvas scene is required, and whether flattened DOCX and XLSX charts are acceptable. None changes the core: keep data and mark identity native, derive SVG and docking geometry together through the canvas engine.
