# Charts & Graphs: Integration Proposal

## TLDR

Use **Recharts** (not Nivo) for chart rendering across Sheets, Docs, and Slides. Charts are stored as JSON
`ChartDefinition` objects in Yjs -- in a `Y.Map("charts")` for sheets, as Tiptap node attributes for docs, and as a
`ChartObject` slide element type for slides. The data format is deliberately kept simple: a flat table of columns and
rows, with no attempt at live cross-app data binding until Phase 5. Start with bar, line, and pie charts only.

## Critical Assessment of the Research

The research document (RESEARCH_GRAPHS.md) is thorough on integration mechanics but has several blind spots and one
significant library recommendation issue worth addressing before implementation.

### Library Decision: Recharts over Nivo

The research recommends Nivo. After reviewing the trade-offs against this specific codebase, **Recharts is the better
fit**. Here is why:

**Against Nivo:**

- Nivo's `@nivo/bar`, `@nivo/line`, `@nivo/pie`, `@nivo/scatterplot` must all be installed separately. Each pulls in
  `@react-spring/web` and d3 modules. Total gzipped cost is ~60-80 KB when you need 4+ chart types -- not the "~45 KB"
  the research suggests for individual packages.
- Nivo uses react-spring for animations. This is a second animation library in the bundle (Eigen uses no spring-based
  animations elsewhere). react-spring is ~15 KB gzipped on its own and its animation model (imperative springs) is
  foreign to the rest of the UI.
- Nivo's data format is **per-chart-type**. Bar charts expect `{indexBy, keys, data: [{category: "A", series1: 10}]}`.
  Pie charts expect `{id, value}[]`. Line charts expect `{id, data: [{x, y}]}[]`. This means our `ChartDefinition`
  must carry a translation layer per chart type, adding complexity the research glosses over.
- Nivo's theming API is powerful but rigid -- `NivoTheme` is a deeply nested object that does not compose well with
  partial overrides. Getting individual axis label truncation or responsive tick counts requires reaching into
  undocumented slots.
- Nivo's `Responsive*` variants use a `ResizeObserver` wrapper that fights with our own container sizing in Tiptap node
  views and sheet overlays, where the chart dimensions are known and passed explicitly.

**For Recharts:**

- Single package (`recharts`, ~45 KB gzipped, tree-shakeable). No extra installs per chart type.
- Native React component model: `<BarChart>`, `<XAxis>`, `<Tooltip>` are composable JSX. This is consistent with how
  Eigen builds UI -- shadcn/ui and Radix are the same pattern.
- Built-in `<ResponsiveContainer>` that actually works, plus explicit width/height props when we know the dimensions
  (sheets overlay, slides bounding box).
- Data format is uniform: `data` is always `Record<string, any>[]`. All chart types consume the same array, just with
  different child components declaring which keys map to what. This maps trivially to our inline data table format.
- SVG output by default. Prints well. `aria-label` can be added to the container `<svg>`.
- Active maintenance, large community, battle-tested at scale.

**Honest Recharts downsides:**

- Animation stacking: rapid data updates (<200ms apart) can cause overlapping transitions. Mitigated by debouncing
  data extraction at 200ms (the research already proposes this).
- Less polished default styling than Nivo. We need to explicitly theme every axis, grid, and tooltip. This is more
  work upfront but gives us full control.
- No built-in dark mode. We pass CSS variable values as props. Slightly more verbose than Nivo's theme object, but
  not materially different in effort.
- Scatter plots require `<ScatterChart>` which has a slightly different data model (`[{x, y}]`). Manageable with a
  thin adapter.

### Edge Cases the Research Misses

**Empty data.** A chart bound to an empty range, or a range where all values are null/empty strings. The component
must render a placeholder ("No data") rather than a broken SVG with zero-height bars or invisible lines.

