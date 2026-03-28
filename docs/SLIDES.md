# Slides App

> **TLDR**: Collaborative presentations using Yjs. `.eigenslides` Drive folders. Pixel-based coordinates (0-1920 x
> 0-1080), converted to percentages for rendering via `pxToPercent()`. 16:9 aspect ratio. Yjs data: `slideOrder` (
> Y.Array), `slides` (Y.Map), `objects` (Y.Map). Object types: text, image.

## Yjs Data Model

```
Y.Array<string>  "slideOrder"  → ordered slide IDs
Y.Map            "slides"      → slideId → Y.Map { id, backgroundColor, backgroundMediaName, objectIds: Y.Array<string> }
Y.Map            "objects"     → objectId → Y.Map { id, slideId, type, x, y, w, h, rotation, ... }
```

**Coordinates**: Stored as absolute pixels (0-1920 for x/w, 0-1080 for y/h). Converted to percentages for rendering via
`pxToPercent(val, axis)` in `types.ts`. This makes layout resolution-independent. `percentToPx(val, axis)` converts
back.

**Dimensions**: Font sizes, border widths, border radii, and letter spacing use CSS container query units (`cqh`/`cqw`)
relative to the slide container (which has `container-type: size`). This ensures all dimensions scale with the slide
container rather than the browser viewport. The helpers `pxToPercentHeight(val)` and `pxToPercentWidth(val)` in
`slide-object.tsx` convert from the 1920x1080 coordinate space to `cqh`/`cqw` units.

### Object Types

**Text**: `text`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `textDecoration`, `textAlign`, `verticalAlign`,
`color`, `letterSpacing`, `lineHeight`, `highlightColor`, `backgroundColor`
**Image**: `mediaName` (file name, resolved at render time), `objectFit`
**Common (BaseObject)**: `x`, `y`, `w`, `h`, `rotation`, `borderColor`, `borderWidth`, `borderRadius`

### Slide Properties

**SlideItem**: `id`, `objectIds`, `backgroundColor`, `backgroundMediaName`

Background color and image can be applied to a single slide, all following slides, or all slides via the
`SlideBackgroundPanel` in the properties panel.

### Shared Rendering

`slide-object.tsx` exports shared helpers used by the editor canvas, presentation mode, and thumbnails:

- `getObjectPositionStyle(obj)` — position, size, rotation, border, background
- `getTextStyle(obj)` — font size, weight, style, color, spacing
- `getVerticalAlignStyle(verticalAlign)` — flexbox alignment for text vertical positioning
- `ReadOnlySlideObject` — read-only object renderer (used in presentation mode)

## File Structure

```
apps/slides/src/components/slides/
├── types.ts                      # SlideItem, SlideObject, DeckData, pxToPercent, percentToPx, defaults
├── normalize-deck.ts             # Yjs normalization (dedup objects, set default fontFamily)
├── editor.tsx                    # Main editor + presentation mode + clipboard
├── toolbar.tsx                   # File menu, undo/redo, insert, present
├── slide-panel.tsx               # Left panel (draggable thumbnails)
├── slide-canvas.tsx              # Main editing area (scaled 16:9)
├── slide-object.tsx              # Object rendering + shared style helpers
├── slide-thumbnail.tsx           # Thumbnail preview
├── slide-properties-panel.tsx    # Right panel (transform, text, image, border, slide background)
├── hooks/
│   ├── use-deck.ts               # Yjs document management
│   ├── use-slide-dnd.ts          # Slide reorder (dnd-kit)
│   ├── use-object-drag.ts        # Canvas drag/resize
│   ├── use-snap-lines.ts         # Alignment snapping
│   └── use-marquee-select.ts     # Drag-to-select multiple objects
```

Shared: `packages/ui/src/components/layout/media/image-resize-handles.tsx` (used by docs + slides)
