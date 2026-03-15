# Graphs & Charts: Cross-App Architecture Research

> **Goal**: A single chart system that renders identically in Sheets, Docs, and Slides. Charts in Sheets are bound to
> cell ranges and update live. Charts in Docs and Slides can either embed inline data or link to a sheet for live
> updates.

## 1. Current State Analysis

### Sheets (fortune-sheet + Yjs)

- **Data model**: `CellMatrix` -- 2D array of `Cell | null`. Each cell has `v` (raw value), `m` (display value), `f`
  (formula string), `ct` (cell type/format).
- **Yjs sync**: Op-based. `Y.Map("state")` holds a JSON snapshot; `Y.Array("ops")` carries incremental ops. Local edit
  -> `onOp` -> Y.Array -> remote `applyOp()`. Snapshot debounced every ~1s (first flush is immediate, subsequent ones
  throttled via `setTimeout` with 1000ms delay).
- **Workbook API** (`WorkbookInstance`): Exposes `getCellValue(r, c)`, `getCellsByRange(range, options)`,
  `getSheet()`, `getAllSheets()`, `calculateFormula()`. Note: `getCellsByRange` returns `(Cell | null)[][]` (a 2D
  row-major array), not `CellWithRowAndCol[]`. The underlying implementation (`getdatabyselection`) iterates rows and
  columns, skipping hidden rows/columns, and returns a nested array of `Cell` objects.
- **Fortune-sheet chart support**: The original Luckysheet/fortune-sheet has `chart_selection: any` in `Context` (typed
  as `any`, initialized to `{}`) and locale files reference chart strings, but no chart rendering is wired up in
  Eigen's fork. This is dead code.
- **Canvas overlay pattern**: Fortune-sheet renders cells on a `<canvas>`. React components float above it via absolute
  positioning. The existing `ImgBoxs` component demonstrates this: it reads `context.insertedImgs`, positions overlays
  using `left/top` in pixels scaled by `context.zoomRatio`, and provides move/resize handles. `NotationBoxes` and
  `FilterOptions` follow the same pattern. Charts would do the same.
- **Reactivity callbacks**: The `Workbook` component accepts `onChange` (fires with `SheetType[]` after edits for
  snapshot persistence) and `onOp` (fires with `Op[]` for Yjs sync). Both are available for triggering chart updates.

### Docs (Tiptap + Yjs)

- **Extension system**: The `ResizableImage` extension at
  `apps/docs/src/components/docs/extensions/resizable-image.tsx` is the exact pattern for charts:
    - `Node.create()` with `group: 'block'`, `atom: true`, `draggable: true`
    - `addAttributes()` for persisted data (`src`, `width`, `alignment`)
    - `addNodeView()` -> `ReactNodeViewRenderer(ResizableImageView)` for React rendering
    - `addCommands()` -> `setResizableImage` for insertion
- **Collaboration**: Node attributes synced automatically via `@tiptap/extension-collaboration`.
- **Resize handling**: `ResizableImageView` wraps content in `ImageResizeHandles` from `packages/ui` and uses
  `updateAttributes` to persist width changes.

### Slides (Yjs objects)

- **Object system**: `SlideObject = TextObject | ImageObject`. `BaseObject` fields: `id`, `slideId`, `x`, `y`, `w`,
  `h`, `rotation`, `borderColor`, `borderWidth`, `borderRadius`.
- **Yjs storage**: Objects stored in `Y.Map("objects")` as individual `Y.Map` entries. The `OBJECT_FIELDS` array in
  `use-deck.ts` defines which fields are read from Y.Map entries. It already includes fields not in the TypeScript type
  (`shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY`), so adding `'definition'` follows established
  precedent.
- **Rendering**: `SlideObjectView` dispatches on `obj.type`. `ReadOnlySlideObject` handles presentation mode.
  `getObjectPositionStyle()` converts pixel coordinates (0-1920 x 0-1080) to percentage-based CSS via `pxToPercent()`.
- **Extension point**: Adding `ChartObject` requires: new type in the union, new branch in `SlideObjectView` and
  `ReadOnlySlideObject`, `'definition'` added to `OBJECT_FIELDS`, and a chart section in
  `slide-properties-panel.tsx`.

### Shared Infrastructure

- **Clipboard**: `EigenClipboardData` with typed items (`EigenClipboardTextItem | EigenClipboardImageItem`). Adding a
  `chart` variant is straightforward -- follows the same discriminated union pattern.
- **Colors**: `EIGEN_ACCENT_COLORS` (17 colors at the 500-weight row, index 5 of `EIGEN_COLOR_STEPS`).
  `EIGEN_ACCENT_COLORS_SHUFFLED` applies golden-ratio shuffling for maximum visual distinction between adjacent colors.
- **Resize handles**: `ImageResizeHandles` at `packages/ui/src/components/layout/media/image-resize-handles.tsx` shared
  between docs and slides.

---

## 2. Chart Library Comparison

### Requirements

| Requirement               | Weight | Notes                                                           |
|---------------------------|--------|-----------------------------------------------------------------|
| SVG output                | High   | Vector rendering in docs/slides; clean export to PNG/SVG        |
| React integration         | High   | Must be a first-class React component, not a wrapper            |
| Declarative API           | High   | Chart config must be JSON-serializable for storage in Yjs       |
| Theming                   | High   | Custom palettes + dark/light mode via CSS variables             |
| Animation / transitions   | Medium | Smooth transitions when data changes; disable in static contexts|
| Bundle size               | Medium | Eigen already bundles fortune-sheet; moderate size is OK        |
| Chart types               | Medium | Bar, line, pie, scatter, area, combo at minimum                 |
| Interactivity             | Medium | Tooltips on hover; must be toggleable per context               |
| Canvas fallback           | Low    | Only for large datasets (10k+ points)                           |
| Server-side rendering     | Low    | Not needed now; relevant for PDF export later                   |
| Active maintenance        | High   | Must have active community and regular releases                 |