**Non-numeric values in numeric columns.** Cells containing `#REF!`, `#DIV/0!`, `#N/A`, or plain text in a column
expected to be numeric. The data extraction layer must coerce these to `null` and the chart must handle sparse data
gracefully (skip nulls in line charts, show zero-height bars with a visual indicator).

**Negative values.** Bar charts must handle negative values (bars extending below the axis). Pie charts cannot represent
negative values -- the editor must warn or block. Stacked bar charts with mixed positive/negative values are a known
UX nightmare; defer to Phase 6.

**Date axes.** The research does not address time-series data. Cells formatted as dates (`ct.fa === "yyyy-MM-dd"`)
should be detected and the X-axis should use a time scale. Recharts supports `scale="time"` on `<XAxis>`. This is
Phase 6 but the `ChartDefinition` format must not preclude it.

**Long labels.** Category labels (X-axis) that overflow. The chart component must: (1) rotate labels 45 degrees when
they overlap, (2) truncate with ellipsis at a configurable max length (default: 20 chars), (3) show full text in
tooltip on hover.

**Small containers.** Slide thumbnails render charts at ~200px wide. At this size, axis labels and legends are
unreadable. Below 200px width, hide axis labels and legend entirely. Below 100px, render a simplified silhouette
(just the shapes, no chrome). This is a Phase 6 polish item.

**Deleted source sheet.** A chart in docs links to a sheet that gets deleted. The chart must fall back to its
`cachedData` and show a "Source unavailable" badge. The `cachedData` field must be mandatory for `sheet-range` data
sources, populated on every successful fetch.

**Resized source range.** If a user inserts rows within the chart's range (e.g., `A1:D10` becomes `A1:D11`), the
chart's range reference does NOT auto-adjust (unlike formulas). This is intentional and matches Google Sheets behavior
for chart ranges. The user must manually update the range. The research proposes auto-adjusting ranges -- I recommend
against this for Phase 1-4 because it requires hooking into sheet's row/column insert logic, which is fragile.

**Formula errors in cells.** `getCellValue` returns the cell's `v` field. For formula errors, `v` may be `undefined`
or contain an error string. The data extraction must check `cell.v` type and treat non-numeric values as null.

### Sheet Data Access Reliability

The research correctly identifies `WorkbookInstance` as the API surface. After reading the implementation:

- `getCellsByRange` delegates to `getdatabyselection` which iterates the 2D `data` array. It returns
  `(Cell | null)[][]`. This is stable -- the function has not changed structurally and its contract is simple.
- `getCellValue` has quirks: it special-cases dates (`ct.fa === "yyyy-MM-dd"` returns `m` instead of `v`) and inline
  strings (concatenates `ct.s` segments). For charts, we should read `cell.v` directly from the `getCellsByRange`
  result rather than calling `getCellValue` per cell, avoiding these special cases.
- The `chart_selection: any` in Context is dead code (initialized to `{}`). The research correctly says to ignore it.
- **Key risk**: sheet's `context` is managed by immer. Reading from it during render is fine, but we must
  not hold stale references across renders. The debounced data extraction must read fresh data on each tick.

### ChartDefinition Simplification

The research proposes a format with `categoryKey`, `series[]`, `xAxis`, `yAxis`, `yAxisRight`, `legend`, `animation`,
`colorPalette`, `backgroundColor`, `interactive`, `stacked`, `smooth` -- 14+ top-level fields. This is over-designed
for Phase 1. The format should start minimal and grow.

Additionally, storing the `definition` as a JSON string (as proposed for Tiptap node attrs and slide objects) is the
correct approach. Yjs handles string values atomically -- no partial merge conflicts on chart config changes.

## Specification

### ChartDefinition Format

