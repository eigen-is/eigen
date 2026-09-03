# Slides App

> **TLDR**: Collaborative presentations using Yjs. `.eigenslides` Drive folders, 16:9. Pixel coordinate
> space (0-1920 × 0-1080), rendered as percentages via `pxToPercent()`. Yjs data: `slideOrder` (Y.Array),
> `slides` (Y.Map), `objects` (Y.Map). Object types: text, image. The canonical types live in
> `packages/lib/src/slides/`, shared by the app and the API.

## Yjs Data Model

```
Y.Array<string>  "slideOrder"  → ordered slide IDs
Y.Map            "slides"      → slideId → Y.Map { id, objectIds: Y.Array<string>, background }
Y.Map            "objects"     → objectId → Y.Map { id, slideId, type, x, y, width, height, angle, ... }
```

**Where the types live**: `SlideItem`, `SlideObject`, `DeckData`, `pxToPercent`, `SLIDE_ASPECT_RATIO`,
`SLIDE_BASE_WIDTH`/`SLIDE_BASE_HEIGHT` and `BORDER_RADIUS_ROUND` are all in `packages/lib/src/slides/`, so
the editor, the exporters and the preview renderer agree on one shape. The app's
`apps/slides/src/components/slides/types.ts` only re-exports them and adds its own `DEFAULT_TEXT_OBJECT` /
`DEFAULT_IMAGE_OBJECT` literals plus the `ApplyTo` union.

**Coordinates**: stored as absolute pixels (0-1920 for x/w, 0-1080 for y/h) and converted to percentages at
render time with `pxToPercent(val, axis)`. That keeps layout resolution-independent. There is no inverse
helper — pointer math scales against the measured canvas size instead.

**Dimensions**: font sizes, border widths, border radii and letter spacing use CSS container query units
(`cqh`/`cqw`) relative to the slide container (which has `container-type: size`). So every dimension scales
with the slide container rather than the browser viewport. `slide-object.tsx` converts from the 1920×1080
coordinate space into those units.

### Object Types

**Text**: `text` (TipTap HTML — edited via the shared `LightEditor`; use `htmlToPlainText` from
`@workspace/lib/html` for plain-text previews like comment anchors and OS-clipboard text), `fontFamily`,
`fontSize`, `fontWeight`, `fontStyle`, `textDecoration`, `textAlign`, `verticalAlign`, `color`,
`letterSpacing`, `lineHeight`, `highlightColor`, `background`
**Image**: `mediaName` (file name, resolved at render time), `objectFit`
**Common (BaseObject)**: `x`, `y`, `width`, `height`, `angle`, `borderColor`, `borderWidth`, `borderRadius`,
`commentCardIds` (plain string array — Y.Map card IDs linking to entries in the `comments` Y.Map)

### Slide Properties

**SlideItem**: `id`, `objectIds`, `background`

## Backgrounds

Slides and text objects both carry `background: BackgroundFill | null`. The fill type is shared across the
suite (`packages/lib/src/types/background.ts`):

```ts
type BackgroundFill =
    | { type: 'solid'; color: string }
    | { type: 'gradient'; from: string; to: string; angle: number }
    | { type: 'image'; mediaName: string; fit: 'cover' | 'contain' };
```

`getBackgroundStyle(fill, resolveMediaUrl?)` from `@workspace/lib/background` turns a fill into CSS:
gradients render as `linear-gradient(<angle>deg, from, to)` (sRGB interpolation), images as a `background-image` sized
`cover` or `contain`. `isSameFill` backs the "mixed" state when a multi-selection disagrees.

Editing UI is the shared `BackgroundFillBlock`
(`packages/ui/src/components/properties-panel/background-fill-block.tsx`): none / solid / gradient /
image segments, with a 3×3 arrow grid for the gradient angle. Slide backgrounds allow all three fill types;
text objects allow solid and gradient only. `SlideBackgroundPanel` adds the apply scope — this slide, this
and following, or all slides.

## Shared Rendering

`slide-object.tsx` exports shared helpers used by the editor canvas, presentation mode, and thumbnails:

- `getObjectPositionStyle(obj)` — position, size, rotation, border, background
- `getTextStyle(obj)` — font size, weight, style, color, spacing
- `getVerticalAlignStyle(verticalAlign)` — flexbox alignment for text vertical positioning
- `ReadOnlySlideObject` — read-only object renderer (used in presentation mode)

Selection chrome (ring + resize handles + rotate handle) is the shared `ObjectTransform` (`packages/ui/src/components/transform/object-transform.tsx`), mounted by `slide-canvas.tsx` for a single selection as a canvas-level overlay above all objects, so it never clips on rounded objects. The rotate handle drags to rotate around the object's center, Shift snaps to 15°, and a live degree readout shows during the drag; resizing a rotated object is rotation-aware (the opposite corner stays pinned). A multi-selection shows a dashed union ring that drags as a group and has no resize or rotate handles. Alt/Opt-drag an object (or a multi-selection) drops a duplicate and leaves the original in place.

## Comments & Mobile

Comments anchor to objects via `commentCardIds`. The comments and activity panes are the shared
`PanelColumn`, opened through `useDocumentPanels(isMobile)` — see [COMMENTS.md](COMMENTS.md) for the card
model and [LAYOUT.md](LAYOUT.md) for the column chrome.

On mobile, slides is **view-only**: `editor.tsx` renders the slide panel full width (thumbnails as a
scrollable list) and skips the canvas and the properties panel entirely. Present mode still works. The
panel column takes over the screen when a pane is open, the same as the other document apps.

## File Structure

`apps/slides/src/components/slides/` holds the editor. The pieces worth naming:

- `editor.tsx` — main editor, presentation mode, clipboard, panel wiring
- `slide-canvas.tsx` + `slide-object.tsx` — editing surface and object rendering
- `slide-panel.tsx` / `slide-properties-panel.tsx` — left thumbnails, right properties + slide background
- `toolbar.tsx`, `slide-thumbnail.tsx`, `slide-object-menu.tsx`, `search-deck.ts` — toolbar, the scaled live-DOM thumbnail, the object context menu, the ⌘F match collector
- `normalize-deck.ts` — Yjs normalization (dedup objects, default fontFamily)
- `hooks/` — `use-deck.ts` (Yjs document + comment links), `use-object-drag.ts` (move, group move and alt-drag duplicate; resize and rotate live in `ObjectTransform`), `use-snap-lines.ts`, `use-marquee-select.ts`, `use-slide-dnd.ts`, `use-active-comments.ts`, `use-slides-presence.ts` (awareness: cursor, selection, active slide), `use-slides-doc-search.ts` (the ⌘F controller over `search-deck.ts`)

Shared: `packages/ui/src/components/transform/object-transform.tsx` (the selection/resize/rotate chrome, used by docs + slides).

## Export & Preview

HTML and PDF export available from the File menu in the slides editor and from the Drive context menu.

- **HTML**: Standalone document with embedded fonts and base64 images. Uses CSS container queries for
  responsive font sizing. Slides displayed as cards with spacing; print mode uses page breaks.
- **PDF**: 16:9 landscape pages (254mm × 142.875mm) via WeasyPrint. Fixed pixel font sizes computed for
  the page dimensions (WeasyPrint doesn't support container queries).

**Quick preview** in Drive's file preview overlay renders the first 8 slides scrollable with spacing between
them (a "Preview truncated" marker is appended when the deck has more). Server-side rendering reuses the same
`renderSlideHtml` function as export, with embed URLs instead of base64 data URIs for images.

### Files

| File | Purpose |
|------|---------|
| `apps/api/src/lib/document/slides.ts` | Yjs → DeckData + media map (shared with export + preview) |
| `apps/api/src/lib/export/slides/render.ts` | Slide/object → HTML (SizeUnit abstraction) |
| `apps/api/src/lib/export/slides/transform.ts` | Worker-side: deck + media → standalone HTML (screen or PDF mode) |
| `apps/api/src/lib/export/export-document.ts` | Main thread: HTML and PDF download envelopes |
| `apps/api/src/lib/preview/eigenslides-render.ts` | Quick preview HTML body (Worker-side) |
