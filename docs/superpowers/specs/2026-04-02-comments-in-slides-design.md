# Comments in Slides

Add comment support to the slides editor, mirroring the existing docs comment system for consistency across apps.

## Anchoring Model

In docs, comments anchor to text ranges via Tiptap marks. Slides use a canvas with positioned objects (no Tiptap), so comments anchor to **slide objects** instead.

Each `SlideObject` gains an optional `commentChatNames: string[]` array stored in the Yjs map. This means:

- Comments travel with the object when moved/resized.
- Deleting an object removes its comments from the active set (chat/DB rows persist, same as docs).
- Multiple comments per object are supported.
- `useActiveComments()` scans all objects for chatNames, mirroring how docs scan ProseMirror marks.

## Changes

### 1. Route: extract chatFolderId

**File:** `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`

Extract `chatFolderId` from `docInfo.folderContents` (same pattern as docs route and the existing `mediaFolderId` extraction):

```ts
const chatFolderId = docInfo?.folderContents?.find((f) => f.name === 'chat')?.id ?? null;
```

Pass `chatFolderId` to `SlideEditor` and through to `MediaResolverProvider`.

### 2. Data model: add commentChatNames to BaseObject

**File:** `apps/slides/src/components/slides/types.ts`

No type change needed for Yjs (it's a dynamic map), but for the TypeScript type used in React state, the `BaseObject` gains:

```ts
commentChatNames?: string[];
```

This is optional so existing slides without comments remain valid. The `useDeck` hook already reads arbitrary keys from Yjs object maps, so reading `commentChatNames` requires only adding it to the type and the deck-to-state conversion.

### 3. useDeck: read/write commentChatNames

**File:** `apps/slides/src/components/slides/hooks/use-deck.ts`

- When converting Yjs object maps to `SlideObject` state, include `commentChatNames` (default to `[]` if absent).
- Add `addCommentToObject(objectId, chatName)` — pushes chatName to the object's `commentChatNames` Y.Array.
- Add `removeCommentFromObject(objectId, chatName)` — removes chatName from the Y.Array.

### 4. useActiveComments hook

**New file:** `apps/slides/src/components/slides/hooks/use-active-comments.ts`

Scans all objects across all slides in `deck.objects` and collects:

- `ids: Set<string>` — all chatNames found on any object.
- `anchorTexts: Map<string, string>` — for text objects: first 100 chars of `obj.text`; for image objects: `"Image"`.

Returns `{ ids, anchorTexts }`. Mirrors `useActiveComments` in docs editor. No debounce needed since deck state is already React state (not ProseMirror doc traversal).

### 5. Toolbar: comment toggle button

**File:** `apps/slides/src/components/slides/toolbar.tsx`

Add a `MessageSquare` icon button in the right section (next to Share), matching docs toolbar layout:

- Props: `onToggleCommentPanel`, `commentPanelOpen`, `unresolvedCommentCount`
- Badge showing unresolved count when > 0 (same markup as docs toolbar).

### 6. Right panel switching

**File:** `apps/slides/src/components/slides/editor.tsx`

Current right panel logic:
- Objects selected + canWrite -> `SlidePropertiesPanel`
- No selection + canWrite -> `SlideBackgroundPanel`

New logic:
- `commentPanelOpen` -> `CommentPanel` (takes priority, same as docs)
- Otherwise -> existing logic

`CommentPanel` receives `activeCommentIds`, `anchorTexts`, `onClose`, `onCommentClick`, `onCommentContextMenu` — identical props to docs usage.

### 7. Object context menu: comment actions

**File:** `apps/slides/src/components/slides/slide-object.tsx`

Extend the existing `ContextMenuContent` with comment items:

**When object has no comments:**
- Separator + "Add comment" item (`MessageSquarePlus` icon)

**When object has comments:**
- Separator + for each comment: submenu or items for color, resolve/reopen, delete comment
- Plus "Add comment" to add another

The "Add comment" action:
1. Opens `CreateCommentDialog` with `selectedText` set to the object's text (or "Image" for images).
2. On creation: calls `addCommentToObject(objectId, chatName)` and sets default color via `useUpdateCommentColor`.

The delete/color/resolve actions use the same mutations as docs (`useResolveComment`, `useUpdateCommentColor`). Delete calls `removeCommentFromObject(objectId, chatName)`.

### 8. Comment indicator: colored corner

**File:** `apps/slides/src/components/slides/slide-object.tsx`

For objects with active unresolved comments, render a colored triangle in the top-right corner:

```tsx
<div
    className="absolute top-0 right-0 w-0 h-0 cursor-pointer"
    style={{
        borderLeft: '16px solid transparent',
        borderTop: `16px solid ${commentColor}`,
    }}
    onClick={(e) => {
        e.stopPropagation();
        onCommentClick?.(chatName);
    }}
/>
```

- Color comes from the first comment's `CommentEntry.color` (or default highlight color if null).
- Not shown for resolved comments.
- Clickable: opens `NoteCardDialog` with `CommentThread` inside (same as docs click-on-highlight flow).
- Visible in both edit and non-edit modes (not shown in presentation mode).

### 9. CreateCommentDialog: share or copy

**Current file:** `apps/docs/src/components/docs/comment-dialog.tsx`

This dialog is currently docs-specific but has no Tiptap dependency. Two options:

Move `CreateCommentDialog` to `@workspace/ui` alongside the other shared comment components. It only depends on `@workspace/lib/api`, `@workspace/lib/chat`, and `@workspace/ui` components — all already shared.

The dialog's `onCommentCreated(chatName)` callback is called by the consuming editor. In docs it applies a Tiptap mark; in slides it calls `addCommentToObject()`.

### 10. NoteCardDialog + CommentThread: view threads

**Already shared in `@workspace/ui`.** Used identically to docs:

- `viewCommentChatName` state in editor.
- Click comment indicator or panel card -> set `viewCommentChatName`.
- Render `NoteCardDialog` with `CommentThread` inside.

### 11. NoteCardContextMenu: shared actions

**Already shared in `@workspace/ui`.** Handles color, resolve/reopen, edit, delete. In slides, "delete" calls `removeCommentFromObject` instead of removing a Tiptap mark.

### 12. Backend

**No changes.** The `comments.db` index, chat folder structure, REST API routes (`/collab/:ownerId/:mountId/:pathId/comments`), and SSE broadcasting are all container-agnostic. They already work for any container type that has a `chat/` subfolder.

## What is NOT in scope

- Pin-based (x,y) comments on empty slide areas — only object-anchored comments.
- Slide-level comments (not anchored to any object) — can be added later.
- Comments in presentation mode — comments are an editing/review feature.
- Mobile layout — slides already hide the canvas on mobile.

## File change summary

| File | Change |
|------|--------|
| `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx` | Extract `chatFolderId`, pass to editor |
| `apps/slides/src/components/slides/types.ts` | Add `commentChatNames?` to BaseObject |
| `apps/slides/src/components/slides/hooks/use-deck.ts` | Read/write commentChatNames, add/remove helpers |
| `apps/slides/src/components/slides/hooks/use-active-comments.ts` | New: scan objects for active comments |
| `apps/slides/src/components/slides/toolbar.tsx` | Add comment toggle button + badge |
| `apps/slides/src/components/slides/editor.tsx` | Comment panel state, dialog, thread viewing, context menu wiring |
| `apps/slides/src/components/slides/slide-object.tsx` | Comment context menu items, colored corner indicator |
| `apps/docs/src/components/docs/comment-dialog.tsx` | Move to `@workspace/ui` (or copy to slides) |
