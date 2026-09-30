# Slides

> **TLDR:** A deck is a canvas document in frame mode. `apps/slides/src/components/slides/` is a thin shell over the engine's `CanvasEditor` ([CANVAS.md](CANVAS.md)): the slide rail, present mode, the slide background panel and the counter. A slide is one 16:9 frame in the `.eigenslides` container's `frames` map. Everything else (elements, tools, keymap, clipboard, rich text, comments, ⌘F, previews, export) is the engine's. Not obvious from the code: the first writer seeds an empty deck under fixed ids, a reorder rewrites one key, and a background reaches other slides only through an explicit Apply.

## A slide is a frame, and the shell adds only the deck's words

A slide is a `VectorFrame` (`packages/lib/src/vector/frames.ts`): an id, a fractional `index`, a name and a serialized `BackgroundFill`. Its size is a constant, and its elements carry its `frameId` with coordinates relative to the frame ([CANVAS.md](CANVAS.md#every-stored-field-is-a-scalar)). Every element kind works on a slide. `SLIDES_STYLE_DEFAULTS` (flat, solid, Inter) decides only how a new element looks.

The shell mounts `CanvasEditor` with `viewport="frame"`, so the slide always fits its space, with no zoom and no free pan ([CANVAS.md](CANVAS.md#frame-mode-always-shows-the-whole-page)). It fills the shared `CanvasToolbar`'s two host slots: `insertItems` with New slide and `centerItems` with Present. The engine can't speak deck vocabulary, so the slide menu (New slide above or below, Duplicate, Delete) lives in the shell. It opens from a rail thumbnail and from a right-click on empty canvas (`onEmptyContextMenu`). The last slide can't be deleted. A phone gets the deck view-only, with no rail ([MOBILE.md](MOBILE.md)).

## The first writer seeds an empty deck

Nothing server-side writes a container's initial Yjs content, so the first writer to open an empty deck adds a title slide (`seed-deck.ts`). It writes in one transaction under its own origin, so ⌘Z can't empty the deck. It tests the live Y.Doc, not React state, so a second effect pass adds nothing. The frame and the title box use fixed ids, so two people opening the same empty deck at once converge on one title slide instead of two.

The reader reads only `elements`, `frames` and `meta`. A deck with no frames is empty whatever other roots it holds, so a deck stored in an older format opens as a new one and gets seeded. That follows the pre-1.0 rule of no backward compatibility for stored formats ([ROADMAP.md](ROADMAP.md)).

## A reorder rewrites one key

The rail (`slide-panel.tsx`) is a dnd-kit sortable list of `FrameThumbnail`s. A drop calls `moveFrame(id, afterId)`, which rewrites the moved frame's fractional `index` and nothing else, so a peer's concurrent rename of either slide survives. The rail groups the scene's elements by frame once per render and hands each thumbnail its own list, so a long deck doesn't filter the scene once per thumbnail.

## The active slide survives its own deletion

`useActiveFrame` (`packages/ui/src/components/vector/hooks/`) keeps the current slide while it exists. When it vanishes, through an undo of its add or a peer's delete, the slide now at its position takes over, clamped to the ends. So the user lands on a neighbour, never on nothing. The hook also gives the counter its index and the phone swipe its step.

## Revealing an element goes to its slide first

The comment pane and ⌘F span the whole deck while the canvas shows one slide. So both reveal through one callback: activate the element's slide, then select the element. An element whose slide is gone is selected in place, because switching to a missing frame would empty the canvas. ⌘F labels each match with its slide and rings the rail thumbnails that hold one ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md), [COMMENTS.md](COMMENTS.md)). Presence carries the frame, so a peer's cursor shows only on the slide they are on.

## Present mode replaces the editor

`present-mode.tsx` draws the slide with `FrameView`, the same read-only page the rail draws, so the presenter shows what the editor shows. The doc hook stays mounted above it, so leaving returns to the same slide and the unsynced-edits guard keeps working. Present claims Escape in the capture phase, as the outermost layer ([CANVAS.md](CANVAS.md#escape-is-layered-per-host-on-purpose)).

A click moves forward and a right-click back, and a clicker's arrow, Page and space keys do the same. A click past the last slide leaves present mode. A right-click on the first slide stays put, because leaving on a backward mis-click would be a surprise. Links in a rich-text box work, because present mode is the one place the layers take pointer events. `deckOwnsClick` keeps a press on a link from also moving the deck.

## A background reaches other slides only through Apply

The background panel (`slide-background-panel.tsx`) mounts in the engine panel's no-selection slot (`emptySection`), because "this and following" is deck vocabulary. Editing paints the current slide. The Apply button sends that paint to this slide, this and following, or all slides (`targetFrameIds` in `apply-to.ts`). So recoloring the deck is an explicit act, never a side effect of a color drag. A stale slide id applies to nothing, never to the deck.

A background is a `BackgroundFill` (`packages/lib/src/types/background.ts`): solid, a two-stop linear gradient, or an image sized `cover` or `contain`. `getBackgroundStyle` renders it on the canvas, the rail and in present mode, and `backgroundCss` renders it on the server, so a gradient prints the way it looks. An image is copied into the container's `media/` folder and stored by name ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)).

## Export and preview render the pages the canvas draws

The server compositor (`apps/api/src/lib/export/canvas/`) turns each frame into one page of positioned layers, the boxes the live canvas gives each element. The HTML and PDF export print those pages at half scale ([EXPORT.md](EXPORT.md#a-deck-prints-each-frame-at-half-scale)), and the drive preview renders the first slides of the same pages ([PREVIEWS.md](PREVIEWS.md#an-eigen-document-previews-a-slice-off-the-event-loop)). Search indexes a deck through the canvas collector ([SEARCH.md](SEARCH.md)).

## See also

- [CANVAS.md](CANVAS.md): the engine, frame mode and the element model
- [MOBILE.md](MOBILE.md): the view-only deck on a phone
