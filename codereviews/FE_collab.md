# Frontend Code Review: Collaborative Apps (Docs, Stickies, Slides, Sheets)

> **Reviewer**: Claude Opus 4.6 (1M context)
> **Scope**: `apps/docs/src/`, `apps/stickies/src/`, `apps/slides/src/`, `apps/sheets/src/`,
> `packages/lib/src/core/collab/`, `packages/lib/src/core/editor/`
> **Date**: 2026-03-19 (full re-review of all source files)

---

## 1. Architecture Overview

All four collab apps follow a consistent structural pattern:

```
App shell (__root.tsx)
  -> Auth guard (_auth.tsx)
     -> Sidebar routes (_auth._sidebar.tsx)
        -> File list (mime.$mimeType.tsx, shared.$to.tsx)
     -> Editor route (_auth.[type].$ownerId.$mountId.$pathId.tsx)
        -> useCollabDocumentInfo() for access/path/folder-contents
        -> Yjs Doc + WebsocketProvider for real-time sync
        -> App-specific editor component
```

### 1.1 Yjs Provider Setup

Each app creates its own `Y.Doc` and `WebsocketProvider` directly (no shared abstraction). The WebSocket URL is
constructed via `getCollabWebSocketUrl(ownerId, mountId, pathId)`. All four apps use `resyncInterval: 5000`.

| App      | Yjs Keys                          | Sync Model         | Undo/Redo              |
|----------|-----------------------------------|--------------------|------------------------|
| Docs     | `default` (Tiptap Collaboration)  | CRDT (Tiptap/Yjs)  | Tiptap history         |
| Stickies | `columns`, `tasks`, `columnOrder` | CRDT (Y.Map/Array) | `Y.UndoManager`        |
| Slides   | `slides`, `objects`, `slideOrder` | CRDT (Y.Map/Array) | `Y.UndoManager`        |
| Sheets   | `state` (Y.Map), `ops` (Y.Array)  | Op-based           | fortune-sheet built-in |

### 1.2 Revision Restore

All apps support revision history via the shared `<RevisionHistory>` component. Each implements a
`handleRestore(state: Uint8Array)` callback that applies a historical Yjs update to the live document:

- **Docs**: Decodes the snapshot to ProseMirror JSON via `yDocToProsemirrorJSON`, then calls
  `editor.commands.setContent(json)`. Clean and Tiptap-idiomatic.
- **Stickies, Slides, Sheets**: Use a generic "clear all shared types + repopulate from temp doc" approach. This logic
  is duplicated across all three apps.

### 1.3 Media Resolution

Docs, Stickies, and Slides wrap their editors in `<MediaResolverProvider>` from `@workspace/lib/drive`. This provider
resolves file names to pathIds/URLs using the existing `useFolderContent` hook, following the name-based reference
pattern documented in [MEDIA-REFERENCES.md](/docs/MEDIA-REFERENCES.md).

### 1.4 Clipboard

Docs and Slides implement the Eigen clipboard protocol (`EigenClipboardData`) for cross-app copy/paste of images and
text objects with re-upload detection via `needsReUpload()`.

---

## 2. Issues

### 2.1 Critical

#### C1. Docs: Comment creation swallows errors silently

**File**: `apps/docs/src/components/docs/comment-dialog.tsx`, lines 33-53

The `handleSubmit` function in `CreateCommentDialog` has a `try/finally` but no `catch` block and no `toast.error()`.
If chat creation or message posting fails, the dialog closes silently with the user seeing no feedback. The comment mark
may not be applied, but the user cannot tell.

```typescript
try {
    const result = await createChat.mutateAsync({parentId: chatFolderId, fileName});
    const chatPath = result as DrivePath;
    if (chatPath?.id) {
        // ... post message ...
        onCommentCreated(chatPath.name);
    }
} finally {
    setIsSubmitting(false);
    setComment('');
    onOpenChange(false); // always closes, even on failure
}
```

