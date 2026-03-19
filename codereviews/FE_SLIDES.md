# FE Code Review: Slides

## Summary

The Slides frontend is a collaborative presentation editor built with React, Yjs, and dnd-kit. It implements a
pixel-based coordinate system (1920x1080) rendered as percentages, with container query units for scalable typography.
The code is well-structured with clear separation between the editor canvas, slide panel, properties panel, and
toolbar. Key concerns are around missing error feedback for user-facing mutations, several `as any` casts, hardcoded
colors, and an un-awaited async call in the clipboard paste handler.

**Files reviewed:**

- `/apps/slides/src/components/slides/` (all files)
- `/apps/slides/src/routes/` (all files)
- `/apps/slides/src/components/slides-sidebar.tsx`
- `/apps/slides/src/main.tsx`
- `/packages/lib/src/core/collab/hooks/use-collab.ts`

## Critical Issues

### 1. Missing `await` on `reUploadImage` in paste handler -- error silently lost

**File:** `/apps/slides/src/components/slides/editor.tsx`, lines 231-239

```typescript
reUploadImage(
    item.sourcePathId, item.sourceOwnerId, item.sourceMountId,
    mediaFolderId, uploadFile.mutateAsync, ownerId, path.mountId, item.mediaName,
).then((result) => {
    addObject(activeSlideId, { ... });
});
```

`reUploadImage` is an async function called with `.then()` but no `.catch()`. If the re-upload fails, the error is
silently swallowed. Per CLAUDE.md: "Always `await` async calls -- missing `await` is the #1 bug class."

Additionally, `activeSlideId` is captured from the outer closure. By the time the `.then()` resolves, the user may have
navigated to a different slide, causing the object to be added to the wrong slide.

**Impact:** Silent failure on cross-document image paste; potential object placement on wrong slide.

**Fix:** Use `await` inside an async handler with try/catch:

```typescript
try {
    const result = await reUploadImage(...);
    addObject(activeSlideId, { ...imageProps, mediaName: result?.mediaName ?? item.mediaName });
} catch (e) {
    toast.error('Failed to paste image');
}
```

### 2. No error feedback on any user-facing mutation

**Files:**

- `/apps/slides/src/components/slides/editor.tsx`, lines 161-172 (image upload)
- `/apps/slides/src/components/slides/editor.tsx`, lines 322-331 (background image upload)
- `/apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`

Per CLAUDE.md: "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`." The
image upload handlers catch errors but only `console.error()` them:

```typescript
} catch (e) {
    console.error('Image upload failed:', e);
}
```

There are zero `toast.error()` or `toast.success()` calls anywhere in the slides frontend. Users get no visual
feedback when uploads fail or succeed.

**Impact:** Users have no way to know if their image upload failed.

**Fix:** Add `toast.error()` in all catch blocks. Consider `toast.success()` for successful uploads.

### 3. `as any` cast bypasses type safety

**File:** `/apps/slides/src/components/slides/editor.tsx`, line 190

```typescript
? (deck.objects[selectedObjectIds[0]] as any).text as string
```

This casts through `any` to access `text` on a `SlideObject` union type. The proper fix is a type guard.

**File:** `/apps/slides/src/components/slides/slide-canvas.tsx`, line 63

```typescript
startDrag(e, objId, mode as any, x, y, w, h);
```

The `mode` parameter from `handleResizeStart` is typed as `string` but `startDrag` expects `DragMode`. This should use
the proper type instead of casting.

Per CLAUDE.md: "Never use `as any` -- fix the type at the source."

**Impact:** Type safety bypassed; refactoring will not catch type mismatches.

**Fix:** For editor.tsx line 190:

```typescript
const obj = deck.objects[selectedObjectIds[0]];
const textPreview = obj?.type === 'text' ? obj.text : undefined;
```

For slide-canvas.tsx line 63, type the `mode` parameter as `DragMode`:

```typescript
const handleResizeStart = useCallback((e: React.MouseEvent, objId: string, mode: DragMode, ...) => {
```

## Pattern Violations

### 4. `interface` used instead of `type`

**File:** `/apps/slides/src/components/slides-sidebar.tsx`, line 12

```typescript
interface SlidesSidebarProps {
```

**File:** `/apps/slides/src/routes/__root.tsx`, line 14

