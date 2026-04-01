# Comments — Redesign Plan

> **TLDR**: Replace the current modal-based comment system with inline creation (floating "Add comment" button on text
> selection), a shared `<CommentThread>` component (reusing `ChatMessageList`/`ChatMessageInput`, with resolve/reopen),
> and a shared `<CommentPanel>` using the same `PropertiesPanel` overlay pattern as figure/table panels. All shared UI
> lives in `packages/ui` (shadcn components throughout), all hooks in `packages/lib`. App-specific code is limited to
> extracting active comment IDs + anchor texts from the Yjs document.

## Current State

Comments exist but are minimal:
- **Create**: toolbar button → modal dialog (`CreateCommentDialog`) — requires text selection, opens full dialog
- **View**: click highlighted text → modal dialog (`ViewCommentDialog`) with embedded `ChatMessageList`
- **No resolve/reopen UI** — backend supports it (`PATCH .../comments/:chatName/status`), frontend hooks exist
  (`useResolveComment`), but no UI surfaces it
- **No comment side panel** — no way to see all comments at once
- **No filtering** — hooks support it (`useComments` returns `mentions[]`), unused
- **Docs-only** — comment mark and dialogs live in `apps/docs`, not reusable

### Key Files (Current)

| File | What it does |
|------|-------------|
| `apps/docs/src/components/docs/comment-dialog.tsx` | `CreateCommentDialog` + `ViewCommentDialog` (modal) |
| `apps/docs/src/components/docs/extensions/comment-mark.ts` | Tiptap plugin with click handler |
| `packages/lib/src/docs/eigendoc/nodes/comment-mark.ts` | `CommentMarkSchema` — tiptap mark definition |
| `packages/lib/src/core/chat/hooks/use-comments.ts` | `useComments`, `useUnresolvedCommentCount`, `useResolveComment` |
| `apps/api/src/lib/chat/comment-index.ts` | `CommentIndex` class (list, resolve, reopen, etc.) |
| `apps/api/src/routes/collab.ts` | Comment REST routes |
| `docs/COMMENTS_IN_DOCS.md` | Architecture of the backend comment index |

## Design Goals

1. **Floating "Add comment" button** — appears on text selection (like Google Docs), not buried in a toolbar menu
2. **Shared `<CommentThread>`** — composes existing `ChatMessageList`/`ChatMessageInput` with resolve/reopen, used
   both in inline popovers (clicking a highlight) and in the comment panel
3. **Resolved comments hidden in doc** — resolved `CommentMark`s get transparent styling via CSS decorations
4. **Shared `<CommentPanel>`** — uses `PropertiesPanel` overlay pattern (same as figure/table panels), consistent
   across docs and slides
5. **Filter by current revision** — only show comments whose `chatName` exists in the current Yjs document state
6. **Reusable across apps** — docs first, then slides/sheets/stickies with minimal per-app wiring
7. **shadcn throughout** — all UI uses shadcn primitives (`Popover`, `Dialog`, `Tabs`, `Select`, `Button`, etc.)

## Architecture

### Layer Split

```
packages/ui/src/components/layout/comments/
├── comment-thread.tsx         # Single comment thread (ChatMessageList + resolve + reply)
├── comment-panel.tsx          # Full panel: header, filters, comment list (uses PropertiesPanel pattern)
├── comment-creation.tsx       # Inline comment creation (shadcn Popover with textarea)
└── add-comment-button.tsx     # Floating button shown on text selection

packages/lib/src/core/chat/hooks/
├── use-comments.ts            # Already exists — useComments, useResolveComment, etc.
└── (no changes needed)

apps/docs/src/components/docs/
├── extensions/comment-mark.ts # Update: add resolved styling, selection button positioning
├── editor.tsx                 # Update: wire comment panel as overlay (same as figure/table), remove modals
└── comment-dialog.tsx         # DELETE — replaced by shared components
```

### Design Principle: Consistency with PropertiesPanel

The comment panel follows the **same pattern** as the figure/table properties panels in docs and the
slide properties panel in slides:

- Uses `PropertiesPanel` from `packages/ui/components/layout/properties-panel/` as the container
- In docs: absolute-positioned overlay inside the Column, slides in/out with `translate-x` transition
- In slides: flex sibling inside the Column content area
- Same width (`w-64` default, can be overridden via `className`), border-left, `ScrollArea`

The comment panel is essentially another properties panel — it appears in the same position, with the same
animation, and the same visual treatment. When a user selects a figure → figure panel shows. When a user
clicks the comment toolbar icon → comment panel shows (in the same slot).