**Impact**: Silent failure on comment creation. User thinks comment was created but nothing happened.
**Fix**: Add `catch` block with `toast.error()`. Only close/reset on success.

#### C2. Stickies/Slides: Revision restore pushes raw JSON into Y.Array instead of Yjs types

In `handleRestore`, the `Y.Array` branch does:

```typescript
localType.push(json);
```

where `json` is the result of `tempDoc.getArray(key).toJSON()`. For simple arrays of primitives (like `columnOrder`
or `slideOrder`), this works because `Y.Array.push()` accepts primitive arrays. But the `Y.Map` branch correctly uses
`jsonToYType()` to convert nested structures. This inconsistency means if a Y.Array ever holds nested Y.Maps, the
restore will silently produce plain objects instead of collaborative Yjs types.

The sheets variant (`use-sheet.ts:176`) has a separate but related issue: it pushes plain JSON values into Y.Map with
`localType.set(k, v as any)` without using `jsonToYType()` at all.

- `apps/stickies/src/components/stickies/board.tsx:108`
- `apps/slides/src/components/slides/editor.tsx:359`
- `apps/sheets/src/components/sheets/hooks/use-sheet.ts:176`

**Impact**: For stickies/slides (string-only arrays) this is latent risk. For sheets, restoring the `ops` Y.Array
produces non-Yjs objects. Restoring Y.Map values in sheets uses `as any` instead of `jsonToYType`.
**Fix**: Use `jsonToYType(v)` consistently in both Y.Map and Y.Array restore branches across all three apps.

### 2.2 Important

#### I1. Stickies `useBoard` and Slides `useDeck` return stale `.current` from refs

Both hooks return `docRef.current` and `undoManager.current` at render time:

- `apps/stickies/src/components/stickies/hooks/use-board.ts:218-219`
- `apps/slides/src/components/slides/hooks/use-deck.ts:452-453`

On the initial render (before `useEffect` runs), these are `null`. They only become non-null after a Yjs observer
triggers a state update. Consumer code guards with `?.` and `if (!yjsDoc)`, so operations during the race window
are silently dropped rather than crashing.

**Impact**: Low probability in practice; user actions before first Yjs sync are silently ignored.
**Fix**: Store `Y.Doc` and `UndoManager` in `useState` so assignment triggers a re-render, or add a `connected` flag.

#### I2. Hardcoded colors throughout docs and slides break dark mode

The project rule mandates theme tokens over hardcoded colors. Several violations:

| File                                                           | Line | Issue                                                        |
|----------------------------------------------------------------|------|--------------------------------------------------------------|
| `apps/docs/src/components/docs/editor.tsx`                     | 135  | `color: '#3b82f6'` dropcursor                                |
| `apps/docs/src/components/docs/editor.tsx`                     | 156  | `class: 'text-blue-600 underline cursor-pointer'` link style |
| `apps/docs/src/components/docs/editor.tsx`                     | 185  | `color: '#9810fa'` collaboration cursor                      |
| `apps/docs/src/components/docs/extensions/resizable-image.tsx` | 72   | `border border-blue-500` selection                           |
| `apps/docs/src/components/docs/extensions/resizable-image.tsx` | 81   | `bg-white` floating toolbar                                  |
| `apps/slides/src/components/slides/slide-object.tsx`           | 219  | `bg-white border-2 border-blue-500` resize handles           |
| `apps/slides/src/components/slides/slide-thumbnail.tsx`        | 39   | `border-blue-500` active indicator                           |
| `apps/slides/src/components/slides/slide-panel.tsx`            | 88   | `border-blue-500` drag overlay                               |
| `apps/slides/src/components/slides/slide-canvas.tsx`           | 141  | `backgroundColor: '#3b82f6'` snap lines                      |

**Impact**: All highlighted elements are invisible or clash in dark mode.
**Fix**: Use `border-primary`, `ring-primary`, `bg-popover`, `text-primary` etc.

