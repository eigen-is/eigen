# Comments in Slides — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add object-anchored comments to the slides editor, reusing the shared comment infrastructure from docs.

**Architecture:** Each slide object stores a `commentChatNames: string[]` array in its Yjs map (plain JSON array, not Y.Array — comment edits are infrequent). The existing `comments.db`, chat folders, and API routes work without changes. The shared `CommentPanel`, `NoteCard`, `CommentThread`, and `NoteCardDialog` components are reused as-is. `CreateCommentDialog` is moved from the docs app to `@workspace/ui`.

**Tech Stack:** React, Yjs, TanStack Query, Radix context menus, shared `@workspace/ui` + `@workspace/lib` packages.

**Spec:** `docs/superpowers/specs/2026-04-02-comments-in-slides-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/ui/src/components/layout/comments/create-comment-dialog.tsx` | Create (moved from docs) | Shared comment creation dialog |
| `packages/ui/src/components/layout/comments/index.ts` | Modify | Export CreateCommentDialog |
| `apps/docs/src/components/docs/comment-dialog.tsx` | Delete | Replaced by shared component |
| `apps/docs/src/components/docs/editor.tsx` | Modify | Update import path |
| `apps/slides/src/components/slides/types.ts` | Modify | Add commentChatNames to BaseObject |
| `apps/slides/src/components/slides/hooks/use-deck.ts` | Modify | Read commentChatNames, add/remove helpers |
| `apps/slides/src/components/slides/hooks/use-active-comments.ts` | Create | Scan objects for active comment IDs |
| `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx` | Modify | Extract chatFolderId, pass to editor |
| `apps/slides/src/components/slides/editor.tsx` | Modify | Comment panel state, dialog, thread, panel switching |
| `apps/slides/src/components/slides/toolbar.tsx` | Modify | Comment toggle button + badge |
| `apps/slides/src/components/slides/slide-object.tsx` | Modify | Comment indicator + context menu items |

---

### Task 1: Move CreateCommentDialog to shared UI

**Files:**
- Create: `packages/ui/src/components/layout/comments/create-comment-dialog.tsx`
- Modify: `packages/ui/src/components/layout/comments/index.ts`
- Delete: `apps/docs/src/components/docs/comment-dialog.tsx`
- Modify: `apps/docs/src/components/docs/editor.tsx`

- [ ] **Step 1: Create the shared dialog**

Copy `apps/docs/src/components/docs/comment-dialog.tsx` to `packages/ui/src/components/layout/comments/create-comment-dialog.tsx`. The file has no docs-specific dependencies — it only uses `@workspace/lib/api`, `@workspace/lib/chat`, and `@workspace/ui` components which are all available in the UI package.

The content is identical to the current file at `apps/docs/src/components/docs/comment-dialog.tsx`:

```tsx
import { chatApi } from '@workspace/lib/api';
import { useCreateChat } from '@workspace/lib/chat';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Textarea } from '@workspace/ui/components/textarea';
import { useState } from 'react';

type CreateCommentDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    ownerId: string;
    mountId: string;
    chatFolderId: string;
    selectedText: string;
    onCommentCreated: (chatName: string) => void;
};

export function CreateCommentDialog({
    open,
    onOpenChange,
    ownerId,
    mountId,
    chatFolderId,
    selectedText,
    onCommentCreated,
}: CreateCommentDialogProps) {
    const [comment, setComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const createChat = useCreateChat(ownerId, mountId);

    const handleSubmit = async () => {
        if (!comment.trim()) return;
        setIsSubmitting(true);

        try {
            const fileName = `comment-${Date.now()}`;
            const result = await createChat.mutateAsync({ parentId: chatFolderId, fileName });
            const chatPath = result as { id: string; name: string } | undefined;

            if (chatPath?.id) {
                await chatApi({ ownerId })({ mountId })({ chatId: chatPath.id }).messages.post({
                    content: comment.trim(),
                });
                onCommentCreated(chatPath.name);
            }
        } finally {
            setIsSubmitting(false);
            setComment('');
            onOpenChange(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Add Comment</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    {selectedText && (
                        <div className="rounded-lg bg-muted border-l-4 border-primary p-3">
                            <p className="text-sm text-muted-foreground italic">
                                "{selectedText.length > 100 ? `${selectedText.slice(0, 100)}…` : selectedText}"
                            </p>
                        </div>
                    )}
                    <Textarea
                        autoFocus
                        placeholder="Write a comment..."
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                        className="min-h-[80px] resize-none"
                    />
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={!comment.trim() || isSubmitting}>
                        {isSubmitting ? 'Commenting...' : 'Comment'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 2: Export from index**

In `packages/ui/src/components/layout/comments/index.ts`, add:

```ts
export { CreateCommentDialog } from './create-comment-dialog';
```

- [ ] **Step 3: Update docs import**

In `apps/docs/src/components/docs/editor.tsx`, change the import from:

```ts
import { CreateCommentDialog } from './comment-dialog';
```

to:

```ts
import { Column, CommentPanel, CommentThread, CreateCommentDialog, LoadingState, NoteCardContextMenu, NoteCardDialog } from '@workspace/ui';
```

(Add `CreateCommentDialog` to the existing `@workspace/ui` import on line 18.)

- [ ] **Step 4: Delete old file**

```bash
rm apps/docs/src/components/docs/comment-dialog.tsx
```

- [ ] **Step 5: Verify build**

```bash
cd apps/docs && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/layout/comments/create-comment-dialog.tsx \
       packages/ui/src/components/layout/comments/index.ts \
       apps/docs/src/components/docs/editor.tsx
git rm apps/docs/src/components/docs/comment-dialog.tsx
git commit -m "refactor: move CreateCommentDialog to shared @workspace/ui"
```

---

### Task 2: Data model + useDeck comment helpers

**Files:**
- Modify: `apps/slides/src/components/slides/types.ts`
- Modify: `apps/slides/src/components/slides/hooks/use-deck.ts`

- [ ] **Step 1: Add commentChatNames to BaseObject**

In `apps/slides/src/components/slides/types.ts`, add to `BaseObject`:

```ts
type BaseObject = {
    id: string;
    slideId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
    borderColor: string;
    borderWidth: number;
    borderRadius: number;
    commentChatNames: string[];
};
```

And add to `DEFAULT_TEXT_OBJECT` and `DEFAULT_IMAGE_OBJECT`:

```ts
commentChatNames: [],
```

- [ ] **Step 2: Add commentChatNames to OBJECT_FIELDS and yMapToObject**

In `apps/slides/src/components/slides/hooks/use-deck.ts`, add `'commentChatNames'` to the `OBJECT_FIELDS` array.

Then update `yMapToObject` to handle the array field. After the for-loop, add:

```ts
function yMapToObject(yMap: Y.Map<unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const field of OBJECT_FIELDS) {
        const val = yMap.get(field);
        if (val !== undefined) obj[field] = val;
    }
    // Ensure commentChatNames is always a string array (may be stored as Y.Array or plain array)
    const raw = obj.commentChatNames;
    if (raw && typeof (raw as Y.Array<string>).toArray === 'function') {
        obj.commentChatNames = (raw as Y.Array<string>).toArray();
    } else if (!Array.isArray(raw)) {
        obj.commentChatNames = [];
    }
    return obj;
}
```

- [ ] **Step 3: Add addCommentToObject and removeCommentFromObject**

In `use-deck.ts`, after the `deleteObject` callback (~line 466), add:

```ts
const addCommentToObject = useCallback((objId: string, chatName: string) => {
    const doc = docRef.current;
    if (!doc) return;
    doc.transact(() => {
        const objectsMap = doc.getMap('objects');
        const objMap = objectsMap.get(objId) as Y.Map<unknown> | undefined;
        if (!objMap) return;
        const current = (objMap.get('commentChatNames') as string[] | undefined) || [];
        const arr = Array.isArray(current) ? [...current] : [];
        if (!arr.includes(chatName)) {
            arr.push(chatName);
            objMap.set('commentChatNames', arr);
        }
    });
}, []);

