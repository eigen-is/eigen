# Proposal: eigen|vector> -- Drawing & Diagramming App

## TLDR

Build a custom collaborative vector drawing app using SVG rendering + Canvas overlay for freehand, with Yjs for
real-time collaboration. Do NOT embed or fork Excalidraw/tldraw -- both have deal-breaking architectural mismatches.
The vector engine lives in `packages/vector/` as a shared package consumed by the standalone app, docs (Tiptap node),
and eventually slides (shared element types). Slides integration is additive -- no rendering rewrite until the engine
is battle-tested.

---

## Critical Evaluation of the Research

### Build from Scratch vs Embed Excalidraw vs Fork Excalidraw

**Recommendation: Build from scratch.** This is the right call, but it needs to be said clearly that this is a
multi-month effort, not a "few weeks" project. The research document's phase estimates (1-2 weeks per phase) are
optimistic for the interaction engineering involved.

**Why not embed Excalidraw (via `@excalidraw/excalidraw`)?**

- **Yjs incompatibility is the killer.** Excalidraw uses last-write-wins per element, not a CRDT. Every other Eigen
  collab app (docs, slides, stickies, sheets) uses Yjs natively. Bolting a Yjs adapter onto Excalidraw means
  maintaining a translation layer between two different conflict resolution models. This is a permanent maintenance
  burden, not a one-time cost.
- **Canvas-only rendering means no lightweight previews.** Drive thumbnails, doc embeds, and slide thumbnails would
  all need to boot the full Excalidraw JS runtime. The existing slides thumbnail pattern (just render the same React
  components smaller) would not work.
- **Bundle size (~500KB gzipped)** is massive for what Eigen needs. Most of that weight is Rough.js rendering,
  collaboration infrastructure Eigen would not use, and UI chrome that conflicts with shadcn/ui.
- **The sketchy aesthetic is wrong for a productivity suite.** It is fun for whiteboarding but looks unprofessional
  in a slide deck or inline diagram.

**Why not fork Excalidraw?**

- Forking a 200K+ LOC project to rip out the rendering engine, replace the state management, and adapt the data
  model is more work than building the subset Eigen actually needs. Excalidraw's internals are tightly coupled --
  the renderer assumes Canvas, the state assumes their update model, the tools assume their event pipeline.
- A fork also creates a maintenance burden: upstream security fixes and features would need to be cherry-picked
  into a divergent codebase.

**Why not tldraw?**

- The tldraw SDK requires a commercial license for use in paid products. The "free" Apache 2.0 packages are the old
  v2 split; the current useful SDK is behind the license.
- tldraw v3 switched to Canvas rendering, losing the lightweight SVG advantage.
- tldraw's `TLStore` (signal-based reactive store) is a parallel reactive system that would need bridging to React
  + TanStack Query. This is integration friction for no user benefit.

**Why building from scratch is feasible here (and not elsewhere):**

Eigen is not building Figma. The target is closer to Google Drawings: basic shapes, arrows, freehand, text labels,
inline in docs. The slides app already implements 60-70% of the interaction model (drag, resize, 8-handle selection,
snap lines, Yjs integration, undo/redo, z-ordering, copy/paste). The incremental jump from slides to a basic drawing
app is smaller than it appears from the outside. The hard parts (arrow bindings, freehand smoothing, viewport
pan/zoom) are well-scoped problems with known solutions.

### Honest Risk Assessment

**What the research gets right:**
- SVG primary + Canvas overlay is the correct rendering strategy for Eigen's use cases.
- The element type system is well-designed and correctly maps to the existing slides types.
- The Yjs data model follows proven patterns from the existing apps.
- The phased approach with slides integration deferred is pragmatic.
- The decision to start docs integration with modal editing (not inline) is wise.

**What the research glosses over or gets wrong:**

1. **Interaction engineering is underestimated.** The research says "slides already solves most of this" for
   selection, resize, rotation. True for rectangular objects. But rotation handles (the circular handle above the
   selection box with rotation snapping at 15-degree increments) are new. Aspect-ratio-locked resize is new.
   Multi-select with a single bounding box transform is new (slides has multi-select but no unified transform).
   Rubber-band selection (drag to select multiple elements) is new. Each of these is a day or two of careful work.