Note: The collaboration cursor color (`#9810fa`) also means every user sees the same purple cursor, providing no way
to distinguish multiple collaborators.

#### I3. Slides: `OBJECT_FIELDS` manually maintained, prone to desync with types

**File**: `apps/slides/src/components/slides/hooks/use-deck.ts`, line 11

```typescript
const OBJECT_FIELDS = ['id', 'slideId', 'type', 'x', 'y', 'w', 'h', 'rotation', 'shadowColor', ...] as const;
```

This manually-maintained array includes `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` -- fields that
do not exist in the `SlideObject` type definition (`types.ts`). If a new field is added to the type but not this array,
it will be silently dropped when reading from Yjs.

**Impact**: Phantom fields are harmlessly read; missing fields would silently cause data loss on Yjs->React sync.
**Fix**: Derive field list from the type or use `yMap.toJSON()` instead.

#### I4. `jsonToYType` utility duplicated in stickies and slides

The exact same function appears in:

- `apps/stickies/src/components/stickies/board.tsx:20-34`
- `apps/slides/src/components/slides/editor.tsx:62-76`

**Fix**: Extract to `packages/lib/src/utils/yjs.ts`.

#### I5. Restore logic duplicated across three apps

Nearly identical `handleRestore` implementations:

- `apps/stickies/src/components/stickies/board.tsx:89-113`
- `apps/slides/src/components/slides/editor.tsx:340-364`
- `apps/sheets/src/components/sheets/hooks/use-sheet.ts:160-199`

All iterate shared Yjs keys, clear Y.Map/Y.Array, and repopulate. The core transplant logic should be a shared
function.

**Fix**: Extract `restoreYjsDocument(liveDoc, snapshotState)` to `packages/lib/src/utils/yjs.ts`.

#### I6. Slides: `duplicateSlide` and several callbacks depend on `[deck]`, defeating memoization

**File**: `apps/slides/src/components/slides/hooks/use-deck.ts`

| Callback            | Line | Dependency                         |
|---------------------|------|------------------------------------|
| `deleteSlide`       | 175  | `[activeSlideId, deck.slideOrder]` |
| `duplicateSlide`    | 218  | `[deck]`                           |
| `moveObjectUp`      | 311  | `[deck.objects]`                   |
| `moveObjectDown`    | 330  | `[deck.objects]`                   |
| `moveObjectToFront` | 349  | `[deck.objects]`                   |
| `moveObjectToBack`  | 368  | `[deck.objects]`                   |

`deck` changes on every Yjs observer event, so these callbacks are recreated every render, defeating `useCallback`.

**Fix**: Read from `docRef.current` Yjs maps directly instead of the derived `deck` state.

#### I7. Stickies/Slides: No loading indicator before Yjs sync

Unlike docs (which shows `<EigenLoader/>` until `connected`), slides renders the full editor with empty state and shows
"No slides yet" until sync fires. Stickies uses `visibility: hidden` when `columnOrder.length <= 1`
(`board.tsx:176`).

**Impact**: Flash of "No slides yet" or hidden content before sync, confusing on slow connections.
**Fix**: Add a `synced` state flag; show `<EigenLoader/>` until true.

#### I8. Docs: `editorRef.current = editor` assigned during render

**File**: `apps/docs/src/components/docs/editor.tsx:270`

Side effect during render. The `editor` from `useEditor` is written to a ref so async callbacks can access the latest
instance. React 19 strict mode may call render twice.

**Fix**: Move to `useEffect(() => { editorRef.current = editor; }, [editor])`.

#### I9. Docs: `useEditor` deps don't include `access.canWrite`

**File**: `apps/docs/src/components/docs/editor.tsx:268`

The `useEditor` hook is configured with `editable: access.canWrite` (line 129), but the dependency array is
`[handleCommentClick]`. If write permission is revoked while the document is open (e.g., ACL change by another user),
the editor remains editable.

**Fix**: Call `editor.setEditable(access.canWrite)` in a `useEffect` watching `access.canWrite`.