const removeCommentFromObject = useCallback((objId: string, chatName: string) => {
    const doc = docRef.current;
    if (!doc) return;
    doc.transact(() => {
        const objectsMap = doc.getMap('objects');
        const objMap = objectsMap.get(objId) as Y.Map<unknown> | undefined;
        if (!objMap) return;
        const current = (objMap.get('commentChatNames') as string[] | undefined) || [];
        const arr = Array.isArray(current) ? current.filter((n) => n !== chatName) : [];
        objMap.set('commentChatNames', arr);
    });
}, []);
```

Add both to the return object:

```ts
return {
    // ... existing fields ...
    addCommentToObject,
    removeCommentFromObject,
};
```

- [ ] **Step 4: Skip commentChatNames in duplicateSlide**

In `duplicateSlide`, inside the object copy loop, add a skip for `commentChatNames` — duplicated objects should not inherit comments:

```ts
for (const [k, v] of Object.entries(srcObj)) {
    if (k === 'id') objYMap.set('id', newObjId);
    else if (k === 'slideId') objYMap.set('slideId', newSlideId);
    else if (k === 'commentChatNames') continue; // Don't copy comments to duplicates
    else objYMap.set(k, v);
}
```

- [ ] **Step 5: Verify build**

```bash
cd apps/slides && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/slides/src/components/slides/types.ts \
       apps/slides/src/components/slides/hooks/use-deck.ts
git commit -m "feat(slides): add commentChatNames to data model and useDeck helpers"
```

---

### Task 3: useActiveComments hook

**Files:**
- Create: `apps/slides/src/components/slides/hooks/use-active-comments.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useMemo } from 'react';
import type { DeckData } from '../types';

type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

const EMPTY: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

export function useActiveComments(deck: DeckData): ActiveComments {
    return useMemo(() => {
        const ids = new Set<string>();
        const anchorTexts = new Map<string, string>();

        for (const obj of Object.values(deck.objects)) {
            if (!obj.commentChatNames?.length) continue;
            for (const chatName of obj.commentChatNames) {
                ids.add(chatName);
                if (!anchorTexts.has(chatName)) {
                    anchorTexts.set(
                        chatName,
                        obj.type === 'text' ? obj.text.slice(0, 100) : 'Image',
                    );
                }
            }
        }

        if (ids.size === 0) return EMPTY;
        return { ids, anchorTexts };
    }, [deck.objects]);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/slides/src/components/slides/hooks/use-active-comments.ts
git commit -m "feat(slides): add useActiveComments hook"
```

---

### Task 4: Route + chatFolderId plumbing

**Files:**
- Modify: `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`
- Modify: `apps/slides/src/components/slides/editor.tsx`

- [ ] **Step 1: Extract chatFolderId in route**

In `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`, add after the `mediaFolderId` line (line 37):

```ts
const chatFolderId = docInfo?.folderContents?.find((f) => f.name === 'chat')?.id ?? null;
```

Pass it to `SlideEditor`:

```tsx
<SlideEditor
    ownerId={ownerId}
    path={path}
    canWrite={canWrite}
    mediaFolderId={mediaFolderId}
    chatFolderId={chatFolderId}
    onAccessDialogOpen={handleAccessDialogOpen}
/>
```

- [ ] **Step 2: Update SlideEditor props and MediaResolverProvider**

In `apps/slides/src/components/slides/editor.tsx`, update the `SlideEditorProps` type (line 82):

```ts
type SlideEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
};
```

Update `MediaResolverProvider` in the `SlideEditor` function (line 96):

```tsx
<MediaResolverProvider
    ownerId={ownerId}
    mountId={path.mountId}
    mediaFolderId={mediaFolderId}
    chatFolderId={chatFolderId}
>
```

Pass `chatFolderId` through to `SlideEditorInner` (it's already destructured from the same props type).

- [ ] **Step 3: Verify build**

```bash
cd apps/slides && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx \
       apps/slides/src/components/slides/editor.tsx