2. **Arrow bindings are a rabbit hole.** The research mentions this as Phase 3 (1-2 weeks) but arrow binding is one
   of the hardest interaction problems in a drawing app. Calculating connection points on rotated shapes, handling
   elbowed paths that route around obstacles, updating bindings when shapes resize (not just move), making bindings
   survive undo/redo -- Excalidraw spent months on this. Budget 3-4 weeks for arrows alone if elbowed routing is
   included. Recommendation: start with straight arrows only, no elbowed routing.

3. **foreignObject text editing in SVG is fragile.** The research acknowledges this but underestimates the effort.
   `<textarea>` inside `<foreignObject>` has different behavior in Chrome, Firefox, and Safari for: focus/blur
   events, keyboard event propagation, cursor positioning with CSS transforms, and scrollable overflow. The slides
   app sidesteps this entirely by using DOM-based rendering (a real `<textarea>` in a positioned `<div>`). For the
   vector app, the pragmatic solution is to render text as SVG for display but use an HTML overlay (positioned
   absolutely outside the SVG, aligned via JavaScript) for text editing. This is how both Excalidraw and tldraw
   handle text input.

4. **Pan/zoom is more work than it sounds.** The research mentions it briefly in Phase 1. A good infinite canvas
   needs: scroll wheel zoom (centered on cursor), pinch-to-zoom on trackpad/touch, smooth animated zoom transitions,
   zoom-to-fit, zoom-to-selection, minimap sync, and correct coordinate transforms between screen space and document
   space for all pointer events. Budget at least a week for this alone.

5. **SVG export quality for text.** The research lists "SVG export is trivial (serialize the DOM subtree)" but
   `foreignObject` content in exported SVGs does not render in many SVG viewers (Inkscape, Illustrator, most
   image viewers). For portable SVG export, text must be converted to `<text>` elements with manual line breaking,
   which loses word-wrap fidelity. This is a known limitation, not a blocker, but should be documented.

6. **PDF export is not addressed.** The research mentions SVG export and PNG export but skips PDF. For a
   productivity suite, PDF export of drawings is expected. SVG-to-PDF conversion via libraries like `jspdf` or
   `pdf-lib` works but has text rendering quality issues (font embedding, Unicode support). This is Phase 6+
   territory but worth flagging.

7. **SVG import is not addressed.** Users will want to import `.svg` files into the vector editor. Parsing arbitrary
   SVG into the element model is a hard problem -- SVG supports gradients, filters, masks, clip paths, nested
   transforms, text on paths, and more. Practical approach: support importing simple SVGs (basic shapes and paths)
   and render complex SVGs as raster images (fallback). This is worth a Phase 6+ line item.

8. **Collaboration with freehand drawing.** The research correctly states that freehand points are committed on
   stroke completion (not per-point). This means other users see the stroke appear all at once, not being drawn.
   This is acceptable. However, the research does not address bandwidth: a complex freehand stroke can be hundreds
   of points even after simplification via perfect-freehand. With multiple users drawing simultaneously, the Yjs
   document can grow quickly. Mitigation: aggressive point simplification (Ramer-Douglas-Peucker algorithm) before
   committing to Yjs, and store simplified points (typically 20-50 per stroke).

9. **The "slides on top of vector" long-term vision (Phase 7) is architectural astronautics.** The research
   acknowledges the risk but still presents it as a goal. Replacing slides' working DOM-based rendering with SVG
   rendering would break text rendering, image rendering, and all interaction handlers -- for no user-visible
   benefit. Users do not care whether a slide element is a `<div>` or an SVG `<rect>`. What users care about is
   shapes, arrows, and freehand in slides -- which can be delivered via Phase 5B (DOM-based shape rendering) without
   touching the rendering engine. **Phase 7 should be explicitly marked as "maybe never" rather than "future."**

10. **1000+ elements performance.** The research provides a reasonable tiered strategy (viewport culling, spatial
    indexing, Canvas fallback). For typical use cases (diagrams with <200 elements, slides with <20), SVG
    performance is fine. The concern is pathological cases: a user imports a complex SVG that becomes 3000
    elements, or draws many freehand strokes. The answer is pragmatic limits: warn when element count exceeds a
    threshold, and optimize lazily.

---

## Integration Proposal

### Architecture