#### I10. Slides: Presentation mode missing keyboard navigation and has non-standard right-click

**File**: `apps/slides/src/components/slides/editor.tsx:377-418`

- Navigation: Click = next slide, right-click (`onContextMenu`) = previous. No arrow key support.
- The `Escape` hotkey (line 155) sets `isPresenting = false` but does not call `document.exitFullscreen()`, causing
  state desynchronization.

**Fix**: Add `ArrowRight`/`Space` = next, `ArrowLeft` = previous, `Escape` = exit presentation + exit fullscreen.

#### I11. Slides: `handleDragOver` shows copy cursor even when read-only

**File**: `apps/slides/src/components/slides/slide-canvas.tsx:81-84`

Always sets `dropEffect = 'copy'` regardless of whether `onDropImage` is provided. In read-only mode, the cursor
misleads users into thinking drop will work.

**Fix**: Guard with `if (!onDropImage) return;` before `preventDefault`.

#### I12. Stickies: `CardSettingsDialog` initial state stale when card changes

**File**: `apps/stickies/src/components/stickies/card-settings-dialog.tsx:23-25`

`useState(cardTitle)`, `useState(cardDescription)`, `useState(cardColor)` capture props at mount time. If another
collaborator edits the card while the dialog is open, the input shows stale data.

**Fix**: Use a `key` prop on `CardSettingsDialog` tied to `cardId`, or sync state with a `useEffect`.

Same issue for `ColumnSettingsDialog` (`column-settings-dialog.tsx:18`).

### 2.3 Minor

#### M1. All four apps: Root component named `DocsRoot` in stickies, slides, and sheets

- `apps/stickies/src/routes/__root.tsx:18`
- `apps/slides/src/routes/__root.tsx:18`
- `apps/sheets/src/routes/__root.tsx:18`

Copy-paste artifact. Should be `StickiesRoot`, `SlidesRoot`, `SheetsRoot`.

#### M2. All four apps: `interface MyRouterContext` instead of `type`

All `__root.tsx` files use `interface` (`apps/docs/src/routes/__root.tsx:14`, etc.), violating the project's "type
over interface" convention.

Additional `interface` violations:

- `apps/docs/src/components/docs/docs-sidebar.tsx:12` -- `interface DocsSidebarProps`
- `apps/slides/src/components/slides-sidebar.tsx:12` -- `interface SlidesSidebarProps`

#### M3. Stickies: `normalizeBoard` runs on every Yjs observer callback

**File**: `apps/stickies/src/components/stickies/hooks/use-board.ts:105`

Called inside `updateReactState` which fires on every deep observation. Since `normalizeBoard` modifies the Yjs doc
(deleting duplicates, adopting orphans), this can trigger recursive observer calls. Yjs handles recursion, but it
creates unnecessary work.

Same for `normalizeDeck` in slides (`use-deck.ts:83`).

**Fix**: Only normalize on sync or structural changes.

#### M4. Stickies: `CardSettingsDialog` delete uses `return` instead of `continue`

**File**: `apps/stickies/src/components/stickies/card-settings-dialog.tsx:53`

```typescript
for (const [, columnMapValue] of columnsMap) {
    if (!(columnMapValue instanceof Y.Map)) return; // BUG: exits transact callback
    // ...
}
```

If any column value is not a Y.Map, the entire transaction callback exits early, potentially leaving the task in
`tasksMap`.

**Fix**: Replace `return` with `continue`.

#### M5. Stickies: `DeleteDialog` nested inside `Dialog` in `ColumnSettingsDialog`

**File**: `apps/stickies/src/components/stickies/column-settings-dialog.tsx:99-105`

The `DeleteDialog` is inside the parent `Dialog`'s content tree. This can cause z-index and focus trap issues.
`card-settings-dialog.tsx` correctly renders it as a sibling using `<>`.

**Fix**: Move `DeleteDialog` outside the parent `Dialog`, matching the pattern in `card-settings-dialog.tsx`.

