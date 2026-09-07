# Proposal: Charts on the Canvas Engine

> **TLDR**: Make a chart a native, editable canvas element whose rendered body is SVG, not an SVG image whose chart semantics have been discarded. Prototype Vega for mature data transformation, scales and layout before building our own layout engine; keep Eigen's existing canvas roughjs/fill painter and derive arrow targets from the same geometry. Slides and vector get a `chart` kind; docs and sheets reuse that renderer without replacing their document/grid models. An arrow binds to a stable series/data-row identity, not a bar's current pixel position. Start with bar, line and pie charts, including annotations; defer live sheet links until their identity, refresh and permission contracts are explicit.

**Status:** Proposed, not implemented. Audit against the repository on 2026-09-07. This is a companion to [PROPOSAL_GRAPHS.md](PROPOSAL_GRAPHS.md), recommending changes to its architecture and sequencing; the original is left intact. Here, "graphs" means data charts, not graph/network diagrams.

## 1. Audit of the original proposal

The original gets several important decisions right: a shared editor, a small initial chart vocabulary, structured data rather than saved pixels, explicit dimensions, snapshot-first cross-app copy, and handling empty/invalid data. Keep those. Its rendering choice and host integration plan no longer fit the current engine or the requirement to annotate individual marks.

| Finding | Evidence and consequence | Recommendation |
|---|---|---|
| Recharts is selected for React composition, not canvas parity | The proposal's `EigenChart` delegates drawing to Recharts. The current canvas draws through `RoughGenerator`, its own options assembly, and `drawableToSvg` in `packages/lib/src/vector/kinds/render-utils.ts`. Merely choosing SVG or matching colours does not reproduce that output. | Own the geometry contract and use the existing painter; evaluate Vega for layout rather than rebuilding chart mathematics. |
| Vector is missing; the slides design is obsolete | [SLIDES.md](../SLIDES.md) describes `CanvasEditor`, `elements`/`frames`/`meta` and the shared registry, not the proposed `SlideObject`, `use-deck.ts` and `ReadOnlySlideObject` integration. | One native kind serves both canvas apps. Do not recreate a separate slides object model. |
| There is no identity for an individual mark | The proposed columns and series use display names; rows are anonymous arrays. Duplicate/renamed headers and reordered categories make labels or array offsets unsafe binding keys. | Persist column, series and row IDs before shipping arrows. |
| Existing arrow binding does not target chart internals | `Binding` in `packages/lib/src/vector/types.ts` contains only `elementId` and `fixedPoint`. `boundEndpoint` docks against the whole element outline. | Extend the binding contract with semantic subtargets; a proportional point on the outer chart box is insufficient. |
| The registry is a good starting point, not a complete annotation implementation | `KindSpec` exposes one outline; `defineKind` supplies four box anchors. `OutlineShape` has no circular-sector variant. | Add an optional subtarget geometry seam, including an honest pie-sector implementation. Do not put chart-specific branches throughout the tools. |
| The proposed sheet overlay and history are a second object system | [SHEETS.md](../SHEETS.md) uses workbook snapshots plus ops and engine undo. `ImgBoxs/index.tsx` already uses `ObjectTransform`; its active image is at z-index 20, not 300. | Keep chart records on the workbook persistence/undo path and use the existing overlay coordinate regions and transform chrome. No bespoke mouse-resize implementation or z-index 250. |
| Docs registration is frontend-only and uses an old image pattern | The current shared `FigureNode` is in `packages/lib/src/docs/eigendoc/nodes/figure.ts`; `getDocExtensions` is shared with server reconstruction. The app's figure view uses `ObjectTransform`. | Add a shared chart node schema, a frontend node view, and static preview/export renderers together. |
| "SVG prints well; no special handling" is not an export plan | [EXPORT.md](../EXPORT.md) has separate Tiptap, canvas and sheet renderers; DOCX and XLSX are not browser SVG renderers. [DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md) requires bounded Worker execution. | Make preview and export part of each host's delivery, with explicit format fallbacks. |
| A debounced `onChange` is not a source consistency contract | Formula dependents, peer ops, undo, snapshot replacement, sorting and structural edits can change chart inputs. A renderer must also work without an open workbook. | Extract from the same materialized data on both sides; observe committed batches, not just the initiating cell or a captured workbook reference. |
| The source-range policy is underspecified | "Do not adjust ranges" silently changes which records a chart represents after an insertion. The claimed Google Sheets equivalence is not established by this audit. | Specify positional versus record identity and structural-edit behavior explicitly. Do not justify behavior with an unverified product comparison. |
| Atomic JSON lacks an editing-conflict policy | A JSON scalar prevents partial JSON merges, but concurrent edits to that scalar resolve last-writer-wins for the whole definition. | State that limitation and prevent a stale chart editor draft from silently replacing a peer's newer definition. |
| Accessibility, export and identity arrive too late | The phase list delays table access and SVG export until polish, and references different phase numbers for live linking in different sections. | Deliver a complete static vertical slice first, including table access, semantic bindings and output fidelity. |