```
packages/
  vector/                        # @workspace/vector -- shared vector engine
    src/
      elements/
        types.ts                 # BaseElement, VectorElement union, defaults
        rectangle.ts             # Rectangle-specific logic (SVG path, hit test)
        ellipse.ts               # Ellipse
        text.ts                  # Text
        image.ts                 # Image
        line.ts                  # Line with optional arrowheads
        arrow.ts                 # Arrow with endpoint bindings
        freehand.ts              # Freehand stroke (perfect-freehand)
        group.ts                 # Group element
      rendering/
        vector-renderer.tsx      # Read-only SVG renderer (for embeds, thumbnails)
        vector-canvas.tsx        # Interactive SVG canvas (selection, tools, overlays)
        element-renderer.tsx     # Dispatch to type-specific SVG renderers
        shape-svg.tsx            # Rectangle, ellipse, diamond -> SVG primitives
        arrow-svg.tsx            # Arrow path calculation + SVG rendering
        freehand-svg.tsx         # SVG path from perfect-freehand points
        text-overlay.tsx         # HTML overlay for text editing (NOT foreignObject)
        canvas-overlay.tsx       # Canvas layer for active freehand input
        selection-layer.tsx      # Selection boxes, handles, snap lines
        cursor-layer.tsx         # Remote user cursors (awareness)
      interaction/
        select-tool.ts           # Selection, move, resize, rotate
        shape-tool.ts            # Shape creation by click-drag
        draw-tool.ts             # Freehand drawing
        arrow-tool.ts            # Arrow creation with endpoint snapping
        text-tool.ts             # Text creation (click to place)
        eraser-tool.ts           # Remove elements by intersection
        pan-tool.ts              # Pan (hand tool, also space+drag)
      hooks/
        use-vector-doc.ts        # Yjs document (like use-deck.ts)
        use-viewport.ts          # Pan/zoom state + transforms
        use-selection.ts         # Selection state, multi-select, rubber-band
        use-tool.ts              # Active tool state machine
        use-element-drag.ts      # Drag/resize (evolved from use-object-drag.ts)
        use-snap.ts              # Snap lines (evolved from use-snap-lines.ts)
      export/
        to-svg.ts                # Export to standalone SVG string
        to-png.ts                # Export to PNG via Canvas
      utils/
        geometry.ts              # Point math, intersection, bounding boxes
        path.ts                  # SVG path string generation
        bounds.ts                # Bounding box calculations (union, intersection)

apps/
  vector/                        # Standalone vector app
    src/
      components/vector/
        editor.tsx               # Full editor layout (toolbar + canvas + panels)
      routes/
        _auth.tsx                # Auth guard
        _auth.vector.$ownerId.$mountId.$pathId.tsx  # Vector file route
```

### Dependency Flow

```
packages/vector (engine, no app-specific code)
  <- apps/vector    (standalone app, toolbar, Drive integration)
  <- apps/docs      (VectorDrawing Tiptap node, modal editor)
  <- apps/slides    (shared element types, DOM-based shape rendering)
```

---

## Element Type Specification

```typescript
type BaseElement = {
  id: string
  type: string
  x: number                    // absolute pixels
  y: number
  w: number                    // bounding box width
  h: number                    // bounding box height
  rotation: number             // degrees (consistent with slides)
  opacity: number              // 0-1
  locked: boolean
  groupId?: string             // parent group ID

  // Stroke
  strokeColor: string
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'

  // Fill
  fillColor: string
  fillStyle: 'solid' | 'none'

  // Border
  borderRadius: number
}

type RectangleElement = BaseElement & { type: 'rectangle' }

type EllipseElement = BaseElement & { type: 'ellipse' }

type DiamondElement = BaseElement & { type: 'diamond' }

type LineElement = BaseElement & {
  type: 'line'
  points: [number, number][]          // relative to x,y
  startArrowhead?: 'arrow' | 'dot' | null
  endArrowhead?: 'arrow' | 'dot' | null
}

type ArrowElement = BaseElement & {
  type: 'arrow'
  points: [number, number][]          // control points, relative to x,y
  startBinding?: { elementId: string; focus: number; gap: number }
  endBinding?: { elementId: string; focus: number; gap: number }
  startArrowhead: 'arrow' | 'dot' | null
  endArrowhead: 'arrow' | 'dot' | null
}

type FreehandElement = BaseElement & {
  type: 'freehand'
  points: [number, number, number][]  // [x, y, pressure], relative to x,y
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
  // Children reference the group via groupId.
  // The group's x/y/w/h is the computed bounding box of children.
}

type VectorElement =
  | RectangleElement
  | EllipseElement
  | DiamondElement
  | LineElement
  | ArrowElement
  | FreehandElement
  | TextElement
  | ImageElement
  | GroupElement
```