git commit -m "feat(slides): plumb chatFolderId from route to editor"
```

---

### Task 5: Toolbar comment button

**Files:**
- Modify: `apps/slides/src/components/slides/toolbar.tsx`

- [ ] **Step 1: Add comment props and button**

Add `MessageSquare` to the lucide imports:

```ts
import { ImagePlus, MessageSquare, Play, Plus, Redo, Type, Undo, UserRoundPlus } from 'lucide-react';
```

Extend `ToolbarProps`:

```ts
type ToolbarProps = {
    canWrite: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    path: DrivePath;
    onAddText: () => void;
    onAddImage: () => void;
    onAddSlide: () => void;
    onPresent: () => void;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    unresolvedCommentCount?: number;
};
```

In the right section of the toolbar (the last `<div className="flex items-center">` around line 99), add the comment button before the share/mode button:

```tsx
<div className="flex items-center">
    {onToggleCommentPanel && (
        <div className="relative">
            <TooltipButton
                icon={MessageSquare}
                tooltipText="Comments"
                onClick={onToggleCommentPanel}
                active={commentPanelOpen}
            />
            {(unresolvedCommentCount ?? 0) > 0 && (
                <span className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center pointer-events-none px-1">
                    {unresolvedCommentCount}
                </span>
            )}
        </div>
    )}
    {canWrite ? (
        <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
    ) : (
        <DocumentModeButton canWrite={canWrite} />
    )}
</div>
```

Destructure the new props in the function signature.

- [ ] **Step 2: Commit**

```bash
git add apps/slides/src/components/slides/toolbar.tsx
git commit -m "feat(slides): add comment toggle button to toolbar"
```

---

### Task 6: Editor — comment panel, dialog, and thread viewing

This is the main integration task. It wires up the CommentPanel in the right sidebar, the CreateCommentDialog, and the NoteCardDialog for viewing threads.

**Files:**
- Modify: `apps/slides/src/components/slides/editor.tsx`

- [ ] **Step 1: Add imports**

Add to `apps/slides/src/components/slides/editor.tsx`:

```ts
import { useAuth } from '@workspace/lib/auth';
import { useComments, useResolveComment, useUpdateCommentColor } from '@workspace/lib/chat';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { CommentPanel, CommentThread, CreateCommentDialog, NoteCardContextMenu, NoteCardDialog } from '@workspace/ui';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { useActiveComments } from './hooks/use-active-comments';
```

- [ ] **Step 2: Add state and hooks in SlideEditorInner**

Inside `SlideEditorInner`, after the existing state declarations (around line 137), add:

```ts
const auth = useAuth();
const [commentPanelOpen, setCommentPanelOpen] = useState(false);
const [commentDialogOpen, setCommentDialogOpen] = useState(false);
const [commentSelectedText, setCommentSelectedText] = useState('');
const [commentObjectId, setCommentObjectId] = useState<string | null>(null);
const [viewCommentChatName, setViewCommentChatName] = useState<string | null>(null);

const activeComments = useActiveComments(deck);
const { data: allComments = [] } = useComments(ownerId, path.mountId, path.id);
const resolveComment = useResolveComment(ownerId, path.mountId, path.id);
const updateColor = useUpdateCommentColor(ownerId, path.mountId, path.id);
const commentContextMenu = useContextMenu<CommentEntry>();

const unresolvedCount = useMemo(() => {
    return allComments.filter((c) => c.status === 'open' && activeComments.ids.has(c.chatName)).length;
}, [allComments, activeComments.ids]);

const viewCommentEntry = viewCommentChatName
    ? allComments.find((c) => c.chatName === viewCommentChatName)
    : null;
```

- [ ] **Step 3: Add comment action handlers**

After the existing handler functions:

```ts
const handleAddComment = useCallback(
    (objId: string) => {
        const obj = deck.objects[objId];
        if (!obj) return;
        setCommentObjectId(objId);
        setCommentSelectedText(obj.type === 'text' ? obj.text.slice(0, 100) : 'Image');
        setCommentDialogOpen(true);
    },
    [deck.objects],
);