The original library size, animation and API comparisons are not measurements of Eigen's current production bundle. They should not drive this decision. Mature data/layout architecture matters more than an existing hand-drawn appearance: evaluate a bounded Vega adapter before committing to custom layout, without introducing React, animation or DOM measurement into Eigen's painter.

## 2. What to build

**A semantic object with an SVG representation.** Keep the data, configuration, style and seed editable. SVG is derived output for the live surface, clipboard fallback and downloads. Saving only SVG would lose data editing, meaningful links and durable mark identity. Saving every bar as an independent scene element would create the opposite problem: users could move marks away from their data, and data refresh would become an object reconciliation job.

| Approach | Decision |
|---|---|
| Recharts/Nivo with a canvas-looking theme | Reject: separate drawing rules and no shared semantic docking geometry. |
| Render a chart, then "roughen" its SVG DOM | Reject: depends on library markup and reconstructs geometry after layout; easy to diverge between browser and Worker. |
| Store SVG as an image | Offer only as an explicit flattened copy/export, not the native object. |
| Persist every mark as a rectangle/ellipse | Reject as the normal model. A future "Convert to shapes" could intentionally discard chart semantics. |
| One chart kind, derived marks, shared canvas painter | Recommend: one movable object, with meaningful internal attachment targets. |
| Vega layout/scenegraph adapted to Eigen geometry | Preferred prototype: reuse mature chart computation while keeping rendering and semantic bindings native. |

All four apps should offer the same chart/data editor and style vocabulary. Native canvas arrows can point from any object to a chart mark in vector and slides. Docs and sheets need a bounded annotation surface inside a chart figure, rather than document-wide arrows crossing paragraphs or grid cells. That annotation surface is part of this proposal, not something obtained automatically by sharing SVG.

## 3. Rendering architecture

```text
validated chart definition + resolved table + persisted appearance + logical box
                              |
                layoutChart (Vega adapter candidate)
                              |
              geometry + labels + semantic mark targets
                     /                      \
          shared canvas painter        binding resolver
                     |                      |
                SVG fragment       arrow endpoint / outline / heading
                     \                      /
                       resolved scene
                              |
           live view / thumbnail / preview / SVG / HTML / PDF
```

### Reuse mature layout: Vega first