### Compatibility with Slides

The slides `BaseObject` maps to `BaseElement` with field renames (`borderColor` -> `strokeColor`,
`borderWidth` -> `strokeWidth`). New fields (`fillColor`, `opacity`, `strokeStyle`) are additive. The slides
`TextObject` and `ImageObject` map directly to `TextElement` and `ImageElement` with identical field names for
all text/image properties.

Migration is additive: existing `.eigenslides` data continues to work. New element types are new `SlideObject`
union members. No breaking changes.

---

## Yjs Data Model

### Structure

```
Y.Map    "elements"      -> elementId -> Y.Map { id, type, x, y, w, h, ... }
Y.Array  "elementOrder"  -> ordered element IDs (z-order, bottom to top)
Y.Map    "meta"          -> { version: 1, background: '#ffffff', gridSize: 20 }
```

Single-page (infinite canvas) by default. Multi-page support (for future design-tool mode) would add
`Y.Map("pages")` and `Y.Array("pageOrder")`, but this is deferred.

### Points Storage

- **Lines/arrows**: `Y.Array` of `Y.Array` (nested) -- allows collaborative editing of individual control points
  without overwriting the full array.
- **Freehand strokes**: JSON-serialized string (`elemYMap.set('points', JSON.stringify(points))`) -- freehand
  strokes are drawn once and never edited point-by-point, so the simpler approach is correct.

### Arrow Bindings

Bindings are stored as flat properties on the arrow element's Y.Map (`startBinding`, `endBinding`). When a bound
element moves, all clients locally recalculate arrow endpoints from the current Yjs state. The calculation is
deterministic, so all clients converge.

---

## Embedding in Docs (Tiptap Node)

### VectorDrawing Extension

```typescript
// apps/docs/src/components/docs/extensions/vector-drawing.tsx

export const VectorDrawing = Node.create({
  name: 'vectorDrawing',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      drawingId: { default: null },     // pathId of the .eigenvector file
      ownerId: { default: null },       // owner of the drawing
      mountId: { default: null },       // mount of the drawing
      width: { default: 600 },
      height: { default: 400 },
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

**Phase 4 (initial): Modal editing.** Double-click opens a dialog containing the full vector editor. The inline
view shows a static SVG preview rendered by `VectorRenderer`.

```typescript
function VectorDrawingView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const { drawingId, ownerId, mountId, width, height } = node.attrs
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <NodeViewWrapper>
      <ImageResizeHandles
        width={width}
        onResize={(w) => updateAttributes({ width: w })}
        selected={selected}
        editable={editor.isEditable}
      >
        <VectorRenderer
          ownerId={ownerId}
          mountId={mountId}
          pathId={drawingId}
          width={width}
          height={height}
          onDoubleClick={() => editor.isEditable && setDialogOpen(true)}
        />
      </ImageResizeHandles>

      {dialogOpen && (
        <VectorEditorDialog
          ownerId={ownerId}
          mountId={mountId}
          pathId={drawingId}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </NodeViewWrapper>
  )
}
```

The `VectorRenderer` connects to the Yjs doc in read-only mode to get the latest element state and renders a pure
SVG. No WebSocket connection is held open while not editing.

**Future: Inline editing.** Replace the dialog with an in-place `VectorCanvas` that intercepts pointer and keyboard
events via `stopPropagation()` on the `NodeViewWrapper`. This requires thorough testing of event isolation from
ProseMirror.

---

## Embedding in Slides

### Phase 5A: Shared Types

Slides imports element types from `@workspace/vector`. The `SlideObject` union gains new members:

```typescript
// apps/slides/src/components/slides/types.ts
import type {
  RectangleElement, EllipseElement, DiamondElement,
  ArrowElement, FreehandElement
} from '@workspace/vector'

type ShapeObject = (RectangleElement | EllipseElement | DiamondElement) & { slideId: string }
type ArrowObject = ArrowElement & { slideId: string }
type FreehandObject = FreehandElement & { slideId: string }

