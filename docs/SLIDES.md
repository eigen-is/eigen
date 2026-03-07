# Slides App — Implementation Plan

## Overview

A collaborative presentation app (like Keynote/Google Slides) using Yjs for real-time sync.
Same backend infrastructure as docs and stickies — collab WebSocket, drive-based storage (`.eigenslides`).

## Layout

- **Left panel**: Slide thumbnails (vertical, draggable to reorder via dnd-kit)
- **Main area**: Active slide canvas (16:9 aspect ratio, scaled to fit viewport)
- **Toolbar**: File menu, undo/redo, insert text/image, share, present button

## Yjs Data Model

Similar pattern to stickies (maps + arrays for ordering + normalization).

```
Y.Array<string>  "slideOrder"     → ordered slide IDs
Y.Map             "slides"         → slideId → Y.Map { id, objectIds: Y.Array<string> }
Y.Map             "objects"        → objectId → Y.Map { id, slideId, type, x, y, w, h, rotation, ...typeSpecific }
```

### Object coordinates — percentage-based

All positions/sizes stored as **percentages of slide dimensions** (0–100).
This makes layout resolution-independent for fullscreen/mobile/export.

- `x`, `y`: top-left corner as % of slide width/height
- `w`, `h`: size as % of slide width/height  
- `rotation`: degrees (0–360)

Reference slide aspect ratio: **16:9** (1920×1080 logical).

### Object type-specific fields

**Text object:**
- `text`: string content
- `fontSize`: number (pt, relative to 1080px height)
- `fontWeight`: 'normal' | 'bold'
- `fontStyle`: 'normal' | 'italic'
- `textAlign`: 'left' | 'center' | 'right'
- `color`: hex string

**Image object:**
- `src`: drive embed URL
- `objectFit`: 'contain' | 'cover' | 'fill'

### Normalization

Same pattern as stickies `normalize-board.ts`:
- Ensure each object belongs to exactly one slide
- Orphaned objects → first slide
- Remove objects referencing deleted slides

## File Structure

```
apps/slides/src/components/slides/
  types.ts                    — SlideItem, SlideObject, TextObject, ImageObject, DeckData
  normalize-deck.ts           — Yjs normalization
  editor.tsx                  — Main editor (connects Yjs, renders layout)
  toolbar.tsx                 — File menu, undo/redo, insert controls, present
  sidebar.tsx                 — App sidebar (already exists, move+clean)
  slide-panel.tsx             — Left panel with draggable slide thumbnails
  slide-canvas.tsx            — The main slide editing area (scaled 16:9)
  slide-object.tsx            — Renders a single object (text or image) with selection/resize
  slide-thumbnail.tsx         — Thumbnail preview of a slide for the left panel
  add-text-dialog.tsx         — Dialog to add/edit text object
  add-image-dialog.tsx        — Dialog to add image object
  object-settings-dialog.tsx  — Edit object properties (position, size, color, etc.)
  hooks/
    use-deck.ts               — Yjs document management (like stickies use-board.ts)
    use-slide-dnd.ts          — dnd-kit for slide reorder + object reorder
    use-object-drag.ts        — Drag/resize objects on the canvas
```

### Shared component — packages/ui

```
packages/ui/src/components/layout/media/
  resizable-image.tsx         — Shared image resize handles + alignment
  image-resize-handles.tsx    — Reusable resize handle overlay (used by docs + slides)
```

Extract the resize logic from `apps/docs/src/components/docs/extensions/resizable-image.tsx`
into a shared `ImageResizeHandles` component. Docs tiptap extension imports from there.

## Implementation Phases

### Phase 1 — Core types & Yjs hook
1. Create `types.ts` with all type definitions
2. Create `normalize-deck.ts`
3. Create `hooks/use-deck.ts` (Yjs connection, CRUD for slides & objects)
4. Create `hooks/use-slide-dnd.ts` (slide reorder with dnd-kit)

### Phase 2 — Shared image component
5. Create `packages/ui/src/components/layout/media/image-resize-handles.tsx`
6. Refactor `apps/docs` resizable-image to use shared component

### Phase 3 — UI components
7. Create `slide-thumbnail.tsx` (miniature slide preview)
8. Create `slide-panel.tsx` (left sidebar with thumbnails, draggable)
9. Create `slide-canvas.tsx` (main editing area, 16:9 scaled)
10. Create `slide-object.tsx` (render + select + resize objects on canvas)
11. Create `use-object-drag.ts` (mouse-based drag/resize on canvas)

### Phase 4 — Dialogs & toolbar
12. Create `add-text-dialog.tsx`
13. Create `add-image-dialog.tsx` (with file upload)
14. Create `object-settings-dialog.tsx` (edit properties)
15. Create `toolbar.tsx` (file menu, undo/redo, insert, present)

### Phase 5 — Editor & route
16. Create `editor.tsx` (compose everything)
17. Update route `_auth.slide.$ownerId.$mountId.$pathId.tsx`
18. Move sidebar to `components/slides/sidebar.tsx`
19. Update `__root.tsx` import

### Phase 6 — Verify
20. `bun run typecheck`
21. `bun run test`

## Key Design Decisions

- **Percentage coordinates**: All object positions are 0–100% of slide area.
  Rendering multiplies by the current canvas pixel size. Fullscreen just changes the multiplier.
- **No embedded rich text editor**: Text objects use simple string + style props (phase 1).
  Tiptap per-object can come later.
- **Object selection**: Click to select, drag to move, corner handles to resize.
  Selected object shows settings in a popover or dialog.
- **Slide aspect ratio**: Fixed 16:9. Canvas scales to fit available space.
- **Thumbnails**: Rendered with CSS `transform: scale()` on a mini version of the canvas.