```typescript
interface MyRouterContext {
```

Per CLAUDE.md: "`type` over `interface` -- except when methods are needed." These are pure data shapes.

### 5. Hardcoded colors throughout

**Files:**

- `/apps/slides/src/components/slides/slide-object.tsx`, line 164: `ring-blue-500`
- `/apps/slides/src/components/slides/slide-object.tsx`, line 219: `bg-white border-2 border-blue-500`
- `/apps/slides/src/components/slides/slide-panel.tsx`, line 88: `border-blue-500`
- `/apps/slides/src/components/slides/slide-thumbnail.tsx`, line 39: `border-blue-500`
- `/apps/slides/src/components/slides/slide-canvas.tsx`, lines 140-141: `backgroundColor: '#3b82f6'`

Per CLAUDE.md: "Use theme tokens, not hardcoded colors." These `blue-500` / `#3b82f6` values are used for selection
indicators and snap lines. While selection UI is often blue by convention, these should use `ring-primary`,
`border-primary`, etc. to respect theme settings and dark mode.

**Fix:** Replace `blue-500` with `primary` (or a dedicated selection token).

### 6. `OBJECT_FIELDS` contains dead fields not in types

**File:** `/apps/slides/src/components/slides/hooks/use-deck.ts`, line 11

```typescript
const OBJECT_FIELDS = ['...', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', '...'];
```

The `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` fields are listed in `OBJECT_FIELDS` but do not
exist in the `BaseObject` type definition in `types.ts`. No code reads or writes these fields. They appear to be
remnants of a removed shadow feature.

**Impact:** Dead code; confusing for contributors; Yjs documents may contain orphaned shadow data.

**Fix:** Remove the four shadow fields from `OBJECT_FIELDS`.

## Security Concerns

### 7. Background image URL injected into inline style without sanitization

**File:** `/apps/slides/src/components/slides/slide-canvas.tsx`, line 103

```typescript
backgroundImage: `url(${bgUrl})`
```

Also in `editor.tsx` line 407 and `slide-thumbnail.tsx` line 47.

The `bgUrl` comes from `resolveMediaUrl()` which constructs a server-relative URL from the Drive API. While the URL is
constructed server-side and not directly from user input, if `mediaName` were ever manipulated to contain special
characters, it could break the CSS or cause unexpected behavior.

**Impact:** Low risk given current URL construction, but defense-in-depth suggests encoding.

**Fix:** Consider CSS-escaping the URL or using an `<img>` element for background images.

### 8. Presentation mode uses `cursor-none` but right-click is overridden

**File:** `/apps/slides/src/components/slides/editor.tsx`, lines 391-397

```typescript
onContextMenu={(e) => {
    e.preventDefault();
    const currentIdx = deck.slideOrder.indexOf(activeSlideId!);
    if (currentIdx > 0) {
        setActiveSlideId(deck.slideOrder[currentIdx - 1]);
    }
}}
```

Overriding `onContextMenu` to navigate backwards is a non-standard UX pattern that prevents users from accessing the
native context menu during presentations (e.g., to exit fullscreen if Escape is not available). This is a minor
usability concern, not a security issue.

## Data Integrity

### 9. `normalizeDeck` called on every Yjs state change

**File:** `/apps/slides/src/components/slides/hooks/use-deck.ts`, line 83

```typescript
const updateReactState = () => {
    normalizeDeck(doc);
    // ... build state
};
```

`normalizeDeck()` modifies the Yjs document (deleting duplicate object references, re-parenting orphans). Calling it
inside the observer callback means:

1. It mutates the Yjs document during an observation, which triggers another observation
2. It runs on every remote update, not just local edits
3. It could cause infinite loops if normalization keeps triggering changes

**Impact:** Potential performance issue with unnecessary Yjs mutations; risk of observer re-entrancy.

**Fix:** Only run normalization on sync (when the document is first loaded from the server) rather than on every update.
Guard against re-entrancy with a flag.

### 10. Slide order reorder deletes and re-inserts entire array

**File:** `/apps/slides/src/components/slides/hooks/use-slide-dnd.ts`, lines 38-42

