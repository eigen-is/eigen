# Canvas apps: TODO

The backlog for the canvas apps: Slides, Vector, Stickies and the canvas engine they share. [CANVAS.md](CANVAS.md) describes the engine and Vector; [SLIDES.md](SLIDES.md) and [STICKIES.md](STICKIES.md) the other two apps. Data-loss and security bugs, and work shared across apps, are in [ROADMAP.md](ROADMAP.md).

**Legend**: Effort: S / M / L / XL (rough T-shirt size).

## Features

- **pptx export: Eigen's fonts and contained pictures** ([EXPORT.md](EXPORT.md#a-pptx-draws-what-drawingml-can-and-loses-the-rest)) (M): `writePptx` (`apps/api/src/lib/export/slides/pptx/`) names the four Eigen fonts without embedding them, so PowerPoint for the web substitutes all four and Google Slides substitutes Excalifont. A contained picture is written as a smaller picture plus a separate border shape, and reads back as two elements. Fonts: embed them (`p:embeddedFontLst`) once a probe shows PowerPoint for the web reads them. Contain: one picture in the element's box with `a:fillRect` insets and its own `a:ln`, as `backgroundXml` does, and read insets back as contain.

- **pptx import: open-path arrowheads, crop, SmartArt** ([EXPORT.md](EXPORT.md#a-pptx-import-adds-slides-and-leaves-a-box-where-it-cant-draw)) (M–L): The reader (`apps/api/src/lib/import/slides/`) draws every preset and custom path. Still lost: arrowheads on an arc or a mixed lines-and-curves freeform; shadows, glows, 3-D; picture crop and flip; TIFF, EMF and WMF pictures (a box); picture fills and gradients past two stops; SmartArt comes in as loose cached shapes; a table, embedded object, SmartArt without cached shapes or an undrawable chart leaves a box. The toast counts each. Next: arrowheads as line ends on a path; SmartArt laid out from its layout definition; crop and flip through sharp with a pixel and time bound; TIFF to PNG and the EMF/WMF fallback image.

- **Canvas rich text: per-paragraph and per-run size, colour and font** ([CANVAS.md](CANVAS.md)) (L): A rich text box stores font, size and colour as box fields (`packages/lib/src/vector/types.ts`), with only marks like bold inline. A pptx import takes the dominant run style, so mixed sizes or colours in one box come in uniform, and the editor can't mix them either. Parity with PowerPoint and Google Slides: per-run size, colour and font and per-paragraph alignment and spacing, in the editor, HTML and PDF export, and the pptx writer and reader.

- **Vector: frames and presenting a drawing** (S–M): The engine takes a `viewport` of `infinite` or `frame` (`packages/ui/src/components/vector/canvas-editor.tsx`) and has `addFrame`, but the vector shell hardcodes `viewport="infinite"` (`apps/vector/src/components/vector/editor.tsx`) and only slides calls `addFrame` or uses `PresentMode`. A drawing can hold no frames. Frames lay out a poster, boards or a storyboard, and presenting comes nearly free with them. Host-shell work on built engine machinery, no model change. Do both together.

- **Canvas element model: radial and stroke gradients** (S–M): `FillPaint` (`packages/lib/src/types/background.ts`) is a two-stop linear gradient and `strokeColor` a plain color, so no radial gradients and no gradient strokes. A small widening of one codec and its two renderers. Frozen-format: Additive: a radial variant in the fill codec; `.eigenvector`/`.eigenslides` shapes are not BC-frozen.

- **Canvas: the text box and the rectangle are one kind** ([CANVAS.md](CANVAS.md)) (M): `VectorRichTextElement` and `VectorRectangleElement` differ only in `type`. In pptx a text box is a `rect` with no fill or line and `a:spAutoFit`. Merge: add an auto-fit flag to the rectangle (set when reading a stored `richtext`), make the Text tool create an unpainted flagged rectangle, have `useRichTextAutoFit` and `closeRichText` read the flag, and drop the `richtext` kind. The one behaviour difference stays: a text box grows and is deleted when empty, a shape spills and stays. Frozen-format: Additive: one stored field.

- **pptx: a shape's text lays out in the shape's own text rectangle** ([EXPORT.md](EXPORT.md)) (M): PowerPoint lays text in the rectangle a preset names (`a:rect`): an ellipse's inscribed rectangle, a diamond's middle half. Eigen uses the whole box minus `padding`, so text in an ellipse, diamond or pie wraps wider than in PowerPoint. Draw and export each preset's text rectangle. Independent of the merge above.

- **Vector exports cut off text that spills past the drawing** ([EXPORT.md](EXPORT.md)) (S): `sceneBounds` (`packages/lib/src/vector/elbow-route.ts`) sizes the drawing PDF, preview and SVG download from element boxes, so a shape's text spilling past the outermost element is cut at the edge. Size the page from the measured text too, or from the box grown by its overflow. Rare.

- **Vector: Escape after a stroke keeps the Draw tool** (XS): Picking Draw and pressing Escape goes back to Select, but after drawing a stroke Escape leaves Draw active, so the next drag draws another stroke. Escape after a stroke returns to Select, as it does before one.

## Bugs and small fixes

Verified, bounded, cheap to fix on the next touch.

- **Canvas: no cap on one element's hatch or path fill work** (S–M): A hatched fill's cost grows with its area, unbounded per element: a hostile hatched path at 2000 × 2000 takes up to 4 s and 34 MiB of SVG, and a wild 400-command path (any pptx `custGeom` import) up to 3.3 s solid. Previews cap only element count (`PREVIEW_MAX_ELEMENTS`) and output bytes (`applyPreviewByteGuard`), both after the work. Fix: one per-element budget for every hatched kind in `packages/lib/src/vector/kinds/render-utils.ts` (wider `hachureGap` or a solid fallback) and a bound on a path's solid fill.

- **Canvas: three files past the split line** (S): `packages/lib/src/vector/geometry.ts` (923 lines), `packages/ui/src/components/vector/tools/use-drawing-tools.ts` (1,102) and `packages/ui/src/components/vector/canvas-editor.tsx` (1,794, still holding the pointer-gesture handlers) each mix several concerns. Split along their seams (outline/hit-test/binding maths, per-tool drawing state, gestures) on the next real touch of each.

- **A canvas shape or image copy pastes nothing into mail compose** (S): ⌘C writes a marker-only `text/html` and no `text/plain`. Mail's LightEditor (`packages/ui/src/components/editor/light-editor.tsx`) has no image node, so the menu copy's `<img>` is dropped too. Fix: an `image/png` flavor on the async copy path, never beside `text/plain` ([CLIPBOARD.md](CLIPBOARD.md#a-copy-never-writes-two-flavors-one-consumer-would-both-accept)). Left for now by the owner: it would fix the menu copy only, not ⌘C.

- **Download image embeds whole font faces** (S–M): `canvas-image.ts` (`packages/ui/src/components/vector/`) inlines each face the image uses as base64 woff2 through `fontFaceCss`, about 0.5 MB a face for a few glyphs. Subsetting needs a font package (owner's yes first).

- **Vector: geometry dispatches through the kind registry, a cycle that bites on entry order** (M): `geometry.ts` imports `ELEMENT_KINDS` and the registry imports geometry's box primitives, so an entry that reaches geometry through a kind's module first (such as `kinds/rectangle.ts`) throws a TDZ `ReferenceError`. `cycle.test.ts` pins the working entries. Fix: geometry dispatches without importing the registry, or the box primitives move to a module both import.

- **Vector and Slides: Escape with a toolbar tooltip showing needs two presses** (XS): The canvas's Escape handler (`canvas-editor.tsx` in `packages/ui/src/components/vector/`) skips an Escape with `defaultPrevented`, which a Radix tooltip sets, so the first press only closes the tooltip. Fix: check for an open menu layer instead of the flag, and pin it beside the bar-menu Escape test.

- **Vector and Slides: text that spills past its shape can't be clicked** (S): Hit testing reads only the shape's outline (`openTextAtClient`, `hitTestTopmost` in `canvas-editor.tsx`), so a click on spilled text selects nothing and a double-click adds a new box. Fix: on a double-click that hits nothing, test the point against each text layer's client rects (about 10 lines), or keep a measured text box per shape for `hitTestTopmost`.

- **Vector and Slides PDF: centered text taller than its shape spills down only, and wraps wider** (S–M): On the canvas and the web page download it spills evenly. WeasyPrint does not center an overflowing flex item and lets the text column grow to its widest word (`richTextCssText` in `packages/lib/src/vector/kinds`). Fix with a print-only centering rule and a pixel gate on text boxes and shapes.

## After 1.0

Build only when a trigger appears.

- **Vector drawing app: embedding (phases 5–6)** (M): Not started: no `drawings/` sub-resource, and elements have no group field (`packages/lib/src/vector/types.ts`). Drawings embedded in docs and sheets as nested `drawings/` sub-resources; grouping deferred to a round unified with slides' object model, alongside last-used style memory. Ruled out: minimap, shape library, PNG export.

- **SVG-native rich text on the server** (M): A downloaded image writes rich text as `<text>`/`<tspan>` from the browser's layout (`packages/lib/src/vector/rich-text-svg.ts`). A box with no browser measurement still draws its HTML in a `foreignObject` (`scene-to-svg.ts`), which only a browser renders. Build only if a server-side consumer needs SVG text without a browser: it means re-implementing line breaking and a second typography source beside `richTextCssText`.

- **Last-used style memory (canvas apps)** (S–M): Not started. No Eigen app remembers last-used styles; Excalidraw does. If built: one shared store for vector and slides (and stickies where sensible). Decide when canvas usage feedback exists.

- **pptx reader: thirteen module caches beside the work budget** (S–M): About thirteen `cachedBy`/`WeakMap` caches in `apps/api/src/lib/import/slides/` (`paint.ts`, `shapes.ts`, `guides.ts`, `lookup.ts`) keep a hostile master linear, but form a second layer to hold in mind. Per-read `Map`s on the `DeckWalk` would read more plainly. Add none without asking whether the work budget alone suffices; fold them in with the one-budget row in P2.