const handleCommentCreated = useCallback(
    (chatName: string) => {
        if (!commentObjectId) return;
        addCommentToObject(commentObjectId, chatName);
        updateColor.mutate({ chatName, color: EIGEN_STICKIES_COLORS[0][1].value });
        setCommentObjectId(null);
    },
    [commentObjectId, addCommentToObject, updateColor],
);

const handleDeleteComment = useCallback(
    (objId: string, chatName: string) => {
        removeCommentFromObject(objId, chatName);
    },
    [removeCommentFromObject],
);
```

Destructure `addCommentToObject` and `removeCommentFromObject` from the `useDeck` call at the top of the component.

- [ ] **Step 4: Wire toolbar props**

Update the `<Toolbar>` component to pass comment props:

```tsx
<Toolbar
    path={path}
    canWrite={canWrite}
    undoManager={undoManager}
    onAccessDialogOpen={onAccessDialogOpen}
    onRestore={handleRestore}
    onAddText={handleAddText}
    onAddImage={() => imageInputRef.current?.click()}
    onAddSlide={() => addSlide()}
    onPresent={handlePresent}
    onToggleCommentPanel={() => setCommentPanelOpen((v) => !v)}
    commentPanelOpen={commentPanelOpen}
    unresolvedCommentCount={unresolvedCount}
/>
```

- [ ] **Step 5: Add right panel switching**

Replace the current right panel section (lines 652-674, the `{selectedObjects.length > 0 && canWrite ? ... : ...}` block) with:

```tsx
{commentPanelOpen ? (
    <CommentPanel
        ownerId={ownerId}
        mountId={path.mountId}
        containerId={path.id}
        currentUserEmail={auth.user!.email}
        activeCommentIds={activeComments.ids}
        anchorTexts={activeComments.anchorTexts}
        onClose={() => setCommentPanelOpen(false)}
        onCommentClick={(chatName) => setViewCommentChatName(chatName)}
        onCommentContextMenu={commentContextMenu.handleContextMenu}
    />
) : selectedObjects.length > 0 && canWrite ? (
    <SlidePropertiesPanel
        objects={selectedObjects}
        onUpdate={updateObjects}
        onDelete={handleDeleteSelectedObjects}
    />
) : canWrite && activeSlideId ? (
    <SlideBackgroundPanel
        currentBackground={activeSlide.backgroundColor}
        currentBackgroundMediaName={activeSlide.backgroundMediaName}
        currentBackgroundImageUrl={backgroundImageUrl}
        onUpdateBackground={(color: string, applyTo: 'this' | 'this-and-following' | 'all') =>
            updateSlideBackground(activeSlideId!, color, applyTo)
        }
        onUpdateBackgroundImage={(mediaName: string, applyTo: 'this' | 'this-and-following' | 'all') =>
            updateSlideBackgroundImage(activeSlideId!, mediaName, applyTo)
        }
        onUploadImage={handleBackgroundImageUpload}
    />
) : null}
```

- [ ] **Step 6: Add dialogs and context menu anchor after the Column closing tag**

After the `</Column>` and before the closing `</ColumnLayout>`, add:

```tsx
{chatFolderId && (
    <CreateCommentDialog
        open={commentDialogOpen}
        onOpenChange={setCommentDialogOpen}
        ownerId={ownerId}
        mountId={path.mountId}
        chatFolderId={chatFolderId}
        selectedText={commentSelectedText}
        onCommentCreated={handleCommentCreated}
    />
)}

{viewCommentChatName && viewCommentEntry && (
    <NoteCardDialog
        open
        onOpenChange={(open) => {
            if (!open) setViewCommentChatName(null);
        }}
        title={activeComments.anchorTexts.get(viewCommentChatName) || viewCommentChatName}
        description={
            viewCommentEntry.lastAuthorEmail
                ? `Comment by ${viewCommentEntry.lastAuthorEmail.split('@')[0]}`
                : undefined
        }
    >
        <CommentThread ownerId={ownerId} mountId={path.mountId} chatName={viewCommentChatName} />
    </NoteCardDialog>
)}