```typescript
slideOrderArray.delete(0, slideOrderArray.length);
const newOrder = [...currentOrder];
newOrder.splice(oldIndex, 1);
newOrder.splice(newIndex, 0, activeId);
slideOrderArray.insert(0, newOrder);
```

This replaces the entire `slideOrder` Y.Array by deleting all items and re-inserting. In a collaborative setting, this
is destructive -- if another user adds a slide concurrently, the delete-and-reinsert will lose their slide.

**Impact:** Concurrent slide additions lost during reorder.

**Fix:** Use targeted `delete` and `insert` operations:

```typescript
slideOrderArray.delete(oldIndex, 1);
slideOrderArray.insert(newIndex, [activeId]);
```

### 11. `jsonToYType` creates nested Y types for revision restore

**File:** `/apps/slides/src/components/slides/editor.tsx`, lines 62-76

The `handleRestore` callback (lines 340-364) clears the current document and re-populates it from a snapshot. It uses
`jsonToYType` to convert plain objects back to Y.Map/Y.Array. However, the restoration replaces Map contents
key-by-key and Array contents by clearing and re-inserting. In a collaborative session, this could conflict with
concurrent edits from other users.

**Impact:** Restoration during active collaboration could cause data loss for other participants.

**Fix:** This is inherent to the "restore from snapshot" feature. Consider warning the user that restoration affects
all collaborators, or performing it atomically.

## Code Quality

### 12. `MergedNumberInput` sets state during render

**File:** `/apps/slides/src/components/slides/slide-properties-panel.tsx`, lines 543-546

```typescript
const externalStr = mixed ? '' : String(value ?? '');
if (!focused && localValue !== externalStr) {
    setLocalValue(externalStr);
}
```

Calling `setLocalValue()` during the render phase (outside an effect or event handler) is an anti-pattern in React 19.
While React handles this with a synchronous re-render, it can cause unexpected double-renders and is flagged by strict
mode.

**Impact:** Potential double-renders; React strict mode warnings.

**Fix:** Move the sync logic into a `useEffect`:

```typescript
useEffect(() => {
    if (!focused) setLocalValue(externalStr);
}, [focused, externalStr]);
```

### 13. Large `useEffect` dependency array for clipboard handlers

**File:** `/apps/slides/src/components/slides/editor.tsx`, line 266

The clipboard `useEffect` has 11 dependencies:

```typescript
}, [selectedObjectIds, deck.objects, activeSlideId, canWrite, addObject, handleImageFile,
    resolveMediaPath, mediaFolderId, uploadFile.mutateAsync, ownerId, path.mountId]);
```

This means the clipboard handlers are re-registered on almost every state change. While `useCallback` memoization helps
for stable references, `selectedObjectIds` and `deck.objects` change frequently.

**Impact:** Frequent event listener churn; potential for stale closures if dependencies are missed.

**Fix:** Consider using `useRef` for rapidly-changing values (like `selectedObjectIds` and `deck.objects`) to avoid
re-registering listeners.

### 14. `useDeck` returns stale refs for `yjsDoc` and `undoManager`

**File:** `/apps/slides/src/components/slides/hooks/use-deck.ts`, lines 452-453

```typescript
yjsDoc: docRef.current,
undoManager: undoManager.current,
```

These return the `.current` value at render time. Since the Yjs doc and undo manager are created in a `useEffect`, on
the first render they will be `null`. Components that depend on these values must handle the `null` case, which they
do -- but it means the first render always shows no data.

**Impact:** Minor; works correctly but is a subtle timing issue.

### 15. Duplicate `deleteObject` / `deleteObjects` logic

**File:** `/apps/slides/src/components/slides/hooks/use-deck.ts`, lines 386-432

`deleteObject` (single) and `deleteObjects` (batch) contain near-identical Yjs transaction logic. `deleteObject` could
simply delegate to `deleteObjects([objId])`.

**Impact:** Code duplication; maintenance burden.

**Fix:** `const deleteObject = useCallback((objId: string) => deleteObjects([objId]), [deleteObjects]);`

### 16. `SlidesSidebar` uses `interface` and has unused props pattern

**File:** `/apps/slides/src/components/slides-sidebar.tsx`

The `onSave` callback passed to `DriveCreateSlides` (line 87) is an empty function `() => {}`. This suggests the prop
may be optional or the component doesn't need it.