```typescript
// packages/lib/src/types/chart.ts

type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'area';

type ChartDataSource =
    | { kind: 'inline'; columns: string[]; rows: (string | number | null)[][] }
    | {
        kind: 'sheet-range';
        ownerId: string;
        mountId: string;
        pathId: string;
        sheetId: string;
        range: string;           // A1-notation, e.g. "A1:D10"
        cachedData: { columns: string[]; rows: (string | number | null)[][] };
    };

type ChartSeries = {
    key: string;                 // Column name from data
    label?: string;              // Display name (defaults to key)
    color?: string;              // Override palette color
}

type ChartDefinition = {
    version: 1;
    type: ChartType;
    title?: string;
    dataSource: ChartDataSource;
    categoryKey: string;         // Column used for X-axis / categories
    series: ChartSeries[];
    stacked?: boolean;
    smooth?: boolean;            // Curved lines for line/area
    colorPalette?: string[];     // Override default EIGEN palette
}
```

This is 8 fields (9 counting version). The research's axis config, legend config, animation config, and secondary
Y-axis are deferred. Recharts provides sensible defaults for all of these. When users need axis labels or legend
repositioning, we add `xAxis?: { label?: string }` and `legend?: { position?: 'bottom' | 'right' | 'hidden' }` as
optional fields in a later phase.

### EigenChart Component API

```typescript
// packages/ui/src/components/charts/eigen-chart.tsx

type EigenChartProps = {
    definition: ChartDefinition;
    width?: number;              // Explicit width in px (sheets overlay, slides)
    height?: number;             // Explicit height in px
    interactive?: boolean;       // Tooltips on hover (default: true)
    animate?: boolean;           // Data-change transitions (default: true)
    className?: string;
}
```

When `width` and `height` are omitted, the component fills its parent via `<ResponsiveContainer>`. When provided, it
renders at fixed dimensions. This dual mode covers all three contexts: sheets (fixed), docs (width from resize handles,
height from aspect ratio), slides (fills bounding box).

Internally, `EigenChart` is a switch on `definition.type`:

```
definition.type === 'bar'     -> <EigenBarChart>
definition.type === 'line'    -> <EigenLineChart>
definition.type === 'pie'     -> <EigenPieChart>
definition.type === 'scatter' -> <EigenScatterChart>
definition.type === 'area'    -> <EigenAreaChart>
```

Each inner component maps `definition.dataSource` (inline or cached) to Recharts' data format and renders the
appropriate Recharts components with Eigen theming.

### Data Extraction (Sheets)

```typescript
// apps/sheets/src/components/sheets/hooks/use-chart-data.ts

function extractChartData(
    workbook: WorkbookInstance,
    sheetId: string,
    range: Selection
): { columns: string[]; rows: (string | number | null)[][] }
```

- Reads the first row as column headers (string values).
- Reads remaining rows as data. For each cell: if `cell.v` is a number, use it. If it is a string, use it (category
  column). If it is null/undefined/object/error, use `null`.
- Returns the flat table format matching `ChartDataSource.inline`.

This function is pure (no side effects, no hooks). It is called from a debounced effect that watches for op changes
affecting the chart's range.

### Theming

```typescript
// packages/ui/src/components/charts/chart-theme.ts

import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';

export const CHART_COLORS = EIGEN_ACCENT_COLORS_SHUFFLED.map(c => c.value);

export function getAxisProps() {
    return {
        tick: { fill: 'hsl(var(--muted-foreground))', fontSize: 12 },
        axisLine: { stroke: 'hsl(var(--border))' },
        tickLine: { stroke: 'hsl(var(--border))' },
    };
}

export function getGridProps() {
    return {
        stroke: 'hsl(var(--border))',
        strokeDasharray: '3 3',
    };
}

export function getTooltipProps() {
    return {
        contentStyle: {
            backgroundColor: 'hsl(var(--popover))',
            color: 'hsl(var(--popover-foreground))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 6,
            fontSize: 12,
        },
    };
}
```

CSS variables adapt to dark/light mode automatically.

### Integration: Sheets

**Storage:** Charts live in `Y.Map("charts")` in the Yjs document. Each entry is a JSON string keyed by chart ID.

