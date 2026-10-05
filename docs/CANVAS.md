# Canvas Engine

> **TLDR:** A drawing and a slide deck are the same thing underneath: a page of elements (shapes, lines, arrows, text boxes, images, freehand strokes) that people place freely and edit together. One engine stores, draws and edits both. `packages/lib/src/vector/` is the half without React, which the server runs too. `packages/ui/src/components/vector/` is the editor, `CanvasEditor`. The Vector app mounts it as an infinite canvas, and the Slides app shows one fixed 16:9 page at a time ([SLIDES.md](SLIDES.md)).

A drawing is a `.eigenvector` file and a deck is a `.eigenslides` file. Both are collab documents ([COLLAB.md](COLLAB.md)): the content is a Yjs document that every open editor holds a copy of, and the server relays and stores the changes. Both use the same three roots in it. `elements` holds one small map per element: its type, position, size, rotation, colors, and whatever that type needs, such as the points of a line or the HTML of a text box. `frames` holds the slides of a deck. A frame is one page of fixed size, and an element on a slide names its frame. Only a deck writes frames, so a drawing has none. `meta` holds the background.

An element's type is called its kind. Each kind is one `defineKind` module that answers every question the engine has about it: its defaults, how to read and validate it, its bounds, whether a click hits it, and how to draw it. Rendering, bounds, hit testing and the panel never ask "is this a rectangle". They ask the kind. Adding a shape is adding that module, plus its name in `VectorElementType` and its entries in `ELEMENT_KINDS`, `TOOL_ORDER` and `ELEMENT_KIND_UI`.

Nothing in a stored document is trusted. Any collaborator, or a forged paste, can write any value. So one function, the reader, turns the Yjs document into a clean scene and repairs what it finds, and everything else works from that scene. The server runs the same reader for previews, export and search.

Drawing is the same on screen and on the server. Each element becomes one layer: a positioned box with the kind's SVG or HTML inside. The live canvas and the server's PDF and preview build that layer with the same code, so an export looks like the screen.

Two more terms come back often. A host is the app that mounts `CanvasEditor` and decides how new elements look: the Vector app or the Slides app. Frame mode is how Slides mounts the canvas: it shows the active frame only, fitted to the screen.

The sections cover the stored fields, the reader, kinds, layers, arrows that stay attached to shapes (bindings), elbow arrows, the viewport, frame mode, undo, text editing, Escape and touch. Three things in them surprise people:

- The reader's repairs live only in the scene it returns. A repaired field is stored only when a later write sets that same field ([§ The reader is the trust boundary](#the-reader-is-the-trust-boundary)).
- One discrete op, such as a delete or a panel change, is one undo step ([§ One discrete op is one undo step](#one-discrete-op-is-one-undo-step)).
- An arrow's binding lives on the arrow alone and re-glues in the shape's own transaction ([§ A binding is stored on the arrow only](#a-binding-is-stored-on-the-arrow-only)).

## Every stored field is a scalar

An element is a flat Yjs map of scalars and strings (`packages/lib/src/vector/types.ts`). Lists and objects ride JSON strings: `points`, `pressures`, `commentCardIds`, `fill`, the bindings. So reading an element is a set of primitive reads, and the write whitelist `ELEMENT_FIELDS` is a list of key names.

`fill` is paint and hatch style in one scalar (`fill.ts`). Colors are hex or the `transparent` token only, so no `url(...)` paint server reaches an export. Anything malformed reads as `TRANSPARENT_FILL`, so a corrupt peer write never throws on a render path.

A missing `roughness` reads as 0, so an old element stays crisp. A missing `seed` reads as 1, because roughjs picks a random seed for 0 and would redraw the jitter on every render.

A frame's size is the `FRAME_WIDTH`/`FRAME_HEIGHT` constant (1920x1080) and is never stored. An element with a `frameId` stores `x`/`y` relative to the frame origin, so frame mode needs no coordinate translation. Elements may overhang; the frame clips them.

A rich-text box's `html` is one scalar, so two people typing in one box resolve last-writer-wins for the whole box ([ROADMAP-POST-1.md](ROADMAP-POST-1.md)).

## The reader is the trust boundary

`readVectorFromDoc` (`read-vector.ts`) turns a Y.Doc into a `VectorScene`. It needs only yjs, so the API Worker runs it too. Each kind's `read` validates its own fields: enums, clamps, string caps, color tokens. Then it repairs what a concurrent merge can leave: colliding fractional indices get fresh ones, an element whose `frameId` names no frame moves to the first frame, and a binding to a missing shape is dropped. The repair lives only in the returned scene. Nothing writes it back: `updateElements` writes only the fields it is given, so a repaired field is stored only when a later write sets that same field. It can't sanitize rich-text `html`, which needs a DOM, so the layers that render it do ([§ One layer per element](#one-layer-per-element-on-the-canvas-and-on-the-server)).

A pasted clipboard record goes through the same `readElementFromFields`, so a forged clipboard is exactly as safe as a hostile peer write.

## A kind is one registry entry

Each kind is one `defineKind` file in `packages/lib/src/vector/kinds/`. Besides defaults, `read`, bounds, hit test and `render`, it gives the outline and the `searchText` that feeds both ⌘F and the server search index. `defineKind` derives the kind's stored `fields` from its `defaults`, so a kind names its keys once. It also re-narrows through the kind's own guard in every method, so no caller casts and a mis-dispatch degrades quietly instead of throwing mid-render. Presentation (icon, label, shortcut, in-place editor, panel section) is the matching `ELEMENT_KIND_UI` entry in `packages/ui/src/components/vector/kinds/`.

`kinds/index.ts` derives the rest: `ELEMENT_FIELDS`, the type validator, the toolbar tools, `baseDefaultsFor` (so a panel reset restores exactly what create gave). A host's style table (`VECTOR_STYLE_DEFAULTS`, `SLIDES_STYLE_DEFAULTS`) decides how a new element looks, never which kinds exist.

**A `case 'rectangle'` in rendering, bounds, hit testing or the panel is a review finding.** `.type` is still read where behavior is truly per kind: the arrow and line family (`isLinearElement`), the rich-text sanitizer, the image's media name.

Adding a kind: add it to `VectorElementType`, write its file, add one line to `ELEMENT_KINDS` and to `TOOL_ORDER`, and one `ELEMENT_KIND_UI` entry. Both registries are a `Record` over every type, so TypeScript rejects a half-added kind. `TOOL_ORDER` is a plain list, which TypeScript does not check for a missing kind.

## Capabilities are asked of the element

`capabilitiesOf(el)` answers what an element supports: fill, hatch, dash, corners, bindable, how it is created. The panel, the tools and the binding code gate on it, never on a type list. It takes the element, not the kind, because some answers depend on geometry: an open line or freehand stroke has nothing to fill until its path closes.

`paintsNothing(el)` is the kind's answer to "is this invisible": an empty text box, a shape with no fill and no border, an image with no picture. The editor rings those with a dashed outline in its chrome layer while editing, so they stay findable. Thumbnails, present mode and exports show the page as it is.

## One layer per element, on the canvas and on the server

`elementLayer` (`scene-layers.ts`) is the one answer to where an element goes and what it draws: a box, an opacity and the kind's `render` output. `layerInnerHtml` turns that into the markup that both the live canvas and the server compositor mount ([EXPORT.md](EXPORT.md#canvas-pages-are-the-boxes-the-live-canvas-draws)), so the two cannot drift. `sceneToSvg` is the standalone SVG for a download and the clipboard. It is DOM-free, so the Worker runs it.

The live layer is positioned with `transform: translate() rotate()`, never `left`/`top`, because the browser snaps a box origin to whole pixels but not a transform. `ElementLayer`'s memo compares the scalar fields, so pan and drag never rerun rough path generation. An elbow arrow also depends on its two bound shapes, so the memo compares those two rather than routing, which costs 50x more.

Rich text carries the class `eigen-canvas-text` everywhere, backed by `packages/ui/src/styles/canvas-text.css`, because list markers and link underlines are out of reach of an inline style. `html` arrives verbatim from any peer or a forged paste, so `ElementLayer` and the paste path both run `sanitizeToLightEditorHtml`.

Gradients carry nine stops sampled in OKLab (`packages/lib/src/background/gradient.ts`), because browsers and WeasyPrint blend two stops in sRGB, through a muddy gray.

## A binding is stored on the arrow only

An arrow is the one kind that depends on other elements. Its math lives in `packages/lib/src/vector/` (`geometry.ts`, `outline.ts`, `elbow-route.ts`, `elbow-pins.ts`), its handles in `packages/ui/src/components/vector/tools/`.

An arrow end binds by storing the target's id and a `fixedPoint`, the anchor as a proportion of the target's width and height. The end follows a move, resize or rotate of the target by construction. Which kinds an arrow may bind to is the `bindable` capability: the three closed shapes, rich text and images.

There is no stored reverse index. `arrowsBoundTo` derives "which arrows dock on this shape" in memory, so there is no second write to keep consistent. A binding to a missing or unbindable shape is dropped on read and never written ([§ The reader is the trust boundary](#the-reader-is-the-trust-boundary)).

After any element patch, `useCanvasDoc` runs `followBindings` for the affected arrows and writes the new geometry inside the same transaction. So a nudge, an align or a paste-move re-glues for free, in one undo step and one broadcast. A shape and its arrow moved together return null and write nothing. This runs on every gesture, so it materializes only the arrows and the shapes they dock on, never the whole scene.

An arrow dragged alone detaches once it moves 10 screen px (`ARROW_UNBIND_SCREEN`). Dragged with its shape, it stays bound.

## An arrow docks on the outline the user sees

`outline.ts` is the one definition of a shape's edge. The renderer draws it and the docking math intersects it, so a bound arrow meets a rounded rectangle exactly on the drawn curve. A rounded shape is a core polygon grown by a disc of the corner radius; docking grows the disc by the binding gap. Rectangles and diamonds share the routine and differ only in the core.

`corners` sets the radius. `round` is the largest radius that keeps the silhouette: a pill for a rectangle, the inscribed circle for a diamond. `straight` is radius 0 and takes the sharp offset path instead of the round model, which would round its corners slightly. That jump between the two is deliberate.

## Both ends aim through each other's anchor

A bound end docks along the segment from its adjacent vertex, as in Excalidraw. On a two-point arrow that vertex is the other end, which may be moving in the same pass. So when both ends are bound, each aims through the other's anchor, the one point of it that holds still. Moving one shape re-docks both ends onto the line between the anchors in one pass.

When the two docks come within 10 units, both ends sit on their anchors instead of drawing a backwards arrow. The guard measures to the other end's dock, not its anchor, because the anchors stay far apart while the docks cross when shapes touch.

A docked end is rounded to stored precision before the box is derived, so a settled arrow re-solves to itself bit for bit and `followBindings` writes nothing. A curved arrow docks where its drawn curve crosses the outline, not its chord. `geometry.test.ts` pins that curve to roughjs's control points. An elbow end resolves from its `fixedPoint` alone, so it never switches sides when the other end moves.

## An elbow route is derived until a segment is pinned

The panel's arrow type (sharp, curved, elbow) is derived from two stored fields, `roundness` and `elbow`, by `arrowShapeOf`, so the two cannot drift.

An unpinned elbow arrow stores the flag, its two endpoints and the bindings. `elbowRoute` derives the orthogonal route on every read, with A* around the bound shapes, as a port of Excalidraw. It falls back to a plain L and never throws, so an arrow always draws. `arrowRoute` is the one gate every path reads (canvas, hit test, bounds, label, export), so none can quietly draw an elbow arrow straight. The route lives in the unrotated frame, so an elbow arrow's angle is always 0.

Dragging a segment pins it (`fixedSegments`, `elbow-pins.ts`). From then on the stored `points` are the route and the router never runs on that arrow again. Dragging an end segment inserts an L-jog so the pinned segment turns interior while the endpoint stays put. `startIsSpecial`/`endIsSpecial` mark such jogs so the next move removes them and corners never pile up.

## Lines trade the transform box for point handles

A selected line or arrow shows a dot per vertex and a translucent dot between each pair (`tools/point-handles.tsx`). Dragging a middle dot inserts a vertex, and the insert and the drag are one sealed write. A two-point line shows only these dots, no transform box. An elbow arrow keeps only its two endpoint dots, with no middle dots, and adds segment-pin dots (`tools/elbow-pin-handles.tsx`), because its bends are not the user's vertices until pinned.

## The label cuts a hole in the shaft

An arrow label is plain text whose `labelWidth` the client measures; its height follows from the line count. It sits at the polyline's middle, and the shaft is masked under it so nothing shows through the text. It is a `<mask>`, not an even-odd clip, because WeasyPrint ignores `clip-rule` ([EXPORT.md](EXPORT.md#weasyprint-dictates-how-a-layer-references-its-paint)).

## The live viewport is a ref

A pan or zoom writes `viewportRef` and one animation frame sets the transform of three nodes: the scene layer, the overlay group and the screen-space chrome. A gesture costs no React render, where a render per pointer event costs about 150 ms of JS. React state holds the last committed viewport, published once input stops, and layout reads that. The chrome is laid out at that viewport, and mid-gesture `chromeTransform` moves and scales the whole chrome layer to the live one.

Anything that must be exact mid-gesture reads the ref: scene conversion, hit-test thresholds, the drawing tools' screen-px radii. React's `zoom` lags behind a gesture, so only chrome layout may use it.

## Frame mode always shows the whole page

Frame mode fits the page on open, on every resize and on every frame switch (`fitFrameViewport` in `packages/lib/src/vector/viewport.ts`). The zoom is the fit's, never the user's: `settle` (`packages/ui/src/components/vector/hooks/use-viewport.ts`), which every gesture write passes through, restores it, so wheel zoom and pinch do nothing and a pan settles back.

The page card's border is drawn in the screen-space chrome at 1 px. A border inside the scaled scene layer fails, because the browser floors `border-width` to whole px: at a 0.57 fit it becomes a blurry, drifting hairline.

`.eigen-paper` (`packages/ui/src/styles/globals.css`) pins the light palette on a surface that shows user content, and `paper.tsx` decides which surface gets it. The infinite canvas is all paper; in frame mode only the card is, and the surround follows the theme. Both chrome layers carry the pin too, so a resize grip is not dark gray on a white slide.

The canvas and the page use `overflow-clip`, not `overflow-hidden`. A hidden box scrolls to reveal a focused caret, which would slide the page away from its chrome during text editing.

## Frame mode scopes the canvas, except comments and search

In frame mode, rendering, hit testing, marquee, snap, select-all and the keyboard read only the active frame's elements. Comments and ⌘F read the whole scene, because both must reach an element on another slide. Every insert goes through the canvas' `addElement` wrappers, which stamp the active `frameId` last, so a paste lands in the frame it is pasted into. Frame ops (`hooks/frame-writes.ts`) share the undo scope with elements, so undoing a frame delete restores its elements in the same step. `nearestFrameId` lands a host on a neighbor when its frame vanishes under an undo or a peer's delete.

## One discrete op is one undo step

`Y.UndoManager` merges everything within 500 ms. So every discrete op (delete, duplicate, z-order, a panel row, a frame op) runs through `sealed()` (`hooks/use-canvas-doc.ts`), which stops capturing on both sides. A gesture that writes as it goes (the opacity slider, a typed number, a run of arrow-key nudges) takes `holdCapture()` instead. It holds the window open until the gesture ends, and `sealed` stands down inside it. The panel publishes the hold on `PropertyGestureContext`, so every number input is one step without threading it.

Fixups that must never be undone write under a non-null origin, which the UndoManager does not track: the image's pending-to-real media name swap, the sweep of abandoned upload placeholders, a text box re-fit caused by someone else, the deck's seed. They still sync to peers. The comments map is outside the undo scope, so ⌘Z never resurrects a card. It is not one of the declared `yjsRoots` either, so a version restore from before a card's delete brings back the element's `commentCardIds` but not the card. The canvas draws no mark for an id whose card is gone.

## Rich text is edited inside its own layer

Double-click opens the kind's `InPlaceEditor` inside the element's own layer, over the box's painted fill and border. Each change writes `html` straight through, unsealed, so the session is one undo step and peers see it live. On exit an empty box is deleted, sealed first. Otherwise the delete would merge into the last keystroke, and whether it is its own step would depend on how fast the user clicked away.

During a text session the canvas keymap is disabled, because `ignoreInputs` does not cover ProseMirror. The viewport freezes so the editor stays on its element.

A box's height only grows (`richTextFitHeight`): the stored height is the user's minimum, and the room below the text is what vertical alignment uses. The layer measures its own text, so every change re-fits in one place. Every client measures the same box and only a shortfall of 1 px or more is written, so concurrent writers converge instead of echoing. The typing user's fit is tracked, so ⌘Z takes back the text and the growth together.

## Escape is layered per host, on purpose

On the canvas Escape goes to the innermost active mode: rich-text editing, then a mid-gesture cancel, then deselect, then the select tool. The text editor stops propagation. `ObjectTransform` claims a resize in the capture phase. The canvas' bubble-phase listener handles the rest. Slides adds present mode as the outer layer. Don't extract a shared Escape router: the per-host phase ordering is what makes the innermost mode win.

## Touch policy lives beside the canvas

`tools/touch-gestures.ts` holds the policy, ported from Excalidraw.

- The first pen contact latches pen mode, after which a finger can only select or edit text, so a resting palm can't draw.
- A second finger aborts the first one's gesture, then pans and pinches. A stroke under 10 points is a palm spike and is discarded.
- Phones get a view-only canvas (`canEdit = canWrite && !isMobile`), where one finger pans. Comments and the file menu keep the real `canWrite`.

## Objects share one transform and snap

`ObjectTransform` (`packages/ui/src/components/transform/`) is the resize and rotate chrome for the canvas, docs figures and sheets images. Its `snapBox` applies on resize only. `snap.ts` takes its threshold in the box's units, so a zoomable host passes `SNAP_SCREEN_THRESHOLD / zoom` to keep the radius constant on screen. A rotated box's axis-aligned edges don't match what the user sees, so it snaps by center only. The aspect lock (`useAspectLock`) starts on for images and remembers a toggle per element while the editor is mounted.

Every panel row is a `PropertyRow` over the shared controls in `packages/ui/src/components/properties-panel/`, never a bespoke control. With nothing selected a host may add its own rows (`emptySection`), because only it knows those words.

## See also

- [SLIDES.md](SLIDES.md): the deck shell
- [CLIPBOARD.md](CLIPBOARD.md): the elements item, paste placement, the SVG flavor
- [COMMENTS.md](COMMENTS.md) and [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md): comments and ⌘F on a canvas
- [EXPORT.md](EXPORT.md) and [PREVIEWS.md](PREVIEWS.md): the server compositor, and how it draws the same arrow
- [COLLAB.md](COLLAB.md): `useCollabDoc` and the loading gate
- [MOBILE.md](MOBILE.md#a-phone-views-canvas-documents-never-edits-them): the view-only canvas on phones