#### M6. All apps: Shared route files (`mime.$mimeType.tsx`, `shared.$to.tsx`) heavily duplicated

Each app has nearly identical file-list route files. The only differences are MIME type filters, navigation targets,
and which `allowCreate*` props are set. These could be extracted to a shared route factory.

#### M7. Docs: Dynamic import of `chatApi` in comment creation

**File**: `apps/docs/src/components/docs/comment-dialog.tsx:43`

```typescript
const {chatApi} = await import("@workspace/lib/api");
```

Adds async overhead to every comment. Likely to break circular imports.

#### M8. Sheets: `SheetData` type is too loose

**File**: `apps/sheets/src/components/sheets/hooks/use-sheet.ts:7`

```typescript
export type SheetData = Record<string, any> & { name: string };
```

This effectively opts out of type safety and cascades `as any` usage throughout the sheets code.

#### M9. Sheets: Snapshot debounce + unreliable `beforeunload` creates data-loss window

After the first flush, snapshots are debounced to 1 second (`use-sheet.ts:156`). The `beforeunload` handler
attempts a synchronous Yjs transaction, which is unreliable on mobile browsers. While ops are synced immediately,
the snapshot for new joiners will be stale.

---

## 3. Strengths

### 3.1 Consistent Architecture

All four apps follow the same structural pattern: AppShell wrapping, auth guards, DriveContext for root path, sidebar
with MIME-filtered file listing, and a full-screen editor route. This makes the codebase predictable and navigable.

### 3.2 Name-Based Media References

Docs, stickies, and slides correctly use name-based references (e.g., `mediaName`, `chatName`) stored in Yjs. The
`MediaResolverProvider` pattern provides clean resolution at render time, making document copy trivial (no Yjs
rewriting needed).

### 3.3 Clipboard Protocol

The Eigen clipboard in docs and slides supports cross-app image paste with automatic re-upload detection via
`needsReUpload(sourceParentId, targetFolderId)`. The clipboard data format includes source coordinates and style
metadata, enabling faithful reproduction of objects across documents.

### 3.4 Yjs Data Normalization

Both `normalizeBoard` (stickies) and `normalizeDeck` (slides) handle CRDT convergence edge cases: deduplicating
items that appear in multiple containers and adopting orphaned items. This is thoughtful defense against concurrent
editing conflicts.

### 3.5 `validateSearch` Correctly Extracts `uid`

All `shared.$to.tsx` and `mime.$mimeType.tsx` routes extract both `pid` and `uid` from search params. This avoids
the documented pitfall of shared item detail panes breaking when `uid` is missing.

### 3.6 Op-Based Sheets Sync

The sheets Yjs integration pushes individual cell operations to a Y.Array rather than full JSON snapshots. This
provides good conflict resolution for concurrent edits on different cells.

### 3.7 Slides Snap Lines

The `useSnapTargets` + `snapRect` system computes alignment snaps from other objects, slide edges, and center lines.
Both move and resize modes are supported, with visual feedback via rendered snap lines.

### 3.8 Proper Access Control Propagation

All editor routes check `docInfo.canWrite` and propagate it through to toolbars (conditionally showing edit controls),
canvas interactions (disabling drag/resize), and `DocumentModeButton` (showing read-only indicator).

---

## 4. Coverage Analysis

| Feature                     | Docs | Stickies  | Slides  | Sheets  |
|-----------------------------|------|-----------|---------|---------|
| Yjs real-time sync          | Yes  | Yes       | Yes     | Yes     |
| Revision history            | Yes  | Yes       | Yes     | Yes     |
| Undo/redo                   | Yes  | Yes       | Yes     | Yes*    |
| Media references            | Yes  | Yes(chat) | Yes     | No      |
| Clipboard (Eigen format)    | Yes  | No        | Yes     | No      |
| Access control (read/write) | Yes  | Yes       | Yes     | Yes     |
| Drag-and-drop               | N/A  | Yes       | Yes     | N/A     |
| Mobile support              | Yes  | Yes       | Partial | Partial |
| Print support               | Yes  | No        | No      | No      |
| Error feedback on mutations | No   | Partial   | Partial | No      |
| Connection status UI        | No   | No        | No      | No      |
| Accessibility (ARIA)        | No   | No        | No      | N/A     |