**Overlay:** A new `ChartOverlay` component, sibling to `ImgBoxs` in the sheet overlay DOM. Each chart has
`{id, left, top, width, height, definition}` stored in the Yjs map. Rendered with absolute positioning, with z-index
250 (between images at 200 and active images at 300).

**Move/resize:** Follow the `ImgBoxs` pattern: mousedown on the chart body starts a move; mousedown on corner handles
starts a resize. Store updated position back to the Yjs map.

**Live updates:** The `onChange` callback fires on every edit. A debounced watcher (200ms) checks if any chart's range
overlaps with changed cells. If so, re-extract data via `extractChartData` and update the chart's definition in the
Yjs map.

**Toolbar:** Add an "Insert Chart" button to `ToolbarRightItems` in
`../../apps/sheets/src/components/sheets/toolbar.tsx`. It reads the current selection from `workbookRef.current.getSelection()`,
extracts data, opens the chart wizard dialog, and on confirm creates an entry in `Y.Map("charts")`.

### Integration: Docs (Tiptap)

Follow the `ResizableImage` extension pattern exactly:

**File:** `apps/docs/src/components/docs/extensions/chart-node.tsx`

- `Node.create({ name: 'eigenChart', group: 'block', atom: true, draggable: true })`
- Attributes: `definition` (JSON string), `width` (number), `alignment` ('left' | 'center' | 'right')
- `ReactNodeViewRenderer(ChartNodeView)` wraps `<EigenChart>` inside `<ImageResizeHandles>`
- Editor command: `insertChart(definition: ChartDefinition)` -- inserts the node with serialized definition

**Registration:** Add `ChartNode` to the extensions array in `../../apps/docs/src/components/docs/editor.tsx`, alongside
`ResizableImage` and `CommentMark`.

**Data source:** In Phase 1-4, docs charts use `dataSource.kind: 'inline'` only. The chart wizard provides a table
input for manual data entry. In Phase 5, `sheet-range` sources are supported via an API endpoint.

### Integration: Slides

**Type extension in `../../apps/slides/src/components/slides/types.ts`:**

```typescript
type ChartObject = BaseObject & {
    type: 'chart';
    definition: string; // JSON-stringified ChartDefinition
}

type SlideObject = TextObject | ImageObject | ChartObject;
```

**OBJECT_FIELDS:** Add `'definition'` to the `OBJECT_FIELDS` array in `use-deck.ts`.

**Rendering in `slide-object.tsx`:**

In `ReadOnlySlideObject`, add a `chart` branch:

```typescript
{obj.type === 'chart' && (
    <EigenChart
        definition={JSON.parse(obj.definition)}
        interactive={false}
        animate={false}
    />
)}
```

In `SlideObjectView`, add the same for non-editing mode. Double-click opens the chart editor dialog.

**Default chart object:**

```typescript
export const DEFAULT_CHART_OBJECT: Omit<ChartObject, 'id' | 'slideId' | 'definition'> = {
    type: 'chart',
    x: 240,
    y: 135,
    w: 1440,
    h: 810,
    rotation: 0,
    ...DEFAULT_BORDER,
};
```

### Integration: Clipboard

Extend `../../packages/lib/src/types/clipboard.ts`:

```typescript
type EigenClipboardChartItem = {
    type: 'chart';
    definition: ChartDefinition;
}

type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem | EigenClipboardChartItem;
```

Copy from sheets: serialize `ChartDefinition` with `dataSource.kind: 'inline'` (snapshot current data). Paste into
docs creates a `ChartNode`; paste into slides creates a `ChartObject`.

### Accessibility

- Chart container: `role="img"` with `aria-label` set to the chart title (if present) or a generated description
  ("Bar chart with 3 series").
- Keyboard: Tab focuses the chart. Enter opens the editor (in editable contexts). No keyboard navigation within the
  chart itself (defer to Phase 6).
- Screen reader alternative: a "View as table" toggle that renders the chart data as an HTML `<table>` below the
  chart. Phase 6.

