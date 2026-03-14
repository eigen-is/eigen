# Slides App

> **TLDR**: Collaborative presentations using Yjs. `.eigenslides` Drive folders. Percentage-based coordinates (0-100% of
> slide dimensions). 16:9 aspect ratio. Yjs data: `slideOrder` (Y.Array), `slides` (Y.Map), `objects` (Y.Map). Object
> types: text, image.

## Yjs Data Model

```
Y.Array<string>  "slideOrder"  → ordered slide IDs
Y.Map            "slides"      → slideId → Y.Map { id, objectIds: Y.Array<string> }
Y.Map            "objects"     → objectId → Y.Map { id, slideId, type, x, y, w, h, rotation, ... }
```

**Coordinates**: All positions/sizes as percentages (0-100) of slide dimensions. Resolution-independent.

### Object Types

**Text**: `text`, `fontSize`, `fontWeight`, `fontStyle`, `textAlign`, `color`
**Image**: `src` (drive embed URL), `objectFit`

## File Structure

```
apps/slides/src/components/slides/
├── types.ts              # SlideItem, SlideObject, DeckData
├── normalize-deck.ts     # Yjs normalization
├── editor.tsx            # Main editor
├── toolbar.tsx           # File menu, undo/redo, insert, present
├── slide-panel.tsx       # Left panel (draggable thumbnails)
├── slide-canvas.tsx      # Main editing area (scaled 16:9)
├── slide-object.tsx      # Render/select/resize objects
├── slide-thumbnail.tsx   # Thumbnail preview
├── hooks/
│   ├── use-deck.ts       # Yjs document management
│   ├── use-slide-dnd.ts  # Slide reorder (dnd-kit)
│   └── use-object-drag.ts # Canvas drag/resize
```

Shared: `packages/ui/src/components/layout/media/image-resize-handles.tsx` (used by docs + slides)
