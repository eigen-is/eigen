# Research: eigen|vector> -- Drawing & Diagramming App

> **TLDR**: A collaborative drawing/diagramming app (like Excalidraw) that also serves as the shared rendering engine
> for docs (inline diagrams) and slides (shape elements). Stored as `.eigenvector` Drive folders. Uses SVG rendering with
> optional Canvas overlay for freehand drawing. Yjs for real-time collaboration. Slides can incrementally adopt vector
> element types to gain shapes, arrows, and freehand -- but a full "slides = vector in page mode" rewrite is a long-term
> goal with significant migration cost.

## Table of Contents

- [Current State Analysis](#current-state-analysis)
- [Excalidraw vs tldraw Comparison](#excalidraw-vs-tldraw-comparison)
- [Proposed Architecture](#proposed-architecture)
- [Element Type System](#element-type-system)
- [Shared Rendering Engine](#shared-rendering-engine)
- [Yjs Data Model](#yjs-data-model)
- [Integration with Docs (Tiptap)](#integration-with-docs-tiptap)
- [Integration with Slides](#integration-with-slides)
- [Could Slides Be Built on Top of Vector?](#could-slides-be-built-on-top-of-vector)
- [Cross-Cutting Concerns](#cross-cutting-concerns)
- [File Format](#file-format)
- [Rendering: SVG vs Canvas](#rendering-svg-vs-canvas)
- [Collaboration UX](#collaboration-ux)
- [Key Libraries](#key-libraries)
- [Performance Considerations](#performance-considerations)
- [Specialized Shape Libraries](#specialized-shape-libraries)
- [Export Capabilities](#export-capabilities)
- [Touch and Stylus Support](#touch-and-stylus-support)
- [Annotations on Documents and Images](#annotations-on-documents-and-images)
- [Implementation Phases](#implementation-phases)
- [Open Questions](#open-questions)

---

## Current State Analysis

### Slides Architecture as Starting Point

The slides app (`apps/slides/`) already implements a 2D element system with many drawing-app characteristics:

**What slides already has:**
- Positioned elements with `x, y, w, h, rotation` (pixel coords in 1920x1080 space, rendered as percentages via
  `pxToPercent()`/`percentToPx()`)
- Z-ordering via `objectIds` Y.Array per slide (not a flat z-index -- the array position is the z-order)
- Drag/move/resize with 8-handle selection (`use-object-drag.ts`)
- Snap-to-object alignment (`use-snap-lines.ts`) -- snaps to edges, centers, and slide midpoints
- Properties panel with transform, text, image, and border editing (including multi-select with merged values)
- Yjs collaboration with WebSocket provider (`getCollabWebSocketUrl`)
- Undo/redo via `Y.UndoManager` scoped to `[slidesMap, objectsMap, slideOrderArray]`
- Copy/paste via Eigen clipboard system (full round-trip for `SlideObject` via `meta` field)
- Context menu with z-order operations (bring to front, send to back, move up/down)
- Slide backgrounds: both solid color and image backgrounds, with apply-to-all/following support
- Presentation mode with fullscreen, click-to-advance, right-click-to-go-back
- Slide thumbnails with simplified rendering (`SlideThumbnail` component)
- Deck normalization (`normalize-deck.ts`) to fix orphaned objects and duplicate references

**Note on types**: The `BaseObject` type in `types.ts` is a local (non-exported) type -- only `TextObject`,
`ImageObject`, and `SlideObject` (the union) are exported. The Yjs `OBJECT_FIELDS` list in `use-deck.ts` includes
`shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` fields that are not in the TypeScript type -- these are
vestigial fields, read from Yjs but never rendered or set by the UI. This is worth cleaning up during vector
integration.

**What slides lacks (that a drawing app needs):**
- Shape primitives (rectangle, ellipse, diamond, triangle, line, arrow)
- Freehand/pen drawing tool
- Connector/arrow tool with endpoint binding
- Path editing (bezier curves, control points)
- Fill patterns and opacity (elements have `borderColor`/`borderWidth`/`borderRadius` and text has `backgroundColor`,
  but there is no general fill concept)
- Grouping (no group type, no multi-element transform)
- Infinite canvas (slides uses fixed 16:9 pages with `SLIDE_BASE_WIDTH=1920`, `SLIDE_BASE_HEIGHT=1080`)
- Pan/zoom
- Multi-tool mode (select, draw, shape, text, eraser)
- SVG/PNG export

**Key observation**: The slides rendering pipeline (`slide-object.tsx`) with `getObjectPositionStyle()`,
`ReadOnlySlideObject`, and `SlideObjectView` demonstrates the pattern of a shared renderer used in edit mode,
presentation mode, and thumbnails. But the rendering is DOM-based (positioned `<div>`s with CSS), not SVG. Migrating
to SVG rendering is a prerequisite for vector integration and would change how text, images, and selection handles
work.

### Docs Architecture

The docs app uses Tiptap (ProseMirror) with Yjs collaboration (`@tiptap/extension-collaboration`). Custom nodes are
added via `ReactNodeViewRenderer` -- the `ResizableImage` extension (`apps/docs/src/components/docs/extensions/
resizable-image.tsx`) demonstrates the exact pattern needed for embedding drawings:

- `Node.create()` with `atom: true, draggable: true, group: 'block'`
- `addAttributes()` for persisted state (`src`, `width`, `alignment`)
- `addNodeView()` returning `ReactNodeViewRenderer(ResizableImageView)`
- The component receives `NodeViewProps` with `node.attrs`, `updateAttributes`, `selected`, `editor`
- Resize handles via shared `ImageResizeHandles` component (`packages/ui/src/components/layout/media/
  image-resize-handles.tsx`)
- Alignment toolbar (left/center/right) appears when selected

A `VectorDrawing` Tiptap node would follow this same pattern, but with two open design questions:

1. **Separate Yjs doc or embedded data?** A `ResizableImage` just stores a `src` URL attribute in the parent doc's Yjs
   state. A vector drawing needs its own Yjs doc (for collaboration on the drawing itself). This means the Tiptap node
   stores a `drawingId` referencing a separate `.eigenvector` Drive file, and the vector editor connects to a separate
   WebSocket collab room. Two concurrent Yjs connections per inline drawing.

2. **Inline editing vs modal editing?** Google Docs uses a modal popup for its drawing editor. Inline editing (edit the
   drawing in-place within the doc) is technically possible but creates interaction conflicts: Tiptap's ProseMirror
   event handling vs the vector canvas's pointer event handling. The safest approach is to intercept events at the
   `NodeViewWrapper` boundary and prevent propagation when the vector canvas is active.

### Yjs Patterns Across Apps

All collaborative apps follow the same pattern:

```
Y.Doc -> WebsocketProvider (getCollabWebSocketUrl) -> observeDeep -> React state
```

The server-side `CollabDocument` (`apps/api/src/lib/collab/collabDocument.ts`) handles persistence to `data.db`,
WebSocket message routing, and awareness protocol for cursor sharing. Each `.eigen*` folder gets a single
`CollabDocument` instance.

| App      | Yjs Structure                                                 | UndoManager Scope |
|----------|---------------------------------------------------------------|-------------------|
| Docs     | Y.XmlFragment (Tiptap collaboration extension)               | Tiptap handles    |
| Slides   | Y.Map("slides") + Y.Map("objects") + Y.Array("slideOrder")   | All three types   |
| Stickies | Y.Map("columns") + Y.Map("tasks") + Y.Array("columnOrder")   | All three types   |
| Sheets   | Y.Map("state") + Y.Array("ops")                              | fortune-sheet     |

Vector would use: `Y.Map("elements") + Y.Array("elementOrder") + Y.Map("pages")` (see Yjs Data Model section).

Note: Awareness (cursor/selection sharing) is already supported at the protocol level by `CollabDocument`. Tiptap uses
it via `CollaborationCursor`. Vector would use it for showing other users' cursor positions and active tool (see
[Collaboration UX](#collaboration-ux)).

---

## Excalidraw vs tldraw Comparison

### Excalidraw

**Architecture:**
- React + TypeScript, MIT licensed
- Renders to a single `<canvas>` element using Canvas 2D API
- Uses Rough.js for the hand-drawn/sketchy visual style
- Scene graph: flat array of `ExcalidrawElement` objects (soft-deleted via `isDeleted` flag for undo)
- Collaboration via a room-based WebSocket protocol. Uses a "last-write-wins" merge per element, not a CRDT. Community
  Yjs adapters exist but are not officially supported and require mapping between Excalidraw's update model and Yjs
  operations.
- Excalidraw+ (their hosted product) uses Firebase for real-time sync
- `@excalidraw/excalidraw` npm package for embedding as a React component

**Element data model (simplified):**
```typescript
type ExcalidrawElement = {
  id: string
  type: 'rectangle' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'freedraw' | 'text' | 'image' | 'frame' | 'embeddable'
  x: number; y: number
  width: number; height: number
  angle: number              // radians (not degrees -- differs from slides)
  strokeColor: string
  backgroundColor: string
  fillStyle: 'hachure' | 'cross-hatch' | 'solid'
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
  roughness: number          // 0 = smooth, 1+ = sketchy
  opacity: number            // 0-100
  groupIds: string[]         // multi-level group nesting
  boundElements: { id: string, type: 'arrow' | 'text' }[]
  points?: [number, number][]  // for lines, arrows, freedraw
  roundness: { type: number, value?: number } | null
  isDeleted: boolean         // soft delete for undo history
  // ... ~30 more fields
}
```

**Strengths:**
- Beloved hand-drawn aesthetic (Rough.js)
- Huge community, well-tested, many integrations
- Good export (SVG, PNG, clipboard with `.excalidraw` JSON)
- Embeddable via `@excalidraw/excalidraw` npm package

**Weaknesses for Eigen:**
- Canvas-only rendering: no lightweight read-only mode (must load full JS runtime + Canvas context even for static
  display), no SSR possible
- Not CRDT-native -- Yjs adapter would be a maintenance burden
- Tightly coupled to its own state management (not easy to extract just the renderer or the element model)
- The sketchy style is opinionated -- may not fit a productivity suite aesthetic
- Large bundle size (~500KB gzipped for the core)
- The element model is monolithic -- hard to extend with custom element types without forking

### tldraw

**Architecture:**
- React + TypeScript, dual licensed (tldraw SDK is free for non-commercial, paid for commercial via
  tldraw.dev license)
- Renders to Canvas (switched from SVG to Canvas in v3 for performance -- shapes previously rendered as SVG are now
  drawn onto a Canvas element)
- Custom rendering engine (no Rough.js)
- Store-based architecture with `TLStore` (their own signal-based reactive store, not Yjs internally but syncs with
  Yjs via `@tldraw/sync`)
- Modular shape system: each shape type is a class with `component()` (React renderer), `indicator()` (selection
  outline), and `getGeometry()` (hit testing)

**Shape data model (simplified):**
```typescript
type TLBaseShape<T extends string, P extends object> = {
  id: TLShapeId
  type: T
  x: number; y: number
  rotation: number
  index: string           // fractional indexing for z-order (avoids array reordering)
  parentId: TLPageId | TLShapeId  // pages or groups
  isLocked: boolean
  opacity: number
  props: P                // type-specific properties
  meta: Record<string, unknown>
}
```

Built-in shape types: `draw`, `geo` (rectangle, ellipse, diamond, cloud, etc.), `arrow`, `line`, `note`, `text`,
`image`, `video`, `bookmark`, `embed`, `frame`, `group`, `highlight`.

**Strengths:**
- Extensible shape system (define custom shapes with custom renderers)
- Clean separation: store, shapes, tools, UI layers
- Good performance with spatial indexing
- Yjs sync support via `@tldraw/sync`
- SDK designed for embedding in other products

**Weaknesses for Eigen:**
- License: the tldraw SDK requires a commercial license for paid products (not just the UI -- the editor core too)
- The Apache 2.0 core packages (`@tldraw/editor`, `@tldraw/tlschema`) are the *old* v2 split. In practice, the useful
  SDK is behind the commercial license.
- Opinionated UI that may conflict with Eigen's design system (shadcn/ui + Tailwind)
- Store model (`TLStore` with signals) is a parallel reactive system to Eigen's React + TanStack Query stack -- would
  need bridging
- Canvas rendering (as of v3) means no lightweight SVG-only read-only mode -- same limitation as Excalidraw

### Recommendation: Build Custom, Inspired by Both

Neither Excalidraw nor tldraw should be embedded directly. Both have licensing, coupling, or architectural mismatches
that make integration more expensive than building from scratch. Instead, build a custom vector engine that:

1. Uses **Eigen's existing element model pattern** (from slides) as the foundation -- same flat Y.Map-per-element
   storage, same `observeDeep` -> React state pattern
2. Adopts **tldraw's shape extensibility pattern** (base type + type-specific props object) but without tldraw's
   signal-based store
3. Renders via **SVG for shapes** + **Canvas overlay for freehand input only** -- this is the pre-v3 tldraw approach,
   which gives us lightweight read-only SVG rendering that neither current Excalidraw nor tldraw v3 can offer
4. Optionally uses **Rough.js** as a per-element style toggle (not the default aesthetic)
5. Uses **perfect-freehand** for pen strokes (both Excalidraw and tldraw use this, 3KB, MIT)
6. Integrates **natively with Yjs** (like the rest of Eigen) -- no adapter layer

The main risk is underestimating the interaction engineering. Selection, multi-select, resize with aspect ratio lock,
rotation handles, snap lines, keyboard nudge, and undo/redo across all of these -- slides already solves most of this,
but extending to arbitrary shapes (especially arrows with bindings) is substantial work.

---

## Proposed Architecture

### Package Structure

```
packages/
  vector/                        # @workspace/vector -- shared vector engine
    src/
      elements/
        types.ts                 # VectorElement union type + BaseElement
        rectangle.ts             # Rectangle element definition
        ellipse.ts               # Ellipse element
        arrow.ts                 # Arrow/connector element
        line.ts                  # Line/polyline element
        freehand.ts              # Freehand drawing element
        text.ts                  # Text element
        image.ts                 # Image element
        group.ts                 # Group element
        frame.ts                 # Frame/artboard element
      rendering/
        svg-renderer.tsx         # SVG renderer (read-only + edit)
        canvas-overlay.tsx       # Canvas for freehand input
        element-renderer.tsx     # Dispatches to type-specific renderers
        arrow-renderer.tsx       # Arrow path calculation + rendering
        shape-renderer.tsx       # Rectangle, ellipse, diamond SVG
        text-renderer.tsx        # foreignObject text rendering
        freehand-renderer.tsx    # SVG path from perfect-freehand points
      interaction/
        select-tool.ts           # Selection, move, resize, rotate
        shape-tool.ts            # Shape creation tool
        draw-tool.ts             # Freehand drawing tool
        arrow-tool.ts            # Arrow/connector tool
        text-tool.ts             # Text creation tool
        eraser-tool.ts           # Eraser tool
        pan-tool.ts              # Pan/hand tool
      hooks/
        use-vector-doc.ts        # Yjs document management (like use-deck.ts)
        use-viewport.ts          # Pan/zoom state
        use-selection.ts         # Selection state + multi-select
        use-tool.ts              # Active tool state
        use-element-drag.ts      # Drag/resize (extends slides' use-object-drag.ts)
        use-snap.ts              # Snap lines (extends slides' use-snap-lines.ts)
        use-history.ts           # Undo/redo via Y.UndoManager
      components/
        vector-canvas.tsx        # Main canvas component (SVG + Canvas layers)
        vector-toolbar.tsx       # Tool selection bar
        properties-panel.tsx     # Element properties (extends slides' pattern)
        minimap.tsx              # Minimap for infinite canvas
        layers-panel.tsx         # Layer/z-order management
      export/
        to-svg.ts                # Export to SVG string
        to-png.ts                # Export to PNG via canvas
        to-json.ts               # Export to JSON (Excalidraw-compatible?)
      utils/
        geometry.ts              # Point, vector, intersection math
        path.ts                  # SVG path generation
        color.ts                 # Color utilities
        bounds.ts                # Bounding box calculations

apps/
  vector/                        # Standalone vector app
    src/
      components/vector/
        editor.tsx               # Full editor (toolbar + canvas + panels)
        toolbar.tsx              # App-level toolbar (file menu, share, etc.)
      routes/
        _auth.tsx                # Auth guard
        _auth.vector.$path.tsx   # Vector file route
```

### Dependency Graph

```
packages/vector (engine)
  <- apps/vector (standalone app)
  <- apps/docs (Tiptap node: inline drawing)
  <- apps/slides (shared element types + renderer)
```

The `packages/vector` package is the core. It exports:
- Element types and defaults
- SVG renderer components (for read-only embedding)
- Full interactive canvas component (for editing)
- Yjs integration hooks
- Export utilities

---

## Element Type System

### Base Element

```typescript
type BaseElement = {
  id: string
  type: string
  x: number              // absolute position (not percentage)
  y: number
  w: number              // bounding box width
  h: number              // bounding box height
  rotation: number       // degrees (matching slides convention)
  opacity: number        // 0-1
  locked: boolean
  groupId?: string       // parent group element ID
  // Style
  strokeColor: string
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
  fillColor: string
  fillStyle: 'solid' | 'hachure' | 'cross-hatch' | 'none'
  // Border (matching slides convention)
  borderRadius: number
}
```

### Concrete Element Types

```typescript
type RectangleElement = BaseElement & {
  type: 'rectangle'
}

type EllipseElement = BaseElement & {
  type: 'ellipse'
}

type DiamondElement = BaseElement & {
  type: 'diamond'
}

type TriangleElement = BaseElement & {
  type: 'triangle'
}

type LineElement = BaseElement & {
  type: 'line'
  points: [number, number][]   // relative to x,y
  startArrowhead?: 'arrow' | 'dot' | 'bar' | null
  endArrowhead?: 'arrow' | 'dot' | 'bar' | null
}

type ArrowElement = BaseElement & {
  type: 'arrow'
  points: [number, number][]   // control points, relative to x,y
  startBinding?: { elementId: string; focus: number; gap: number }
  endBinding?: { elementId: string; focus: number; gap: number }
  startArrowhead: 'arrow' | 'dot' | 'bar' | null
  endArrowhead: 'arrow' | 'dot' | 'bar' | null
  elbowed: boolean             // right-angle connector mode
}

type FreehandElement = BaseElement & {
  type: 'freehand'
  points: [number, number, number][]  // [x, y, pressure]
  simulatePressure: boolean
}

type TextElement = BaseElement & {
  type: 'text'
  text: string
  fontSize: number
  fontWeight: 'normal' | 'bold'
  fontStyle: 'normal' | 'italic'
  textAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'center' | 'bottom'
  color: string
  lineHeight: number
  letterSpacing: number
}

type ImageElement = BaseElement & {
  type: 'image'
  src: string
  objectFit: 'contain' | 'cover' | 'fill'
  sourcePath?: DrivePath
}

type GroupElement = BaseElement & {
  type: 'group'
  // Children reference the group via their `groupId` field.
  // The group's x/y/w/h is the bounding box of its children (computed, not stored).
}

type FrameElement = BaseElement & {
  type: 'frame'
  name: string           // displayed label
  clipContent: boolean   // clip children to frame bounds
}

type VectorElement =
  | RectangleElement
  | EllipseElement
  | DiamondElement
  | TriangleElement
  | LineElement
  | ArrowElement
  | FreehandElement
  | TextElement
  | ImageElement
  | GroupElement
  | FrameElement
```

### Compatibility with Slides

The slides `BaseObject` (local type in `types.ts`, not exported) maps to `BaseElement`:

| Slides BaseObject    | Vector BaseElement | Notes                                          |
|----------------------|--------------------|-------------------------------------------------|
| `id`                 | `id`               | Same                                            |
| `slideId`            | --                 | Vector uses pages, not slides                   |
| `x, y, w, h`        | `x, y, w, h`      | Same coordinate meaning (absolute pixels)       |
| `rotation`           | `rotation`         | Same (degrees)                                  |
| `borderColor`        | `strokeColor`      | Rename for drawing convention                   |
| `borderWidth`        | `strokeWidth`      | Rename                                          |
| `borderRadius`       | `borderRadius`     | Same                                            |
| --                   | `fillColor`        | New: interior fill                              |
| --                   | `opacity`          | New: element-level opacity                      |
| --                   | `strokeStyle`      | New: dashed/dotted                              |

The slides `TextObject` maps to vector `TextElement` with identical text properties (`fontSize`, `fontWeight`,
`fontStyle`, `textDecoration`, `textAlign`, `verticalAlign`, `color`, `letterSpacing`, `lineHeight`, `highlightColor`,
`backgroundColor`). The slides `ImageObject` maps to vector `ImageElement` (`src`, `objectFit`, `sourcePath`).

Migration from slides' current types to vector's extended types is additive -- no breaking changes to existing data.
However, the rendering change (DOM -> SVG) is not additive. SVG text rendering via `<foreignObject>` behaves
differently from a `<p>` in a positioned `<div>` (see [Rendering: SVG vs Canvas](#rendering-svg-vs-canvas) for
details).

Also note: `SlideItem` has `backgroundColor`, `backgroundImage`, and `backgroundImageSourcePath` -- these are
slide-level (page-level) properties that have no equivalent in the vector element model. They would stay as page
metadata, not become elements.

---

## Shared Rendering Engine

### Architecture

```
VectorCanvas (SVG root)
  |-- BackgroundLayer (grid, page bounds)
  |-- ElementLayer (SVG group, renders all elements)
  |     |-- ShapeRenderer (rect, ellipse, diamond -> SVG primitives)
  |     |-- ArrowRenderer (line/arrow -> SVG path)
  |     |-- FreehandRenderer (freehand -> SVG path from perfect-freehand)
  |     |-- TextRenderer (foreignObject wrapping div)
  |     |-- ImageRenderer (foreignObject wrapping img)
  |-- SelectionLayer (selection boxes, handles, snap lines)
  |-- CanvasOverlay (HTML Canvas, positioned over SVG, for active freehand input)
```

### Why SVG Primary

1. **Lightweight read-only mode**: Embedding a drawing in a doc or rendering a thumbnail just requires SVG elements --
   no Canvas context, no JS event loop. This is the single biggest advantage over both Excalidraw and tldraw v3.
2. **CSS styling**: SVG elements can use CSS variables, respond to dark mode via `currentColor` and CSS custom
   properties.
3. **Accessibility**: SVG elements can have ARIA labels, `<title>`, `<desc>`, and are part of the DOM tree for screen
   readers.
4. **Text rendering**: `<foreignObject>` allows real HTML/CSS text with word wrap, selection, and copy. However, this
   comes with caveats: `foreignObject` content does not participate in SVG transforms cleanly in all browsers, and text
   selection can leak outside the SVG viewport. Both Excalidraw and tldraw abandoned `foreignObject` for text and use
   Canvas text rendering instead. For Eigen, the trade-off is worth it because our text elements are typically short
   labels, not paragraphs -- and the fallback to Canvas for long text is always available.
5. **Print quality**: SVG is resolution-independent, prints at any DPI without rasterization artifacts.
6. **Export**: SVG export is trivial (serialize the DOM subtree). PNG export renders the SVG to a temporary Canvas via
   `Image` + `drawImage()`, then calls `toBlob()`.
7. **Thumbnails**: Same SVG renderer works at any scale for Drive file thumbnails and slide thumbnails, matching how
   `SlideThumbnail` already works (just renders the same components at a smaller size).

### Canvas Overlay for Freehand

Freehand drawing needs high-frequency input (pointer events at 60fps+). During active drawing, a transparent Canvas
element overlays the SVG. The Canvas renders the in-progress stroke in real-time. On pointer up, the stroke is
converted to an SVG path (via perfect-freehand) and added to the SVG layer. This hybrid approach gives both smooth
drawing and lightweight static rendering.

### Shared Renderer Usage

```typescript
// Read-only: docs embed, slides thumbnail, Drive preview
<VectorRenderer elements={elements} width={400} height={300} viewBox={bounds} />

// Interactive: vector app, docs inline edit, slides element edit
<VectorCanvas
  elements={elements}
  viewport={viewport}
  selection={selection}
  activeTool={tool}
  onElementUpdate={handleUpdate}
  onElementCreate={handleCreate}
  editable={canWrite}
/>
```

The `VectorRenderer` is a pure SVG component with zero interactivity -- used for previews, thumbnails, read-only embeds.
The `VectorCanvas` wraps `VectorRenderer` and adds interaction layers (selection, tools, canvas overlay).

---

## Yjs Data Model

### Standalone Vector Document

```
Y.Map          "elements"    -> elementId -> Y.Map { id, type, x, y, w, h, ... }
Y.Array        "elementOrder"-> ordered element IDs (z-order, bottom to top)
Y.Map          "pages"       -> pageId -> Y.Map { id, name, viewport }
Y.Array        "pageOrder"   -> ordered page IDs
Y.Map          "meta"        -> { version, gridSize, snapToGrid, background }
```

For infinite-canvas mode (no pages): a single implicit page. For multi-page mode (like a design tool): multiple pages
with independent element sets.

### Element Storage in Yjs

Each element is a `Y.Map` inside the top-level `elements` Y.Map. Properties are flat key-value pairs (matching the
slides pattern):

```typescript
// Creating an element
doc.transact(() => {
  const elementsMap = doc.getMap('elements')
  const orderArray = doc.getArray('elementOrder')

  const elemYMap = new Y.Map()
  elemYMap.set('id', id)
  elemYMap.set('type', 'rectangle')
  elemYMap.set('x', 100)
  elemYMap.set('y', 200)
  elemYMap.set('w', 300)
  elemYMap.set('h', 200)
  elemYMap.set('rotation', 0)
  elemYMap.set('strokeColor', '#000000')
  elemYMap.set('fillColor', '#ffffff')
  // ...

  elementsMap.set(id, elemYMap)
  orderArray.push([id])
})
```

This mirrors exactly how `use-deck.ts` stores slide objects. The `observeDeep` pattern for syncing to React state is
identical.

### Points Storage for Lines/Freehand

For elements with `points` arrays (lines, arrows, freehand), there are two approaches:

**Option A -- Y.Array of Y.Array (nested):**
```typescript
const pointsArray = new Y.Array()
for (const [x, y, pressure] of points) {
  const point = new Y.Array()
  point.push([x, y, pressure])
  pointsArray.push([point])
}
elemYMap.set('points', pointsArray)
```

This allows collaborative editing of individual control points without overwriting the entire array. Good for
arrows/lines where users may adjust control points.

**Option B -- Flat JSON array (simpler):**
```typescript
elemYMap.set('points', JSON.stringify(points))
```

Simpler but overwrites the entire array on any edit. Fine for freehand strokes that are drawn once and never edited
point-by-point.

Recommendation: Option A for arrows/lines (control points are user-editable), Option B for freehand strokes (drawn
once, edited by deleting the whole stroke). This matches how slides stores simple values (flat key-value) vs
structured data (Y.Array for `objectIds`).

### Arrow Bindings

Arrow start/end bindings reference other element IDs. When a bound element moves, the arrow endpoints must update.
This is handled reactively:

```typescript
// When element X moves, find all arrows bound to X and recalculate endpoints
function handleElementMove(elementId: string, newPos: {x, y, w, h}) {
  for (const arrow of getArrowsBoundTo(elementId)) {
    recalculateArrowEndpoints(arrow, elements)
  }
}
```

Bindings are stored as plain properties on the arrow element's Y.Map. The recalculation happens locally on each client
after Yjs sync -- it's deterministic so all clients converge.

---

## Integration with Docs (Tiptap)

### Tiptap Custom Node: `VectorDrawing`

Following the `ResizableImage` pattern:

```typescript
export const VectorDrawing = Node.create({
  name: 'vectorDrawing',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      drawingId: { default: null },     // ID of the .eigenvector file in Drive
      width: { default: 600 },          // display width in pixels
      height: { default: 400 },         // display height
      alignment: { default: 'center' },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(VectorDrawingView)
  },

  addCommands() {
    return {
      insertVectorDrawing: (options) => ({ commands }) => {
        return commands.insertContent({ type: this.name, attrs: options })
      },
    }
  },
})
```

### VectorDrawingView Component

```typescript
function VectorDrawingView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { drawingId, width, height } = node.attrs
  const [editing, setEditing] = useState(false)

  if (editing) {
    // Full interactive vector canvas, connects to its own Yjs doc
    return (
      <NodeViewWrapper
        onMouseDown={e => e.stopPropagation()}  // prevent ProseMirror from stealing events
        onKeyDown={e => e.stopPropagation()}    // prevent Tiptap hotkeys during drawing
      >
        <VectorCanvas
          documentId={drawingId}
          width={width}
          height={height}
          onClose={() => setEditing(false)}
          editable={editor.isEditable}
          toolbarPosition="top"  // floating toolbar above the drawing
        />
      </NodeViewWrapper>
    )
  }

  // Read-only: render static SVG from last-known element state
  return (
    <NodeViewWrapper>
      <ImageResizeHandles
        width={width}
        onResize={(w) => updateAttributes({ width: w })}
        selected={selected}
        editable={editor.isEditable}
      >
        <VectorRenderer
          documentId={drawingId}
          width={width}
          height={height}
          onDoubleClick={() => editor.isEditable && setEditing(true)}
        />
      </ImageResizeHandles>
    </NodeViewWrapper>
  )
}
```

### Inline Editing: Practical Challenges

Inline editing (drawing directly within the doc flow) is more complex than the modal approach:

1. **Event isolation**: ProseMirror intercepts keyboard events (backspace, arrow keys, etc.) and mouse events (drag
   selection). The `NodeViewWrapper` must call `stopPropagation()` on all pointer and keyboard events when the vector
   canvas is active. Tiptap's `atom: true` helps (ProseMirror treats the node as opaque) but doesn't fully prevent
   parent event handlers from firing.

2. **Two Yjs docs on one page**: The parent document has its own `Y.Doc` + `WebsocketProvider`. The inline vector
   drawing connects to a separate `Y.Doc`. This doubles the WebSocket connections per inline drawing. For documents
   with many drawings, this could be expensive. Mitigation: only connect the vector Yjs doc when the drawing enters
   edit mode; in read-only mode, fetch a cached SVG snapshot.

3. **Scroll interaction**: When the vector canvas has pan/zoom, two-finger scroll must be intercepted by the vector
   canvas, not the doc's scroll container. CSS `touch-action: none` on the vector canvas handles this, but it means
   you can't scroll past the drawing by swiping over it -- a usability concern for mobile.

4. **Size negotiation**: The drawing has an intrinsic size (its element bounding box) but is displayed at a constrained
   width within the doc. Resizing the embed should change the display scale, not the drawing's coordinate space. This
   is a `viewBox` / scale transform, not a resize of elements.

For Phase 4, the recommendation is to start with **modal editing** (double-click opens a dialog with the full vector
editor) and move to inline editing later once the interaction isolation is battle-tested.

### Comparison with Other Products

Google Docs opens a modal drawing editor. The drawing is a separate entity embedded as an image with "double-click to
edit." Notion embeds third-party tools (Miro, Figma) via iframes. Our approach is native: the drawing lives as an
`.eigenvector` file in Drive (shareable, versionable), the inline preview is live SVG (not rasterized), and the editor
shares auth/storage/collab infrastructure.

---

## Integration with Slides

### Current Slides Element Types

The slides app has exactly two element types (`apps/slides/src/components/slides/types.ts`):

- `TextObject`: text content + typography properties (`fontSize`, `fontWeight`, `fontStyle`, `textDecoration`,
  `textAlign`, `verticalAlign`, `color`, `letterSpacing`, `lineHeight`, `highlightColor`, `backgroundColor`)
- `ImageObject`: `src` (Drive embed URL), `objectFit` (`contain`/`cover`/`fill`), `sourcePath`

Both extend a local `BaseObject` with `id`, `slideId`, `x`, `y`, `w`, `h`, `rotation`, `borderColor`, `borderWidth`,
`borderRadius`.

### Integration Path

**Phase 5A -- Shared Types**: The vector `BaseElement` becomes the source of truth. Slides imports from
`@workspace/vector`:

```typescript
// In slides types.ts, import from vector:
import type { TextElement, ImageElement, RectangleElement, EllipseElement, ArrowElement } from '@workspace/vector'

// SlideObject becomes a union of vector elements + slide-specific wrapper
type SlideObject = (TextElement | ImageElement | RectangleElement | EllipseElement | ArrowElement) & {
  slideId: string  // vector elements don't have slideId -- slides adds it
}
```

**Phase 5B -- DOM-Based Shape Rendering**: Add new shape cases to `SlideObjectView` and `ReadOnlySlideObject` in
`slide-object.tsx`. Render shapes as inline SVG inside the existing positioned `<div>` approach:

```typescript
// In slide-object.tsx, new case:
{obj.type === 'rectangle' && (
  <svg className="w-full h-full" viewBox={`0 0 ${obj.w} ${obj.h}`}>
    <rect width={obj.w} height={obj.h} fill={obj.fillColor} stroke={obj.strokeColor}
          strokeWidth={obj.strokeWidth} rx={obj.borderRadius} />
  </svg>
)}
```

**Phase 5C -- Shape Tools**: Add shape insertion tools to the slides toolbar. Users can add rectangles, ellipses,
arrows to slides. The properties panel gets fill/stroke sections for shape objects.

### Coordinate System Reconciliation

- **Vector app**: Absolute pixel coordinates on an infinite canvas. Viewport pan/zoom (translate + scale) determines
  what's visible. The SVG `viewBox` attribute handles the transform.
- **Slides**: Absolute pixels in 1920x1080 space. Rendering converts to percentages via `pxToPercent()`, making
  slides responsive to container size.
- **Doc embeds**: The drawing has intrinsic dimensions (bounding box of all elements). Display at a fixed width with
  aspect-ratio-preserving scale. The SVG `viewBox` handles this naturally.

All three contexts store the same absolute coordinates. The rendering difference is entirely in how the SVG
`viewBox` and container sizing work:

```typescript
// Vector app: viewBox tracks the pan/zoom viewport
<svg viewBox={`${viewport.x} ${viewport.y} ${viewport.w} ${viewport.h}`} width="100%" height="100%">

// Slides: viewBox is always the full slide (0 0 1920 1080), container has aspect-ratio: 16/9
<svg viewBox="0 0 1920 1080" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">

// Doc embed: viewBox is the bounding box of all elements, container has fixed width
<svg viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} width={displayWidth}>
```

This eliminates the need for a `CoordinateTransform` abstraction. The SVG standard already solves this with
`viewBox` + `preserveAspectRatio`. Font sizes and stroke widths are in the same coordinate space as element
positions -- they scale naturally with the `viewBox`.

---

## Could Slides Be Built on Top of Vector?

**Partially yes, but a full rewrite is a long-term goal with significant migration cost.** The practical path is
incremental: share element types first, then share rendering, then share interaction -- not a big-bang rewrite.

### What Slides Is Today

Slides = fixed-page canvas (1920x1080) + elements (text, image) + slide management (ordering, duplication, background)
+ presentation mode. It has ~1200 LOC of custom interaction code (`use-object-drag.ts`, `use-snap-lines.ts`,
`slide-object.tsx`, `slide-canvas.tsx`) and ~300 LOC of Yjs integration (`use-deck.ts`, `normalize-deck.ts`).

### What Would Slides Gain from Vector?

- Shape primitives: rectangles, ellipses, arrows, lines, freehand
- Connector arrows that bind to shapes and follow when shapes move
- Fill patterns, opacity, dashed strokes
- Grouping
- A richer properties panel

### What Would Break or Need Rework?

1. **Rendering model change (DOM -> SVG)**: Slides currently renders elements as positioned `<div>`s with CSS
   transforms. Text is a `<p>` with `white-space: pre-wrap`. Images are `<img>` with `object-fit`. Switching to SVG
   means text becomes `<foreignObject>` (which has cross-browser quirks with overflow, scrolling, and events), and
   images become `<image>` or `<foreignObject>` wrapping `<img>`. The current `SlideThumbnail` also uses the same
   DOM-based rendering -- it would need to switch to SVG too. **This is the biggest risk.**

2. **Coordinate system**: Slides stores absolute pixels (0-1920, 0-1080) and converts to percentages at render time
   via `pxToPercent()`. The vector engine uses absolute coordinates with a viewport transform. For slides, the
   viewport transform would be fixed (scale-to-fit the slide container). This is conceptually clean but changes how
   `getObjectPositionStyle()` works -- from CSS percentages to SVG `transform` attributes.

3. **Text editing**: Slides currently uses a `<textarea>` for inline text editing (double-click to edit). The vector
   engine would need to support the same interaction but inside an SVG context. This either means a `<foreignObject>`
   wrapping a `<textarea>` (fragile) or an HTML overlay positioned via JavaScript (more reliable).

4. **Slide-specific features that don't map to vector concepts**:
   - `SlideItem.backgroundImage` / `backgroundImageSourcePath` -- page-level background images with "apply to
     this/following/all" support
   - `SlideItem.backgroundColor` -- per-page background color
   - Deck normalization (`normalize-deck.ts`) -- fixes orphaned objects, deduplicates references
   - Slide duplication (deep-clones all objects)
   - Presentation mode (fullscreen, click-to-advance, right-click-to-go-back)
   These stay in `apps/slides` as slide-specific logic. The vector engine provides the canvas; slides provides the
   page management.

5. **Yjs data model**: Slides uses `Y.Map("slides")` + `Y.Map("objects")` + `Y.Array("slideOrder")`. Vector uses
   `Y.Map("elements")` + `Y.Array("elementOrder")` + `Y.Map("pages")`. The structures are similar but not identical.
   Migration requires either a compatibility layer or a one-time data migration for existing `.eigenslides` files.
   Since data is throwaway during dev, migration is not a concern now.

### Recommended Incremental Path

1. **Phase A -- Shared types** (low risk): Move `BaseElement` and shape types to `packages/vector`. Slides imports
   and extends them. Existing `TextObject`/`ImageObject` become aliases. No rendering changes.

2. **Phase B -- Add shapes to slides** (medium risk): Add rectangle, ellipse, arrow as new `SlideObject` variants.
   Render them using the existing DOM-based approach (positioned `<div>`s with SVG inline or as background). This
   gives slides shapes without changing the rendering engine.

3. **Phase C -- Shared SVG renderer** (high risk): Replace slides' DOM rendering with the vector SVG renderer. This
   is the big change. It should only happen after the vector engine is stable and proven in the standalone app.

### Why Not Separate Systems Long-Term?

Maintaining two element systems, two renderers, and two interaction models is a maintenance burden. Every bug fix and
feature (e.g., "add gradient fills") must be implemented twice. The vector engine should eventually be the single
source of truth for 2D element rendering across Eigen.

---

## Cross-Cutting Concerns

### Copy-Paste of Vector Elements

The current `EigenClipboardItem` union (`packages/lib/src/types/clipboard.ts`) only has `text` and `image` types. To
support copy-paste of vector elements between apps, a new item type is needed:

```typescript
type EigenClipboardVectorItem = {
  type: 'vector-elements'
  meta: {
    elements: VectorElement[]
    bounds: { x: number; y: number; w: number; h: number }
  }
}
```

**Cross-app paste behavior:**

| Source | Target | Behavior |
|--------|--------|----------|
| Vector -> Vector | Paste elements at cursor, offset slightly to show paste happened |
| Vector -> Slides | Paste as slide objects. Map `VectorElement` fields to `SlideObject` fields. If the source has shapes that slides doesn't support yet, paste as an embedded `.eigenvector` image. |
| Vector -> Docs | Paste as inline SVG image (rasterize to PNG if SVG embedding is complex) |
| Slides -> Vector | Paste as vector elements. Map `SlideObject` fields to `VectorElement` fields. |
| External SVG -> Vector | Parse SVG, convert to vector elements (limited: only simple shapes and paths) |

For the `text/html` fallback (cross-tab paste), the vector elements would be serialized as an SVG string in the HTML
payload. External apps that paste this content get a rendered SVG. Eigen apps that paste it extract the
`data-eigen-clipboard` attribute to get the structured data.

See `docs/RESEARCH_COPY_PASTE.md` for the full clipboard architecture.

### Vector Drawings as Slide Backgrounds

Slides already supports `backgroundImage` per slide (`SlideItem.backgroundImage`). A vector drawing could be used as a
slide background by:

1. Exporting the `.eigenvector` to SVG on the server
2. Serving the SVG as an image URL via the Drive embed endpoint
3. Setting `backgroundImage` to that URL

This would be a static snapshot, not a live vector -- but it covers the "design a complex background in vector, use it
in slides" workflow. Live vector backgrounds (rendering the vector SVG inline behind slide content) would require the
SVG renderer to be available in the slides app, which is Phase C of the slides integration.

### Preview of `.eigenvector` Files in Drive

Following the pattern in `docs/RESEARCH_PREVIEWS.md`, the preview system needs:

1. A viewer component that renders the vector SVG read-only (the `VectorRenderer` component)
2. A thumbnail generator that renders the SVG at thumbnail size (server-side or on first open)
3. Registration in the preview pipeline:

```typescript
{ canHandle: (m) => m === 'application/eigenvector', thumbnailSupported: true,
  component: lazy(() => import('./viewers/eigenvector-viewer')), priority: 90 }
```

Since `VectorRenderer` is pure SVG with no Canvas dependency, the preview is lightweight -- no heavy JS runtime
needed for read-only display.

### Graphs and Charts in Vector

Vector drawings can host chart/graph elements as a specialized element type:

```typescript
type ChartElement = BaseElement & {
  type: 'chart'
  chartType: 'bar' | 'line' | 'pie' | 'scatter'
  data: { labels: string[]; datasets: { label: string; values: number[]; color: string }[] }
}
```

This would render as SVG (bar chart = `<rect>` elements, line chart = `<polyline>`, pie = `<path>` arcs). The chart
element would have a data editor in the properties panel (simple table input) rather than requiring a separate sheets
document. This is how Excalidraw's chart feature works -- data in, SVG out.

However, charts are a Phase 6+ feature. The priority is getting basic shapes and freehand drawing working first.

---

## File Format

### Storage: `.eigenvector`

Following the established Eigen pattern:

```
mydiagram.eigenvector/
  data.db              # Yjs document (same as .eigendoc, .eigenstickies, .eigenslides)
```

The Yjs document contains the full vector drawing state.

### Drive Integration

```typescript
// packages/lib/src/types/drive.ts additions:
export const DRIVE_TYPE_VECTOR = "vector" as const;
export const DRIVE_MIME_VECTOR = "application/eigenvector" as const;
export type DriveTypeVector = typeof DRIVE_TYPE_VECTOR;

// Add DriveTypeVector to the DrivePathType union
// Add to DriveCollabType: ... | DriveTypeVector
// Add to isCollabType(): || type === DRIVE_TYPE_VECTOR
```

### Backend

Following the existing `createSlides()` pattern in `apps/api/src/lib/drive/drive.ts`:

```typescript
// apps/api/src/lib/drive/drive.ts addition:
async createVector(mountId: string, parentId: string, vectorName: string): Promise<DrivePath> {
  const mount = this.getMount(mountId);
  if (!(await this.canWrite(mountId, parentId, this.owner))) {
    throw new ApiError(403, 'No write permission');
  }
  const safeName = `${vectorName}.eigenvector`;
  const pathId = await mount.createFolder(parentId, safeName, DRIVE_TYPE_VECTOR);
  await CollabDocument.create(this, mountId, pathId);
  const vector = await mount.getPath(pathId);
  if (!vector) throw new ApiError(500, 'Failed to create vector');
  this.emit(SSEventType.DRIVE_FILE_CREATED, vector);
  return vector;
}
```

### JSON Export Format

For interoperability, support exporting to a JSON format similar to Excalidraw's `.excalidraw` format:

```json
{
  "type": "eigenvector",
  "version": 1,
  "elements": [
    {
      "id": "elem_abc123",
      "type": "rectangle",
      "x": 100, "y": 200,
      "w": 300, "h": 200,
      "rotation": 0,
      "strokeColor": "#000000",
      "fillColor": "#e3f2fd",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "opacity": 1,
      "borderRadius": 8
    }
  ],
  "elementOrder": ["elem_abc123"],
  "meta": {
    "background": "#ffffff",
    "gridSize": 20
  }
}
```

---

## Rendering: SVG vs Canvas

### Detailed Comparison

| Criterion              | SVG                              | Canvas                          | Winner for Eigen      |
|------------------------|----------------------------------|---------------------------------|-----------------------|
| Read-only embed        | Lightweight, just DOM nodes      | Needs JS runtime + context      | SVG                   |
| Text rendering         | foreignObject = real HTML text   | `measureText` + manual wrapping | SVG (with caveats)    |
| Print quality          | Vector, infinite resolution      | Raster, fixed resolution        | SVG                   |
| Interactivity          | DOM events per element           | Hit testing via math             | SVG (simpler)         |
| Performance (< 500)    | Excellent                        | Excellent                       | Tie                   |
| Performance (> 2000)   | Degrades (DOM node count)        | Excellent                       | Canvas                |
| Freehand input         | Laggy (path recalc each frame)   | 60fps+ native                   | Canvas                |
| Dark mode              | CSS variables work               | Manual color management          | SVG                   |
| Accessibility          | ARIA on elements                 | Single opaque rectangle          | SVG                   |
| Export to SVG          | Trivial (serialize DOM)          | Must rebuild SVG separately      | SVG                   |
| Export to PNG          | SVG -> Canvas -> `toBlob()`      | Direct `toDataURL()`            | Canvas (simpler)      |
| Thumbnails             | Scale SVG, done                  | Re-render at different size      | SVG                   |
| foreignObject quirks   | Overflow, z-index, events leak   | N/A                             | Canvas                |

**foreignObject caveats**: `<foreignObject>` is the standard way to embed HTML inside SVG. It works well for simple
content (a text label, a small `<div>`), but has known issues:
- Overflow does not clip correctly in Safari in some configurations
- Elements inside `foreignObject` can receive mouse events even when another SVG element is visually on top
- Scrollable content inside `foreignObject` conflicts with SVG zoom/pan
- `<textarea>` inside `foreignObject` has focus/blur issues in Firefox

For Eigen, text elements are typically short labels (slide titles, diagram labels), where `foreignObject` works fine.
For long-form text editing (paragraphs), a positioned HTML overlay (outside the SVG) is more reliable.

### Decision: SVG Primary + Canvas Overlay

The hybrid approach gives the best of both:

- **SVG** for all static/interactive elements: shapes, text, images, arrows, stored freehand strokes
- **Canvas** only during active freehand drawing (temporary overlay, disposed after stroke completes)
- **Canvas** for export-to-PNG (one-shot rendering)

If performance becomes an issue with >2000 elements (unlikely for typical diagrams), the escape hatch is viewport
culling + spatial indexing, not a full Canvas rewrite. The tldraw v3 switch to Canvas was motivated by their
"infinite whiteboard" use case with thousands of shapes -- Eigen's use case is more constrained.

### Performance Cliff Mitigation

For documents with many elements:
- **Viewport culling**: Only render elements whose bounding boxes intersect the viewport (this is the single most
  impactful optimization)
- **Level-of-detail**: At low zoom, replace complex elements (text, images) with colored rectangles
- **Spatial indexing**: R-tree (`rbush`, 5KB) for fast viewport queries
- **DOM recycling**: Reuse SVG element nodes when scrolling, updating attributes rather than creating/destroying

---

## Collaboration UX

### Multiple People Drawing at Once

Collaborative drawing has different UX challenges than collaborative text editing:

1. **Spatial conflicts**: Two users can draw overlapping elements. Unlike text (where cursor position defines
   insertion point), drawing has no natural "insertion point" -- elements can be placed anywhere. This means
   concurrent edits rarely conflict at the CRDT level (different Yjs keys), but users may draw on top of each other
   without realizing it.

2. **Cursor visibility**: Show each user's cursor position, active tool, and name label. This uses the Yjs awareness
   protocol (already supported by Eigen's `CollabDocument`). Each client publishes:

```typescript
provider.awareness.setLocalStateField('cursor', {
  x: pointerX,    // in document coordinates, not screen
  y: pointerY,
  tool: activeTool,  // 'select' | 'rectangle' | 'draw' | ...
  color: userColor,
  name: userName,
})
```

Other clients render ghost cursors as SVG overlays. The cursor shape can reflect the active tool (crosshair for shape
tools, pencil for draw, pointer for select).

3. **Selection conflicts**: Two users can select the same element. If user A is dragging an element while user B edits
   its text, the Yjs merge is fine (different keys: position vs text content), but the visual feedback is confusing.
   Solution: show a colored border on elements that other users have selected, with their name label. Don't prevent
   concurrent selection -- just make it visible.

4. **Freehand drawing**: During active freehand drawing, points are collected locally and committed to Yjs on stroke
   completion (not per-point). This means other users don't see the stroke being drawn in real-time. This is the
   standard approach (both Excalidraw and tldraw do this). Streaming points per-frame would generate too many Yjs
   operations and cause jitter on slow connections.

5. **Undo isolation**: `Y.UndoManager` can be scoped to track only local changes. User A's undo should not undo user
   B's rectangle. This is the default Yjs behavior when each client creates its own `UndoManager` instance.

### Awareness State

```typescript
type VectorAwareness = {
  cursor: { x: number; y: number } | null
  tool: string
  selectedIds: string[]
  color: string
  name: string
}
```

This is rendered as a thin SVG layer on top of the element layer:
- Colored cursor icons for each remote user
- Colored selection outlines on elements selected by remote users
- Name labels near cursors (fading after a few seconds of inactivity)

---

## Key Libraries

### Must-Have

| Library            | Purpose                    | Size    | License | Notes                                    |
|--------------------|----------------------------|---------|---------|------------------------------------------|
| **perfect-freehand** | Pen stroke smoothing     | 3KB     | MIT     | Used by both Excalidraw and tldraw       |
| **yjs**            | CRDT collaboration         | already | MIT     | Already used across all Eigen collab apps |
| **y-websocket**    | Yjs WebSocket provider     | already | MIT     | Already used                             |
| **nanoid**         | ID generation              | already | MIT     | Already used                             |

### Optional

| Library            | Purpose                    | Size    | License | Notes                                    |
|--------------------|----------------------------|---------|---------|------------------------------------------|
| **rough-notation** | Hand-drawn annotations     | 3.5KB   | MIT     | Lighter than Rough.js, good for annotations |
| **roughjs**        | Sketchy shape rendering    | 13KB    | MIT     | Opt-in style mode                        |
| **d3-shape**       | Arrow path calculation     | 8KB     | ISC     | Only if custom path math is insufficient |
| **rbush**          | R-tree spatial index       | 5KB     | MIT     | For viewport culling with many elements  |

### Not Needed (Build Custom)

- **@excalidraw/excalidraw**: Too large, too coupled, wrong rendering model
- **@tldraw/tldraw**: License concerns, too opinionated UI
- **konva/react-konva**: Canvas-only, no SVG
- **fabric.js**: Canvas-only, old architecture

---

## Performance Considerations

### Element Count Targets

| Count      | Approach                         |
|------------|----------------------------------|
| < 500      | Render all SVG, no optimization  |
| 500-2000   | Viewport culling                 |
| 2000-5000  | Viewport culling + spatial index |
| > 5000     | Consider Canvas fallback         |

Most drawings will have < 200 elements. Slides typically have < 20 per page. Doc embeds typically < 50.

### Freehand Performance

Freehand strokes can generate hundreds of points. For rendering:
- During drawing: Canvas overlay, raw points at 60fps
- After drawing: Convert to optimized SVG path via perfect-freehand, reduce point count
- Storage: Store the reduced point set (typically 10-50 points per stroke after simplification)

### Collaboration Performance

Yjs handles concurrent edits well for map-based storage. Key considerations:
- Each property change is an independent Yjs operation (fine-grained)
- During active drag: batch position updates using `requestAnimationFrame`, commit to Yjs at the end (matching slides'
  current `dragPreview` pattern)
- Freehand: collect points locally, push to Yjs on stroke complete (not per-point)

---

## Specialized Shape Libraries

Beyond basic shapes (rectangle, ellipse, diamond), a drawing app needs pre-built shape sets for common diagram types.
These should be implemented as **shape presets** (pre-configured `VectorElement` instances), not new element types.

### Flowchart Shapes

Standard flowchart symbols, each a styled `RectangleElement` or `DiamondElement` with default size and label:

| Shape | Implementation | Default Text |
|-------|---------------|-------------|
| Process | Rectangle, no border radius | "Process" |
| Decision | Diamond | "Yes/No?" |
| Terminal | Rectangle, full border radius (pill shape) | "Start/End" |
| Data | Parallelogram (custom SVG path via `PathElement`) | "Input" |
| Document | Rectangle with wavy bottom edge (custom path) | "Document" |
| Database | Cylinder (custom path) | "Database" |

These are inserted from a "Shapes" panel in the toolbar, similar to how Google Drawings and draw.io work.

### Org Chart / Tree Layout

An org chart is not a special element type -- it's a set of rectangles connected by arrows, with an automatic layout
algorithm. The vector engine provides the elements; a layout function positions them:

```typescript
function layoutOrgChart(
  nodes: { id: string; parentId?: string; label: string }[],
  options: { direction: 'top-down' | 'left-right'; spacing: number }
): VectorElement[]
```

This generates `RectangleElement`s (with text) and `ArrowElement`s (with bindings). The user can then manually adjust
positions -- the layout is a one-time operation, not a constraint system.

### Mind Maps

Similar to org charts but with a radial layout. Same approach: a layout function that generates positioned elements.

### Mathematical Diagrams

For mathematical diagrams (graphs, geometric constructions), the key requirement is precise positioning and labels with
mathematical notation. Math notation could be rendered via KaTeX inside a `<foreignObject>`. However, this is a
specialized use case -- defer to Phase 6+.

### Implementation Strategy

Shape libraries should be stored as JSON templates (arrays of `VectorElement` definitions) in `packages/vector/src/
templates/`. They are not separate files in Drive -- they're built into the app. Users insert them via a toolbar panel,
and the template elements are instantiated in the current document.

Custom user templates (save a selection as a reusable template) is a future feature that would store templates as
`.eigenvector` files in a user's Drive.

---

## Export Capabilities

### SVG Export

```typescript
function exportToSvg(elements: VectorElement[], options?: {
  background?: string
  padding?: number
  darkMode?: boolean
}): string {
  // Calculate bounding box of all elements
  // Render SVG string with proper viewBox
  // Include embedded fonts if custom fonts used
  // Inline image data as base64 or keep URLs
}
```

### PNG Export

```typescript
async function exportToPng(elements: VectorElement[], options?: {
  scale?: number      // 1 = 1x, 2 = 2x retina
  background?: string
  width?: number
  height?: number
}): Promise<Blob> {
  // Render SVG to string
  // Create offscreen Canvas
  // Draw SVG onto Canvas via Image
  // canvas.toBlob()
}
```

### Clipboard Export

When copying elements from vector, use the Eigen clipboard system with the new `vector-elements` item type (see
[Cross-Cutting Concerns](#cross-cutting-concerns)):

```typescript
const data: EigenClipboardData = {
  version: 1,  // bump to version 2 when adding vector-elements type
  items: [{
    type: 'vector-elements',
    meta: {
      elements: selectedElements,
      bounds: getBounds(selectedElements),
    }
  }]
}
```

For the `text/html` fallback (cross-tab and external paste), include an SVG rendering of the selected elements. This
gives external apps a visual representation, while Eigen apps extract the structured data from the
`data-eigen-clipboard` attribute.

For the `text/plain` fallback, export element labels/text content as plain text (if any).

---

## Touch and Stylus Support

### Pointer Events API

Use the Pointer Events API (not mouse/touch separately):
- `pointerdown`, `pointermove`, `pointerup`
- `event.pressure` for pressure-sensitive drawing (stylus)
- `event.pointerType` to distinguish 'mouse', 'touch', 'pen'
- `event.tiltX`, `event.tiltY` for stylus tilt (future: calligraphy brushes)

### Touch Gestures

| Gesture              | Action           |
|----------------------|------------------|
| One finger drag      | Tool action (draw, select, etc.) |
| Two finger pinch     | Zoom             |
| Two finger drag      | Pan              |
| Long press           | Context menu     |
| Double tap           | Edit text        |

### Palm Rejection

When `pointerType === 'pen'`, ignore concurrent touch events (palm resting on screen). This is standard behavior
with the Pointer Events API when properly configured.

---

## Annotations on Documents and Images

The vector engine naturally enables annotation use cases. All annotation modes share the same core: an
`.eigenvector` file with a background layer (image, PDF page, or transparent overlay) and vector elements drawn on
top.

### Image Annotations

In Drive, when previewing an image, offer an "Annotate" action that:
1. Creates an `.eigenvector` file (sibling to the image in Drive) with the image as a locked background
   `ImageElement` at position (0,0) with the image's natural dimensions
2. Opens the vector editor with a restricted tool set (freehand, arrow, text, highlight rectangle)
3. Annotations are stored as vector elements on top of the image
4. The original image is unchanged -- annotations are a separate file that references it

The annotated version can be exported as PNG (image + annotations flattened) or viewed in the preview system (SVG
overlay on the image).

### Document Annotations

In Docs, a "Draw" toolbar button that:
1. Creates/opens an inline `.eigenvector` embedded via the `VectorDrawing` Tiptap node
2. User draws a diagram, flowchart, or annotation
3. The drawing appears inline in the document flow

This is distinct from "drawing on top of the document" (like a whiteboard overlay). Inline drawings are positioned
within the text flow like images. A full-page annotation overlay (draw anywhere on the page) is a separate feature
that would require a Canvas layer above the Tiptap editor -- significantly more complex and not recommended for Phase
4.

### PDF Annotations (Future)

Same pattern: render PDF pages as images (via pdf.js), each page gets a transparent `.eigenvector` overlay. The
annotation file stores references to page numbers and vector elements per page. This requires the multi-page vector
mode (`Y.Map("pages")`) where each page corresponds to a PDF page.

---

## Implementation Phases

### Phase 0: Foundation (1-2 weeks)

**Goal**: Shared element types and basic SVG renderer.

- Create `packages/vector/` package structure
- Define `BaseElement` and initial element types: `rectangle`, `ellipse`, `text`, `image`
- Build `VectorRenderer` (read-only SVG renderer)
- Build `ElementRenderer` that dispatches by type
- Implement SVG equivalents of slides' `getObjectPositionStyle()` and `getTextStyle()`
- Unit tests for geometry/bounds utilities
- Verify `foreignObject` text rendering works across Chrome, Firefox, Safari

### Phase 1: Standalone App (2-3 weeks)

**Goal**: Working vector app with basic shapes.

- Create `apps/vector/` app (following the standard Eigen app structure: `_auth.tsx` guard, `_auth._sidebar.tsx`,
  route for `.eigenvector` files)
- Build `VectorCanvas` with interactive SVG (pan/zoom viewport, selection layer)
- Implement tools: select (move/resize/rotate), rectangle, ellipse, text
- Implement `use-vector-doc.ts` (Yjs integration, following `use-deck.ts` pattern from slides)
- Properties panel (reuse `PropertiesPanel`, `PropertyRow`, `PropertySection` from `@workspace/ui`)
- Register `.eigenvector` file type in Drive:
  - Add `DRIVE_TYPE_VECTOR` and `DRIVE_MIME_VECTOR` to `packages/lib/src/types/drive.ts`
  - Add to `DriveCollabType` union and `isCollabType()` function
  - Add `createVector()` to `apps/api/src/lib/drive/drive.ts` (following `createSlides()` pattern)
  - Add route in `apps/api/src/routes/drive.ts`
- Snap lines (port from slides' `use-snap-lines.ts`, generalize to viewport coordinates)
- Undo/redo via `Y.UndoManager`
- Keyboard shortcuts (Delete, Cmd+Z, Cmd+C/V, arrow keys for nudge, Cmd+A for select all)

### Phase 2: Drawing Tools (1-2 weeks)

**Goal**: Freehand drawing and lines.

- Add `perfect-freehand` dependency (3KB, MIT)
- Implement Canvas overlay for freehand input (pointer events -> local point buffer -> commit to Yjs on pointerup)
- Freehand tool with pressure sensitivity (`event.pressure`)
- Line tool with arrowheads
- Eraser tool (removes elements whose bounding boxes intersect the eraser path)
- Stroke style options (solid, dashed, dotted)
- Fill style options (solid, none, hachure if Rough.js is included)
- Awareness integration: show remote users' cursors and tool state

### Phase 3: Arrows and Connectors (1-2 weeks)

**Goal**: Smart arrows that bind to shapes.

- Arrow tool that snaps to element connection points (edges + center)
- Binding system: arrows store `startBinding` / `endBinding` with element IDs. When a bound element moves, a reactive
  handler recalculates arrow endpoints. This must be deterministic (all clients compute the same result from the same
  Yjs state).
- Elbowed (right-angle) connector mode
- Basic arrow label (text on the midpoint of the arrow path)

### Phase 4: Docs Integration (1-2 weeks)

**Goal**: Drawings in documents.

- Create `VectorDrawing` Tiptap extension (following `ResizableImage` pattern)
- **Start with modal editing**: double-click opens a dialog with the full vector editor. Click "Done" saves and
  closes. The inline view shows a static SVG snapshot.
- Resize handles on the embedded drawing (display scale only, does not resize elements)
- "Insert drawing" toolbar button in docs editor
- Later iteration: inline editing (edit in-place within the doc flow) once event isolation is proven

### Phase 5: Slides Integration (incremental, 2-4 weeks)

**Goal**: Slides gains shape tools without a rendering rewrite.

- **Phase 5A -- Shared types**: Import `BaseElement` and shape types from `@workspace/vector`. Define `ShapeObject`,
  `ArrowObject`, `FreehandObject` as new `SlideObject` variants. Add to the `OBJECT_FIELDS` list in `use-deck.ts`.
  Clean up the vestigial shadow fields while doing this.
- **Phase 5B -- DOM-based shape rendering**: Add rendering for the new shape types in `slide-object.tsx` using
  positioned `<div>`s with inline SVG (e.g., `<svg viewBox="..."><rect .../></svg>` inside the positioned div). This
  avoids the DOM-to-SVG migration while giving slides shapes.
- **Phase 5C -- Shape tools in toolbar**: Add shape insertion tools (rectangle, ellipse, arrow) to the slides toolbar.
  Properties panel gets fill/stroke options for shape objects.

### Phase 6: Advanced Features (ongoing)

- Diamond, triangle, star, polygon shape presets
- Grouping/ungrouping (requires group-aware selection, group transforms)
- Frames (artboards) for organizing elements into named regions
- Minimap (render all elements at tiny scale in a corner overlay)
- SVG/PNG export with configurable background, padding, scale
- Copy-paste between vector, slides, and docs (requires `EigenClipboardVectorItem` type)
- Flowchart shape library (process, decision, terminal, data, database)
- Rough.js opt-in sketchy style mode
- Touch/stylus optimization (palm rejection, pressure curves)
- Gradient fills, drop shadows, image crop/mask inside shapes

### Phase 7: Slides SVG Rendering Migration (future)

- Replace slides' DOM-based rendering with the vector SVG renderer
- Slides becomes: `packages/vector` canvas in fixed-page mode + slide management + presentation mode
- Delete slides-specific rendering code (`getObjectPositionStyle()`, `ReadOnlySlideObject`, `ThumbnailObject`)
- Keep slides-specific features: slide panel, presentation mode, backgrounds, speaker notes, templates
- This phase only makes sense after the vector engine has been stable and battle-tested for months

---

## Open Questions

1. **Infinite canvas vs fixed-page default?** Infinite canvas is more natural for diagrams. Fixed pages make sense
   for printable output. Recommendation: default to infinite canvas, offer "add page" for multi-page mode.

2. **Rough.js: include or defer?** The hand-drawn style is fun but may feel unprofessional. Recommendation: defer to
   Phase 6. If included, make it a per-element style toggle (`roughness: 0` = smooth, `roughness: 1+` = sketchy),
   not a global setting.

3. **Arrow routing complexity**: Simple (straight line + optional elbow) vs complex (A* pathfinding around shapes)?
   Recommendation: start with straight + elbow. Pathfinding is a rabbit hole. Both Excalidraw and tldraw use simple
   routing.

4. **Font handling in SVG export**: System fonts render fine in the browser but may not be available when the SVG is
   opened in another app. Options: (a) embed font subsets as `@font-face` in the SVG (complex, increases file size),
   (b) convert text to paths on export (loses editability), (c) use web-safe fonts only (limiting). Recommendation:
   option (c) for now, option (a) for Phase 6.

5. **Dark mode**: Drawings should maintain their authored appearance (a white-background diagram stays white in dark
   mode). The canvas chrome (toolbar, panels, background outside the drawing) follows the system theme. The drawing's
   background color is an explicit setting, not tied to the system theme.

6. **Inline vector in docs: separate file or embedded data?** Recommendation: separate `.eigenvector` file, referenced
   by `drawingId` attribute in the Tiptap node. This keeps the doc's Yjs document small and allows the drawing to be
   shared/opened independently. The downside is that deleting the doc does not automatically delete orphaned drawings
   -- Drive cleanup logic would need to handle this.

7. **Multi-select interaction model**: Should multi-select create a temporary group (single bounding box, single
   transform) or allow independent transforms? Recommendation: temporary group (like slides does today), with explicit
   "Group" action for permanent grouping.