### Printing

SVG charts print well by default. No special handling needed. Ensure `@media print` styles hide the chart toolbar
overlay and resize handles.

## Concrete File Changes

### New Files

| File | Purpose |
|------|---------|
| `packages/lib/src/types/chart.ts` | `ChartDefinition`, `ChartType`, `ChartDataSource`, `ChartSeries` types |
| `packages/ui/src/components/charts/eigen-chart.tsx` | Main chart component (type switch) |
| `packages/ui/src/components/charts/bar-chart.tsx` | Recharts `<BarChart>` wrapper |
| `packages/ui/src/components/charts/line-chart.tsx` | Recharts `<LineChart>` wrapper |
| `packages/ui/src/components/charts/pie-chart.tsx` | Recharts `<PieChart>` wrapper |
| `packages/ui/src/components/charts/scatter-chart.tsx` | Recharts `<ScatterChart>` wrapper |
| `packages/ui/src/components/charts/area-chart.tsx` | Recharts `<AreaChart>` wrapper |
| `packages/ui/src/components/charts/chart-theme.ts` | Color palette, axis/grid/tooltip style helpers |
| `packages/ui/src/components/charts/chart-utils.ts` | `resolveChartData()`, `suggestChartType()`, empty-data checks |
| `packages/ui/src/components/charts/chart-editor/chart-editor.tsx` | Chart creation/editing dialog |
| `packages/ui/src/components/charts/chart-editor/chart-type-selector.tsx` | Chart type grid |
| `packages/ui/src/components/charts/chart-editor/data-table-input.tsx` | Inline data entry table |
| `packages/ui/src/components/charts/chart-editor/series-config.tsx` | Series color/label config |
| `packages/ui/src/components/charts/chart-editor/chart-preview.tsx` | Live preview in editor |
| `apps/sheets/src/components/sheets/chart-overlay.tsx` | Floating chart overlays on the sheet canvas |
| `apps/sheets/src/components/sheets/hooks/use-chart-data.ts` | Data extraction from WorkbookInstance |
| `apps/docs/src/components/docs/extensions/chart-node.tsx` | Tiptap extension |

### Modified Files

| File | Change |
|------|--------|
| `../../packages/ui/package.json` | Add `recharts` dependency |
| `../../packages/lib/src/types/clipboard.ts` | Add `EigenClipboardChartItem` to union |
| `../../apps/slides/src/components/slides/types.ts` | Add `ChartObject` to `SlideObject` union |
| `../../apps/slides/src/components/slides/hooks/use-deck.ts` | Add `'definition'` to `OBJECT_FIELDS` |
| `../../apps/slides/src/components/slides/slide-object.tsx` | Add chart rendering branch |
| `../../apps/docs/src/components/docs/editor.tsx` | Register `ChartNode` extension |
| `../../apps/docs/src/components/docs/editor-toolbar.tsx` | Add "Insert Chart" button |
| `../../apps/sheets/src/components/sheets/editor.tsx` | Render `<ChartOverlay>`, pass workbook ref |
| `../../apps/sheets/src/components/sheets/toolbar.tsx` | Add "Insert Chart" button |
| `../../apps/sheets/src/components/sheets/hooks/use-sheet.ts` | Initialize `Y.Map("charts")` in Yjs doc |

## Chart Type Priority

| Priority | Type | Rationale |
|----------|------|-----------|
| 1 | Bar | Most common business chart. Covers grouped and stacked variants. |
| 2 | Line | Time series, trends. Trivial to add alongside bar (same data format). |
| 3 | Pie | Single-series categorical data. Different rendering path but simple. |
| 4 | Area | Line chart variant. Minimal additional code. |
| 5 | Scatter | Different data model (x/y pairs). Requires adapter layer. |
| 6+ | Doughnut, Radar, Heatmap | Niche. Add on demand. |