### Shared Chat Components (Already Exist)

Comment threads reuse the existing shared chat components in `packages/ui/components/layout/chat/`:

- `ChatMessageList` — already used by `comment-dialog.tsx` (docs) and `card-dialog.tsx` (stickies)
- `ChatMessageInput` — same, shared across chat, docs, stickies

The `CommentThread` component composes these, adding resolve/reopen buttons and compact mode.
The `resolveChatId` + `useChatRoom` pattern is already established in stickies `CardChat` component.

### What Each App Provides

Each app must supply a function to extract active comment data from its current document state. This is the
only app-specific piece:

```typescript
// Adapter type — each app implements this
type CommentAnchorProvider = {
    /** Return set of chatNames that exist in the current document revision */
    getActiveCommentIds: () => Set<string>;
    /** Return the anchor text for a given comment (the text the comment is attached to) */
    getAnchorText: (chatName: string) => string | null;
    /** Optional: scroll to / highlight the anchor for a given comment */
    scrollToComment?: (chatName: string) => void;
};
```

**Per-app implementations:**
- **Docs**: walk tiptap doc for `CommentMark` marks → collect `chatName` attributes + anchor text
- **Slides**: scan Y.Map slides for comment annotations (future)
- **Sheets**: scan Y.Map cells for comment annotations (future)
- **Stickies**: scan Y.Map cards for `chatName` field (future)

Everything else (thread rendering, resolve/reopen, filtering, side panel) is shared.

### Types

Add a typed response for the comment list endpoint. Currently `useComments` returns untyped `response.data`.

```typescript
// packages/lib/src/types/chat.ts — add alongside existing CommentEntry
export type CommentListItem = {
    chatName: string;
    status: 'open' | 'resolved';
    resolvedBy: string | null;
    resolvedAt: string | null;
    lastAuthorEmail: string | null;
    lastMessageSnippet: string | null;
    lastActivityAt: string | null;
    messageCount: number;
    createdAt: string;
    mentions: string[];
};
```

Update `useComments` to return `CommentListItem[]`.

## Components

### 1. Floating "Add Comment" Button

Appears when the user selects text in the editor. Positioned near the selection (right margin or above/below).

**Approach**: Tiptap `BubbleMenu`-style floating element, but simpler — a single icon button that appears outside
the document canvas in the right margin, vertically aligned with the selection. This avoids conflicting with
the existing bubble menu / toolbar.

```
┌─────────────────────────────┐  ╭───╮
│ The quick brown fox jumps   │  │ 💬│  ← floating button in right margin
│ ███████████████ the lazy    │  ╰───╯
│ dog.                        │
└─────────────────────────────┘
```

- Only visible when `access.canWrite && chatFolderId && hasSelection`
- Keyboard shortcut: `Cmd+Alt+M` (matches Google Docs convention)
- Click → opens inline comment creation popover (not a modal dialog)

**Implementation**: ProseMirror plugin that listens to selection changes, computes the vertical position of the
selection, and renders a React portal. The button lives outside the editor's scrollable area (in the gap between
the A4 canvas and the right edge), so it doesn't interfere with content.

### 2. Inline Comment Creation

When the user clicks the floating button (or presses `Cmd+Alt+M`), a shadcn `Popover` appears anchored to the
selection with a `Textarea` and `Button`. Much lighter than the current full-screen `Dialog`.

```
┌────────────────────────────────┐
│ ┌────────────────────────────┐ │
│ │ Write a comment...         │ │
│ │                            │ │
│ └────────────────────────────┘ │
│               [Cancel] [Comment] │
└────────────────────────────────┘
```

Uses shadcn components: `Popover`, `PopoverContent`, `Textarea`, `Button` — same as the color picker popovers
already used in `EditorToolbar`.

**Props:**
```typescript
type CommentCreationProps = {
    ownerId: string;
    mountId: string;
    chatFolderId: string;
    selectedText: string;
    onCreated: (chatName: string) => void;
    onCancel: () => void;
};
```

**Location**: `packages/ui/src/components/layout/comments/comment-creation.tsx`

On submit: creates chat (reuses `useCreateChat`), posts first message, calls `onCreated(chatName)` so the app
can apply the mark. Same flow as current `CreateCommentDialog` but using a `Popover` instead of a `Dialog`.

### 3. CommentThread

