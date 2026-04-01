# Comments — Redesign Plan

> **TLDR**: Replace the current modal-based comment system with inline creation (floating "Add comment" button on text
> selection), a shared `<CommentThread>` component (with resolve/reopen), and a shared `<CommentSidePanel>` that opens
> as a right Column. All shared UI lives in `packages/ui`, all hooks in `packages/lib`. App-specific code is limited to
> extracting active comment IDs from the Yjs document and wiring the side panel into the app's `ColumnLayout`.

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
2. **Shared `<CommentThread>`** — renders a single comment thread with resolve/reopen, used both inline (popover when
   clicking a highlight) and in the side panel
3. **Resolved comments hidden in doc** — resolved `CommentMark`s get a different style (no highlight) or are hidden
4. **Shared `<CommentSidePanel>`** — opens as a right `Column` (350px), shows all comments with filters
5. **Filter by current revision** — only show comments whose `chatName` exists in the current Yjs document state
6. **Reusable across apps** — docs first, then slides/sheets/stickies with minimal per-app wiring

## Architecture

### Layer Split

```
packages/ui/src/components/layout/comments/
├── comment-thread.tsx         # Single comment thread (messages + resolve + reply input)
├── comment-side-panel.tsx     # Full panel: header, filters, comment list
├── comment-creation.tsx       # Inline comment creation (popover with textarea)
└── add-comment-button.tsx     # Floating button shown on text selection

packages/lib/src/core/chat/hooks/
├── use-comments.ts            # Already exists — useComments, useResolveComment, etc.
└── (no changes needed)

apps/docs/src/components/docs/
├── extensions/comment-mark.ts # Update: add resolved styling, selection button positioning
├── editor.tsx                 # Update: wire side panel Column, remove modal dialogs
└── comment-dialog.tsx         # DELETE — replaced by shared components
```

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

When the user clicks the floating button (or presses `Cmd+Alt+M`), a small popover appears anchored to the
selection with a textarea and submit button. Much lighter than the current full-screen dialog.

```
┌────────────────────────────────┐
│ ┌────────────────────────────┐ │
│ │ Write a comment...         │ │
│ │                            │ │
│ └────────────────────────────┘ │
│                    [Cancel] [Comment] │
└────────────────────────────────┘
```

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
can apply the mark. Same flow as current `CreateCommentDialog` but without the modal.

### 3. CommentThread

Shared component for rendering a single comment's message thread. Used in two places:
1. **Inline popover** — when clicking a comment highlight in the doc (replaces `ViewCommentDialog`)
2. **Inside the side panel** — each comment in the list is a `CommentThread`

```typescript
type CommentThreadProps = {
    ownerId: string;
    mountId: string;
    chatName: string;
    status: 'open' | 'resolved';
    /** Compact mode for side panel (fewer messages shown, no full chat input) */
    compact?: boolean;
    onResolve?: () => void;
    onReopen?: () => void;
    onDelete?: () => void;
    onScrollToAnchor?: () => void;
    className?: string;
};
```

**Features:**
- Shows message thread via `ChatMessageList` (or a lighter variant in compact mode)
- Resolve button (checkmark) — calls `useResolveComment` mutation
- Reopen button — appears on resolved comments
- Reply input — `ChatMessageInput` (full in popover, simplified in side panel)
- "Go to text" link — calls `onScrollToAnchor` to scroll the editor to the highlighted text

**Location**: `packages/ui/src/components/layout/comments/comment-thread.tsx`

### 4. CommentSidePanel

Opens as a right `Column` (same pattern as drive detail panel). Triggered by the comment icon in the toolbar.

```typescript
type CommentSidePanelProps = {
    ownerId: string;
    mountId: string;
    containerId: string;
    currentUserEmail: string;
    /** Set of chatNames present in the current document revision */
    activeCommentIds: Set<string>;
    /** Map of chatName → quoted anchor text, extracted from the doc by the app */
    anchorTexts: Map<string, string>;
    onClose: () => void;
    onScrollToComment?: (chatName: string) => void;
};
```

**Layout:**
```
┌──────────────────────────────────┐
│ Comments                      ✕  │
├──────────────────────────────────┤
│ [All comments] [For you]        │
│ ┌─ Filter: [Open ▾] ──────────┐ │
│                                  │
│ ┌──────────────────────────────┐ │
│ │ "The quick brown fox..."     │ │
│ │ Alice · 2 min ago        ✓  │ │
│ │ This needs rewording         │ │
│ │ [Reply...]                   │ │
│ └──────────────────────────────┘ │
│                                  │
│ ┌──────────────────────────────┐ │
│ │ "jumps over the lazy dog"   │ │
│ │ Bob · 1 hour ago         ✓  │ │
│ │ Great paragraph!             │ │
│ │ [Reply...]                   │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

**Tabs / Filters:**
- **All comments**: all open comments whose `chatName` is in `activeCommentIds`
- **For you**: same, filtered to comments where `mentions[]` includes `currentUserEmail`
- **Status filter dropdown**: Open (default), Resolved, All
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
- Resolve button (checkmark)
- Click → expand to full `CommentThread` inline, or scroll to anchor in doc

**Location**: `packages/ui/src/components/layout/comments/comment-side-panel.tsx`

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

`TiptapEditor` currently renders a bare `<Column id="doc-editor" width="w-full">` inside a fragment (`<>...</>`).
There is **no** `ColumnLayout` in the parent route chain — the doc route (`_auth.doc.$ownerId.$mountId.$pathId.tsx`)
wraps the editor in a plain `<div className="flex-1 overflow-hidden">`. This means we can safely introduce a
`ColumnLayout` inside `TiptapEditor` without nesting conflicts.

The `MediaResolverProvider` wraps `TiptapEditor` in `CollaborativeEditor`, so both the editor Column and the
comment panel Column will have access to `useMediaResolver()` (needed for `resolveChatId`).

The figure/table property panels are absolute-positioned overlays inside the editor Column. When the comment
side panel is open, these overlays remain inside the editor Column and do not conflict. If both a property panel
and the comment panel are visible simultaneously, they occupy separate space (overlay inside editor vs. Column
to the right).

### Updated editor.tsx Layout

```tsx
// Current: bare <Column> with fragment wrapper and modal dialogs
// New: <ColumnLayout> with editor Column + optional comment Column, no modals