<ContextMenuAnchor contextMenu={commentContextMenu}>
    <NoteCardContextMenu
        currentColor={commentContextMenu.item?.color}
        status={commentContextMenu.item?.status}
        onEdit={() => {
            if (commentContextMenu.item) setViewCommentChatName(commentContextMenu.item.chatName);
            commentContextMenu.close();
        }}
        onChangeColor={(color) => {
            if (commentContextMenu.item)
                updateColor.mutate({ chatName: commentContextMenu.item.chatName, color: color || null });
            commentContextMenu.close();
        }}
        onResolve={() => {
            if (commentContextMenu.item)
                resolveComment.mutate({ chatName: commentContextMenu.item.chatName, status: 'resolved' });
            commentContextMenu.close();
        }}
        onReopen={() => {
            if (commentContextMenu.item)
                resolveComment.mutate({ chatName: commentContextMenu.item.chatName, status: 'open' });
            commentContextMenu.close();
        }}
        onDelete={() => {
            if (!commentContextMenu.item) {
                commentContextMenu.close();
                return;
            }
            const chatName = commentContextMenu.item.chatName;
            // Find which object has this comment and remove it
            for (const obj of Object.values(deck.objects)) {
                if (obj.commentChatNames?.includes(chatName)) {
                    removeCommentFromObject(obj.id, chatName);
                    break;
                }
            }
            commentContextMenu.close();
        }}
    />
</ContextMenuAnchor>
```

- [ ] **Step 7: Pass handleAddComment and allComments to SlideCanvas**

Add new props to the `<SlideCanvas>` call so slide objects can trigger comment actions:

```tsx
<SlideCanvas
    // ... existing props ...
    onAddComment={canWrite && chatFolderId ? handleAddComment : undefined}
    onCommentClick={setViewCommentChatName}
    allComments={allComments}
    activeCommentIds={activeComments.ids}