Shared component for rendering a single comment's message thread. Follows the same `resolveChatId` →
`useChatRoom` pattern as stickies `CardChat` (`apps/stickies/src/components/stickies/card-dialog.tsx`).

Used in two places:
1. **Inline popover** (shadcn `Popover`) — when clicking a comment highlight in the doc (replaces `ViewCommentDialog`)
2. **Inside the comment panel** — each comment in the list is a `CommentThread` in compact mode

```typescript
type CommentThreadProps = {
    ownerId: string;
    mountId: string;
    chatName: string;
    status: 'open' | 'resolved';
    anchorText?: string;
    /** Compact mode for panel (fewer messages shown, simplified input) */
    compact?: boolean;
    onResolve?: () => void;
    onReopen?: () => void;
    onScrollToAnchor?: () => void;
    className?: string;
};
```

**Internally**: resolves `chatName` → `chatId` via `useMediaResolver().resolveChatId()`, then uses `useChatRoom`
to get messages and send handler. Renders:

- Anchor text quote (if provided) — styled like the existing `CreateCommentDialog` quote block
- `ChatMessageList` from `packages/ui/components/layout/chat/` (existing shared component)
- `ChatMessageInput` from `packages/ui/components/layout/chat/` (existing shared component)
- Resolve `Button` (shadcn, `variant="ghost"`, checkmark icon) — calls `useResolveComment` mutation
- Reopen `Button` — appears on resolved comments
- "Go to text" link — calls `onScrollToAnchor` to scroll the editor to the highlighted text

In compact mode: shows only the last few messages and a simplified reply input.

**Location**: `packages/ui/src/components/layout/comments/comment-thread.tsx`

### 4. CommentPanel

An absolute-positioned overlay panel — **same pattern as `FigurePropertiesPanel` / `TablePropertiesPanel`** in
docs. Uses `PropertiesPanel` as its container, slides in/out with the same `translate-x` transition. Triggered
by the comment icon in the toolbar.

```typescript
type CommentPanelProps = {
    ownerId: string;
    mountId: string;
    containerId: string;
    currentUserEmail: string;
    /** Set of chatNames present in the current document revision */
    activeCommentIds: Set<string>;
    /** Map of chatName → quoted anchor text, extracted from the doc by the app */
    anchorTexts: Map<string, string>;
    onScrollToComment?: (chatName: string) => void;
};
```

**Rendering** (uses `PropertiesPanel` + `PropertySection` for consistent styling):
```tsx
<PropertiesPanel className="w-80"> {/* wider than default w-64 to fit comment threads */}
    <div className="px-3 py-2 border-b flex items-center justify-between">
        <span className="text-sm font-medium">Comments</span>
        <div className="flex gap-1">
            <TooltipButton icon={X} tooltipText="Close" onClick={onClose} />
        </div>
    </div>

    {/* Tab bar: All / For you — using shadcn Tabs */}
    <Tabs defaultValue="all">
        <TabsList className="...">
            <TabsTrigger value="all">All comments</TabsTrigger>
            <TabsTrigger value="mine">For you</TabsTrigger>
        </TabsList>
        {/* Status filter: shadcn Select */}
        <Select defaultValue="open">...</Select>
    </Tabs>

    {/* Comment list — each item is a compact CommentThread */}
    {filteredComments.map(comment => (
        <CommentThread key={comment.chatName} compact ... />
    ))}
</PropertiesPanel>
```

**Tabs / Filters:**
- **All comments**: all open comments whose `chatName` is in `activeCommentIds`
- **For you**: same, filtered to comments where `mentions[]` includes `currentUserEmail`
- **Status filter dropdown** (shadcn `Select`): Open (default), Resolved, All
  - "Open" = `status === 'open'` AND `chatName` in `activeCommentIds`
  - "Resolved" = `status === 'resolved'` AND `chatName` in `activeCommentIds`
  - "All" = any status, `chatName` in `activeCommentIds`

All filtering is client-side. `useComments()` returns the full list; the panel intersects with `activeCommentIds`
(from the Yjs doc) and applies status/mention filters.