**Recommendation: prototype [Vega](https://vega.github.io/vega/) before writing our own chart layout engine.** Its separation is data arrays -> transforms/scales/encodings/layout -> scenegraph -> renderer. It supports headless SVG, documents [`view.scenegraph()`](https://vega.github.io/vega/docs/api/view/#view_scenegraph), and exposes a [custom renderer registration interface](https://vega.github.io/vega/docs/api/view/#renderModule). Vega is BSD-3-Clause licensed. This is a stronger architectural reference than roughViz's browser-oriented D3/roughjs integration.

Keep Eigen's bounded `ChartDefinition` and flexible table input, translating them into trusted Vega templates. Vega's [data model](https://vega.github.io/vega/docs/data/) accepts record arrays; Eigen's column-oriented or matrix input can normalize into those records at one adapter boundary. Pass copies carrying explicit Eigen row/series IDs, because Vega's runtime tuples are mutable and its generated IDs are not persistent document identity. Extract geometry, labels, group transforms, clipping and semantic IDs into an Eigen-owned layout result. The canvas painter draws that result; arrows resolve against it. Do not recover semantics by parsing generated SVG.

**Headless does not mean pure or synchronous.** Vega is a stateful dataflow runtime whose evaluation may be asynchronous. Keep it outside the synchronous kind `render` method: prepare a revision-keyed layout before painting, discard stale completions, and publish layout plus binding targets together. The browser and document-transform Worker must run the same adapter. A resize preview needs the same prepared geometry for both chart and arrows; pan/move must not rerun layout. If this requires excessive changes to the canvas rendering contract, that is a reason to reject the adapter, not hide an async runtime inside a supposedly pure function.

The integration has explicit constraints: no arbitrary user-authored Vega specifications, expressions, event streams or URL/file loaders; only trusted templates over validated data. Use identical font measurement, dimensions and locale policy on client and server: Vega's canvas-measured text and headless fallback metrics can otherwise produce different layouts. Preserve all existing Eigen paint semantics, including corners and rough overshoot, when adapting scenegraph geometry. Export through Eigen's painter as well: Vega's `toSVG()` selects its SVG renderer, so registering another renderer does not automatically change that export path.

The alternatives remain useful references, not equal fits. [Observable Plot](https://observablehq.com/plot/) has a clean accessor/channel data API, but its output contract constructs DOM nodes, Node rendering needs a DOM implementation, and it has no built-in pie mark. [ECharts](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/) has mature flexible datasets and DOM-free SVG SSR, but adapting its zrender displayables or series-specific layouts is a heavier boundary than Vega's documented scenegraph. [roughViz](https://github.com/jwilber/roughViz) is useful for visual examples, not the primary foundation for renderer architecture.

The decision prototype is grouped bars, gapped lines with dots, and pie through **Vega -> Eigen layout -> existing painter**, in both a browser and an actual Bun Worker. Verify labels, clipping, reorder-stable IDs, semantic endpoints and canonical SVG parity; measure startup, updates, resizing, dependency cost and cleanup. Bun compatibility and those costs are not yet established. Prefer the adapter if it saves substantial layout work through supported interfaces and meets the interaction budget. Otherwise retain a small custom layout using mature D3 scale/shape primitives, documenting the measured reason. Vega-Lite compilation is optional later; it is not required for the initial three trusted templates.

### Shared layout adapter, pure painter

Put the chart layout adapter, validation and mark geometry beside the canvas core, for example `packages/lib/src/vector/charts/`. Put shared data/configuration types in `packages/lib/src/types/chart.ts`. The native adapter is `packages/lib/src/vector/kinds/chart.ts`; its `render` consumes prepared layout synchronously and returns `{ svg }`. Extending render context and memoization to carry prepared chart layouts is part of the Vega prototype, not a facility the current registry already provides.

React components in `packages/ui/src/components/charts/` own the wizard, data table, preview and accessible interaction, not scales or drawing. A standalone chart view calls the same pure renderer as the kind. The canvas React kind supplies its icon, label and panel/editor entry. Apps only connect insertion, selection and persistence.

Export reusable helpers through `@workspace/lib/vector`, types through `@workspace/lib/types/chart`, and shared UI through its area barrel; regenerate [SHARED-PRIMITIVES.md](../SHARED-PRIMITIVES.md) during implementation. Backend code must never import a hook barrel, `packages/ui` React code, or `packages/sheet` through lib. A sheet adapter may pass lib a `CellMatrix`; lib must not accept `WorkbookInstance` or call into the sheet package.

No Eigen painter fetches a sheet, writes Yjs, measures a browser element, or starts a timer. Width and height are resolved by the host before layout. The layout adapter owns any runtime lifecycle and disposes it explicitly; the layout result is derived data, not another persisted source of truth.

### Exact canvas paint semantics

Reuse or narrowly extract the existing painter; do not copy its constants into `chart-theme.ts`.

| Concern | Required behavior |
|---|---|
| Sketch options | Same `baseRoughOptions`, dash handling, multistroke policy, fill weight, hachure gap, vertex preservation and small-shape roughness adjustment. The adjustment uses the **mark's** dimensions, not the enclosing chart's dimensions. |
| Bars and point markers | Derived rectangles and ellipses use the same geometry and generator choice as equivalent canvas shapes, including corner treatment and ellipse curve fitting. These are temporary drawing records, not Yjs children. |
| Lines and wedges | Reuse the common rough options and SVG serializer. Add only the missing path/sector geometry; pie is not an ellipse with an approximate rectangular hitbox. Line dots are real mark targets. |
| Fill | Use the canonical `Fill` codec and its solid/gradient paint plus `hachure`, `cross-hatch`, `solid`, `zigzag` style. Preserve the other half when changing paint or hatch. Reuse the OKLab gradient stops and transparent-stop treatment. |
| Randomness | Derive each primitive's nonzero seed from the chart's persisted seed and stable semantic ID/role. Never from row position, value, render order, time or an SVG instance ID. A data reorder must not reroll every hatch. |
| SVG references | Each fragment owns its gradient and clip definitions. Scope IDs by render instance, chart and mark, using the existing safe-ID encoding. A thumbnail and editor can show the same chart simultaneously without ID collisions. Keep references in SVG attributes, not CSS `url(...)`. |
| Opacity | Apply object opacity once on the enclosing layer. Do not multiply it into each overlapping mark as well. |
| Typography | Plain SVG text, with explicit persisted fonts, sizes and colours; reuse canvas font metrics and exported font embedding. No HTML `foreignObject` is required for chart labels. |

The current helpers are typed around existing kinds and do not all have public barrel exports. Sharing them may require a small structural paint-input type and a common path painter. That refactor must keep existing canvas output unchanged; introducing a second implementation with the same-looking parameters is not reuse.

Define appearance ownership explicitly. The chart element owns base stroke/roughness/seed/opacity plus typography; its ordinary `fill` is the chart-box background. Series fills, and per-category fills for pie, live in chart configuration as canonical `Fill` values. The chart panel labels background and mark styling separately and uses the existing property controls. A "change all series hatch" action preserves each series' paint.

Assign initial colours from the existing Eigen palette and persist them against series/category IDs; reordering or hiding data must not reassign colours. Axes, ticks and grid lines use the shared line painter with chart-defined roles, not a Recharts/CSS styling layer. Text remains normal glyphs, as on the canvas.

Creation materializes style defaults once: vector starts from `VECTOR_STYLE_DEFAULTS`, slides from `SLIDES_STYLE_DEFAULTS`; docs/sheets get an explicit chart creation preset. Reopening or pasting does not restyle an existing chart to the destination app. App dark mode changes editor furniture, not stored document colours; follow the canvas paper convention.

**Parity means the same layout, primitive paths and paint options for the same inputs.** It does not promise identical raster pixels across unrelated font engines. Compare canonical SVG output and compare screenshots in controlled renderers with the shipped fonts.

### Logical dimensions, clipping and text

Lay out at the chart's logical document size. A slide thumbnail scales the finished composition; it must not recompute ticks or hide legends because its screen width happens to be 180px. A real user resize may recompute layout, and attached arrows must use that same recomputed layout.

Use deterministic tick selection, formatting and label truncation. Pin locale/time-zone policy rather than inheriting the viewing device's defaults. Reuse `font-metrics.ts` for vertical placement, but do not mistake it for horizontal text measurement: v1 needs bounded label slots and a deterministic fit/truncation policy, proven with shipped fonts in the prototype. Full labels remain available in the table and tooltip.

Leave explicit padding for labels, strokes and rough overshoot; clip plotted marks at the plot region when needed, not the entire element indiscriminately. The geometry used for picking must respect that clip. Reject impossible sizes with an actionable editor message; a stored malformed or unsupported chart renders a visible placeholder, not a silently missing object.

## 4. Data model and durable identity

Retain the original flat-table idea, but distinguish identity from text. The following is a proposed contract sketch, not an already-exported type:

```typescript
type ChartCell = string | number | null;

type ChartTable = {
    columns: { id: string; label: string; kind: 'category' | 'number' }[];
    rows: { id: string; values: ChartCell[] }[];
};

type ChartSeries = {
    id: string;
    columnId: string;
    label: string;
    fill: Fill;
};

type ChartMarkRef = {
    seriesId: string;
    rowId: string;
};
```

`Fill` above is the existing shared type, not a new chart-specific fill shape. Values follow the table's column order; configuration refers to column IDs. IDs survive label changes, reordering and edits. Duplicate labels are legal; duplicate IDs are not. Inline row IDs are allocated once on insertion, never rebuilt from the label or numeric value. Restoring a deleted row by undo restores its ID.

Use a versioned, validated definition with a discriminated chart encoding: bar/line have a category column and one or more series; pie has one numeric series and category fills keyed by row ID. Expose only implemented kinds and options. Do not advertise scatter/area/stacking in the v1 union and then quietly render something else.

A canvas chart stores its definition in a JSON scalar beside its ordinary scalar geometry/appearance fields. Different charts merge independently; concurrent definition edits to one chart are whole-definition last-writer-wins. The shared editor works on a local draft and checks that its base definition is still current before Apply, offering reload/reapply rather than silently overwriting peer changes. Apply is one sealed transaction; Cancel writes nothing.

### Initial numerical behavior

Bar, line and pie should share extraction and validation, not numeric coercions hidden inside individual React wrappers.

| Input | v1 behavior |
|---|---|
| Finite numeric value | Plot it; negative bars extend from the zero baseline. A bar scale includes zero. |
| Missing value or formula error | Preserve a missing value and its diagnostic; no zero-height bar pretending it is zero. Line charts break at missing points rather than silently bridging them. |
| Zero | Valid bar/line data, distinct from missing. A zero-height bar retains a baseline attachment point. |
| Pie with negative values | Show a configuration/data error, not absolute values or silently omitted negatives. |
| Pie with total zero or no usable values | Visible "No data" state. Zero slices do not create fictitious wedges. |
| Constant series, one point, empty table | Deterministic nondegenerate scale or explicit empty state; no NaN/Infinity SVG coordinates. |
| Duplicate category labels | Separate rows and targets, identified by row IDs. No implicit aggregation. |

Categorical line charts with visible point markers satisfy the requested "dots on a line". Time axes, scatter plots, aggregation, stacked bars and smoothing are later features. A future time column must carry explicit type/epoch semantics; checking one exact number-format string is not a reliable date detector.

## 5. Arrows attached to chart marks

### Persist semantics, derive coordinates

Extend the parsed binding into two forms, while continuing to read existing box bindings:

```typescript
type Binding =
    | { elementId: string; fixedPoint: [number, number] }
    | {
          elementId: string;
          target: { kind: 'chart-mark'; seriesId: string; rowId: string };
          port: 'auto' | 'value';
      };
```

This is a proposed replacement contract for the existing private `Binding` type. The chart is still the forward target `elementId`; the reverse arrow index remains derived. IDs within a chart are scoped to that chart. A binding to the chart's outer box remains possible and behaves like today's shape binding.

`layoutChart` must return mark geometry and semantic ports alongside its draw instructions:

| Mark | Default semantic attachment | Additional geometry |
|---|---|---|
| Bar | `value`: centre of the value-end cap, whether above or below zero | Rounded rectangle outline for `auto` boundary docking; a zero bar gets a baseline point. |
| Pie slice | `value`: outer arc at the slice's angular midpoint | Exact sector hit region and boundary for `auto`; include the full-circle single-slice case. |
| Line point | `value`: the data-point marker, approached at its boundary so the arrowhead does not cover it | Ellipse outline; missing points expose no target. |

For `auto`, approach from the arrow's adjacent segment and dock on the selected mark's boundary using the same gap policy as canvas shapes. For `value`, keep the semantic port as values, layout or arrow direction change. Rotation transforms both the port and its outward normal through the chart box into scene/frame coordinates. Do not call the ordinary whole-chart `outlinePoint` after resolving a mark: that would move the endpoint back to the outside of the graph.

Dock against the unjittered geometric outline, as the canvas already does, not a random rough stroke fragment. The visible hatch does not change which mark an arrow targets.

### Extend the registry, not every consumer

Add an optional subtarget interface to the kind contract that resolves a semantic reference and hit-tests possible references from a pointer. Return geometry, port/normal and routing bounds as plain data. Ordinary shapes continue to use their current single-outline path. Avoid fake persisted bar elements, synthetic scene IDs and DOM `getBBox()` queries.

The present `OutlineShape` cannot express a pie sector. Add a sector primitive with shared path, containment and intersection logic, or a common bounded approximation with an explicit accuracy contract. **Recommendation: exact circular-sector geometry** for v1 pie. A bounding rectangle or the full pie circle is not a substitute.

Update the complete binding lifecycle, not only arrow creation:

| Surface | Required change |
|---|---|
| Codec and reader | Decode/validate both forms; check target kind and scope; preserve valid unresolved mark references. |
| Tools and focus handles | `tools/binding.ts`, endpoint drag and point-handle previews carry a semantic candidate, not just a shape ID and ratio. |
| Geometry | `boundEndpoint`, the opposite-end aim, `followBindings` and rotated transforms resolve the selected mark. Two ends can bind to different marks in the same chart. |
| Elbows | Resolve the selected mark's bounds/port/heading for both derived routes and `fixedSegments` updates. The enclosing chart rectangle must not obstruct access to an interior point. |
| Gesture and definition writes | Native chart edits and any resulting committed arrow geometry share the existing sealed transaction. Local resize previews use previewed chart layout. |
| Read-only rendering | Resolve chart-dependent endpoints from the current definition before bounds, hit tests, labels and rendering, even if no writer tab has opened the document. |
| Memoization | `ElementLayer.sameRouteContext` currently considers only derived elbows. All arrows with mark targets depend on chart definition/data/layout, including straight, curved and pinned arrows. |
| Duplicate/paste/frame operations | Remap the enclosing chart ID, retain local row/series IDs, and clear references outside the copied set. Enforce same-frame or same-embedded-figure bindings. |

Use one pure scene-resolution pass for semantic endpoints across live, server and clipboard output. Existing local writes can continue storing the settled arrow geometry for undo and fallback; those stored endpoints are not authoritative over a resolved mark. A remote definition edit or source refresh must not require every viewer to write corrective geometry into Yjs.

For elbows, the selected mark replaces the chart box as that end's routing obstacle. v1 does **not** promise routing around every bar, label or grid line: today's router considers the bound targets, not arbitrary scene obstacles. Preserve that bounded scope. Resolve a rotated port's outward normal to a supported cardinal heading; every routed/pinned segment stays axis-aligned, including the terminal leg. Do not introduce a diagonal terminal segment that the pin editor cannot represent.

### Missing targets and interaction

Deleting/temporarily filtering a row, hiding a series, a missing numeric value, or a zero pie slice may make a valid identity unresolvable. Keep that semantic reference and the last committed endpoint; show an unresolved-target indicator and offer reattach/detach. Never silently retarget to the row now occupying its old index, to a matching label, or to the whole chart. If undo or a later refresh restores the same identity, it resolves again. Deleting the chart itself follows normal dangling-element behavior.

Changing chart type preserves attachment when the same series/row is represented; otherwise it becomes unresolved. Exports containing unresolved annotations surface a warning and a visible explanatory note, rather than presenting a stale endpoint as successfully attached. A read-only render never repairs stored data.

While dragging an arrow endpoint, highlight the specific mark and show its label/value. Resolve overlap deterministically: eligible visible chart/scene layer first, then nearest eligible mark/port with a stable-ID tie break. Respect clipping and use the existing screen-space/coarse-pointer tolerance policy, capped for dense charts. Keep Ctrl/Cmd's binding suppression. A normal click selects the whole chart; double-click or Enter opens its editor. Tooltips must not steal pointer capture from move/resize.

Provide a keyboard route through the data table's rows/series to select an attachment target. A title and "View data" table are first-release requirements, not polish; colour and hover alone cannot communicate chart values or annotation targets.

## 6. Integration in all four apps

### Vector and slides: native chart element

Register the chart in both kind registries and the bindable type union. Let `CanvasEditor`, `ElementLayer`, `FrameView`, arrange, comments and search consume the kind rather than adding application rendering branches. Add chart fields to the typed patch surface in `use-canvas-doc.ts`.

The code currently also has `TOOL_ORDER`, `CREATION_ORDER` and `VectorElementPatch`; registration is not literally just one new registry line. Add the kind to field enumeration order and update the corresponding completeness tests. Recommend `creation: 'none'` initially, inserted through the shared toolbar's Insert menu and wizard, like an explicitly inserted object rather than a drag-created empty chart.

The kind's `searchText` returns title, labels and series names; expose its `fontFamily` in the kind fields so current font collection can see it. One chart remains one comment/selection/z-order object. Its marks are not separate comment objects in v1.

### Docs: a chart figure in document flow

Add a shared chart node to `getDocExtensions`, with app-specific NodeView behavior layered on it. Follow current figure placement/width/alignment conventions, not old `ResizableImage` code. Decide schema grouping explicitly: today's figure is an inline atom with block/wrap layout; a true block-only chart is possible but must be tested inside paragraphs, lists and tables rather than assumed equivalent.

Recommend a block-layout chart figure initially, with stored logical scene dimensions and a document width. Height follows the figure aspect ratio. Reflow scales the whole figure, including annotations, and does not change data layout. No page-space `x`/`y` or cross-paragraph arrows.

For annotations, the node carries a bounded local scene: exactly one chart plus canvas arrows and optional text labels, with a logical viewport. It is an embedding envelope, **not** children stored inside the chart element and not recursively nestable. Render it using the same scene machinery. An "Annotate" dialog mounts shared canvas interaction over a draft of that scene; Apply writes one node transaction, Cancel none.

`useCanvasDoc` currently owns a top-level document/provider, and `CanvasEditor` takes its `CanvasDoc`. A nested editor therefore needs a narrow, reusable in-memory/draft adapter for that editing contract, not another websocket provider or a fake slide frame: slide frames are fixed 1920x1080. Separate the needed interaction/document adapter from network lifecycle only where this integration requires it.

Add static chart-node rendering to doc export and quick preview, plus chart text to the doc search/extraction path. Test HTML serialization/import so an editor-only node is not dropped by a server schema or sanitizer.

### Sheets: workbook-owned floating chart figure

Recommend a keyed `Sheet.charts` collection in the shared sheet model, each entry holding figure geometry and the same bounded local scene. Persist it through the existing snapshot/op pipeline and edit it through engine recipes. Do not introduce an independent Yjs root and a second undo manager just for charts.

Materialize the collection wherever a sheet enters the engine/replay path, following the existing materialize-before-patching discipline. Cover snapshot encode/decode, add/duplicate/delete sheet, remote ops, reload, version restore and rejected/no-op writes. A move, resize or annotation Apply is one engine undo step. This does not claim to fix the existing workbook's broader positional-concurrency limitations.

Place figures in the same scroll/freeze coordinate regions as floating images and reuse `ObjectTransform`. Use a shared overlay selection/order policy with images; do not invent fixed high z-index values or allow a selected chart to obscure portaled menus. Persist document geometry, not scroll-adjusted screen coordinates.

"Insert chart from selection" initially takes a typed **snapshot** from the current computed table, allocates stable IDs and opens the shared wizard. It remains fully editable and annotatable in all four apps. Clearly label it as a snapshot; do not imply it follows subsequent cell edits.

### Annotations outside canvas apps

Docs and sheets use the same bounded figure envelope and annotation editor. A wrapper can store a serialized scene on the docs node and through the sheet record without changing the scalar-only native element contract. Draft history is local to the open annotation dialog; Apply enters the host's history once.

No arrows between separate sheet figures or between a figure and arbitrary cells/paragraphs in this proposal. Those would require a host-wide object layer and its own anchoring rules. Native vector/slides arrows remain unrestricted within their scene/frame.

## 7. Live sheet data: a separate consistency contract

Keep source linkage outside the renderer. Distinguish inline/snapshot, same-workbook range and cross-document range. Preserve `ownerId`, `mountId`, `pathId`, `sheetId` for cross-document references; do not fetch the current user's similarly named sheet as a fallback.

**Same-workbook live charts come before cross-app live links**, but after the static/annotation slice. Extract from the committed, materialized workbook on the frontend and from snapshot-plus-replay on the server, using one pure cell-table adapter. Follow existing formula recalculation policy; previews must not gain an unrestricted new recalc pass.

Derive local live data rather than having every viewing client rewrite a cached definition on every cell change. Invalidation covers dependent formula results, peer batches, undo/redo, sort/filter, row/column changes, sheet deletion and snapshot replacement. Coalesce extraction work if necessary, but bind rendering and arrow resolution to the same resolved revision; no "new bars, old arrows" intermediate frame.

### Identity is the prerequisite, not an A1 string

Eigen's grid is currently positional; it has no durable row/column IDs. [PROPOSAL_SHEETS_YJS_WORKBOOK.md](PROPOSAL_SHEETS_YJS_WORKBOOK.md) describes the larger stable-ID direction, not an implemented facility charts can assume.

For live **record-following** annotations, recommend an explicit unique, non-empty key column. Derive row identity from its typed key, not its row number or display label. A key edit is a deletion plus insertion; duplicate/missing keys suspend affected bindings with a visible diagnostic. Do not append an occurrence index to hide ambiguity.

A range without a stable key may still draw a live chart, but must not offer record-following mark bindings. Existing bindings from a snapshot require explicit mapping to the chosen keys when linking, or remain unresolved. Binding to the whole chart box remains available. This is preferable to promising that an arrow follows "Alice" while actually following cell B7.

Range and value-column references still need insert/delete/move handling even with row keys. Define structural transforms beside the existing row/column machinery and apply them in the same operation batch. Do not parse and rewrite A1 strings in React. Sorting must move key/value pairs together; concurrent structural edits inherit the engine's known limits. If a mapping cannot be established unambiguously, mark the source unresolved and require reselection rather than guessing.

Recommended range semantics: an insertion before the range shifts it; an insertion within its bounds expands it; an insertion immediately after it does not. Deletion shrinks it, and deletion of the entire range or a required key/value column invalidates that source. Test boundary positions, cut/move and their inverses explicitly. These are proposed Eigen rules, not a claim of another spreadsheet's exact behavior.

### Cross-document refresh and sharing

Start with explicit **Refresh from sheet**, not background refresh by every viewer. A successful refresh commits a complete table plus its source revision/time into the destination chart in one edit; reject a stale response if the user changed the source/configuration while the request was in flight. Failure preserves the previous snapshot and reports whether access, deletion or availability prevented refresh. Unlink retains that snapshot and semantic IDs.

A linked snapshot is a **copy of source data into the destination document**. Anyone allowed to read the destination can read those copied values, including through clipboard/export. Show that consequence when linking/refreshing. Revoking access to the source cannot retract already-shared snapshots.

A refresh requires read permission on the source and write permission on the destination; rendering the destination requires neither a source fetch nor source credentials. Use the Drive ACL wrapper and Home relay for cross-home work, owner-scoped query keys, input/range limits, and existing hook error handling. A guessed reference grants no access.

Automatic refresh is a later feature needing a designated writer and explicit grant/revocation policy. SSE should invalidate permission-scoped source revisions, not broadcast raw data or cause every viewer to persist it. Persisting a refreshed snapshot must also invalidate destination preview/search caches; a source-only SSE cannot refresh a cache keyed by destination file version.

## 8. Clipboard, export and resource bounds

### Editable copy versus flattened copy

Reuse the existing typed `elements` item for native charts and chart-plus-arrow selections. Define producer/consumer conversion for the bounded chart figure in docs/sheets; do not emit both native elements and a second independently accepted chart item for the same object.

Canvas-to-canvas paste preserves style, seed, geometry and definition, remapping chart IDs and arrow bindings together. A single chart with supported annotations can paste into docs/sheets as an editable figure. Arbitrary mixed canvas selections still use the existing SVG fallback rather than silently dropping unsupported elements. Unbound/external-to-selection arrows follow the existing remap policy.

The clipboard carries the current table snapshot by default; retaining a live source is an explicit paste/link choice with source validation. Scope local IDs to the copied chart, preserve actual figure width/height, and obey [CLIPBOARD.md](../CLIPBOARD.md)'s flavour arbitration so an SVG fallback and native chart do not paste twice.

Offer "Copy as SVG" / SVG download as self-contained derived output with embedded required fonts, no source credentials, no remote references and no hidden raw table/config metadata by default. Editable Eigen clipboard data is a separate, explicit carrier.

### Output support is a release requirement

| Surface/format | Planned behavior |
|---|---|
| Vector/slides live, thumbnail and present mode | Same chart kind and resolved arrow geometry; scale the completed scene. |
| Docs/sheets live | Same chart/figure renderer; host controls only placement and editing. |
| Server quick previews | Render charts through the existing per-type Workers. Bound chart marks as well as top-level elements; a single chart is not a loophole in the 500-element cap. |
| SVG and standalone HTML | Native paths/text/defs with resolved annotations, explicit dimensions, fonts and escaped labels. |
| PDF | Existing sanitized HTML/SVG through WeasyPrint; test local gradient/clip references and preserve complete annotated figures across pagination. |
| DOCX | Prove the existing converter's chart-image support. If inline SVG is not preserved reliably, deliberately rasterize the **same** rendered figure through a bounded off-thread path and surface the loss of editability. |
| XLSX | Do not assume ExcelJS writes native charts. First support an explicitly flattened chart image with drawing anchors, validating PNG generation and workbook image placement; native Excel charts and round-trip chart import are separate work. |

The image fallback is format-specific, not a second chart renderer. Keep the editable definition in Eigen; importing a flattened DOCX/XLSX image cannot reconstruct it. If a format fallback is not ready, return/surface a clear unsupported-content warning rather than claiming a complete export while silently dropping the chart.

Chart drawing stays inside the current transform runner. Do not put Recharts SSR, a new headless browser or chart CPU work on the API main thread. Update the existing typed protocol only when the format fallback actually needs new inputs/results.

### Validate before allocating or drawing

Use one limit table for encoded definition bytes, columns/rows/series, label length, numeric/geometry ranges, generated primitives, SVG bytes and annotations per figure. Provisional v1 ceilings to verify in the prototype: 256 KiB per definition, 2,000 rows, 32 columns, 12 series, 2,000 visible marks and 100 annotation elements per figure. A legal row count multiplied by series count can still exceed the mark cap; reject explicitly rather than silently sample.

Also bound per-document aggregate chart work and roughjs path-op generation; an output byte guard after generating millions of hatch segments is too late. Enforce these at UI/API/clipboard/document-read boundaries, not only during insertion. Benchmarks may justify changing the proposed numbers before acceptance.

Stored/clipboard JSON is untrusted: validate version, kind, dimensions, finite values, rectangular data, unique IDs and references. Escape all SVG text/attributes, use canonical paint/font validators and existing export sanitization; do not accept arbitrary SVG, HTML formatters, executable callbacks or external resource URLs in a chart definition. Preserve invalid definitions for recovery while showing a bounded error placeholder. New input is rejected with a specific error.

Memoize layout/paint by definition revision, logical size, persisted style and seed. Movement, pan and zoom should reuse the drawing; resolving several arrows to one chart should reuse its layout. Keep caches bounded and invalidate them on data, dimensions, fonts and style changes. No global never-evicted cache of every historical definition.

## 9. Delivery order and acceptance

Each phase is a vertical slice with persistence, undo and output coverage, not just a component that happens to render in React.

| Phase | Deliverable and gate |
|---|---|
| 0. Layout/rendering/binding prototype | Evaluate Vega -> Eigen layout -> pure canvas painter for grouped bars, pie sectors and gapped lines with dots, in browser and Bun Worker. Gate on supported APIs, font/layout parity, async resize behavior, stable IDs, binding geometry and measured runtime/dependency costs before choosing Vega or custom D3-based layout. Also measure chart limits and DOCX/XLSX fallback feasibility. |
| 1. Native chart and shared editor | Validated IDs/data, three chart types, styles, table access, SVG output, canvas insertion in **both** vector and slides. Legacy shape rendering/binding stays unchanged. |
| 2. Native semantic annotations | Straight, curved, elbow and pinned arrows follow marks through edits, resize, rotate, duplication and undo; read-only output resolves the same endpoints. |
| 3. Docs and sheets figures | Shared bounded annotation editor, shared docs schema/static rendering, sheet snapshot insertion and workbook history, editable cross-app copy and complete output behavior. This completes the first four-app release. |
| 4. Same-workbook live ranges | Batch-aware extraction, explicit key identity, structural reference handling, remote/undo/reload consistency. No per-viewer cache writes. |
| 5. Cross-document linking | Permission-checked manual refresh, copied-data disclosure, stale-response handling, unlink and destination-cache invalidation. Automatic subscriptions require a separate accepted policy. |
| Later | Time/scatter/area/stacked charts, arbitrary "convert to shapes", native Office chart import/export, and host-wide docs/sheets arrows. |

Acceptance examples must exercise the actual output and behavior:

1. **Paint parity:** Compare an isolated bar/marker with its equivalent canvas rectangle/ellipse across every fill style, gradients including transparency, stroke styles, roughness settings, corners and small dimensions. Existing shape SVG does not change after painter extraction.
2. **Determinism:** Render the same chart after reload, reorder, duplicate and in editor/thumbnail/export; normalize only instance-scoped SVG IDs. Data reorder preserves the seeds and style of unchanged marks.
3. **Semantic attachment:** Rename duplicate labels, reorder rows/series, change positive bars to negative/zero, alter pie proportions and move a line point. Each arrow still names the same series/row and meets the current intended mark.
4. **Lifecycle:** Delete/filter/restore a mark, switch chart type, delete the source/chart, duplicate a frame, paste a chart with two arrows, and undo/redo. No index-based retargeting or cross-frame references; unresolved state is visible.
5. **Geometry:** Nonuniform resize, rotated chart, two ends on the same chart, curved/multipoint shafts and pinned elbows agree in preview, pointer-up, reload, hit testing and export. A settled resolve is idempotent.
6. **Host persistence:** Two clients, offline edits/reconnect, docs schema reconstruction, sheet snapshot-plus-ops reload, sheet duplicate/delete and version restore preserve charts and annotations. Stale dialog Apply cannot silently replace a peer edit.
7. **Formats:** Open real SVG/HTML/PDF/DOCX/XLSX outputs in their consumers. Verify chart presence, labels, hatch/gradient appearance, annotation endpoints, dimensions and declared flattening. Preview caps never silently turn a full chart into a different dataset.
8. **Limits and access:** Oversized tables, hostile IDs/labels/fills, missing fonts, ambiguous source keys, revoked permissions and old refresh responses produce explicit bounded outcomes, without losing the stored figure or fetching unauthorized data.

Use the existing workspace test layout and runners: pure chart/binding contracts under `packages/lib/src/test/vector/`, sheet integration under `packages/sheet/src/test/`, and export/preview/restore routes under `apps/api/src/test/`. Follow [WORKING-METHOD.md](../WORKING-METHOD.md) for independent review and real browser/output verification, and run `bun run check` for implementation changes.

## 10. Decisions to approve before implementation

Recommended defaults are native semantic charts, a Vega layout-adapter prototype before custom layout work, one Eigen canvas painter, bar/line/pie first, mark-level arrows in the first four-app release, bounded annotations inside docs/sheets figures, snapshot-first data, and explicit key identity before live record-following annotations.

The meaningful scope choices are whether the first release must include live same-workbook ranges, whether bounded figure annotations satisfy docs/sheets or host-wide arrows are required, and whether explicitly flattened DOCX/XLSX charts are acceptable. None changes the central recommendation: **keep chart data and mark identity native; derive SVG and docking geometry together through the canvas engine.**
