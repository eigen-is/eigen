# Slides

> **TLDR:** A deck is a set of slides that people edit together and then present. Underneath, it is a canvas document whose pages are frames of one size per deck, 16:9 or 4:3 at a physical width of its own, drawn by the canvas engine ([CANVAS.md](CANVAS.md)). `apps/slides/src/components/slides/` is a thin shell over the engine's `CanvasEditor`: it adds the slide rail and its phone strip, present mode, the slide background panel and the slide counter.

A deck is a `.eigenslides` file. Each slide is a frame: one page of the canvas, stored in the `frames` map of the deck's Yjs document ([COLLAB.md](COLLAB.md)). Every element on the deck sits on one frame and stores its position relative to it. The shell mounts the canvas in frame mode, which shows only the active slide, fitted to the screen. Everything else (elements, tools, keymap, clipboard, rich text, comments, ⌘F, previews, export) is the engine's.

So the shell adds only what the engine has no word for: a deck as an ordered list of slides on a page of physical size. Six things in it surprise people:

- The first writer to open an empty deck seeds it, under fixed ids ([§ The first writer seeds an empty deck](#the-first-writer-seeds-an-empty-deck)).
- A reorder rewrites one key ([§ A reorder rewrites one key](#a-reorder-rewrites-one-key)).
- A background reaches other slides only through an explicit Apply ([§ A background reaches other slides only through Apply](#a-background-reaches-other-slides-only-through-apply)).
- The deck writer, which a pptx Convert and Import… write through, inserts an update under fresh ids and rewrites nothing the deck holds; only an Import… that replaces clears the deck ([§ The deck writer inserts under fresh ids](#the-deck-writer-inserts-under-fresh-ids-and-only-a-replace-clears-the-deck)).
- A slide size change moves no element, so a 4:3 deck switched to 16:9 hides what sits below the new edge ([§ A deck has one slide size, and a change moves nothing](#a-deck-has-one-slide-size-and-a-change-moves-nothing)).
- A text size is stored in px and shown in pt, at the deck's own width, so a pptx's 44 pt title stays 44 pt ([§ A deck has a physical width, so its text sizes read in pt](#a-deck-has-a-physical-width-so-its-text-sizes-read-in-pt)).

## A slide is a frame, and the shell adds only the deck's words

A slide is a `VectorFrame` (`packages/lib/src/vector/frames.ts`): an id, a fractional `index`, a name and a serialized `BackgroundFill`. Its size is the deck's slide size, and its elements carry its `frameId` ([CANVAS.md](CANVAS.md#every-stored-field-is-a-scalar)). Every element kind works on a slide. `SLIDES_STYLE_DEFAULTS` (flat, solid, Inter) decides only how a new element looks.

The shell mounts `CanvasEditor` with `viewport="frame"`, so the slide always fits its space, with no zoom and no free pan ([CANVAS.md](CANVAS.md#frame-mode-always-shows-the-whole-page)). It fills the shared `CanvasToolbar`'s three host slots: `fileItems` with Page setup, `insertItems` with New slide and `centerItems` with Present. The engine has no notion of slides, so the slide menu (New slide above or below, Duplicate, Delete) lives in the shell. It opens from a rail thumbnail and from a right-click on empty canvas, where `CanvasEditor`'s `backgroundMenu` puts the slide rows below the canvas' own Paste. The last slide can't be deleted. A phone gets the deck view-only. In place of the rail, `SlideStrip` puts the same thumbnails in one row under the slide, so a tap jumps to any slide of a long deck ([MOBILE.md](MOBILE.md)).

## A deck has one slide size, and a change moves nothing

A deck is 16:9 or 4:3. The size is one key, `slideSize` in the deck's `meta` root, and `SLIDE_SIZES` in `packages/lib/src/vector/frames.ts` is the one table of what each means: 16:9 is 1920×1080 and 4:3 is 1920×1440. Both keep the width, as Google's slide sizes do. So a switch from 16:9, the size every new deck opens at, to 4:3 adds a band at the bottom and hides nothing, and the export and preview scales, which divide by `FRAME_WIDTH`, hold for both. A frame stores no size of its own: the reader reads the key through `oneOf`, so a missing, unknown or forged value reads as 16:9, and stamps the size on every `VectorFrame`. Everything downstream reads `frame.width` and `frame.height`: the editor's fit, snap and off-page guard, the rail, present mode, the export and the preview. `nearestSlideSize` maps a page of any size to the closer of the two by shape, for an importer. The deck's physical width is a key of its own beside it ([§ A deck has a physical width](#a-deck-has-a-physical-width-so-its-text-sizes-read-in-pt)), so a size change keeps it and changes only the height.

File → **Page setup…** (`page-setup-dialog.tsx`) offers the two under Google's names, Widescreen 16:9 and Standard 4:3, and a viewer or a phone sees it read-only. Until the user picks, the open dialog shows the deck's size as it is now, a peer's change included, and OK writes only a pick that differs from it, so an untouched OK never overwrites a peer. A change is one `updateMeta` write, sealed, so it is one undo step, and `meta` is in the deck's version-restore roots. Elements keep their stored position and size, as in Google Slides. A switch from 4:3 to 16:9 therefore clips whatever sits below y = 1080, on the canvas, the rail, in present mode and the exports. It is not deleted: ⌘A and a marquee still reach it, and undo or switching back shows it again. Rescaling or re-centering the content would rewrite every element, a bigger write than a page change should be.

The size arrives as a new frame extent with the same frame id, whether this tab or a peer wrote it. `useViewport` re-fits on a change of the extent as it does on a frame switch; without that, the old zoom would stay and cut off the bottom of a slide that grew. The rail's drag card takes the dragged frame's ratio. The drive hero is a fixed 16:9 box, so a 4:3 first slide narrows to the hero's height there (`.drive-preview-hero .page-fit` in `globals.css`).

## A deck has a physical width, so its text sizes read in pt

A slide's frame is 1920 px wide in every deck, and the canvas stores every size in those px, the same engine and the same fields a drawing has ([CANVAS.md](CANVAS.md)). A deck also has a physical width in pt, `slideWidth` in its `meta`. So a deck has a pt per px of its own. `slidePxToPt` and `slidePtToPx` in `packages/lib/src/vector/frames.ts` are the one conversion, and every place a deck meets pt goes through them: the Size and Letter rows, the pptx reader and writer, and the PDF's sheet. PowerPoint, Google Slides and Keynote all speak pt on a page, and a pptx's sizes only survive the trip when the deck has the file's width: one fixed width would show PowerPoint's 13.33 in widescreen title, 44 pt, as 33 pt.

A new deck is PowerPoint's widescreen, 960 pt (`DEFAULT_SCENE_META`), so a pt is exactly 2 px; the seeder writes it, as a deck must state its width. A deck without one was made before decks had a width, and its PDF printed the 1920 px as 10 in, so the reader reads a missing or forged value as 720 pt (`UNSTORED_SLIDE_WIDTH`). Page setup keeps the width, so a 4:3 deck made from a new one is 13.33 by 10 in, still 2 px a pt, not PowerPoint's 10 by 7.5 in, which would be 8/3. The reader holds a stored width to PowerPoint's 1 to 56 in on both sides: at least 128 pt, where a 16:9 slide is 1 in tall, and at most 4032 pt.

The panel's Size row (`FontSizeRow`, `packages/ui/src/components/properties-panel/`) shows a deck's sizes in pt on the half-point grid of `packages/lib/src/constants/fonts.ts`, through the `FontSizeStepper` Docs and Sheets use, with its 1 pt steps and its 1 to 400 pt range. A step moves each selected box from its own size. The Letter row shows a deck's letter spacing in pt to the hundredth, as pptx writes it. A drawing has no page, so the same rows show px. **Every row rounds only what it shows.** The stored px is written only when the user sets a value, so a box pasted from a deck into a drawing, or into a deck of another width, keeps its px to the bit, and selecting a box never rewrites it. Its shown pt changes with the width: a copy keeps the look, not the number. Positions, sizes, padding and the stroke width stay px in both apps. The stroke width is a number field shown to the hundredth, as a pptx line lands between whole px: 1 pt is 2.67 px on a 10 in deck, and the reader and the writer carry it exactly, to the EMU.

The reader's px range for a font size is one for decks and drawings, because a paste between them keeps its px: 1 pt on the widest deck to 400 pt on a 10 in one (`MAX_FONT_SIZE_PX`), so every deck Eigen makes reaches all of fonts.ts' range and a drawing's text stops near 1,067 px. A pptx deck under 10 in wide stops short of 400 pt.

## The first writer seeds an empty deck

Creating a deck writes no Yjs content, so the first writer to open an empty deck adds a title slide (`seed-deck.ts`). It writes in one transaction under its own origin, so ⌘Z can't empty the deck. It tests the live Y.Doc, not React state, so a second effect pass adds nothing. The frame and the title box use fixed ids, so two people opening the same empty deck at once converge on one title slide instead of two.

The reader reads only `elements`, `frames` and `meta`. A deck with no frames is empty whatever other roots it holds, so a deck stored in an older format opens as a new one and gets seeded. That follows the pre-1.0 rule of no backward compatibility for stored formats ([ROADMAP.md](ROADMAP.md)).

## A reorder rewrites one key

The rail (`slide-panel.tsx`) is a dnd-kit sortable list of `FrameThumbnail`s. A drop calls `moveFrame(id, afterId)`, which rewrites the moved frame's fractional `index` and nothing else, so a peer's concurrent rename of either slide survives. The rail and the phone strip group the scene's elements by frame once per render and hand each thumbnail its own list, so a long deck doesn't filter the scene once per thumbnail.

## The active slide survives its own deletion

`useActiveFrame` (`packages/ui/src/components/vector/hooks/`) keeps the current slide while it exists. When it vanishes, through an undo of its add or a peer's delete, the slide now at its position takes over, clamped to the ends. So the user lands on a neighbor, never on nothing. The hook also gives the counter its index and the phone swipe its step.

## Revealing an element goes to its slide first

The comment pane and ⌘F span the whole deck while the canvas shows one slide. So both reveal through one callback: activate the element's slide, then select the element. An element whose slide is gone is selected in place, because switching to a missing frame would empty the canvas. ⌘F labels each match with its slide and rings the thumbnails that hold one, in the rail or the phone strip ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md), [COMMENTS.md](COMMENTS.md)). Presence carries the frame, so a peer's cursor shows only on the slide they are on.

## Present mode replaces the editor

`present-mode.tsx` draws the slide with `FrameView`, the same read-only page the rail draws, so the presenter shows what the editor shows. The doc hook stays mounted above it, so leaving returns to the same slide and the unsynced-edits guard keeps working. Present claims Escape in the capture phase, as the outermost layer ([CANVAS.md](CANVAS.md#escape-is-layered-per-host-on-purpose)).

A click moves forward and a right-click back, and a clicker's arrow, Page and space keys do the same. A click past the last slide leaves present mode. A right-click on the first slide stays put, because leaving on a backward mis-click would be a surprise. Links in a rich-text box work, because present mode is the one place the layers take pointer events. `deckOwnsClick` keeps a press on a link from also moving the deck.

## A background reaches other slides only through Apply

The background panel (`slide-background-panel.tsx`) mounts in the engine panel's no-selection slot (`emptySection`), because "this and following" is a slides idea the engine doesn't have. Editing paints the current slide. The Apply button sends that paint to this slide, this and following, or all slides (`targetFrameIds` in `apply-to.ts`). So recoloring the deck is an explicit act, never a side effect of a color drag. A stale slide id applies to nothing, never to the deck.

A background is a `BackgroundFill` (`packages/lib/src/types/background.ts`): solid, a two-stop linear gradient, or an image sized `cover` or `contain`. `getBackgroundStyle` renders it on the canvas, the rail and in present mode, and `backgroundCss` renders it on the server, so a gradient prints the way it looks. An image is copied into the container's `media/` folder and stored by name ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)).

## The deck writer inserts under fresh ids, and only a replace clears the deck

The server has a deck writer for the pptx import, `apps/api/src/lib/document/slides.ts`: Convert to Slides on a `.pptx` in Drive, and File › Import… in an open deck ([EXPORT.md](EXPORT.md#a-pptx-import-adds-slides-and-leaves-a-box-where-it-cant-draw)). The update is untrusted, so `readSlidesUpdate` first reads it back through the reader in a scratch doc: a record the reader would heal or drop for a hostile peer is healed or dropped here, and only the clean scene is written ([CANVAS.md](CANVAS.md#the-reader-is-the-trust-boundary)). The caller bounds the update's size and record count, and hands it media names that are already free in the deck's `media/` folder, since the writer stores them as given.

Every write is one transaction, and every slide and element gets a fresh id. Element frame ids and arrow bindings are remapped to the new ids, and an imported element starts with no comment cards. The work is linear in the update's records.

`insertSlidesIntoYjs` is Import…'s default. It places the file's slides after the slide the user is on, the one the client names, through `frameKeysAfter` (`packages/lib/src/vector/write-vector.ts`), the key arithmetic the editor's New slide uses, and after the last slide when that one is gone. Slides sharing a key, two peers' new slides after one slide, sort by id, and a slide placed after one of them goes after all of them, since no key lies between: `keysAfter` (`fractional-index.ts`), the rule a canvas z-order move places by too. Unlike that move, a slide's placement writes no repair, since it rewrites no other slide. Nothing already in the deck is cleared or rewritten, and its `meta` stays, because an open tab's undo stack and its comments point at those Y.Maps.

`replaceSlidesInYjs` clears the deck's frames and elements and writes the file's with its `meta`, whose `slideSize` is the one nearest the file's and whose `slideWidth` keeps the file's pt per px. Convert fills a brand-new deck through it, and Import… replaces an open one through it, after a version is saved, since the cleared records orphan their comment cards ([EXPORT.md](EXPORT.md#a-replace-saves-a-version-first)). A file with no slides leaves a converted deck with none, and the first writer to open it seeds it like a new one, so there is one empty-deck path. An Import… of such a file writes nothing and says so, rather than adding nothing silently or emptying the deck.

## Export and preview render the pages the canvas draws

The server compositor (`apps/api/src/lib/export/canvas/`) turns each frame into one page of positioned layers, the boxes the live canvas gives each element. The HTML and PDF export print those pages at the deck's width ([EXPORT.md](EXPORT.md#a-deck-prints-each-frame-at-its-own-width)), and the drive preview renders the first slides of the same pages ([PREVIEWS.md](PREVIEWS.md#an-eigen-document-previews-a-slice-off-the-event-loop)). The pptx export writes each frame as a slide of DrawingML shapes from the scene itself, because PowerPoint needs shapes it can edit, not positioned HTML ([EXPORT.md](EXPORT.md#a-decks-pptx-is-written-from-the-scene-one-drawingml-shape-per-element)). Search indexes a deck through the canvas collector ([SEARCH.md](SEARCH.md)).

## See also

- [CANVAS.md](CANVAS.md): the engine, frame mode and the element model
- [MOBILE.md](MOBILE.md): the view-only deck on a phone