**Each comment card shows:**
- Quoted anchor text (from `anchorTexts` map, extracted by the app's `CommentAnchorProvider`)
- Author avatar + name + relative time
- First message snippet (from `lastMessageSnippet`)
- Reply count (from `messageCount`)
- Resolve button (checkmark) — uses shadcn `Button` with `variant="ghost"`
- Click → expand to full `CommentThread` inline, or scroll to anchor in doc

**All UI elements use shadcn components**: `Tabs`/`TabsList`/`TabsTrigger`, `Select`, `Button`, `ScrollArea`
(via `PropertiesPanel`), `Separator`, `Badge` for counts.

**Location**: `packages/ui/src/components/layout/comments/comment-panel.tsx`

### 5. Resolved Comment Visibility

Resolved comments should not be visually highlighted in the document. Two approaches:

**Chosen approach: CSS-based hiding via data attribute**

The `CommentMark` already renders `<span class="comment-highlight" data-chat-name="...">`. We add a
`data-resolved` attribute when the comment is resolved, and style it to remove the highlight:

```css
.tiptap .comment-highlight[data-resolved="true"] {
    background-color: transparent;
    border-bottom: none;
    cursor: default;
}
```

This requires the editor to know which comments are resolved. The `useComments` hook already provides this.
Pass the resolved set to the `CommentMark` extension config, which updates decorations accordingly.

**Implementation**: Use ProseMirror decorations (not mark attributes) to add `data-resolved` to rendered spans.
The extension receives a `resolvedCommentIds: Set<string>` and creates inline decorations that add the attribute.
This keeps the Yjs mark clean (no resolved state in the collaborative doc) while controlling visibility via CSS.

**Reactivity**: Changing a React prop does not automatically recompute ProseMirror plugin decorations. The
decoration plugin must use `editor.extensionStorage` or a metadata transaction to trigger recomputation. Pattern:
store the resolved set in extension storage, dispatch a no-op transaction with metadata when the set changes,
and read from storage in the plugin's `apply()` method to rebuild the `DecorationSet`. This ensures decorations
update when a collaborator resolves/reopens a comment (SSE → query refetch → resolved set changes → transaction
→ decorations recomputed).

## Integration with Docs Editor

### Context: Current Layout

`TiptapEditor` renders a `<Column>` containing a `relative overflow-hidden` div. Inside that div:
- The scrollable A4 canvas with the tiptap editor
- An **absolute-positioned overlay** for figure/table `PropertiesPanel` (slides in from right)

The comment panel uses **exactly the same pattern** — another absolute overlay in the same container. The
`sidebarContext` state already switches between `'document' | 'figure' | 'table'`; we extend it to include
`'comments'`. Only one panel shows at a time (selecting a figure closes comments, opening comments deselects
any active panel).

The `MediaResolverProvider` wraps `TiptapEditor` in `CollaborativeEditor`, so the comment panel has access
to `useMediaResolver()` for `resolveChatId`.

### Updated editor.tsx Layout

```tsx
// Current sidebar states: 'document' | 'figure' | 'table'
// New: 'document' | 'figure' | 'table' | 'comments'
const [sidebarContext, setSidebarContext] = useState<'document' | 'figure' | 'table' | 'comments'>('document');

const showSidebar = isWide && sidebarContext !== 'document';

// Inside the Column's relative container (same pattern as existing panels):
<Column id="doc-editor" width="w-full" toolbar={<EditorToolbar ... />}>
    <div className="h-full relative overflow-hidden">
        {/* scrollable A4 canvas (unchanged) */}
        <div ref={scrollContainerRef} className="h-full w-full overflow-y-scroll bg-muted p-4">
            {/* editor content */}
        </div>

        {/* Existing figure/table panels + new comment panel — same absolute overlay slot */}
        {isWide && (
            <div className={`absolute inset-y-0 right-0 transition-transform duration-200 ease-in-out
                            ${showSidebar ? 'translate-x-0' : 'translate-x-full'}`}>
                {sidebarContext === 'comments' ? (
                    <CommentPanel
                        ownerId={path.ownerId}
                        mountId={path.mountId}
                        containerId={path.id}
                        currentUserEmail={auth.user!.email}
                        activeCommentIds={activeComments.ids}
                        anchorTexts={activeComments.anchorTexts}
                        onClose={() => setSidebarContext('document')}
                        onScrollToComment={scrollToComment}
                    />
                ) : sidebarContext === 'figure' ? (
                    <FigurePropertiesPanel ... />
                ) : sidebarContext === 'table' ? (
                    <TablePropertiesPanel ... />
                ) : null}
            </div>
        )}
    </div>
</Column>
```

**No `ColumnLayout` change needed** — the comment panel lives in the same absolute overlay as the existing
panels. No Column width changes, no nesting concerns. The `Column` stays `width="w-full"` as before.

### Active Comments from Tiptap

Extract both the set of active comment IDs and the anchor text for each comment. The doc traversal fires on
every editor `update` event (including remote collab changes), so debounce to avoid walking the full doc on
every keystroke.

```typescript
type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};

function useActiveComments(editor: Editor | null): ActiveComments {
    const [result, setResult] = useState<ActiveComments>({ ids: new Set(), anchorTexts: new Map() });

    useEffect(() => {
        if (!editor) return;
        let timer: ReturnType<typeof setTimeout>;

        const update = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const ids = new Set<string>();
                const anchorTexts = new Map<string, string>();

                editor.state.doc.descendants((node, pos) => {
                    node.marks?.forEach((mark) => {
                        if (mark.type.name === 'comment' && mark.attrs.chatName) {
                            const chatName = mark.attrs.chatName;
                            ids.add(chatName);
                            if (!anchorTexts.has(chatName)) {
                                // Collect text content under this mark
                                const text = editor.state.doc.textBetween(pos, pos + node.nodeSize, ' ');
                                anchorTexts.set(chatName, text.slice(0, 100));
                            }
                        }
                    });
                });

                setResult({ ids, anchorTexts });
            }, 200); // debounce 200ms
        };

        update();
        editor.on('update', update);
        return () => {
            editor.off('update', update);
            clearTimeout(timer);
        };
    }, [editor]);

    return result;
}
```

### Toolbar Change

The comment icon in `EditorToolbar` gets dual behavior:
- **With text selected**: triggers inline comment creation (same as current `onAddComment`)
- **Without selection**: toggles the comment side panel open/closed

Add `onToggleCommentPanel` callback and unresolved count badge:

```tsx
<TooltipButton
    icon={MessageSquare}
    tooltipText={hasSelection ? "Add comment" : "Comments"}
    onClick={hasSelection ? onAddComment : onToggleCommentPanel}
    badge={unresolvedCount > 0 ? unresolvedCount : undefined}
/>
```

## Scroll-to-Comment

When a user clicks a comment in the side panel, the editor should scroll to the highlighted text:

```typescript
function scrollToComment(editor: Editor, chatName: string) {
    let targetPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
        if (targetPos !== null) return false;
        node.marks?.forEach((mark) => {
            if (mark.type.name === 'comment' && mark.attrs.chatName === chatName) {
                targetPos = pos;
            }
        });
    });
    if (targetPos !== null) {
        editor.chain().focus().setTextSelection(targetPos).scrollIntoView().run();
    }
}
```

## Mobile Considerations

The comment panel uses the same `isWide` media query check as the existing figure/table panels — it only
appears on screens wider than 1200px. This is the established pattern (docs editor already hides property
panels on narrow screens).

**Floating "Add comment" button**: Not practical on mobile — text selection is OS-controlled and positioning a
floating button in the margin doesn't work on narrow screens. On mobile, the toolbar button remains the primary
way to add comments (requires text selection first, same as current behavior).

**Inline popovers**: shadcn `Popover` works on mobile but should use `align="center"` and a wider trigger area.
For comment creation, fall back to shadcn `Dialog` on mobile (use `isMobile` from `useLayout()` to switch).

**Initial implementation**: Desktop-first. Mobile-specific rendering can be deferred — the existing pattern
of hiding panels on narrow screens is acceptable for now.

## Implementation Order

### Step 1: Shared CommentThread component
- Create `packages/ui/src/components/layout/comments/comment-thread.tsx`
- Renders messages, resolve/reopen button, reply input
- Uses existing `useComments`, `useResolveComment` hooks
- Test in isolation

### Step 2: CommentPanel
- Create `packages/ui/src/components/layout/comments/comment-panel.tsx`
- Uses `PropertiesPanel` as container (same as figure/table panels)
- shadcn `Tabs` (All / For you), shadcn `Select` for status filter
- Accepts `activeCommentIds` + `anchorTexts` props for revision-aware filtering
- Each item renders `CommentThread` in compact mode

### Step 3: Wire into docs editor
- Extend `sidebarContext` from `'document' | 'figure' | 'table'` to include `'comments'`
- Render `CommentPanel` in existing absolute overlay slot (same `div` as figure/table panels)
- Implement `useActiveComments` hook (debounced, returns ids + anchorTexts)
- Update toolbar button to toggle comment panel
- Pass resolved IDs to CommentMark for CSS-based hiding

### Step 4: Floating "Add comment" button + inline creation
- Add ProseMirror plugin for selection-aware floating button
- Create `packages/ui/src/components/layout/comments/comment-creation.tsx`
- Create `packages/ui/src/components/layout/comments/add-comment-button.tsx`
- Replace `CreateCommentDialog` with inline popover
- Register `Cmd+Alt+M` shortcut via `addKeyboardShortcuts()` in the `CommentMark` extension

### Step 5: Replace ViewCommentDialog with inline popover
- Clicking a comment highlight opens a popover (not modal) showing `CommentThread`
- Popover positioned near the highlight, similar to Google Docs
- Remove `comment-dialog.tsx` from docs app

### Step 6: Resolved comment hiding
- Add ProseMirror decoration plugin that reads resolved set
- Add CSS rule for `[data-resolved="true"]` — transparent background
- Resolved comments still clickable (to reopen) but not visually highlighted

### Step 7: Slides / Sheets / Stickies integration (future)
- Each app implements `CommentAnchorProvider`
- Each app adds `CommentSidePanel` Column to its layout
- Comment creation varies per app (slides: selection on canvas, sheets: cell selection)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Panel layout | Absolute overlay using `PropertiesPanel` | Same pattern as figure/table panels in docs and slides — consistent, no layout changes |
| Comment creation UI | Floating button + shadcn `Popover` | Lighter than `Dialog`, matches Google Docs UX, uses existing popover pattern from toolbar |
| Comment viewing | shadcn `Popover` on highlight click | Replaces `Dialog`-based `ViewCommentDialog`, inline experience |
| Resolved visibility | CSS decoration, not Yjs | Keeps collaborative doc clean, visual-only change |
| Filtering strategy | Client-side intersection | Yjs doc already loaded, comment list is small (<100) |
| Anchor text in panel | `anchorTexts` map prop, extracted by app | App walks doc (debounced), passes map to shared panel |
| Comment styles location | Shared stylesheet in packages/ui | Consistent with project convention for shared prose/code styles |
| Doc traversal performance | Debounced 200ms | Fires on every collab update, debounce avoids expensive walks on each keystroke |
| Chat message rendering | Reuse existing `ChatMessageList` + `ChatMessageInput` | Already shared in packages/ui, used by chat, docs, stickies |
| All UI primitives | shadcn components | `Popover`, `Dialog`, `Button`, `Tabs`, `Select`, `Textarea`, `ScrollArea`, `Badge` |

## Files to Create

| File | Purpose |
|------|---------|
| `packages/ui/src/components/layout/comments/comment-thread.tsx` | Single thread: `ChatMessageList` + resolve + reply (reuses shared chat components) |
| `packages/ui/src/components/layout/comments/comment-panel.tsx` | Full panel using `PropertiesPanel` container: tabs, filters, comment list |
| `packages/ui/src/components/layout/comments/comment-creation.tsx` | Inline creation via shadcn `Popover` with `Textarea` + `Button` |
| `packages/ui/src/components/layout/comments/add-comment-button.tsx` | Floating button shown on text selection |
| `packages/ui/src/components/layout/comments/index.ts` | Barrel exports |

## Files to Modify

| File | Change |
|------|--------|
| `apps/docs/src/components/docs/editor.tsx` | Add `'comments'` to `sidebarContext`, render `CommentPanel` in existing overlay slot, remove dialog imports |
| `apps/docs/src/components/docs/editor-toolbar.tsx` | Dual-mode comment button, unresolved badge |
| `apps/docs/src/components/docs/extensions/comment-mark.ts` | Add resolved decorations plugin, `addKeyboardShortcuts()` |
| `packages/ui/src/styles/eigen-prose.css` | Move comment-highlight + resolved styles to shared stylesheet |
| `apps/docs/css/globals.css` | Remove comment-highlight styles (moved to shared) |
| `packages/ui/src/index.ts` | Export new comment components |
| `packages/lib/src/types/chat.ts` | Add `CommentListItem` type |
| `packages/lib/src/core/chat/hooks/use-comments.ts` | Type `useComments` return as `CommentListItem[]` |

## Files to Delete

| File | Reason |
|------|--------|
| `apps/docs/src/components/docs/comment-dialog.tsx` | Replaced by shared components |

## No Backend Changes Required

The existing backend fully supports this redesign:
- `GET /collab/.../comments` — list with mentions (used by side panel)
- `PATCH .../comments/:chatName/status` — resolve/reopen (used by CommentThread)
- `GET /collab/.../comments/unresolved-count` — badge count
- SSE `CHAT_COMMENT_INDEX_UPDATED` — real-time updates
- Chat creation + message posting — unchanged