### Library Analysis

#### Recharts

- **Rendering**: SVG (React components that render SVG elements)
- **Bundle**: ~45 KB gzipped (tree-shakeable)
- **API**: Composable React components (`<BarChart>`, `<Bar>`, `<XAxis>`, etc.)
- **Theming**: Props-based; no built-in theme object. Colors must be passed to each element.
- **Animation**: Built-in via `<Animate>` component. Transitions on data change use `isAnimationActive` prop.
  Known issue: animations can stutter with rapid data updates (sub-second). Workaround: disable animation for
  live-updating charts, enable only for initial render and user-initiated changes.
- **React**: First-class. Built on React + D3 scales (d3-scale, d3-shape). No D3 DOM manipulation.
- **Chart types**: Bar, Line, Area, Pie, Radar, Scatter, Treemap, Funnel, Radial, Composed (combo)
- **Strengths**: Intuitive compositional API maps naturally to a serializable definition. Good TypeScript types.
  Large community (~24k GitHub stars). SVG output works in all embedding contexts.
- **Weaknesses**: No built-in theme system (theming is manual per-prop). Animation is basic. No Canvas mode for
  large datasets. Limited advanced chart types.

#### Nivo

- **Rendering**: SVG, Canvas, or HTML (per chart type -- e.g., `@nivo/bar` exports both `Bar` and `BarCanvas`)
- **Bundle**: ~60-120 KB gzipped (depends on which `@nivo/*` packages are imported; tree-shakeable per package)
- **API**: Single component per chart type with a config object prop. Example: `<Bar data={...} keys={...}
  theme={...} />`
- **Theming**: Built-in `theme` prop with deep customization (axis, grid, labels, tooltip, legends all themed from
  one object). Theme matches well with Eigen's CSS-variable approach -- a single `createEigenChartTheme()` function
  could produce the entire theme.
- **Animation**: Uses `react-spring` for smooth, physics-based transitions. Data changes animate smoothly by default.
  This is a meaningful advantage over Recharts' basic CSS transitions.
- **React**: Built for React. Uses React context for theming. Server-side rendering supported.
- **Chart types**: ~30 types including all standard ones plus Heatmap, Sunburst, Chord, Sankey, Waffle, Calendar,
  Swarmplot, Network.
- **Strengths**: Best-in-class theming. Smooth animations. Dual SVG/Canvas rendering solves the large-dataset problem
  without a library switch. Rich chart type selection. Responsive containers built-in.
- **Weaknesses**: Config-object API is less compositional than Recharts. Heavier abstraction layer. Larger bundle
  when importing multiple chart types.
- **Fit for Eigen**: The theme system is a strong match for Eigen's dark/light mode and design language. The config
  object API is actually fine for our use case -- our `ChartDefinition` is itself a config object that maps to Nivo's
  props. The dual SVG/Canvas rendering eliminates open question #3 (large datasets).

#### Chart.js 4 (+ react-chartjs-2)

- **Rendering**: Canvas only (no SVG mode)
- **Bundle**: ~65 KB gzipped
- **API**: Imperative config object; `react-chartjs-2` is a thin wrapper
- **Theming**: Global defaults + per-chart options
- **Fit for Eigen**: **Eliminated.** Canvas-only rendering cannot be embedded in Tiptap NodeViews or slides objects
  without rasterizing to an image first, losing interactivity and resolution independence.

#### ECharts (+ echarts-for-react)

- **Rendering**: Canvas (default) or SVG
- **Bundle**: ~300 KB+ gzipped
- **Fit for Eigen**: **Eliminated.** Bundle size alone is disqualifying for a productivity suite that already carries
  fortune-sheet. The wrapper approach also means poor React integration.

#### Visx (Airbnb)

- **Rendering**: SVG (low-level D3 primitives as React components)
- **Bundle**: ~20-40 KB gzipped (highly tree-shakeable via `@visx/*` packages)
- **API**: Low-level composable primitives (`@visx/shape`, `@visx/axis`, `@visx/scale`, etc.)
- **Fit for Eigen**: Maximum flexibility but requires building every chart type from scratch. Appropriate as a fallback
  for one-off exotic visualizations, not as the primary charting solution.

#### Observable Plot

- **Rendering**: SVG (generates SVG DOM directly, not React components)
- **Bundle**: ~40 KB gzipped
- **API**: Functional/declarative marks-based grammar. `Plot.plot({marks: [Plot.barY(data, {x: "name", y: "value"})]})`.
- **React integration**: Generates DOM directly. Requires `useRef` + `useEffect` mounting pattern. Not composable
  with React's rendering model. The `@observablehq/plot` package does not export React components.
- **Theming**: CSS-based, limited programmatic control
- **Fit for Eigen**: The grammar-of-graphics API is elegant but the non-React rendering model is a poor fit.
  Every chart would need a ref-based wrapper component that manages DOM lifecycle outside React. This creates issues
  with React 19's concurrent features and makes server rendering impossible.

#### Vega-Lite

- **Rendering**: SVG or Canvas (via Vega runtime)
- **Bundle**: ~200 KB+ gzipped (includes full Vega runtime)
- **API**: Purely declarative JSON grammar (the spec IS the serialization format)
- **Fit for Eigen**: The concept of a JSON grammar is worth borrowing, but the bundle is too large and React
  integration is via a thin wrapper. Over-engineered for our needs.

### Recommendation: Nivo (revised from Recharts)

The original draft recommended Recharts. After closer analysis, **Nivo is the stronger choice** for Eigen:

1. **Theme system** -- Nivo's `theme` prop maps directly to Eigen's CSS variables. A single theme factory function
   produces consistent styling across all chart types, including automatic dark/light mode. Recharts requires
   manually passing colors to every axis, grid, label, and tooltip.
2. **Animation quality** -- Nivo uses `react-spring` for physics-based transitions. When sheet data changes, bars
   smoothly resize rather than jumping. This matters for the live-updating use case.
3. **SVG + Canvas duality** -- Each Nivo chart type has both SVG and Canvas variants with identical APIs. When a chart
   references a large data range (>5k points), we can switch to the Canvas variant without changing the definition.
4. **Config-object API is actually a good fit** -- Our `ChartDefinition` is itself a config object. Mapping
   `ChartDefinition -> Nivo props` is straightforward and arguably simpler than mapping `ChartDefinition -> Recharts
   component tree`.
5. **Richer chart types** -- Heatmap, Sunburst, and Sankey are valuable in a productivity suite and come for free.

**Recharts remains a valid alternative** if bundle size is a primary concern or if the team prefers the compositional
API. The architecture in this document works with either library -- the `<EigenChart>` component abstracts the
rendering library behind the `ChartDefinition` interface.

**Keep Visx as a fallback** for any one-off visualization that neither library supports.

---

## 3. Proposed Architecture: EigenChart

One `<EigenChart>` component that takes a `ChartDefinition` and renders identically everywhere. Lives in
`packages/ui/` and is consumed by sheets, docs, and slides.

```
packages/
  ui/src/components/charts/
    eigen-chart.tsx          # Main renderer: ChartDefinition -> Nivo component
    chart-definition.ts      # TypeScript types for ChartDefinition
    chart-theme.ts           # Eigen theme factory (CSS variables -> Nivo theme)
    chart-colors.ts          # Color palette from EIGEN_ACCENT_COLORS
    chart-utils.ts           # Definition -> Nivo props mapping, data transforms
    charts/
      bar-chart.tsx          # Bar chart wrapper
      line-chart.tsx         # Line chart wrapper
      pie-chart.tsx          # Pie chart wrapper
      scatter-chart.tsx      # Scatter chart wrapper
      area-chart.tsx         # Area chart wrapper
      combo-chart.tsx        # Mixed bar + line (uses Nivo layers)
    sparkline.tsx            # Minimal inline chart for sheets cells
    index.ts                 # Public exports

packages/
  lib/src/types/
    chart.ts                 # ChartDefinition type (shared FE + BE)
```

### Integration Points

```
apps/sheets/    -> packages/ui/charts/    (chart overlay on canvas + data binding)
apps/docs/      -> packages/ui/charts/    (Tiptap node extension)
apps/slides/    -> packages/ui/charts/    (SlideObject type: 'chart')
```

---

## 4. Chart Definition Format (Data Model)

The chart definition is a JSON-serializable object that fully describes a chart. It borrows the
declarative-grammar idea from Vega-Lite but uses a simpler, purpose-built schema.

```typescript
type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'combo' | 'doughnut' | 'radar' | 'heatmap';

type ChartDataSource =
    | { kind: 'inline'; rows: (string | number | null)[][]; columns: string[] }
    | { kind: 'sheet-range'; ownerId: string; mountId: string; pathId: string; sheetId: string; range: string;
        cachedData?: { columns: string[]; rows: (string | number | null)[][] } }
    // range is A1-notation like "A1:D10" or a named range
    // cachedData: last-known inline snapshot for fallback when sheet is inaccessible

type ChartSeries = {
    dataKey: string;              // Column name from data source
    type?: 'bar' | 'line' | 'area'; // For combo charts
    color?: string;               // Override auto-assigned color
    name?: string;                // Display name in legend
    yAxisId?: 'left' | 'right';  // For dual-axis charts
    stack?: string;               // Stack group ID for stacked charts
}

type ChartAxis = {
    show?: boolean;
    label?: string;
    min?: number | 'auto';
    max?: number | 'auto';
    tickCount?: number;
    format?: string;              // Number format like "0.0%", "$#,##0"
}

type ChartLegend = {
    show?: boolean;
    position?: 'top' | 'bottom' | 'left' | 'right';
}

type ChartAnimation = {
    enabled?: boolean;            // Default: true in editors, false in static contexts
    duration?: number;            // Milliseconds, default: 400
    stiffness?: number;           // react-spring stiffness for Nivo, default: 90
    damping?: number;             // react-spring damping for Nivo, default: 15
}

type ChartDefinition = {
    version: 1;
    type: ChartType;
    title?: string;
    dataSource: ChartDataSource;
    categoryKey: string;          // Column used for X-axis / categories
    series: ChartSeries[];
    xAxis?: ChartAxis;
    yAxis?: ChartAxis;
    yAxisRight?: ChartAxis;       // Secondary Y-axis
    legend?: ChartLegend;
    animation?: ChartAnimation;
    colorPalette?: string[];      // Override default EIGEN colors
    backgroundColor?: string;
    interactive?: boolean;        // Enable tooltips/hover (default: true)
    stacked?: boolean;
    smooth?: boolean;             // Smooth lines for line/area charts
}
```

### Design Rationale

- **`dataSource.kind: 'inline'`** -- chart carries its own data. Used when pasted into docs/slides without a sheet
  link, or when the user manually enters data.
- **`dataSource.kind: 'sheet-range'`** -- chart references a cell range in a sheets file. Includes optional
  `cachedData` so the chart degrades gracefully when the source sheet is inaccessible (deleted, permissions revoked).
- **`animation`** -- separate from `interactive` because static contexts (slides presenter) may want entry animations
  without interactivity.
- **`version: 1`** -- enables future schema evolution.

### Example