export type SlideObject = TextObject | ImageObject | ShapeObject | ArrowObject | FreehandObject
```

### Phase 5B: DOM-Based Shape Rendering

Render shapes as inline SVG inside the existing positioned `<div>` approach. No rendering engine change.

```typescript
// In slide-object.tsx, new cases in ReadOnlySlideObject and SlideObjectView:
{obj.type === 'rectangle' && (
  <svg className="w-full h-full" viewBox={`0 0 ${obj.w} ${obj.h}`} preserveAspectRatio="none">
    <rect width={obj.w} height={obj.h}
          fill={obj.fillColor} stroke={obj.strokeColor}
          strokeWidth={obj.strokeWidth} rx={obj.borderRadius} />
  </svg>
)}
{obj.type === 'ellipse' && (
  <svg className="w-full h-full" viewBox={`0 0 ${obj.w} ${obj.h}`} preserveAspectRatio="none">
    <ellipse cx={obj.w/2} cy={obj.h/2} rx={obj.w/2} ry={obj.h/2}
             fill={obj.fillColor} stroke={obj.strokeColor}
             strokeWidth={obj.strokeWidth} />
  </svg>
)}
```

### Phase 5C: Shape Tools in Slides Toolbar

Add toolbar buttons for inserting rectangles, ellipses, arrows. The properties panel gains fill/stroke sections
for shape objects.

---

## File Format: `.eigenvector`

### Storage

```
mydiagram.eigenvector/
  data.db              # Yjs document (same pattern as .eigendoc, .eigenslides, etc.)
```

### Drive Registration

```typescript
// packages/lib/src/types/drive.ts
export const DRIVE_TYPE_VECTOR = "vector" as const;
export const DRIVE_MIME_VECTOR = "application/eigenvector" as const;
export type DriveTypeVector = typeof DRIVE_TYPE_VECTOR;

// Add DriveTypeVector to DrivePathType union
// Add to DriveCollabType union
// Add to isCollabType(): || type === DRIVE_TYPE_VECTOR
```

### Backend

```typescript
// apps/api/src/lib/drive/drive.ts -- following createSlides() pattern:
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

### Route

```typescript
// apps/api/src/routes/drive.ts -- add endpoint for vector creation:
.post('/vector', async ({ body, home }) => {
  return home.drive.createVector(body.mountId, body.parentId, body.name);
}, { body: t.Object({ mountId: t.String(), parentId: t.String(), name: t.String() }) })
```

---

## Concrete File Changes

### New Files