<ColumnLayout mobileColumn={commentPanelOpen ? 'comments' : 'doc-editor'}>
    <Column id="doc-editor" width="flex" toolbar={<EditorToolbar ... />}>
        {/* existing editor content + figure/table property overlays */}
        {/* + floating add-comment button */}
        {/* + inline comment creation popover */}
        {/* + inline comment view popover (replaces ViewCommentDialog) */}
    </Column>

    {commentPanelOpen && (
        <Column
            id="comments"
            width="350px"
            onBack={() => setCommentPanelOpen(false)}
            toolbar={<Toolbar><span className="font-semibold text-sm">Comments</span>
                       <TooltipButton icon={X} onClick={close} /></Toolbar>}
        >
            <CommentSidePanel
                ownerId={path.ownerId}
                mountId={path.mountId}
                containerId={path.id}
                currentUserEmail={auth.user!.email}
                activeCommentIds={activeCommentIds}
                anchorTexts={anchorTexts}
                onClose={() => setCommentPanelOpen(false)}
                onScrollToComment={scrollToComment}
            />
        </Column>
    )}
</ColumnLayout>
```

Note: the editor Column width changes from `w-full` (current) to `flex`. With `ColumnLayout`, `flex` means
"take remaining space" (`flex: 1 1 auto`), which is correct when the comment panel takes 350px.

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

The `ColumnLayout` handles mobile automatically via `mobileColumn` — when the comment panel is open on mobile,
it replaces the editor view (full-screen panel with back button). This matches the drive detail pattern.

**Floating "Add comment" button**: Not practical on mobile — text selection is OS-controlled and positioning a
floating button in the margin doesn't work on narrow screens. On mobile, the toolbar button remains the primary
way to add comments (requires text selection first, same as current behavior).

**Inline popovers**: Comment creation and view popovers should render as bottom sheets or full-width panels on
mobile instead of anchored popovers. Use `isMobile` from `useLayout()` to switch rendering mode.

**Initial implementation**: Desktop-first. Mobile support for the side panel comes free via `ColumnLayout`.
Mobile-specific popover rendering can be deferred to a follow-up.

## Implementation Order

### Step 1: Shared CommentThread component
- Create `packages/ui/src/components/layout/comments/comment-thread.tsx`
- Renders messages, resolve/reopen button, reply input
- Uses existing `useComments`, `useResolveComment` hooks
- Test in isolation

### Step 2: CommentSidePanel
- Create `packages/ui/src/components/layout/comments/comment-side-panel.tsx`
- Tabs (All / For you), status filter dropdown
- Accepts `activeCommentIds` prop for revision-aware filtering
- Each item renders `CommentThread` in compact mode

### Step 3: Wire into docs editor
- Add `ColumnLayout` wrapper to `editor.tsx`
- Add comment panel `Column` (conditional on `commentPanelOpen` state)
- Implement `useActiveCommentIds` hook
- Update toolbar button to toggle panel
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
| Side panel vs overlay | `Column` (350px) | Matches drive detail pattern, responsive, mobile-ready |
| Comment creation UI | Floating button + popover | Lighter than modal, matches Google Docs UX |
| Resolved visibility | CSS decoration, not Yjs | Keeps collaborative doc clean, visual-only change |
| Filtering strategy | Client-side intersection | Yjs doc already loaded, comment list is small (<100) |
| Anchor text in panel | `anchorTexts` map prop, extracted by app | App walks doc (debounced), passes map to shared panel |
| Comment styles location | Shared stylesheet in packages/ui | Consistent with project convention for shared prose/code styles |
| Doc traversal performance | Debounced 200ms | Fires on every collab update, debounce avoids expensive walks on each keystroke |

## Files to Create

| File | Purpose |
|------|---------|
| `packages/ui/src/components/layout/comments/comment-thread.tsx` | Single comment thread with resolve/reply |
| `packages/ui/src/components/layout/comments/comment-side-panel.tsx` | Full panel with filters and comment list |
| `packages/ui/src/components/layout/comments/comment-creation.tsx` | Inline popover for creating comments |
| `packages/ui/src/components/layout/comments/add-comment-button.tsx` | Floating button on text selection |

## Files to Modify

| File | Change |
|------|--------|
| `apps/docs/src/components/docs/editor.tsx` | Add ColumnLayout, comment panel Column, remove dialog usage |
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