```json
{
    "version": 1,
    "type": "bar",
    "title": "Q4 Revenue by Region",
    "dataSource": {
        "kind": "sheet-range",
        "ownerId": "user-abc",
        "mountId": "mount-123",
        "pathId": "path-456",
        "sheetId": "sheet-1",
        "range": "A1:D5"
    },
    "categoryKey": "Region",
    "series": [
        { "dataKey": "Q1", "color": "#fb2c36" },
        { "dataKey": "Q2", "color": "#00bc7d" },
        { "dataKey": "Q3", "color": "#2b7fff" }
    ],
    "xAxis": { "label": "Region" },
    "yAxis": { "label": "Revenue ($)", "format": "$#,##0" },
    "legend": { "show": true, "position": "bottom" },
    "stacked": false
}
```

---

## 5. Integration with Sheets (Data Binding)

### Chart as Canvas Overlay

Fortune-sheet renders cells on a `<canvas>`. Charts float above it as absolutely positioned React components. The
`ImgBoxs` component demonstrates the pattern: it reads from context, positions using `left`/`top` pixels scaled by
`context.zoomRatio`, and provides move/resize handles via mouse events.

A chart in sheets is an "object" with:
- A bounding rectangle (x, y, width, height in pixels, scaled by `context.zoomRatio`)
- A `ChartDefinition` with `dataSource.kind: 'sheet-range'`
- Move/resize handles (reuse `ImageResizeHandles` from packages/ui)

### Data Extraction from Fortune-Sheet

The `WorkbookInstance.getCellsByRange()` API returns `(Cell | null)[][]` (2D row-major array). Each cell has `v`
(computed value) and `m` (display string). The API internally calls `getdatabyselection()` which skips hidden
rows/columns and reads from the current flow data (formula-evaluated).

```typescript
function extractChartData(
    workbook: WorkbookInstance,
    range: string, // A1-notation
    sheetId?: string
): { columns: string[]; rows: (string | number | null)[][] } {
    // 1. Parse A1 notation to { row: [r1, r2], column: [c1, c2] }
    // 2. Call workbook.getCellsByRange(parsedRange, { id: sheetId })
    //    Returns (Cell | null)[][] — a 2D row-major array
    // 3. First row -> column headers (cell.v or cell.m as strings)
    // 4. Remaining rows -> data rows, using cell.v (computed value) for numbers
    // 5. Return { columns, rows }
}
```

Key considerations:
- **Use `cell.v`** (raw/computed value) for numeric data, not `cell.m` (formatted display string).
- **Formula cells**: `cell.v` contains the result after formula evaluation. Charts read computed values, not formulas.
- **Hidden rows/columns**: `getCellsByRange` already skips hidden rows/columns via `cfg.rowhidden` and `cfg.colhidden`
  checks in `getdatabyselection`.

### Live Update Reactivity

When cells in a chart's bound range change, the chart must re-render. Two signals are available:

1. **`onOp` callback** -- fires with `Op[]` on every local edit. Use for immediate updates:
   ```typescript
   function doesOpAffectRange(op: Op, range: { row: [number, number]; column: [number, number] }): boolean {
       if (op.path[0] === 'data' && typeof op.path[1] === 'number' && typeof op.path[2] === 'number') {
           return op.path[1] >= range.row[0] && op.path[1] <= range.row[1]
               && op.path[2] >= range.column[0] && op.path[2] <= range.column[1];
       }
       if (op.op === 'insertRowCol' || op.op === 'deleteRowCol') return true;
       return false;
   }
   ```

2. **`onChange` callback** -- fires with the full sheet data after edits (used for snapshot persistence). This captures
   formula recalculation results. Charts should debounce re-extraction off this callback (~200ms) since `onChange` fires
   frequently.

For **remote edits** (another user changes cells via Yjs), the `applyOp` path triggers a context re-render. Chart
overlays need to detect this by either:
- Observing the Yjs `ops` array for remote ops that affect the chart range
- Polling the workbook API on a short interval (~500ms) when the chart is visible

**Recommendation**: Use `onOp` for local edits (immediate), observe the Yjs `ops` array for remote edits (via
`opsArray.observe`), and debounce data extraction to 200ms to batch rapid changes.

### Chart Storage in Sheets Yjs Document

Charts live outside the fortune-sheet `CellMatrix` in a separate Yjs structure:

```
Y.Map("state")        -> snapshot (existing)
Y.Array("ops")        -> incremental ops (existing)
Y.Map("charts")       -> chartId -> Y.Map { id, definition (JSON string), x, y, w, h, sheetId }
```

The `definition` is stored as a JSON string (atomic replacement). Chart position fields (`x`, `y`, `w`, `h`) are
separate Y.Map keys so that move/resize operations sync granularly without replacing the entire definition.

The `sheetId` field associates the chart with a specific sheet tab. Charts are only rendered on their associated
sheet.

### Chart Anchoring

- **Floating position**: Chart has absolute pixel position (x, y, w, h) relative to the sheet grid. When rows/columns
  are inserted above/left, the chart position shifts. This matches Excel/Google Sheets behavior.
- **Range binding**: The `dataSource.range` (e.g., `"B2:E10"`) uses A1-notation. When rows/columns are inserted within
  the range, the range reference must update (like formula references). This is handled at the chart layer, not by
  fortune-sheet's formula engine.

### UI Flow for Creating a Chart in Sheets

1. User selects a cell range (e.g., A1:D10)
2. Clicks "Insert Chart" in the Eigen-level toolbar (`ToolbarLeftItems` / `ToolbarRightItems`), not the fortune-sheet
   toolbar. This keeps chart logic outside fortune-sheet.
3. Chart wizard opens with:
    - Auto-detected chart type based on data shape (see section 12)
    - Live preview
    - Series and axis configuration
4. On confirm, a chart is created in `Y.Map("charts")` and rendered as a floating overlay

---

## 6. Integration with Docs (Tiptap Extension)

### Chart Node Extension