Horizontal bar charts are a `layout="vertical"` prop on `<BarChart>` in Recharts -- no new component needed.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Recharts animation stacking on rapid updates | Medium | Debounce data extraction at 200ms. Disable animation below 200ms update interval. |
| Fortune-sheet API instability | Medium | Access data only via `getCellsByRange`. Write integration tests that exercise the extraction path. |
| Chart overlay z-index conflicts with sheet UI | Low | Use z-index 250 (between inactive images at 200 and active images at 300). |
| Large chart definitions bloating Yjs documents | Low | JSON stringified definitions are typically 500-2000 bytes. Negligible compared to cell data. |
| Recharts bundle size impacting non-chart apps | Low | Charts are in `../../packages/ui` but tree-shaking ensures only apps that import chart components pay the cost. |
| Cross-app live linking complexity (Phase 5) | High | Defer entirely until charts are stable in single-app mode. Ship inline-data-only for Phases 1-4. |
| Stale `cachedData` in docs/slides after sheet changes | Medium | Always update cache on successful fetch. Show "last updated" timestamp. Manual refresh button. |

## Phases

### Phase 1: Core Chart Component

- Install `recharts` in `../../packages/ui`
- Create `packages/lib/src/types/chart.ts`
- Create `packages/ui/src/components/charts/` with `eigen-chart.tsx`, individual chart wrappers, and `chart-theme.ts`
- Handle empty data, null values, negative values
- Test with hardcoded inline data

**Deliverable:** `<EigenChart definition={...} />` renders bar, line, and pie charts with Eigen theming.

### Phase 2: Chart Editor

- Create `packages/ui/src/components/charts/chart-editor/`
- Chart type selector, inline data table input, series config, live preview
- `suggestChartType()` auto-detection from data shape
- The editor is a reusable dialog component, consumed by all three apps

**Deliverable:** Users can configure chart type, data, and series through a dialog.

### Phase 3: Sheets Integration

- Add `Y.Map("charts")` to the sheets Yjs document
- Create `chart-overlay.tsx` with absolute positioning, move/resize
- Data extraction via `extractChartData()` from `WorkbookInstance`
- "Insert Chart" button in toolbar
- Debounced live updates when cell data changes
- Chart selection, deletion, editing (re-open editor dialog)

**Deliverable:** Charts in sheets, live-updating on cell changes.

### Phase 4: Docs Integration

- Create `chart-node.tsx` Tiptap extension
- `ChartNodeView` with `ImageResizeHandles` (following `resizable-image.tsx`)
- "Insert Chart" toolbar button opening the chart editor with inline data input
- Register extension in editor.tsx

**Deliverable:** Charts as resizable, draggable blocks in documents.

### Phase 5: Slides Integration

- Add `ChartObject` type and `'definition'` to `OBJECT_FIELDS`
- Chart rendering in `ReadOnlySlideObject` and `SlideObjectView`
- "Insert Chart" in slides toolbar
- Chart section in properties panel
- Clipboard: copy chart from any app, paste into slides

**Deliverable:** Charts as positionable slide objects.

### Phase 6: Cross-App Live Linking

- API endpoint: `GET /api/drive/:ownerId/:mountId/sheets/:pathId/range`
- SSE event for sheet data changes
- `useChartData()` hook in `../../packages/lib` (resolves sheet-range, subscribes to SSE, caches)
- "Update from sheet" and "Unlink" actions in docs and slides chart toolbars
- Clipboard preserves sheet links with inline fallback

**Deliverable:** Charts in docs/slides live-update when the source sheet changes.

### Phase 7: Polish

- Scatter chart support
- Area chart support
- Auto-rotating long axis labels
- Small-container graceful degradation
- Date axis support
- Number formatting on axes (respect source cell format)
- Print CSS for chart toolbars/handles
- Accessibility: data table toggle, improved aria labels
- Dark mode testing
- Stacked/grouped bar chart variants
- SVG/PNG export