\* Sheets undo/redo is handled by fortune-sheet internally, not by `Y.UndoManager`.

---

## 5. Relevant Files

### Shared Libraries

- `/packages/lib/src/core/collab/hooks/use-collab.ts` -- `useCollabDocumentInfo`, `useCollabRevisions`, query keys
- `/packages/lib/src/core/editor/hooks/use-file-content.ts` -- `useFileContent` (for inline text editing, not collab)
- `/packages/lib/src/core/editor/hooks/use-file-save.ts` -- `useFileSave` (for inline text editing, not collab)

### Docs

- `/apps/docs/src/components/docs/editor.tsx` -- Main Tiptap editor with Yjs collaboration
- `/apps/docs/src/components/docs/editor-toolbar.tsx` -- Full formatting toolbar (715 lines)
- `/apps/docs/src/components/docs/extensions/resizable-image.tsx` -- Drag-resizable image node
- `/apps/docs/src/components/docs/extensions/comment-mark.ts` -- Inline comment mark
- `/apps/docs/src/components/docs/comment-dialog.tsx` -- Comment create/view dialogs

### Stickies

- `/apps/stickies/src/components/stickies/hooks/use-board.ts` -- Yjs board management + card/column CRUD
- `/apps/stickies/src/components/stickies/hooks/use-drag-and-drop.ts` -- DnD with Yjs sync
- `/apps/stickies/src/components/stickies/normalize-board.ts` -- CRDT normalization
- `/apps/stickies/src/components/stickies/board.tsx` -- Main board with DnD context + restore logic

### Slides

- `/apps/slides/src/components/slides/hooks/use-deck.ts` -- Yjs deck management (455 lines)
- `/apps/slides/src/components/slides/hooks/use-object-drag.ts` -- Canvas drag/resize
- `/apps/slides/src/components/slides/hooks/use-snap-lines.ts` -- Alignment snapping
- `/apps/slides/src/components/slides/editor.tsx` -- Main editor + clipboard + presentation mode (509 lines)
- `/apps/slides/src/components/slides/slide-object.tsx` -- Object rendering + shared style helpers
- `/apps/slides/src/components/slides/slide-properties-panel.tsx` -- Properties panel (575 lines)

### Sheets

- `/apps/sheets/src/components/sheets/hooks/use-sheet.ts` -- Op-based Yjs sync (209 lines)
- `/apps/sheets/src/components/sheets/editor.tsx` -- Fortune-sheet workbook wrapper

### Documentation

- `/docs/STICKIES.md`, `/docs/SLIDES.md`, `/docs/SHEETS.md` -- Architecture docs
- `/docs/MEDIA-REFERENCES.md` -- Name-based reference system

---

## 6. Summary

The collab apps are architecturally sound with a consistent pattern across all four apps. The Yjs integration is
well-structured with CRDT normalization for conflict resolution, and the media reference system is elegantly designed.

**Priority fixes:**

1. **Error feedback** (C1) -- Comment creation and other mutations lack `toast.error()` or `catch` blocks
2. **Restore consistency** (C2) -- Y.Array restore branches should use `jsonToYType()` like the Y.Map branches
3. **Hardcoded colors** (I2) -- Multiple `border-blue-500`, `bg-white`, `text-blue-600` violations need theme tokens
4. **Stale ref returns** (I1) -- `useBoard`/`useDeck` should use state instead of returning ref snapshots
5. **Code deduplication** (I4, I5) -- Extract `jsonToYType` and `restoreYjsDocument` to shared utility
6. **Slides presentation mode** (I10) -- Add keyboard navigation and fix Escape/fullscreen desync