| File | Purpose |
|------|---------|
| `packages/vector/package.json` | Package config, deps: `perfect-freehand`, `yjs`, `y-websocket` |
| `packages/vector/src/elements/types.ts` | `BaseElement`, all element types, `VectorElement` union, defaults |
| `packages/vector/src/elements/rectangle.ts` | Rectangle SVG path, hit test, connection points |
| `packages/vector/src/elements/ellipse.ts` | Ellipse SVG, hit test |
| `packages/vector/src/elements/text.ts` | Text defaults, measurement utils |
| `packages/vector/src/elements/image.ts` | Image element logic |
| `packages/vector/src/elements/line.ts` | Line + arrowhead SVG path |
| `packages/vector/src/elements/arrow.ts` | Arrow with binding logic |
| `packages/vector/src/elements/freehand.ts` | perfect-freehand integration |
| `packages/vector/src/elements/group.ts` | Group bounding box calculation |
| `packages/vector/src/rendering/vector-renderer.tsx` | Read-only SVG renderer |
| `packages/vector/src/rendering/vector-canvas.tsx` | Interactive canvas (SVG + overlays) |
| `packages/vector/src/rendering/element-renderer.tsx` | Type dispatch for SVG rendering |
| `packages/vector/src/rendering/shape-svg.tsx` | Rectangle, ellipse, diamond SVG |
| `packages/vector/src/rendering/arrow-svg.tsx` | Arrow path + arrowhead SVG |
| `packages/vector/src/rendering/freehand-svg.tsx` | Freehand stroke SVG path |
| `packages/vector/src/rendering/text-overlay.tsx` | HTML text editing overlay |
| `packages/vector/src/rendering/canvas-overlay.tsx` | Canvas for active freehand input |
| `packages/vector/src/rendering/selection-layer.tsx` | Selection boxes, handles, rotation handle |
| `packages/vector/src/rendering/cursor-layer.tsx` | Remote user cursors |
| `packages/vector/src/interaction/select-tool.ts` | Select, move, resize, rotate, rubber-band |
| `packages/vector/src/interaction/shape-tool.ts` | Shape creation via click-drag |
| `packages/vector/src/interaction/draw-tool.ts` | Freehand drawing tool |
| `packages/vector/src/interaction/arrow-tool.ts` | Arrow tool with snap-to-shape |
| `packages/vector/src/interaction/text-tool.ts` | Click to place text |
| `packages/vector/src/interaction/eraser-tool.ts` | Remove by intersection |
| `packages/vector/src/interaction/pan-tool.ts` | Pan + space-drag |
| `packages/vector/src/hooks/use-vector-doc.ts` | Yjs integration (like `use-deck.ts`) |
| `packages/vector/src/hooks/use-viewport.ts` | Pan/zoom state |
| `packages/vector/src/hooks/use-selection.ts` | Selection state |
| `packages/vector/src/hooks/use-tool.ts` | Tool state machine |
| `packages/vector/src/hooks/use-element-drag.ts` | Drag/resize (evolved from slides) |
| `packages/vector/src/hooks/use-snap.ts` | Snap lines (evolved from slides) |
| `packages/vector/src/export/to-svg.ts` | SVG export |
| `packages/vector/src/export/to-png.ts` | PNG export via Canvas |
| `packages/vector/src/utils/geometry.ts` | Point math, intersections |
| `packages/vector/src/utils/path.ts` | SVG path string generation |
| `packages/vector/src/utils/bounds.ts` | Bounding box utilities |
| `apps/vector/` | Full standalone app (standard Eigen app structure) |
| `apps/docs/src/components/docs/extensions/vector-drawing.tsx` | Tiptap node for inline drawings |

### Modified Files

| File | Change |
|------|--------|
| `packages/lib/src/types/drive.ts` | Add `DRIVE_TYPE_VECTOR`, `DRIVE_MIME_VECTOR`, update unions |
| `apps/api/src/lib/drive/drive.ts` | Add `createVector()` method |
| `apps/api/src/routes/drive.ts` | Add `/vector` creation endpoint |
| `packages/lib/src/types/clipboard.ts` | Add `EigenClipboardVectorItem` type |
| `apps/slides/src/components/slides/types.ts` | (Phase 5A) Import from `@workspace/vector`, extend union |
| `apps/slides/src/components/slides/slide-object.tsx` | (Phase 5B) Add shape rendering cases |
| `apps/slides/src/components/slides/hooks/use-deck.ts` | (Phase 5A) Add shape fields to `OBJECT_FIELDS` |
| `apps/slides/src/components/slides/toolbar.tsx` | (Phase 5C) Add shape insertion buttons |
| `apps/slides/src/components/slides/slide-properties-panel.tsx` | (Phase 5C) Add fill/stroke sections |

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Interaction engineering takes longer than estimated | High | Accept this. Budget 2x the research estimates. The first 80% (basic shapes, select, move, resize) will go fast because slides has paved the road. The last 20% (rotation, rubber-band select, arrow bindings) will take disproportionately long. |
| foreignObject text rendering quirks across browsers | Medium | Do NOT use foreignObject for text editing. Render text as SVG `<text>` for display, use a positioned HTML overlay for editing (the Excalidraw/tldraw approach). Use foreignObject only for read-only text display in the SVG renderer where full HTML text fidelity is needed. |
| SVG performance degrades with many elements | Low | Viewport culling handles this. Typical diagrams have <200 elements. Add `rbush` spatial indexing only if perf profiling shows need (>500 elements visible). |
| Arrow bindings create subtle bugs with undo/redo | Medium | Keep arrow binding logic simple: straight arrows only in Phase 3. Elbowed routing is Phase 6+. Test undo/redo of arrow creation, bound element move, and bound element deletion. |
| Two Yjs docs in docs (parent doc + inline drawing) | Medium | Only connect the drawing's Yjs doc when in edit mode. In read-only mode, render from a cached snapshot. This avoids holding N WebSocket connections for N inline drawings. |
| Slides rendering rewrite (Phase 7) breaks things | High | Do not do Phase 7. Slides works fine with DOM rendering. Shape support via Phase 5B (inline SVG in positioned divs) gives users what they want without architectural risk. Revisit only if maintaining two renderers becomes an actual burden (it probably will not). |
| SVG export lacks text fidelity | Low | Use `<text>` elements in exported SVGs with manual line breaking. Accept that exported SVGs may render text slightly differently in external viewers. For pixel-perfect output, export to PNG. |
| Bundle size growth from new package | Low | `perfect-freehand` is 3KB. The vector engine is custom code, not a large dependency. The rendering components are tree-shakeable -- apps that only need `VectorRenderer` do not bundle interaction code. |