/>
```

These props will be threaded through to `SlideObjectView` in the next tasks.

- [ ] **Step 8: Verify build**

```bash
cd apps/slides && npx tsc --noEmit
```

Note: this may show type errors for the new SlideCanvas props that haven't been added yet. That's expected and will be resolved in Tasks 7-8.

- [ ] **Step 9: Commit**

```bash
git add apps/slides/src/components/slides/editor.tsx
git commit -m "feat(slides): wire up comment panel, dialog, and thread viewing"
```

---

### Task 7: Comment indicator on slide objects

**Files:**
- Modify: `apps/slides/src/components/slides/slide-object.tsx`

- [ ] **Step 1: Add comment indicator props to SlideObjectView**

Add to `SlideObjectViewProps`:

```ts
type SlideObjectViewProps = {
    // ... existing props ...
    commentColor?: string | null;
    onCommentClick?: (chatName: string) => void;
    firstCommentChatName?: string | null;
};
```

- [ ] **Step 2: Render colored corner**

Inside the `SlideObjectView` component, after the resize handles block (after the `HANDLE_POSITIONS.map(...)` block, around line 264), add the comment indicator:

```tsx
{firstCommentChatName && commentColor && (
    <div
        className="absolute top-0 right-0 cursor-pointer z-10"
        style={{
            width: 0,
            height: 0,
            borderLeft: '16px solid transparent',
            borderTop: `16px solid ${commentColor}`,
        }}
        onClick={(e) => {
            e.stopPropagation();
            onCommentClick?.(firstCommentChatName);
        }}
        onMouseDown={(e) => e.stopPropagation()}
    />
)}
```

This sits inside the object div (before its closing `</div>`), so it's positioned relative to the object and moves/resizes with it.

- [ ] **Step 3: Also show indicator in ReadOnlySlideObject (non-edit, non-presenting)**

Note: the `ReadOnlySlideObject` is only used in presentation mode, where we don't show comments. No change needed there.

- [ ] **Step 4: Commit**

```bash
git add apps/slides/src/components/slides/slide-object.tsx
git commit -m "feat(slides): add colored corner comment indicator on objects"
```

---

### Task 8: Context menu comment actions + SlideCanvas threading

**Files:**
- Modify: `apps/slides/src/components/slides/slide-object.tsx`
- Modify: `apps/slides/src/components/slides/slide-canvas.tsx`

- [ ] **Step 1: Add comment items to object context menu**

Add imports at the top of `slide-object.tsx`:

```ts
import {
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
} from '@workspace/ui/components/context-menu';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants/colors';
import { isLightColor } from '@workspace/ui/components/layout/media/color-picker';
import { Check, CircleOff, MessageSquarePlus, Palette, RotateCcw } from 'lucide-react';
```

Add to `SlideObjectViewProps`:

```ts
type SlideObjectViewProps = {
    // ... existing props including comment indicator props from Task 7 ...
    onAddComment?: (objId: string) => void;
    commentEntries?: Array<{ chatName: string; color: string | null; status: 'open' | 'resolved' }>;
    onCommentResolve?: (chatName: string) => void;
    onCommentReopen?: (chatName: string) => void;
    onCommentChangeColor?: (chatName: string, color: string | null) => void;
    onCommentDelete?: (objId: string, chatName: string) => void;
};
```

In the `ContextMenuContent` of the editable object, after the existing delete item (~line 291), add:

```tsx
{onAddComment && (
    <>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAddComment(obj.id)}>
            <MessageSquarePlus className="h-4 w-4 mr-2" /> Add comment
        </ContextMenuItem>
    </>
)}
{commentEntries && commentEntries.length > 0 && (
    <>
        <ContextMenuSeparator />
        {commentEntries.map((entry) => (
            <ContextMenuSub key={entry.chatName}>
                <ContextMenuSubTrigger>
                    <div
                        className="h-3 w-3 rounded-full mr-2 border border-border/50"
                        style={{ backgroundColor: entry.color || undefined }}
                    />
                    {entry.status === 'open' ? 'Comment' : 'Comment (resolved)'}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                    <ContextMenuItem onClick={() => onCommentClick?.(entry.chatName)}>
                        Edit
                    </ContextMenuItem>
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Palette className="h-4 w-4 mr-2" /> Color
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            <div className="flex gap-1 p-2">
                                <button
                                    type="button"
                                    className="h-4 w-4 rounded-full border border-border hover:scale-125 transition-transform flex items-center justify-center bg-background"
                                    title="No color"
                                    onClick={() => onCommentChangeColor?.(entry.chatName, null)}
                                >
                                    <CircleOff className="h-2.5 w-2.5 text-muted-foreground" />
                                </button>
                                {EIGEN_STICKIES_COLORS[0].map((c) => (
                                    <button
                                        type="button"
                                        key={c.value}
                                        className="h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center"
                                        style={{ backgroundColor: c.value }}
                                        title={c.label}
                                        onClick={() => onCommentChangeColor?.(entry.chatName, c.value)}
                                    >
                                        {entry.color === c.value && (
                                            <Check
                                                className="h-2 w-2"
                                                style={{ color: isLightColor(c.value) ? '#000' : '#fff' }}
                                            />
                                        )}
                                    </button>
                                ))}
                            </div>
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                    {entry.status === 'open' ? (
                        <ContextMenuItem onClick={() => onCommentResolve?.(entry.chatName)}>
                            <Check className="h-4 w-4 mr-2" /> Resolve
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuItem onClick={() => onCommentReopen?.(entry.chatName)}>
                            <RotateCcw className="h-4 w-4 mr-2" /> Reopen
                        </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        variant="destructive"
                        onClick={() => onCommentDelete?.(obj.id, entry.chatName)}
                    >
                        <Trash2 className="h-4 w-4 mr-2" /> Delete comment
                    </ContextMenuItem>
                </ContextMenuSubContent>
            </ContextMenuSub>
        ))}
    </>
)}
```

- [ ] **Step 2: Thread comment props through SlideCanvas**

In `apps/slides/src/components/slides/slide-canvas.tsx`, add props for comment data and callbacks. The canvas receives them from the editor and passes them to each `SlideObjectView`.

Add to `SlideCanvasProps`:

```ts
onAddComment?: (objId: string) => void;
onCommentClick?: (chatName: string) => void;
allComments?: CommentEntry[];
activeCommentIds?: Set<string>;
```

Import `CommentEntry`:

```ts
import type { CommentEntry } from '@workspace/lib/types/chat';
```

When rendering each `SlideObjectView`, compute and pass the comment props:

```ts
const objCommentEntries = allComments
    ?.filter((c) => obj.commentChatNames?.includes(c.chatName))
    ?? [];
const firstUnresolved = objCommentEntries.find((c) => c.status === 'open');
```

Pass to `SlideObjectView`:

```tsx
<SlideObjectView
    // ... existing props ...
    onAddComment={onAddComment}
    onCommentClick={onCommentClick}
    commentColor={firstUnresolved?.color}
    firstCommentChatName={firstUnresolved?.chatName}
    commentEntries={objCommentEntries.map((c) => ({
        chatName: c.chatName,
        color: c.color,
        status: c.status,
    }))}
    onCommentResolve={onCommentResolve}
    onCommentReopen={onCommentReopen}
    onCommentChangeColor={onCommentChangeColor}
    onCommentDelete={onCommentDelete}
/>
```

Also pass the resolve/reopen/color/delete callbacks from the editor through the canvas. Add these to `SlideCanvasProps`:

```ts
onCommentResolve?: (chatName: string) => void;
onCommentReopen?: (chatName: string) => void;
onCommentChangeColor?: (chatName: string, color: string | null) => void;
onCommentDelete?: (objId: string, chatName: string) => void;
```

Wire these from the editor's `<SlideCanvas>`:

```tsx
<SlideCanvas
    // ... existing props ...
    onAddComment={canWrite && chatFolderId ? handleAddComment : undefined}
    onCommentClick={setViewCommentChatName}
    allComments={allComments}
    activeCommentIds={activeComments.ids}
    onCommentResolve={(chatName) => resolveComment.mutate({ chatName, status: 'resolved' })}
    onCommentReopen={(chatName) => resolveComment.mutate({ chatName, status: 'open' })}
    onCommentChangeColor={(chatName, color) => updateColor.mutate({ chatName, color })}
    onCommentDelete={handleDeleteComment}
/>
```

- [ ] **Step 3: Verify build**

```bash
cd apps/slides && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/slides/src/components/slides/slide-object.tsx \
       apps/slides/src/components/slides/slide-canvas.tsx \
       apps/slides/src/components/slides/editor.tsx
git commit -m "feat(slides): add comment actions to object context menu"
```

---

### Task 9: Final integration and manual testing

- [ ] **Step 1: Run full build**

```bash
cd /Users/reinder/Documents/GitHub/eigen && bun run build
```

Expected: no errors across all packages.

- [ ] **Step 2: Run type checks across affected packages**

```bash
cd apps/slides && npx tsc --noEmit
cd apps/docs && npx tsc --noEmit
cd packages/ui && npx tsc --noEmit
```

- [ ] **Step 3: Manual test checklist**

Start the dev server and test in browser:

1. Open a slides document
2. Verify comment button appears in toolbar (MessageSquare icon)
3. Click comment button — CommentPanel slides in from right, replacing properties panel
4. Right-click a text object — verify "Add comment" appears in context menu
5. Add a comment — verify:
   - Dialog shows with object text preview
   - After submit, colored corner appears on object
   - Comment shows in the panel
   - Badge count updates on toolbar
6. Click the colored corner — verify thread dialog opens
7. Right-click an object with a comment — verify color/resolve/delete options in submenu
8. Resolve a comment — verify corner indicator disappears
9. Delete a comment — verify corner disappears and comment removed from panel
10. Duplicate a slide — verify comments are NOT copied to duplicated objects

- [ ] **Step 4: Final commit**

If any fixes were needed during testing, commit them:

```bash
git add -A
git commit -m "fix(slides): address issues found during comment integration testing"
```
