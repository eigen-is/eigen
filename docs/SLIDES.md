# Slides App

> **TLDR**: Collaborative presentations on the canvas engine. A `.eigenslides` container's Y.Doc holds `elements`, `frames` and `meta` — one **frame** per slide, pinned 16:9 at 1920×1080 — and `apps/slides` is a thin shell over `CanvasEditor` in frame mode: the slide rail, present mode, the slide background panel, the counter. Everything else (the element model, the tools, the keymap, the clipboard, in-place rich text, comments, ⌘F, previews, export) is the engine's. See [CANVAS.md](CANVAS.md).

## The deck as a canvas

A slide is a `VectorFrame`: `{ id, index, name, background }`, where `index` is a fractional index (the rail's drag rewrites exactly that one key) and `background` is a serialized `BackgroundFill` — the same codec an element's fill uses. Width and height are the `FRAME_WIDTH`/`FRAME_HEIGHT` constants, never stored.

An element belongs to a slide through its `frameId`, and its `x`/`y` are **relative to the frame origin**, so the frame's coordinate space *is* the canvas' scene space in frame mode — no translation anywhere. Elements may overhang; the frame clips them.

Every element kind is available on a slide: rectangle, diamond, ellipse, image, rich text, freedraw, line, arrow. A deck's *style* differs from a drawing's only through `SLIDES_STYLE_DEFAULTS` (flat, solid, Inter) — the per-host table that decides how a NEW element looks, never which kinds exist.

## The shell

`apps/slides/src/components/slides/`:

- **`editor.tsx`** — the shell: the doc hook (`useCanvasDoc`), the active frame, tool + selection state, comments, ⌘F, presence, the slide ops. It mounts `CanvasEditor` with `viewport="frame"`, the rail on its left, `CanvasPropertiesPanel` (or the comments/activity `PanelColumn`) on its right, and a `Slide N of M` counter under the canvas.
- **`slide-panel.tsx`** — the rail: `FrameThumbnail` per slide inside dnd-kit's sortable list; a drop calls `moveFrame(id, afterId)`, which rewrites one fractional index (so a peer's concurrent rename of either slide survives). Right-click / long-press gives Duplicate and Delete; the last slide cannot be deleted. It slices the scene's elements once and hands each thumbnail its own frame's list, so a long deck does not re-filter per thumbnail per render.
- **`present-mode.tsx`** — the fullscreen overlay: `FrameView` at container size, click forward (a click past the last slide exits), right-click back, a clicker's keys (Arrow / PageUp / PageDown / space), Escape, and a fading exit button. Links inside a rich-text box work because present mode is the one place the layers take pointer events. `presentStep(index, count, delta)` is the pure step decision.
- **`slide-background-panel.tsx`** + **`apply-to.ts`** — the shared `BackgroundFillBlock` plus the scope (this slide / this and following / all slides). It mounts in the engine panel's no-selection slot (`emptySection`); editing paints the current slide and the Apply button re-sends that paint at the chosen scope, so "all slides" is an explicit act rather than something a colour drag does to the deck. `targetFrameIds` resolves the scope.
- **`toolbar.tsx`** — File / Edit / Insert from the shared menus (`EDIT_TOOLS` / `INSERT_TOOLS`), the engine's tool buttons (`ToolButtons`), Add slide, Present.
- **`seed-deck.ts`** — `seedDeck(doc)`: a new deck's first slide.
- **`hooks/use-slide-dnd.ts`** — dnd-kit state and the drop → `moveFrame` translation.

The active frame is `useActiveFrame` (`packages/ui`): it keeps the current slide while it exists and otherwise activates whatever now occupies its position, so an undo that removes a slide, or a peer deleting the one you are on, lands you on its neighbour instead of nowhere. It also owns the `index` the counter shows and the `step` the phone swipe drives.

**A new deck seeds itself.** Nothing server-side writes a container's initial Yjs content, so the first *writer* to open an empty deck adds one frame and a welcome title box — one transact under its own origin sentinel, so ⌘Z cannot empty the deck, and guarded on the live Y.Doc so a second pass (or a peer that seeded first) adds nothing.

## Comments, search, presence

All three are the engine's, with the deck's vocabulary layered on:

- **Comments** anchor to an element through `commentCardIds`; opening a card activates that element's slide first, then selects it. See [COMMENTS.md](COMMENTS.md).
- **⌘F** searches the whole deck through `searchScene`, labelling each match with its slide ("Slide 3"); revealing a match switches slides and selects the element, and the rail rings the slides that hold one. See [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md).
- **Presence** publishes the peer's frame, so a cursor shows only on the slide its owner is on.

**Layered Escape** (the shared discipline, [CANVAS.md](CANVAS.md)): present → in-place text edit → find bar → deselect. Present claims Escape in the capture phase because it is the outermost layer; every other layer is the canvas' own.

**Limitation**: a rich-text box's `html` is one scalar field, so two people editing the same box at once resolve last-writer-wins for that box. Different boxes merge normally.

## Phones

A phone gets the deck read-only (`canEdit = canWrite && !isMobile`): the frame-fit canvas, a one-finger swipe between slides, the counter, present mode, comments and the file menu. The rail and the properties panel are desktop surfaces. See [MOBILE.md](MOBILE.md).

## Backgrounds

A slide's background is a `BackgroundFill` (`packages/lib/src/types/background.ts`): solid, a two-stop linear gradient, or an image sized `cover`/`contain`. `getBackgroundStyle` turns it into CSS for the canvas, the thumbnails and present mode; `backgroundCss` does the same for the server compositor, so a gradient prints the way it renders. A background image is copied into the container's `media/` folder and stored by name — see [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md).

## Export, preview and search

One compositor serves all of them: `sceneLayers` → positioned HTML layers, one page per frame.

| File | Purpose |
|------|---------|
| `apps/api/src/lib/export/canvas/render.ts` | `framePages(scene, resolveMedia)` — one `CanvasPage` per frame — and `renderCanvasPage(page, scale, resolveMedia?)` |
| `apps/api/src/lib/export/canvas/transform.ts` | `renderEigenslidesExport` + `canvasHtmlDocument` — the standalone HTML/PDF document. A frame is 1920×1080 and a deck prints at scale 0.5, so the sheet stays 960 × 540 px (254mm × 142.875mm at 96 dpi) |
| `apps/api/src/lib/preview/eigenslides-render.ts` | The first 8 slides as compositor pages, each rich-text body sanitized before the page is composed |
| `apps/api/src/lib/search/extract-render.ts` | `collectCanvasText` — every kind's `searchText`, tag-free, in reading order |

See [EXPORT.md](EXPORT.md), [PREVIEWS.md](PREVIEWS.md), [SEARCH.md](SEARCH.md).