---

## Phases (Revised Estimates)

### Phase 0: Foundation (2 weeks)
- Create `packages/vector/` package
- Define `BaseElement` and initial types: rectangle, ellipse, text, image
- Build `VectorRenderer` (read-only SVG renderer)
- Build `ElementRenderer` dispatch
- Geometry and bounds utilities with tests
- Verify text rendering across Chrome, Firefox, Safari

### Phase 1: Standalone App (3-4 weeks)
- Create `apps/vector/` app structure
- Register `.eigenvector` in Drive (`DRIVE_TYPE_VECTOR`, `DRIVE_MIME_VECTOR`, `createVector()`, route)
- Build `VectorCanvas` with interactive SVG
- Implement pan/zoom viewport (`use-viewport.ts`)
- Implement select tool: move, resize (8-handle), rotation handle
- Implement shape tool: rectangle, ellipse by click-drag
- Implement text tool: click to place, HTML overlay for editing
- Implement `use-vector-doc.ts` (Yjs integration)
- Properties panel (fill, stroke, opacity, text properties)
- Snap lines (port + generalize from slides)
- Undo/redo via `Y.UndoManager`
- Keyboard shortcuts: Delete, Cmd+Z/Y, Cmd+C/V, arrow nudge, Cmd+A
- Rubber-band multi-select

### Phase 2: Drawing Tools (2-3 weeks)
- Add `perfect-freehand` dependency
- Canvas overlay for freehand input
- Freehand tool with pressure sensitivity
- Line tool with arrowheads
- Eraser tool
- Stroke style options (solid, dashed, dotted)
- Fill options (solid, none)
- Point simplification (Ramer-Douglas-Peucker) before Yjs commit
- Awareness integration: remote cursors and tool state

### Phase 3: Arrows (3-4 weeks)
- Arrow tool with snap-to-element connection points
- Binding storage and reactive endpoint recalculation
- Handle bound element move, resize, delete
- Arrow label (text at midpoint)
- Straight arrows only (no elbowed routing)
- Thorough undo/redo testing for arrow operations

### Phase 4: Docs Integration (2-3 weeks)
- `VectorDrawing` Tiptap extension (following `ResizableImage` pattern)
- Modal editing: double-click opens dialog with full vector editor
- "Insert drawing" toolbar button (creates `.eigenvector` in Drive, inserts node)
- Read-only SVG preview via `VectorRenderer`
- Resize handles on embedded drawing (display scale only)
- Cached SVG snapshot for read-only mode (no WebSocket connection)

### Phase 5: Slides Integration (2-3 weeks)
- **5A**: Import types from `@workspace/vector`, extend `SlideObject` union
- **5B**: DOM-based shape rendering in `slide-object.tsx` (inline SVG in divs)
- **5C**: Shape tools in toolbar, fill/stroke in properties panel
- Clean up vestigial shadow fields in `OBJECT_FIELDS`

### Phase 6: Polish (ongoing, no fixed timeline)
- SVG/PNG export with configurable options
- Copy-paste between vector, slides, docs
- Diamond, triangle shape presets
- Grouping/ungrouping
- Minimap
- Flowchart shape library
- Touch/stylus optimization
- Elbowed arrow routing
- SVG file import (simple shapes only)
- Rough.js sketchy style toggle (opt-in per element)

### Phase 7: Slides SVG Rendering Migration (maybe never)
- Explicitly deferred. Only revisit if maintaining two renderers becomes a measurable burden.
- The pragmatic path is Phase 5B (DOM-based shapes in slides) which gives users shapes without risk.
