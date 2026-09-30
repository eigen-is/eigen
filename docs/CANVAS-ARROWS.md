# Canvas Arrows

> **TLDR:** An arrow is the one canvas kind that depends on other elements. The math lives in `packages/lib/src/vector/` (`geometry.ts`, `outline.ts`, `elbow-route.ts`, `elbow-pins.ts`) and the handles in `packages/ui/src/components/vector/tools/`. Not obvious from the code: a binding is stored on the arrow only and re-glued inside the same transaction as the shape's move, an arrow docks on the outline the user sees, and an elbow arrow's route is derived until the user pins a segment. The engine around it: [CANVAS.md](CANVAS.md).

## A binding is stored on the arrow only

An arrow end binds by storing the target's id and a `fixedPoint`, the anchor as a proportion of the target's width and height. The end follows a move, resize or rotate of the target by construction. Which kinds an arrow may bind to is the `bindable` capability: the three closed shapes, rich text and images.

There is no stored reverse index. `arrowsBoundTo` derives "which arrows dock on this shape" in memory, so there is no second write to keep consistent. A binding to a missing or unbindable shape is dropped on read and never written ([CANVAS.md](CANVAS.md#the-reader-is-the-trust-boundary)).

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

A selected line or arrow shows a dot per vertex and a translucent dot between each pair (`tools/point-handles.tsx`). Dragging a middle dot inserts a vertex, and the insert and the drag are one sealed write. A two-point line shows only these dots, no transform box. An elbow arrow shows segment-pin dots instead (`tools/elbow-pin-handles.tsx`), because its bends are not the user's vertices until pinned.

## The label cuts a hole in the shaft

An arrow label is plain text whose `labelWidth` the client measures; its height follows from the line count. It sits at the polyline's middle, and the shaft is masked under it so nothing shows through the text. It is a `<mask>`, not an even-odd clip, because WeasyPrint ignores `clip-rule` ([EXPORT.md](EXPORT.md#the-canvas-compositor)).

## See also

- [CANVAS.md](CANVAS.md): the element model, the registry, the layers
- [EXPORT.md](EXPORT.md): how the server draws the same arrow