Follow the `ResizableImage` extension pattern at `apps/docs/src/components/docs/extensions/resizable-image.tsx`:

```typescript
// apps/docs/src/components/docs/extensions/chart-node.tsx

export const ChartNode = Node.create({
    name: 'eigenChart',
    group: 'block',
    atom: true,
    draggable: true,

    addAttributes() {
        return {
            definition: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('data-chart-definition'),
                renderHTML: (attrs: Record<string, unknown>) => ({
                    'data-chart-definition': attrs.definition,
                }),
            },
            width: { default: null },
            alignment: { default: 'center' },
        };
    },

    addNodeView() {
        return ReactNodeViewRenderer(ChartNodeView);
    },

    addCommands() {
        return {
            insertChart: (definition: ChartDefinition) => ({ commands }) => {
                return commands.insertContent({
                    type: 'eigenChart',
                    attrs: { definition: JSON.stringify(definition) },
                });
            },
        };
    },
});
```

### ChartNodeView Component

```typescript
function ChartNodeView({ node, updateAttributes, selected, editor }: NodeViewProps) {
    const definition = JSON.parse(node.attrs.definition) as ChartDefinition;

    // If dataSource.kind === 'sheet-range', fetch data via useChartData() hook
    // If dataSource.kind === 'inline', use embedded data directly

    return (
        <NodeViewWrapper
            className={`flex ${alignment === 'center' ? 'justify-center' : alignment === 'right' ? 'justify-end' : 'justify-start'}`}
            data-drag-handle=""
            draggable={editor.isEditable}
        >
            <ImageResizeHandles
                width={node.attrs.width}
                aspectRatio={16/10}
                maxWidth={getMaxWidth()}
                onResize={(w) => updateAttributes({ width: w })}
                selected={selected}
                editable={editor.isEditable}
            >
                <EigenChart
                    definition={definition}
                    interactive={editor.isEditable}
                    width={node.attrs.width || 600}
                />
                {selected && editor.isEditable && (
                    <ChartToolbar onEdit={...} onUnlink={...} />
                )}
            </ImageResizeHandles>
        </NodeViewWrapper>
    );
}
```

### Sheet-Linked Charts in Docs

When a chart references a sheet range (`dataSource.kind: 'sheet-range'`):

1. **On mount**: Fetch current data via `GET /api/drive/:ownerId/:mountId/sheets/:pathId/range`
2. **Live updates**: Subscribe to SSE `sheet-data-changed` events. When the referenced sheet changes, re-fetch.
   Fall back to manual "Refresh" button if SSE is unavailable.
3. **Offline fallback**: Use `cachedData` from the `ChartDataSource`. Update the cache whenever fresh data is fetched.

### Inserting Charts in Docs

Two workflows:
1. **Copy from Sheets**: Clipboard includes `ChartDefinition` with sheet-range source. Pasted chart is linked.
2. **Insert inline**: Chart wizard with manual data entry (table input). Creates `dataSource.kind: 'inline'`.

---

## 7. Integration with Slides (Slide Element)

### ChartObject Type

Extend the `SlideObject` union in `apps/slides/src/components/slides/types.ts`:

```typescript
type ChartObject = BaseObject & {
    type: 'chart';
    definition: string; // JSON-stringified ChartDefinition
}

type SlideObject = TextObject | ImageObject | ChartObject;
```

### Yjs Storage

Chart objects stored in `Y.Map("objects")` alongside text and image objects. Add `'definition'` to the `OBJECT_FIELDS`
array in `use-deck.ts` (which already has precedent for fields not in the TypeScript type, like `shadowColor`).

### Rendering

In `slide-object.tsx`, add a chart branch alongside the existing `text` and `image` branches:

```typescript
// In ReadOnlySlideObject:
{obj.type === 'chart' && (
    <EigenChart
        definition={JSON.parse(obj.definition)}
        interactive={false}
    />
)}

// In SlideObjectView (editor mode):
{obj.type === 'chart' && !editing && (
    <div className="w-full h-full pointer-events-none">
        <EigenChart
            definition={JSON.parse(obj.definition)}
            interactive={false}
        />
    </div>
)}
```

Charts in slides are non-interactive (no tooltips). Double-click opens the chart editor.

### Properties Panel

Add a chart section to `slide-properties-panel.tsx` using the existing `PropertySection` / `PropertyRow` components:
- Chart type selector
- Data source indicator (inline or sheet link)
- "Edit data" button (opens chart wizard)
- Color palette selector
- Title field

### Data Flow

Slides are typically consumed as presentations, not live dashboards. Use a **snapshot-on-insert** approach: copy
current data inline at insert time, with a manual "Update from sheet" action.

---

## 8. Fortune-Sheet Considerations

### Overlay Positioning Details

The `ImgBoxs` component demonstrates the positioning pattern charts should follow:

- Images store `left`, `top`, `width`, `height` in logical pixels
- Rendered positions are multiplied by `context.zoomRatio`
- Active image (selected) gets z-index 300, inactive images get z-index 200
- Move and resize are handled via `onImageMoveStart` / `onImageResizeStart` event handlers

Charts should follow this pattern but with higher z-index than images (since charts often overlay data regions the
user wants to see).

### Data Access

Use `WorkbookInstance` API exclusively. The return types:

| Method                | Parameters                                      | Returns                |
|-----------------------|-------------------------------------------------|------------------------|
| `getCellValue`        | `(row, col, options?)`                          | `Cell` value           |
| `getCellsByRange`     | `(range: Selection, options?)`                  | `(Cell \| null)[][]`   |
| `getSelection`        | `()`                                            | `Selection[]`          |
| `getAllSheets`        | `()`                                            | `Sheet[]`              |
| `calculateFormula`    | `(sheetId?, range?)`                            | void (triggers recalc) |

