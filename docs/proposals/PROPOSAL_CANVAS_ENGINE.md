# Proposal: slides on the vector engine

> **TLDR**: Vector and slides already share the transform chrome, the snap, marquee and arrange math, the panel rows, the fonts, the collab lifecycle and the comment cards. They do not share the two things that "vector inside slides" needs: the element model and the editor host. Slides has two object kinds (rich text, image), an `objectIds` array per slide, percent geometry with container-query units and its own gesture loop. Vector has eight element kinds, fractional-index z-order, one SVG scene and its own gesture loop. About 1,200 lines of host code exist twice and two behaviours already disagree. This proposal makes slides **a deck of fixed-size frames on the vector engine**: one element model (vector's, plus a `richtext` element, a `frames` root, `BackgroundFill` frame backgrounds and per-element `commentCardIds`), one live renderer (an HTML base with one `<svg>` per element, so rich text is a plain div), one interaction host (`CanvasEditor` with a `viewport` mode, infinite or frame) and two thin shells. Rich text stays TipTap HTML, a div between the per-element svgs, and the export compositor emits the same structure, which WeasyPrint handles. No backward compatibility (decided 2026-09-03). Recommendation: do it, in five phases. The first phase pays for itself without touching slides.

## Goals

1. **Every vector element in a slide.** Shapes, lines, arrows that bind to any element including rich text boxes and images, elbow routing, freedraw, images, hand text, arrow labels. Same tools, same panel rows, same keymap, same clipboard.
2. **One host, one renderer.** A gesture, a snap rule or a paste rule is written once. A fix in vector is a fix in slides. The 1,200 duplicated lines go away, and so do the two behaviours that already disagree (the additive-select modifier and z-order stepping).
3. **Slides stays slides.** Fixed 16:9 frames, rich text, gradient and image backgrounds, per-object comments, thumbnails, present mode, HTML and PDF export, ⌘F.
4. **Vector gains what slides has.** Per-element comments, in-document search, gradient fills, a canvas background that is actually editable.
5. **Server rendering stays pure and deterministic.** One reader, one `sceneToSvg`, one export compositor. Nothing measures text on the server.

## Non-goals

- **Merging the two file types or the two apps.** `.eigenslides` and `.eigenvector` keep their MIME and extension (frozen values) and their own shells. What merges is the engine underneath.
- **A rich-text layout engine for SVG.** Rich text renders as HTML everywhere. An SVG-native rich text (deterministic line breaking into `tspan` runs, so thumbnails and PDF need no HTML at all) is a later option, documented in Risks, not built.
- **Animations, transitions, speaker notes, PPTX export.** Not built. None is blocked by this design and none was possible before it either. See "The question, answered".
- **Embedding whole drawings in docs and sheets** ([PROPOSAL_VECTOR.md](PROPOSAL_VECTOR.md) phases 5 and 6). Unchanged for docs and sheets. For slides it becomes unnecessary: shapes are native.
- **Frames in the vector app** (a frame tool, presenting a drawing). The model supports it. The shell work is a later round.
- **Backward compatibility.** Decided 2026-09-03: neither `.eigenslides` nor `.eigenvector` stored shapes are kept. No migration, no tolerant reader. Demo seed data is regenerated.
- **Stickies and docs figures.** Untouched.

## Current state (recap)

Everything below was verified against main at 25c9d6d4a and re-checked at f7bebdc14, both on 2026-09-03.

**The two editors side by side.**

| Aspect | Slides (`apps/slides/src/components/slides/`) | Vector (`packages/ui/src/components/vector/`) |
|---|---|---|
| Object kinds | `text` (TipTap HTML), `image` | `rectangle`, `diamond`, `ellipse`, `text`, `image`, `freedraw`, `line`, `arrow` |
| Geometry fields | `x, y, width, height, angle`, px in 1920×1080, degrees | same names, scene units, degrees |
| Z-order | position in a per-slide `objectIds` Y.Array (`use-deck.ts:343`) | fractional `index` string (`packages/lib/src/vector/fractional-index.ts`, stepped in `use-vector-keyboard.ts:27`) |
| Yjs roots | `slides`, `objects`, `slideOrder` (+ `comments`) | `elements`, `meta` (+ `comments`) |
| Live render | absolutely positioned divs, percent geometry, `cqw`/`cqh` units (`slide-object.tsx:27`) | one `<svg>`, one `<g>` per element from `elementToSvg` (`element-node.tsx:40`) |
| Text | `LightEditor` in place, every keystroke streams to Yjs (`slide-object.tsx:238`) | `<textarea>` overlay, one write on commit, client-measured width (`text-overlay.tsx`, `text-measure.ts`) |
| Comments | `commentCardIds` per object | document-level only (`apps/vector/.../editor.tsx:35`) |
| ⌘F | yes, text objects (`search-deck.ts`) | no |
| Presence | cursor, selection, `slideId` | cursor, selection |
| Fill | `BackgroundFill` on slide + text object | solid colour + hachure styles |
| Export | HTML + PDF through a compositor with a `SizeUnit` abstraction (`export/slides/render.ts`) | SVG, and PDF as inline `<svg>` in a WeasyPrint page (`export/vector/transform.ts:47`) |
| Preview | HTML body, first 8 slides | SVG image |
| Mobile | view-only, canvas unmounted | view-only, one-finger pan |
| Tests | 2 files (`search-deck`, `normalize-deck`) | lib: geometry, elbow routing, reader, `sceneToSvg`, snap, fractional index; ui: clipboard, binding, touch gestures |

**What is already shared** (the [CANVAS.md](../CANVAS.md) inventory, plus a few primitives the code shares that CANVAS.md does not name yet): `ObjectTransform` with its `boxToStyle` / `screenDeltaToScene` / `snapBox` seams, `snap.ts`, `marqueeMode` / `marqueeHits`, `computeArrange`, `TransformSection` / `AlignSection` / `ZOrderButtons` / `useZOrderHotkeys`, `ColorRow` / `MergedSelect` / `FontPicker` / `BackgroundFillBlock`, the context-menu item groups, `CursorLayer` + awareness helpers, `useCollabDoc`, the comment card model, the typed clipboard, `classifyPaste`, the media upload hooks, `EIGEN_FONTS`, `NUDGE_STEP` / `DUPLICATE_OFFSET`. The geometry field names already match because of the earlier canonical-object work.

**What exists twice.** The duplication audit counted roughly 1,200 lines of parallel host code: the drag-move loop (~120), clipboard producers and consumers (~150), z-order (~130, and on two different models), text edit entry and exit (~90), keyboard wiring (~70), image insert placement (~60), delete, duplicate, nudge, marquee, snap-guide rendering, presence wiring, Escape stacks and the two pointer-to-model converters. Two behaviours disagree today: additive select is Shift in vector and ⌘ or Ctrl in slides (`slide-object.tsx:166`), and vector collapses a non-contiguous z-order block into one gap (`use-vector-keyboard.ts:27`) while slides steps each id one slot (`use-deck.ts:336`).

**The pipelines.** One Worker protocol with per-type arms (`document/transform/protocol.ts`). Two readers (`document/slides.ts`, `lib/vector/read-vector.ts`). Two export renderers. Two preview renderers. Two search collectors in one file (`search/extract-render.ts`); the slides one indexes the stored TipTap HTML as-is, tags included, while the slides find bar strips them with `stripTagsServer`. One font registry, but two ways of sizing text: vector stores client-measured widths so the server never measures; slides lets CSS wrap text in the box, which is why slides needs a box layout engine (WeasyPrint) and vector does not. WeasyPrint renders inline `<svg>` (vector's PDF proves it) and 2D CSS transforms, but not container queries (`export/slides/render.ts:114`) and not HTML inside `foreignObject`.

**Precedent.** Figma Slides is a 1920×1080 frame on the Figma canvas, non-resizable, non-rotatable, in slide rows. Excalidraw+ turns frames into slides and exports PDF and PPTX from them. tldraw renders every shape as DOM. Keynote and PowerPoint are shape models with connectors and rich text per shape. "A deck is fixed frames over a drawing model" is the industry's shape, not a novelty.

## The question, answered

**Rich text.** Slides' rich text is smaller than it looks. The marks are bold, italic, strike, link, bullet and numbered lists and blockquote (`light-editor.tsx:56`); everything else (font, size, weight, colour, alignment, spacing, highlight) is per box. It stays HTML. On the canvas it is a plain div between the per-element svgs, so it interleaves with shapes in z-order, and it is edited in place with `LightEditor`, as slides does today. The export compositor emits the same layer structure, so PDF needs nothing special. Arrows, bindings, snapping, comments and search never look inside the box.

**Export.** Each app keeps its formats. One compositor produces the HTML behind slides HTML, slides PDF and vector PDF. `sceneToSvg` produces vector SVG and the clipboard SVG; thumbnails, present mode and previews share the compositor's layer structure. PPTX becomes plausible later because a shape model exports to shapes; an HTML deck does not.

**Animations.** A build order or a transition is a property of an element on a frame. That is true in a DOM deck and in an engine deck alike, so nothing here decides it. The shared element model does make the Keynote-style morph (the same element id on two frames, animate the geometry between them) the obvious design when the time comes.

**Is slides just a vector canvas with a fixed size?** Yes, plus a deck shell. The shell is what stays app-specific: the thumbnail rail, present mode, frame backgrounds with apply-to, and a viewport that fits one frame.

## Alternatives considered

- **A. Shape objects in slides painted by vector's renderer, two models kept.** The "share the renderer, not the model" idea in [PROPOSAL_VECTOR.md](PROPOSAL_VECTOR.md). Rejected. Arrows are the point, and bindings, elbow routing, point handles, binding-aware duplicate and binding-aware paste are all written against `VectorElement`. Two models means adapters both ways and a second, smaller vector inside slides that drifts from the first.
- **B. Embed drawings as `drawings/` sub-resources** (phase 6). Rejected for slides. An embedded drawing is an island: an arrow cannot bind to a slide text box, comments inside belong to the drawing, editing is a modal. Still right for docs and sheets.
- **C. Slides on the vector engine, two shells.** Recommended. The rest of this document.
- **D. One app and one file type.** Rejected. MIME values are frozen, export defaults differ, and users think of a deck and a drawing as different things. C gives D's engineering benefit without the product cost.
- **E. One scene SVG with rich text as `foreignObject`.** The first draft's live renderer. It changes vector's render path least, but it puts HTML inside SVG on the live path (WebKit's historic weak spot), forces overlay editing for rich text, and gives the canvas a different DOM shape from the export compositor. Rejected 2026-09-03 for the HTML base in section 4, Reinder's suggestion.

## Design

### 1 — One element model

`packages/lib/src/vector/types.ts` stays the engine's model. The engine keeps the name vector; there is no directory or subpath rename (open question 3). Changes:

- **`frameId: string`** on every element, `''` for none. Coordinates are frame-relative when set (section 2).
- **`richtext`** element (section 3).
- **`commentCardIds`** on every element, stored as a JSON string like `points` and the bindings, so the scalar-only `ELEMENT_FIELDS` convention holds. This is what vector avoided when it chose document-level comments; the JSON-string form is the answer.
- **Image** gains `objectFit: 'fill' | 'contain' | 'cover'` (slides' three). The renderer maps it to `preserveAspectRatio` (`none`, `xMidYMid meet`, `xMidYMid slice`).
- **Box elements** (`richtext`, `image`) gain `borderRadius: number` in px. Their `strokeColor` and `strokeWidth` render as the border: one convention, stroke is border. Shapes keep `roundness`.
- **`BackgroundFill | null`** (`packages/lib/src/types/background.ts`) on frames. Every fillable element carries one `fill` scalar instead: a serialized `Fill` — the same paint half (solid colour or two-stop gradient, image excluded) PLUS the roughjs hatch `style`, so a kind that fills has exactly one stored field and the panel's Fill block owns both halves. Only the kinds roughjs hatches honour the style (`capabilities.fillStyle`); rich text paints the paint half as CSS.
- **`meta`** stays (`background`, `gridSize`) and finally gets a writer: a canvas background row in the panel with nothing selected.

The Y.Doc layout is the same for both types: `elements` (Y.Map of per-element Y.Map), `frames` (Y.Map of per-frame Y.Map), `meta`, `comments`. `EIGEN_DOC_TYPE_INFO` declares `yjsRoots: { elements: 'map', frames: 'map', meta: 'map' }` for both (`packages/lib/src/types/drive.ts:114,149`). `readVectorFromDoc` reads both and validates the new fields the way it validates the old ones (enum checks, clamps), plus a byte cap on `html`, which would be the first string field the reader caps; today `cleanStr` only strips control characters.

Deleted: `packages/lib/src/slides/` (`types.ts`, `fields.ts`), `apps/api/src/lib/document/slides.ts`, `apps/slides/.../normalize-deck.ts`. `SLIDE_BASE_WIDTH`, `SLIDE_BASE_HEIGHT` and `SLIDE_ASPECT_RATIO` move next to the frame type.

### 2 — Frames

- **Root `frames`.** Per frame a Y.Map `{ id, index, name, width, height, background }`. `index` is a fractional index from the same helper the elements use, so deck order is a sort, a reorder is one write, and concurrent reorders from two tabs merge instead of fighting over an array.
- **Slides pins them.** Every frame is `SLIDE_BASE_WIDTH × SLIDE_BASE_HEIGHT`, never moved, resized or rotated (the Figma Slides rule). The vector app does not show frames in this program.
- **Membership is one scalar.** `frameId` on the element replaces the per-slide `objectIds` array. That removes the whole parent-holds-child-ids corruption class `normalizeParentChildRefs` repairs today (an object referenced by two slides, or by none). In a document that has frames, an element whose `frameId` names no frame (including `''`) is re-homed at read time to the lowest-index frame, derived from the same doc state on every peer, never written; in a frameless drawing `''` is simply the canvas. `normalize-deck.ts` goes; `normalize-refs.ts` stays for stickies.
- **Z-order stays global.** A frame's elements sort by their fractional `index`. Moving an element to another frame keeps its index.
- **Frame-relative coordinates.** An element in a frame stores `x, y` relative to the frame origin, so every slide is `0..1920 × 0..1080` and a duplicated frame is a plain copy. The engine adds the frame origin through one seam (`elementOrigin(el, frames)`) in bounds and hit-testing, so a later vector round can lay frames out on the infinite canvas without touching the tools.
- **Frame ops** on the doc hook: `addFrame(afterId?)`, `deleteFrame(id)` (deletes its elements in the same transact), `duplicateFrame(id)` (through `duplicateElements`, so arrow bindings remap to the copies), `moveFrame(id, afterId)`, `updateFrame(id, fields)`, `updateFrames(ids, fields)` for the apply-to scope. The vector doc hook's `undoScope` grows from `[elements, meta]` to include `frames` (`use-vector-doc.ts:159`); `useCollabDoc` tracks only the roots the host names, so without this frame ops are not undoable. Undo can bring a frame back; the shell follows the active frame, and if it vanishes, activates the nearest neighbour by index.

### 3 — The `richtext` element

- **Fields.** `html` (TipTap HTML from `LightEditor`, sanitized at the paste seam by `sanitizeToLightEditorHtml` as today), the per-box typography slides has now (`fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `textDecoration`, `textAlign`, `verticalAlign`, `color`, `letterSpacing`, `lineHeight`, `highlightColor`), `background: BackgroundFill | null`, `borderRadius`, plus the base fields.
- **Bindable.** `isBindable` grows to `richtext` and `image`, so an arrow docks on the box outline exactly as on a rectangle, and elbow routing treats the box as an obstacle. This is the feature the whole proposal exists for.
- **Render.** The element's layer is a div holding the HTML and the inline style `getTextStyle` produces today (slides' `slide-object.tsx` text branch, moved into the engine). Only `sceneToSvg`, which serves SVG export and the clipboard SVG, wraps it in a `<foreignObject>`; browsers render that, and it is the one surface where rich text rides inside SVG.
- **Edit.** Double-click mounts `LightEditor` in place inside the layer (`toolbar="floating"`, `proseStyle={false}`), slides' pattern today; hand text keeps its `TextOverlay`. Writes keep slides' discipline: every `onChange` writes `html`, so collaborators see typing, and unlike hand text there is no measurement to commit. Escape and click-away exit; empty on exit deletes the element (vector's rule).
- **No measurement.** The HTML wraps inside the box; overflow stays visible (slides today). Search plain-texts `html` with `stripTagsServer` from the React-free `@workspace/lib/html` leaf, which the find bar and the server collector can both import (`htmlToPlainText` is DOM-only); the comment anchor text is the first 80 characters of that.
- **Hand `text` stays.** Measured plain text in the hand font, and arrow labels. In slides it sits under Insert as the second text tool (open question 1).

### 4 — Rendering: an HTML base, one `<svg>` per element

The scene is a div, not an `<svg>`. `useViewport`'s group transform (`translate(scroll) scale(zoom)`) goes on that div. Each element is one absolutely positioned layer, in z-order by DOM order: `left`, `top`, `width`, `height` and `transform: rotate(angle)` from the element's box, holding either an `<svg overflow="visible">` with `elementToSvg(el, { positioned: false })` (the fragment minus the translate and rotate it bakes into its `<g>` today) or, for rich text, the HTML div. Layers are `pointer-events: none`; the canvas container keeps the pointer events and hit-testing stays the geometry math, so lines, hollow shapes and arrows keep their exact thresholds. Two exceptions: a rich text layer takes pointer events while it is being edited, so `LightEditor` gets the clicks, and in present mode, so links work. The selection chrome, snap guides and cursors stay in the overlay SVG. Frame mode adds a frame background layer and clips the scene div to the frame.

- **Why.** It is the structure slides already has, the structure the export compositor emits for WeasyPrint, and tldraw's proven model. Rich text is native HTML, edited in place, and HTML never sits inside SVG on the live path. Live canvas, thumbnail, present mode and export share one layer shape, so what you see is what prints.
- **Thumbnails** become `FrameThumbnail`: the same read-only element layers inside a container scaled by `transform: scale(thumbWidth / SLIDE_BASE_WIDTH)`, memoised on the frame's element tuple (slides' scaled render today, without the `cqw`/`cqh` unit conversion). **Present mode** is the same at full screen. **Drive preview** is the server compositor's body. `sceneToSvg` stays for vector's SVG export and the clipboard SVG. `pxToPercent`, the container-query units and `ReadOnlySlideObject` go away.
- **What changes in vector.** Only the wrapper: `element-node.tsx` renders a layer div instead of a `<g>`, and `elementToSvg` gains the `positioned: false` option. The fragments are the same bytes, which is what the phase-1 gate checks.
- **Costs.** One `<svg>` root per element instead of one `<g>`; tldraw runs thousands, and viewport culling with `display: none` is the lever if a scene ever needs it. Text under a CSS-scaled container is re-rastered after a zoom settles, so a pinch can look soft for a frame (tldraw's behaviour, acceptable). Roughjs strokes paint outside the box: `overflow: visible` covers the live path, and WeasyPrint's handling of it is the phase-0 golden, with explicit padding as the fallback.

### 5 — One host: `CanvasEditor` with a viewport mode

`VectorCanvas` plus its hooks become `CanvasEditor`, still under `packages/ui/src/components/vector/`. Props: the doc hook, `viewport: 'infinite' | 'frame'`, `frameId?`, `tools` (which of `VECTOR_TOOLS` the host offers), `defaults` (section 10), `canEdit`, and slots for the toolbar and the extra panel sections.

- **`useViewport` gains frame mode.** `fitFrame(width, height)` sets zoom and scroll so the frame fills the container with a letterbox. Wheel zoom stays (zooming into a slide is useful); pan is clamped to the frame and reset on frame switch. On phones the frame fits and one finger pans, vector's rule. Everything downstream already goes through `clientToScene` / `boxToStyle`, so the gesture loop, `ObjectTransform`, snap guides, marquee, presence and the text overlay need no change. Frame mode seeds the frame edges and centre as snap targets through the existing `extraV` / `extraH` (slides' rule today).
- **Element scope.** `visibleElements` is the active frame's elements in frame mode, all elements otherwise. Select-all, marquee, hit-test, clipboard, presence and search read the scoped list. New elements get the active `frameId` and frame-relative coordinates.
- **One answer to the two disagreements.** Additive select is Shift (vector, Excalidraw, Figma). Z-order stepping is vector's block collapse.
- **Deleted from slides.** `slide-canvas.tsx`, `slide-object.tsx`, `use-object-drag.ts`, `use-marquee-select.ts`, `use-snap-lines.ts`, `use-deck.ts` (replaced by the engine's doc hook plus the frame ops), `normalize-deck.ts`, the DOM thumbnail, and most of `editor.tsx`. About 3,000 lines out (the nine files are 2,983 today), about 600 in for the shell.

### 6 — The deck shell (`apps/slides`)

Keeps the route, `SlidePanel` (thumbnails via `FrameThumbnail`, dnd reorder writing the frame `index`), present mode (the frame's layers full-screen, same controls: click forward, right-click back, Escape out), `SlideBackgroundPanel` (`BackgroundFillBlock` + apply-to over frames), the toolbar (File / Edit / Insert from the shared `ToolbarMenu`, tool buttons from the engine's tool list), and the mobile layout (thumbnail list + present). The properties panel is the engine's panel plus the rich text section (today's `TextProperties` rows) and, with nothing selected, the frame background panel.

### 7 — Comments, search, presence

- **Comments.** `commentCardIds` per element for both types. Unanchored cards stay allowed, which keeps vector's document-level comments working. `useActiveComments` moves into the engine; opening a card activates the frame, selects the element and opens the card (slides' flow today).
- **Search.** One `useCanvasDocSearch` controller over hand text, rich text (plain-texted) and arrow labels; context reads "Slide N" in frame mode; reveal activates the frame and rings the element. Vector gets ⌘F and the `?q=` deep link for free, which closes the "vector has no find bar" note in its route.
- **Presence.** Awareness carries `frameId`; frame mode filters peers by frame (slides' `isPeerVisible`).

### 8 — Clipboard

A typed `elements` item on `EigenClipboardData` (`packages/lib/src/types/clipboard.ts`): the selected `VectorElement`s with bindings intact and media by name. It replaces the `meta.vector` carrier that rides on a text item today. Both hosts write and read it, so slides ↔ vector paste is lossless both ways; the paste re-anchors frame-relative coordinates (viewport centre in infinite mode; in place or offset in frame mode, slides' rule). Foreign flavours are unchanged: the self-contained SVG, the typed image and text items, the D6 policy. Rich text pasted into docs carries its HTML.

### 9 — Server pipelines

- **Reader.** `readVectorFromDoc` returns `VectorScene { elements, frames, meta }`, validates the new fields and re-homes dangling `frameId`s. `document/slides.ts` is deleted.
- **`sceneToSvg(scene, { frameId? })`.** With a frame: the frame is the viewBox, the background comes from its `BackgroundFill` (solid rect; gradient as a `<linearGradient>`; image as `<image>` through `resolveMedia`), and `richtext` renders as `foreignObject` (SVG export and clipboard only).
- **Export compositor.** `apps/api/src/lib/export/canvas/render.ts`, grown from today's `export/slides/render.ts`. Per frame a page; per element in z-order the same layer the live canvas renders: an absolutely positioned `<svg overflow="visible">` holding `elementToSvg(el, { positioned: false })`, or the rich text `<div>`. `SizeUnit` stays (`cqw`/`cqh` for the responsive HTML cards, px for PDF). It serves slides HTML, slides PDF and vector PDF (one page sized to the content bounds; this replaces the inline-svg wrapper so rich text in a drawing prints). Vector SVG stays `sceneToSvg`. Fonts and media are inlined as today.
- **Preview.** Slides: the compositor body for the first 8 frames (today's rule). Vector: the `sceneToSvg` image, unchanged until phase 4 puts rich text in vector; from then on vector's preview is the compositor body too, because the drive preview shows the SVG through an `<img>` and rich text inside an image-loaded SVG is nothing to rely on.
- **Search extraction.** One collector over hand text, rich text and arrow labels in frame order, stripping tags with `stripTagsServer`. That also fixes today's slides collector, which indexes the raw HTML.
- **Media.** Enumeration stays folder-based; `mediaName` fields and the frame background image are unchanged.
- **Registry.** Both entries declare the same `yjsRoots`; `TextPreviewMode` (`packages/lib/src/constants/preview.ts`) keeps `eigenslides` and gains `eigenvector` when vector's preview moves to the compositor body.

### 10 — Style defaults per host

One `StyleDefaults` table. Vector: Excalidraw's look (roughness 1, hachure, Excalifont). Slides: clean (roughness 0, solid fill, stroke width 2, round edges, Inter). roughjs at roughness 0 is exact (the curved-arrow golden pins it), so slides shapes are clean by default and hand-drawn on request. The "last-used style memory" roadmap row becomes the one store both hosts read; until it exists, the per-host defaults are the store.

## Performance invariants

- Frame mode renders only the active frame's elements. A thumbnail re-renders only when its own frame's element tuple changes.
- Rich text is never measured. Hand text keeps client measurement; the server still never measures.
- One Yjs transact per gesture. Frames never add a write to an element move.
- Preview and export cost scale with frames × elements, exactly as slides does today.
- `ElementNode` memoisation per element is unchanged; a layer is one div and one svg. Viewport culling (`display: none` off-screen) is the reserve lever, not needed at today's scene sizes.

## Phased rollout

Each phase is its own branch and is mergeable on its own. Estimates are honest, and PROPOSAL_VECTOR's 2× rule applies.

| Phase | Scope | Ships | Estimate |
|---|---|---|---|
| **0 — Spike + contract** | A perf and crispness check of the HTML base (500 shapes + 50 rich text boxes, three browsers, zoom in and out). A WeasyPrint golden for the per-element compositor (roughjs paths in positioned `<svg>`s, `overflow: visible`, padding as the fallback). The contract in [CANVAS.md](../CANVAS.md): element fields, frames, `richtext`, the clipboard item. | Numbers and a written contract | 1 wk |
| **1 — The host** | The HTML base (section 4) and `CanvasEditor` with viewport mode, element scope, tools filter and style defaults. `commentCardIds` on elements (the one model field this phase needs), per-element comments and ⌘F in vector. Shift additive select. Vector runs on it. | Vector unchanged for users, plus per-element comments and ⌘F | 2–3 wk |
| **2 — The model** | `frames` root, `frameId`, `richtext`, `objectFit`, `borderRadius`, `BackgroundFill` on frames and rich text, the clipboard `elements` item, reader + `sceneToSvg` + search collector, registry `yjsRoots`, the demo builders under `apps/api/src/scripts/demo/` updated (the vector site plan is content-built; the deck is a byte-copied fixture that has to be re-authored). | The engine can hold a deck; no deck UI yet | 1–2 wk |
| **3 — Slides on the engine** | The deck shell rebuilt: `SlidePanel` over frames, `FrameThumbnail`, present mode, background panel, rich text in-place editing, the export compositor, preview, search, comments, presence. The old slides editor deleted. | Slides with shapes, arrows and everything else | 3–5 wk |
| **4 — Parity polish** | Gradient fills for shapes (PROPOSAL_VECTOR design), the last-used style store, the `meta` background row, rich text in vector's Insert menu. | Both apps at parity | 1–2 wk |

Later, each its own proposal: frames in vector and presenting a drawing; SVG-native rich text; animations; PPTX export; container text (a label inside a shape, Excalidraw's `containerId`).

## Verification gate

- **Phase 1** is a render-path refactor, so it gets the pixel gate: `sceneToSvg` goldens unchanged (the fragments are the same bytes), and a Playwright screenshot of the demo site plan compared before and after at a tight pixel tolerance, since each svg root rasterises on its own. Behaviour probes for select, marquee, drag, Alt-drag, resize, rotate, snap, z-order and paste.
- **Phase 3** legs: draw a rectangle and a rich text box, connect them with an elbow arrow, move the text box, the arrow follows; duplicate the slide, the copied arrow binds to the copied boxes; comment on a shape, open it from the pane, land on the right slide; ⌘F finds rich text on slide 3; reorder slides from two tabs at once; a PDF golden with shapes, rich text and a gradient background; a thumbnail updates on a remote edit; present mode; phone view-only.
- **Unit**: the reader (frames, dangling `frameId` re-home, `html` cap), `duplicateFrame` binding remap, z-order across frames, a lossless slides ↔ vector clipboard round-trip, the search collector.
- `bun run check` clean, the casts baseline not raised.

## Risks and caveats

- **Text under a scaled container.** Browsers re-raster HTML text after a CSS-transform zoom settles, so a pinch can look soft for a frame. tldraw lives with it; the phase-0 check measures it.
- **Roughjs strokes overflow the element box.** Each element's `<svg>` needs `overflow: visible` (live) and, if WeasyPrint ignores that, padding (PDF), or shapes look shaved. PROPOSAL_VECTOR flagged this; the phase-0 golden proves it.
- **Gradient interpolation.** Slides draws CSS gradients in oklab on screen and drops that for WeasyPrint, so screen and PDF already differ. SVG gradients interpolate in sRGB. Decision below: sRGB everywhere.
- **Phase 3 is a rewrite of the slides editor.** Mitigation: phases 1 and 2 land first with vector as the live proof, so phase 3 is deletion plus a shell, and every deck behaviour has a Playwright leg.
- **Two text kinds in one app.** A rich text box and a hand text element look and behave differently. Open question 1 settles the tool layout.
- **Two write disciplines in one host.** Hand text commits once; rich text streams. Acceptable because rich text has no measured side effect. To be documented in CANVAS.md.
- **Undo across frames.** Undo can resurrect or remove the active frame; the shell follows (section 2).
- **Demo data.** The vector site plan is rebuilt from `content.ts` by `vector-build.ts`; the demo deck (`sponsor-pitch.eigenslides`) is a byte-copied fixture with no builder, so it has to be re-authored or a deck builder written. There is no migration.
- **SVG-native rich text, the later option.** With a fixed frame, text layout could be resolved once on the client into `tspan` runs (bold, italic, links, list bullets), which would make thumbnails, preview and PDF pure SVG and drop the HTML compositor. It is a text layout engine, roughly 1–2k lines, and it changes nothing in this proposal's model, only the `richtext` renderer. Not now.

## Recommendation

Do it. The gap between the two editors is now exactly the host loop and the model; everything else already converged. "Vector inside slides" cannot be done well without sharing those two, and once they are shared, what is left of slides is a thin shell. No backward compatibility removes the only expensive part. Phase 1 is worth doing on its own. It is not urgent next to the 1.0 data-trust work; it is the right next canvas round.

## Decisions (2026-09-03)

- **No backward compatibility** for `.eigenslides` or `.eigenvector` stored shapes (Reinder). MIME and extension values stay frozen.
- **The engine keeps the name vector.** `packages/lib/src/vector` and `packages/ui/src/components/vector` stay; slides runs on the vector engine.
- **Additive select is Shift** in both apps. **Z-order stepping** is vector's block collapse in both.
- **Gradients interpolate in sRGB** on screen, in SVG and in PDF, so all three agree; the `in oklab` on the slides screen path goes.
- **Frames are pinned in slides** and absent from the vector shell in this program.
- **The live renderer is an HTML base with one `<svg>` per element** (Reinder's suggestion, 2026-09-03). Rich text is a plain div edited in place; `foreignObject` appears only in SVG export and the clipboard SVG.

## Open questions

1. **Text tools per host.** Recommendation: `T` is rich text in slides and hand text in vector; the other sits under Insert in both. Alternative: rich text only in slides, hand text only in vector.
2. **Frames in the vector app.** A frame tool and "present this drawing" is what Excalidraw+ sells. Later round, yes or no?
3. **Rename `vector` to `canvas`?** Recommendation: no. The exports map, every import and the docs would churn for a name.
4. **Slides on phones.** Keep the thumbnail list + present, or a frame-fit view-only canvas with swipe between frames, which the engine now gives for free. Recommendation: the latter, in phase 4.
5. **Container text.** A label inside a shape that follows the shape (Excalidraw's `containerId`). Neither app has it. Wanted for diagrams in both?
6. **Frame size per deck.** 16:9 only, or a per-deck frame size (4:3, A4) since the frame carries `width` and `height` anyway? Recommendation: 16:9 only until asked.
7. **SVG export of a drawing that holds rich text.** `foreignObject` (browsers render it, some other tools do not) or a plain-text fallback? Recommendation: `foreignObject`.

## Reference

- [PROPOSAL_VECTOR.md](PROPOSAL_VECTOR.md): the engine, the sub-resource embed model for docs and sheets, the gradient-fill design, the "share the renderer, not the model" idea this proposal replaces for slides.
- [CANVAS.md](../CANVAS.md): the shared primitives and conventions this proposal builds on; becomes the engine doc when phase 1 lands.
- [SLIDES.md](../SLIDES.md), [EXPORT.md](../EXPORT.md), [PREVIEWS.md](../PREVIEWS.md), [CLIPBOARD.md](../CLIPBOARD.md), [COMMENTS.md](../COMMENTS.md).
- Precedents: Figma Slides (slides are 1920×1080 frames in slide rows on the design canvas), Excalidraw+ presentations (frames become slides, PDF and PPTX export), tldraw (per-shape DOM rendering with viewport culling).