### 17. Unused `formatForDisplay` import

**File:** `/apps/slides/src/components/slides/toolbar.tsx`, line 2

`formatForDisplay` is imported from `@tanstack/react-hotkeys` and used in tooltip text. This is actually used (lines
125, 131), so this is not dead code -- but the usage embeds hotkey display formatting inline rather than using
constants.

## Architecture

### 18. Percentage coordinate system is well-designed

The 1920x1080 pixel coordinate space stored in Yjs, converted to percentages via `pxToPercent()` for layout and
container query units (`cqh`/`cqw`) for typography, is a clean approach. It makes the presentation
resolution-independent while keeping coordinates in human-readable pixel values for editing.

### 19. No slides-specific hooks in `packages/lib`

The slides app has no hooks in `packages/lib/src/core/slides/`. All data management is done via the shared
`useCollabDocumentInfo` hook and local Yjs state in `useDeck`. This is appropriate since Yjs manages its own state
outside TanStack Query. However, any future server-side slides features (templates, export, etc.) will need a
`packages/lib/src/core/slides/` directory.

### 20. Presentation mode is minimal

Presentation mode (editor.tsx lines 377-419) is a fullscreen overlay with click-to-advance and right-click-to-go-back.
There is no keyboard navigation (arrow keys), no slide transition animations, and no speaker notes. For an MVP this is
fine, but worth noting for future work.

### 21. No mobile support for editor

The editor uses `ColumnLayout` with a single column `mobileColumn="editor"`. However, the canvas interactions (drag,
resize, snap lines) are mouse-only with no touch event handling. The properties panel and slide panel are hidden on
mobile since there's only one column. The sidebar routes use `DriveLayout` which does handle mobile.

## Positive Patterns

- **Clean type definitions:** `types.ts` provides clear, well-typed structures for `SlideObject`, `SlideItem`, and
  `DeckData`. The discriminated union (`TextObject | ImageObject`) enables safe narrowing
- **Shared rendering helpers:** `getObjectPositionStyle()`, `getTextStyle()`, and `ReadOnlySlideObject` are reused
  across editor, presentation mode, and thumbnails -- single source of truth for rendering
- **Proper Yjs transaction usage:** All mutations in `useDeck` are wrapped in `doc.transact()`, ensuring atomic
  updates and proper undo/redo integration
- **Snap lines implementation:** The alignment snapping system (`use-snap-lines.ts`) is well-factored with clean
  separation between target computation and snap application
- **Memo usage:** `SlideObjectView` and `SlideThumbnail` are properly wrapped in `memo()` to prevent unnecessary
  re-renders
- **Read-only support:** The `canWrite` prop is consistently threaded through all components, properly disabling editing
  interactions for read-only users
- **Clipboard integration:** Full clipboard support (copy, paste, cross-document image re-upload) using the shared
  `@workspace/lib/clipboard` system
- **Theme-compliant status bar:** The bottom status bar uses `bg-muted`, `border-t`, `text-muted-foreground` correctly

## Recommendations

| Priority | Issue | Description                                                                      |
|----------|-------|----------------------------------------------------------------------------------|
| **P0**   | #1    | Add `await` and error handling for `reUploadImage` in paste handler              |
| **P0**   | #2    | Add `toast.error()` feedback for all user-facing mutations (uploads, paste)      |
| **P0**   | #10   | Fix slide reorder to use targeted Yjs operations instead of delete-all/re-insert |
| **P1**   | #3    | Remove `as any` casts; use type guards and proper type parameters                |
| **P1**   | #5    | Replace hardcoded `blue-500` / `#3b82f6` with theme tokens                       |
| **P1**   | #9    | Move `normalizeDeck` out of the observer callback; run only on initial sync      |
| **P1**   | #6    | Remove dead shadow fields from `OBJECT_FIELDS`                                   |
| **P2**   | #4    | Replace `interface` with `type` per project convention                           |
| **P2**   | #12   | Fix render-time state update in `MergedNumberInput`                              |
| **P2**   | #13   | Use refs for frequently-changing clipboard handler dependencies                  |
| **P2**   | #15   | Deduplicate `deleteObject` / `deleteObjects`                                     |
| **P2**   | #20   | Add keyboard navigation to presentation mode (arrow keys)                        |