Do **not** directly access `context.luckysheetfile[n].data`. The API handles sheet index resolution and
returns formula-evaluated values.

### Context Pollution

The existing `chart_selection: any` in fortune-sheet's `Context` (initialized to `{}`) should be ignored entirely. Our
chart system is independent -- charts live in a separate Yjs structure, not in fortune-sheet's context.

---

## 9. Theming and Styling

### Color Palette

Default chart colors from `EIGEN_ACCENT_COLORS_SHUFFLED`:

```typescript
// From packages/lib/src/constants/colors.ts
// EIGEN_ACCENT_COLOR_ROW = 5 -> index 5 of EIGEN_COLOR_STEPS -> 500-weight
// goldenRatioShuffle ensures adjacent series have high visual contrast
const CHART_COLORS = EIGEN_ACCENT_COLORS_SHUFFLED.map(c => c.value);
// 17 colors: red-500, green-500, blue-500, violet-500, ... (golden-ratio ordered)
```

Series are assigned colors in order from this palette. Users can override individual series colors via
`ChartSeries.color`.

### Theme Integration

For Nivo, create a theme factory that reads CSS custom properties:

```typescript
function createEigenChartTheme(): NivoTheme {
    return {
        text: {
            fontSize: 12,
            fill: 'hsl(var(--foreground))',
        },
        axis: {
            ticks: { text: { fill: 'hsl(var(--muted-foreground))' } },
            legend: { text: { fill: 'hsl(var(--foreground))' } },
        },
        grid: {
            line: { stroke: 'hsl(var(--border))' },
        },
        tooltip: {
            container: {
                background: 'hsl(var(--popover))',
                color: 'hsl(var(--popover-foreground))',
                borderColor: 'hsl(var(--border))',
            },
        },
    };
}
```

This automatically adapts to dark/light mode since the CSS variables change with the theme.

For Recharts (alternative), the same values must be passed as individual props to each `<XAxis>`, `<YAxis>`,
`<CartesianGrid>`, `<Tooltip>`, etc. -- more verbose but functionally equivalent.

### Responsive Sizing

- **Sheets**: Explicit pixel dimensions, scaled by `context.zoomRatio`.
- **Docs**: Width in pixels (like `ResizableImage`), height derived from aspect ratio. Nivo's `ResponsiveBar` etc.
  handle container fill. Recharts equivalent: `<ResponsiveContainer>`.
- **Slides**: Fills bounding box. Coordinates in pixels (0-1920 x 0-1080), rendered as percentages via
  `pxToPercent()`.

---

## 10. Cross-App Data Flow

### Sheet -> Docs / Slides (Live Link)

```
Sheet cell change
    -> Yjs op broadcast
    -> API SSE event: "sheet-data-changed" { ownerId, mountId, pathId, sheetId }
    -> Docs/Slides SSE handler checks if any open chart references that sheet
    -> If yes: re-fetch range data via API
    -> Update cachedData in ChartDefinition
    -> EigenChart re-renders with smooth animation
```

### API Endpoint

```
GET /api/drive/:ownerId/:mountId/sheets/:pathId/range
    ?sheet=sheet-1
    &range=A1:D10
    -> { columns: string[], rows: (string | number | null)[][] }
```

This endpoint opens the `.eigensheets` Yjs document, reads the snapshot, parses cell data, and returns computed values.
This avoids docs/slides needing access to the fortune-sheet engine.

### Clipboard Transfer

Add a chart variant to the clipboard discriminated union:

```typescript
// In packages/lib/src/types/clipboard.ts
type EigenClipboardChartItem = {
    type: 'chart';
    definition: ChartDefinition;
    inlineData?: { columns: string[]; rows: (string | number | null)[][] };
}

type EigenClipboardItem = EigenClipboardTextItem | EigenClipboardImageItem | EigenClipboardChartItem;
```

The `inlineData` field always contains a snapshot so pasted charts work even if the source sheet is inaccessible.

Paste behavior:
- **Same app**: Keep sheet link
- **Different app**: Keep sheet link + store inline snapshot as fallback
- **External paste (outside Eigen)**: Export as PNG image via `writeEigenClipboard` with `text/html` containing an
  `<img>` tag of the rasterized chart

---

## 11. Interactivity and Animation Model

| Context              | Interactive | Tooltips | Animations           |
|----------------------|------------|----------|----------------------|
| Sheets (editor)      | Yes        | Yes      | On data change (smooth transitions) |
| Docs (editor)        | Yes        | Yes      | On data change (subtle) |
| Docs (read-only)     | Hover only | Yes      | None                 |
| Slides (editor)      | No         | No       | None                 |
| Slides (presenting)  | No         | No       | Entry animation on slide transition |
| Thumbnail / preview  | No         | No       | None                 |
| Export (SVG/PNG)      | No         | No       | None                 |

The `<EigenChart>` component accepts:
- `interactive: boolean` -- controls tooltips and cursor behavior
- `animate: boolean | ChartAnimation` -- controls data-change transitions and entry animations

### Data-Change Transitions

When a chart's data changes (live sheet update or user edit), the library should animate the transition:
- Bars smoothly resize to new heights
- Line points move to new positions
- Pie slices rotate/resize

Nivo handles this via `react-spring` by default. For Recharts, use `isAnimationActive` and `animationDuration` props,
but be aware that rapid updates (<200ms) can cause animation stacking. Debouncing data extraction (section 5) prevents
this.

---

## 12. Chart Editing UI and Auto-Detection

### Chart Type Auto-Detection

When the user selects a cell range and clicks "Insert Chart", analyze the data shape:

```typescript
function suggestChartType(data: { columns: string[]; rows: (string | number | null)[][] }): ChartType {
    const numericCols = data.columns.filter((_, i) =>
        data.rows.every(row => row[i] === null || typeof row[i] === 'number')
    );
    const stringCols = data.columns.filter((_, i) =>
        data.rows.some(row => typeof row[i] === 'string')
    );

    if (stringCols.length === 1 && numericCols.length >= 1) return 'bar';
    if (numericCols.length === 2 && stringCols.length === 0) return 'scatter';
    if (numericCols.length === 1 && stringCols.length === 1) return 'pie';
    if (numericCols.length >= 2) return 'line';
    return 'bar'; // default
}
```

### CSV Paste -> Chart Suggestion

When the user pastes CSV/TSV data into sheets (handled by fortune-sheet's paste handler), detect if the pasted data
looks like it would make a good chart (e.g., has header row + numeric columns) and show a toast: "Create chart from
pasted data?" with a one-click action.

### Shared Chart Editor

```
packages/ui/src/components/charts/
    chart-editor/
        chart-editor.tsx           # Main editor container
        chart-type-selector.tsx    # Grid of chart type icons
        data-source-panel.tsx      # Inline data table or sheet range picker
        series-config-panel.tsx    # Series colors, names, axis binding
        axis-config-panel.tsx      # Axis labels, min/max, format
        style-config-panel.tsx     # Colors, legend, title
        chart-preview.tsx          # Live preview
```

The editor takes a `ChartDefinition` and calls `onChange(updatedDefinition)` on every change.

Placement per app:
- **Sheets**: Sidebar panel (like `SlidePropertiesPanel`)
- **Docs**: Dialog
- **Slides**: Dialog overlaying the canvas

---

## 13. Cross-Cutting Concerns

### Charts in Copy-Paste

The clipboard system (see `docs/CLIPBOARD.md`) encodes `EigenClipboardData` as JSON in a `data-eigen-clipboard`
attribute within `text/html`. Charts add a third item type to the discriminated union (`'chart'`). Key behaviors:

- **Copy chart from sheets**: Serialize `ChartDefinition` + snapshot current data as `inlineData`. Write both the
  Eigen clipboard data and a PNG fallback to `text/html`.
- **Paste chart into docs**: Read `EigenClipboardChartItem`, create a `ChartNode` with the definition. If the
  sheet is accessible, keep the link; otherwise fall back to inline data.
- **Paste chart into slides**: Same as docs, but create a `ChartObject` slide element.
- **Cross-document media re-upload**: Not needed for charts (unlike images, charts don't reference media files).
  The `needsReUpload()` check in the clipboard system can skip chart items.
- **External paste (non-Eigen target)**: The PNG fallback in `text/html` is used.

### Chart Previews and Thumbnails

Charts must render correctly in non-interactive preview contexts:
- **Slide thumbnails**: `ReadOnlySlideObject` renders charts at small scale. The chart library must handle small
  dimensions gracefully (hide axis labels below ~100px width, simplify tick marks).
- **Drive file previews**: If `.eigensheets` previews include visible charts, the preview renderer needs access to
  the chart component. Consider server-side SVG rendering for thumbnail generation.
- **Search results / link previews**: Use the PNG export path.

### Sparklines in Sheet Cells

Mini inline charts within cells (Google Sheets `=SPARKLINE()` equivalent). These are distinct from overlay charts:

- Rendered as small SVG within the cell bounds, not as a canvas overlay
- Data comes from a cell range formula: `=SPARKLINE(B2:B10, "line")`
- Fortune-sheet would need custom cell rendering support (a cell with a sparkline renders SVG instead of text)
- This is a Phase 6+ feature. The `<EigenChart>` component can serve as the renderer if given `interactive={false}`
  and minimal dimensions, but a dedicated lightweight `<Sparkline>` component (using Visx or raw SVG) would be more
  appropriate for the constrained cell context.

### Real-Time Chart Updates (Reactivity Model)

The full reactivity chain for a live-updating chart in sheets:

```
User edits cell B3
    -> fortune-sheet onOp fires with Op[] (path: ["data", 2, 1, ...])
    -> Chart overlay checks: does Op affect range B1:B10? Yes.
    -> Debounce timer (200ms) starts/resets
    -> Timer fires: call workbook.getCellsByRange({row: [0,9], column: [1,1]})
    -> Extract data, compare with previous data
    -> If changed: update chart component props
    -> Chart library animates transition (bars resize, lines shift)

Remote user edits cell B3 (via Yjs)
    -> Yjs ops array observer fires
    -> applyOp() updates fortune-sheet context
    -> Same debounce + re-extract flow as above
```

Formula dependency: if B3 contains `=SUM(D1:D100)` and a user edits D50, the `calculateFormula` step updates B3's
`v` value before `onChange` fires. The chart sees the updated computed value. No explicit dependency tracking is needed
because `getCellsByRange` always reads post-evaluation values.

### Chart Themes and Eigen Design Language

Charts should feel native to Eigen's UI. Specific guidelines:
- **Font**: Inherit from the app's font stack (system fonts). No chart-specific fonts.
- **Border radius**: Bar charts use subtle rounding (2-3px) matching Eigen's UI component style.
- **Grid lines**: Use `hsl(var(--border))` with dashed style. Match the subtle grid of shadcn/ui tables.
- **Tooltip**: Use shadcn's Popover styling (`--popover`, `--popover-foreground`, `--border`). Small shadow.
- **Legend**: Below chart by default. Use `--muted-foreground` for text. Small color swatches (12px circles).
- **Title**: `--foreground` color, 14px, medium weight. Optional; most charts in sheets won't have titles.

---

## 14. Implementation Phases

### Phase 1: Core Chart Component

**Scope**: `EigenChart` renders a chart from a `ChartDefinition` with inline data.

1. Add chart library dependency (`@nivo/bar`, `@nivo/line`, `@nivo/pie`, `@nivo/scatterplot`) to the workspace
2. Create `packages/ui/src/components/charts/` with:
    - `chart-definition.ts` -- types (also in `packages/lib/src/types/chart.ts`)
    - `chart-theme.ts` -- Eigen theme factory
    - `chart-colors.ts` -- palette from `EIGEN_ACCENT_COLORS`
    - `eigen-chart.tsx` -- main component (dispatches to per-type wrappers)
    - Individual chart type wrappers (bar, line, pie, scatter, area)
3. Test with inline data in a standalone page

**Deliverable**: `<EigenChart definition={...} />` renders any supported chart type with Eigen theming.

### Phase 2: Sheets Integration

**Scope**: Insert, display, and live-update charts in sheets.

1. Add `Y.Map("charts")` to the sheets Yjs document in `use-sheet.ts`
2. Create chart overlay component (`chart-overlay.tsx`): absolute positioning, zoom scaling, move/resize
3. Data extraction utilities using `WorkbookInstance.getCellsByRange()`
4. Live update detection via `onOp` and Yjs observation
5. "Insert Chart" button in the Eigen-level toolbar
6. Chart wizard dialog (type selection + series config + preview)
7. Chart CRUD operations on the Yjs `charts` map

**Deliverable**: Users can insert charts in sheets that update live when cell data changes.

### Phase 3: Docs Integration

**Scope**: Charts as Tiptap nodes.

1. `chart-node.tsx` Tiptap extension (following `resizable-image.tsx` pattern)
2. `ChartNodeView` with `ImageResizeHandles`
3. "Insert Chart" toolbar button
4. Inline data entry in chart wizard
5. Clipboard: copy chart from sheets -> paste into docs
6. `EigenClipboardChartItem` type in clipboard system

**Deliverable**: Charts in docs with inline data or pasted from sheets.

### Phase 4: Slides Integration

**Scope**: Charts as slide objects.

1. `ChartObject` type in `types.ts`
2. `'definition'` added to `OBJECT_FIELDS` in `use-deck.ts`
3. Chart rendering branches in `slide-object.tsx` / `ReadOnlySlideObject`
4. "Insert Chart" in slides toolbar
5. Chart section in `slide-properties-panel.tsx`
6. Clipboard support

**Deliverable**: Charts as positionable, resizable slide objects.

### Phase 5: Cross-App Live Linking

**Scope**: Charts in docs/slides reference sheet data and update live.

1. API endpoint: `GET /api/drive/:ownerId/:mountId/sheets/:pathId/range`
2. SSE event for sheet data changes
3. `useChartData()` hook in `packages/lib/` (resolves sheet-range, subscribes to SSE, caches data)
4. Wire up in docs `ChartNodeView` and slides `SlideObjectView`
5. "Update from sheet" and "Unlink from sheet" actions

**Deliverable**: Charts in docs/slides live-update when the source sheet changes.

### Phase 6: Polish and Advanced Features

1. Chart type auto-detection from data shape
2. Number formatting on axes (respect source cell format)
3. Dual Y-axis and combo charts
4. Stacked/grouped variants
5. SVG/PNG export
6. Print CSS support
7. Additional chart types (heatmap, radar, doughnut)
8. CSV paste -> chart suggestion toast
9. Sparklines in cells (lightweight, separate from overlay charts)
10. Dark mode testing and refinement
11. Entry animations for slides presentation mode

---

## 15. File Locations Summary

| What                        | Where                                                              |
|-----------------------------|--------------------------------------------------------------------|
| ChartDefinition type        | `packages/lib/src/types/chart.ts`                                  |
| EigenChart component        | `packages/ui/src/components/charts/eigen-chart.tsx`                |
| Chart theme                 | `packages/ui/src/components/charts/chart-theme.ts`                 |
| Chart colors                | `packages/ui/src/components/charts/chart-colors.ts`                |
| Chart editor UI             | `packages/ui/src/components/charts/chart-editor/`                  |
| Sparkline component         | `packages/ui/src/components/charts/sparkline.tsx`                  |
| Sheets chart overlay        | `apps/sheets/src/components/sheets/chart-overlay.tsx`              |
| Sheets data extraction      | `apps/sheets/src/components/sheets/hooks/use-chart-data.ts`        |
| Docs Tiptap extension       | `apps/docs/src/components/docs/extensions/chart-node.tsx`          |
| Slides ChartObject type     | `apps/slides/src/components/slides/types.ts`                       |
| Cross-app data hook         | `packages/lib/src/core/sheets/hooks/use-chart-data.ts`             |
| API range endpoint          | `apps/api/src/routes/drive.ts` (or new sheets route)               |
| Clipboard chart item        | `packages/lib/src/types/clipboard.ts`                              |

---

## 16. Open Questions

1. **Chart editor scope**: Start minimal (type, series, axes, colors). Add trendlines, error bars, and annotations
   only if users ask. Google Sheets' chart editor is intimidatingly complex -- avoid that.

2. **Performance with large ranges**: A chart bound to 26,000 cells. With Nivo, switch to the Canvas variant
   (e.g., `BarCanvas` instead of `Bar`) when the data exceeds ~5,000 points. With Recharts, aggregate or
   downsample.

3. **Formula dependency tracking**: When a chart references `A1:D10` but those cells contain formulas depending on
   cells outside the range, any change to upstream cells triggers formula recalculation which updates `cell.v`.
   The `onChange` callback fires after recalculation, so the chart sees updated values without explicit dependency
   tracking. This is sufficient for now.

4. **Collaborative chart editing**: Atomic JSON replacement (last write wins) is fine. Chart editing is a quick dialog
   interaction, not a sustained collaborative session.

5. **Accessibility**: Both Nivo and Recharts generate SVG with basic structure. Add `role="img"` and
   `aria-label={chart.title}` to the chart container. Consider a data table toggle for screen readers.
