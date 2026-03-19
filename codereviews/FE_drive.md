# Frontend Review: Drive App

**Scope:** `apps/drive/` (all source files), `apps/drive/css/globals.css`, plus shared components in
`packages/ui/src/components/layout/drive/`, `packages/lib/src/core/drive/`, `packages/lib/src/core/editor/`
**Reviewed:** 2026-03-19

---

## Architecture Overview

The Drive app is a file management frontend built around a shared `DriveLayout` component. It provides four
authenticated
routes plus a login page:

| Route                             | File                                       | Purpose                        |
|-----------------------------------|--------------------------------------------|--------------------------------|
| `/fs/$ownerId/$mountId/$pathId`   | `_auth.fs.$ownerId.$mountId.$pathId.tsx`   | Main folder browser            |
| `/edit/$ownerId/$mountId/$pathId` | `_auth.edit.$ownerId.$mountId.$pathId.tsx` | Inline text file editor        |
| `/shared/$to`                     | `_auth.shared.$to.tsx`                     | Shared files (by-me / with-me) |
| `/mime/$mimeType`                 | `_auth.mime.$mimeType.tsx`                 | Files filtered by MIME type    |

**Routing**: TanStack Router with file-based conventions. Auth guard in `_auth.tsx` using `beforeLoad` redirect.
The root route (`__root.tsx`) initializes `DriveContext` with the root folder path and default mount ID, wrapping all
child routes in `AppShell` + `DriveContext.Provider`.

**File listing**: All four authenticated routes delegate to `DriveLayout` (in `packages/ui`), which orchestrates
`DriveList` (with `DriveTable`), `DriveDetail`, and 10+ dialog components for CRUD operations. The fs route passes
folder contents from `useFolderContent`; the mime route uses `useMimeContent`; the shared route uses `useSharedPaths`.

**Upload**: File uploads go through `DriveUploadFiles`, which uses `uploadWithProgress` for XHR-based progress tracking
via the shared `UploadProvider`. External file drops are handled by `DriveList` using a `dragCounter` ref pattern for
accurate enter/leave tracking on nested elements.

**Preview**: Quick Look opens via `PreviewProvider.openPreview()`, passing the current file and its siblings for
keyboard navigation. The preview overlay is in `packages/ui`.

**Inline editing**: Text files detected by `isInlineEditable()` navigate to the edit route. `NativeFileEditor`
dispatches between `MarkdownEditor` (Tiptap WYSIWYG with source mode toggle) and `CodeEditor` (CodeMirror 6), both
lazy-loaded via `React.lazy()`. Save logic is centralized in `useEditorSave` with optimistic concurrency, Cmd+S hotkey,
beforeunload protection, and conflict resolution dialog.

**Sharing UI**: `DriveAccessDialog` opens `DriveAccessListEdit`, which shows direct ACL entries, inherited entries (from
ancestor folders via `useBreadcrumb`), visibility toggle, and team sharing. The read-only `DriveAccessList` is embedded
in `DriveDetail`.

**Data hooks**: All in `packages/lib/src/core/drive/hooks/` and `packages/lib/src/core/editor/hooks/`. No direct
`useQuery`/`useMutation` calls in the app layer. Query keys follow the hierarchical pattern with `ownerId` scoping.

**SSE**: `handleDriveSSEvent` in `packages/lib/src/core/drive/sse-handlers.ts` dispatches to shared invalidation
functions for all drive event types.

---

## Critical Issues

### C1. Search Params `uid` Not Validated in Shared Route -- Detail Panel Broken for "Shared With Me"

**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:13-16, 23, 27`

The `validateSearch` function extracts both `pid` and `uid`:
```typescript
validateSearch: (search: Record<string, unknown>) => {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    const uid = typeof search.uid === 'string' ? search.uid : undefined;
    return {pid, uid} as DriveSearchParams;
},
```

However, the `uid` value is used on line 27 to fetch path info for the selected file:

```typescript
const {data: selectedPath = null} = usePathInfo(uid || '', mountId, pid || '');
```

When `uid` is empty (user has not yet selected a shared item), `usePathInfo` is called with `ownerId = ''`. The hook's
`enabled` guard (`!!ownerId`) prevents the fetch, which is correct. But more importantly, the shared route hardcodes
`mountId = DEFAULT_MOUNT_ID` on line 26, meaning files shared from non-default mounts (e.g., team mounts with custom
mount IDs) will fail the path lookup because the `mountId` in the API call won't match the file's actual mount.

The `uid` search param carries the *ownerId* of the shared file (set on line 48: `uid: path.ownerId`), but the mount ID
is never propagated -- it always falls back to `'default'`. For team drives with custom mounts, this will return a 404
from the API.

**Impact:** Detail panel fails silently for items on non-default mounts. Currently, most paths use the default mount, so
this affects only team drives with multiple mounts.

**Fix:** Add a `mid` search param for the mount ID, or resolve it from the `DrivePath` object directly.

---

### C2. `markDirty` Used Before Declaration in MarkdownEditor
**File:** `apps/drive/src/components/editor/markdown-editor.tsx:75-81, 93`

```typescript
const editor = useEditor({
    extensions: useMarkdownExtensions(content),
    content,
    onUpdate: () => {
        markDirty();       // line 79: references markDirty
    },
});
// ... lines 83-92 ...
const {saveState, showConflict, setShowConflict, markDirty, doSave, confirmClose} =
    useEditorSave({...});  // line 93: markDirty declared here
```

The `onUpdate` callback captures `markDirty` via closure before it is declared. This works at runtime because
`onUpdate` fires asynchronously (on user input), and by that time `markDirty` has been assigned. However:

1. If Tiptap ever calls `onUpdate` synchronously during editor initialization (some extensions do this), it will throw
   a `ReferenceError` due to the temporal dead zone of `const`.
2. The ordering dependency is invisible -- reordering the hook calls breaks the component with no compile-time warning.
3. ESLint's `no-use-before-define` would flag this.

**Impact:** Correctness risk. Works today but fragile against Tiptap updates or refactoring.

**Fix:** Use a ref to hold the markDirty function:
```typescript
const markDirtyRef = useRef<() => void>(() => {});
const editor = useEditor({
    extensions: useMarkdownExtensions(content),
    content,
    onUpdate: () => { markDirtyRef.current(); },
});
const {markDirty, ...rest} = useEditorSave({...});
markDirtyRef.current = markDirty;
```

---

### C3. `handleMovePath` Has No Error Handling

**File:** `packages/ui/src/components/layout/drive/drive-layout.tsx:110-113`

```typescript
const handleMovePath = async (path: DrivePath, targetItemId: string) => {
    if (!allowMove) return;
    await movePath.mutateAsync({pathId: path.id, targetParentId: targetItemId});
};
```

`mutateAsync` is awaited but has no try/catch and no `onError` callback on the mutation. If the move fails (e.g.,
permission denied, target folder deleted), the error propagates as an unhandled promise rejection. Per CLAUDE.md:
"Every mutation needs error feedback -- wrap `mutateAsync` in try/catch with `toast.error()`, or use the `onError`
callback."

**Impact:** Users who drag-and-drop a file to a folder where the move fails will see no feedback. The file appears to
stay in place with no error message.

**Fix:**

```typescript
const handleMovePath = async (path: DrivePath, targetItemId: string) => {
    if (!allowMove) return;
    try {
        await movePath.mutateAsync({pathId: path.id, targetParentId: targetItemId});
    } catch {
        toast.error(`Failed to move "${path.name}"`);
    }
};
```

---

## Important Issues

### I1. CodeEditorView useEffect Missing Dependencies
**File:** `apps/drive/src/components/editor/code-editor.tsx:135-147`

```typescript
useEffect(() => {
    if (!containerRef.current) return;
    const extensions = [...cmBaseExtensions(language, isDark)];
    if (onChange) {
        extensions.push(EditorView.updateListener.of(update => {
            if (update.docChanged) onChange(update.state.doc.toString());
        }));
    }
    const state = EditorState.create({doc: content, extensions});
    const view = new EditorView({state, parent: containerRef.current});
    viewRef.current = view;
    return () => view.destroy();
}, [isDark]);
```

The effect depends on `content`, `language`, and `onChange`, but only lists `[isDark]`. The parent compensates by using
`key={reloadKey}` to force full unmount/remount on content changes. But the `onChange` callback from the `CodeEditor`
parent is created with `useCallback(... , [markDirty])`, meaning its identity changes if `markDirty` changes.

Additionally, when `CodeEditorView` is used inside `MarkdownEditor`'s source mode (lines 133-139), it receives a fresh
`onChange` arrow function on every render. This is safe only because the effect ignores `onChange` changes -- the stale
closure still calls the original `setSourceContent` and `markDirty`.

**Impact:** If a parent re-renders with a different `onChange` but the same `isDark`, the new callback is silently
ignored. Currently safe because of the `key`-based remounting contract, but fragile and undocumented.

**Fix:** Either add the missing dependencies and properly rebuild on change, or add a clear comment explaining the
intentional `key`-based remounting contract.

---

### I2. DriveUploadFiles Has Render-Phase Side Effect
**File:** `packages/ui/src/components/layout/drive/drive-upload-files.tsx:47-55`

```typescript
// Trigger file input click when open changes to true
if (open && fileInputRef.current && initialFiles.length === 0) {
    setTimeout(() => {
        fileInputRef.current?.click();
        onOpenChange(false);
    }, 0);
}
```

This code runs directly in the render body (not in a `useEffect`). Every re-render where `open` is true and
`initialFiles` is empty schedules another `setTimeout`. In React 18+ concurrent mode, renders can be interrupted and
retried, causing this side effect to fire multiple times.

The `useEffect` on lines 35-45 also has incomplete dependencies: it references `processFiles`, `onAfterUpload`, and
`onOpenChange` but only depends on `[open, initialFiles]`.

**Impact:** Multiple file-picker dialogs could open in quick succession under concurrent rendering.

**Fix:** Move the file input click logic into a `useEffect`:
```typescript
useEffect(() => {
    if (open && initialFiles.length === 0) {
        fileInputRef.current?.click();
        onOpenChange(false);
    }
}, [open, initialFiles.length, onOpenChange]);
```

---

### I3. Non-Null Assertion on `auth.user` in Guarded Routes

**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx:24`
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:25`

```typescript
const ownerId = auth.user!.id;
```

Both routes use `!` to assert `auth.user` is non-null. The `_auth.tsx` guard redirects unauthenticated users during
`beforeLoad`, but this runs at navigation time, not render time. If the auth state changes between navigation and
render (e.g., session expiration, token invalidation), `auth.user` could be null.

The root route (`__root.tsx:22`) correctly handles this with `user?.id || ''`.

**Impact:** Potential runtime crash on session expiry while viewing mime or shared routes.

**Fix:** Use optional chaining: `const ownerId = auth.user?.id ?? '';`

---

### I4. Dark Mode Not Supported in Tiptap Editor Styles
**File:** `apps/drive/css/globals.css`

All `.tiptap` styles use hardcoded light-mode colors:

- Links: `color: #2563eb` / hover `color: #1d4ed8` (lines 60-67)
- Inline code: `background-color: #f3f4f6`, `color: #dc2626` (lines 155-161)
- Blockquote border: `3px solid #d1d5db`, text `color: #6b7280` (lines 138-144)
- Table headers: `background-color: #f9fafb` (line 217)
- Table borders: `1px solid #d1d5db` (line 209)
- Horizontal rule: `border-top: 2px solid #e5e7eb` (line 150)
- Selection: `background-color: #bfdbfe` (line 240)
- Checked task items: `color: #9ca3af` (line 131)
- Checkbox accent: `accent-color: #7c3aed` (line 120)

There are zero `.dark .tiptap` rules. The shared `eigen-prose.css` in `packages/ui/src/styles/` has full dark mode
support for the equivalent elements, demonstrating the expected pattern.

**Impact:** The Tiptap WYSIWYG editor is unreadable in dark mode. Light gray text on light backgrounds, invisible
borders, wrong selection colors.

**Fix:** Add `.dark .tiptap` variants mirroring `eigen-prose.css`, or share CSS variables between the two stylesheets.

---

### I5. `useMarkdownExtensions` Creates New Extension Instances Every Render
**File:** `apps/drive/src/components/editor/markdown-editor.tsx:40-53`

```typescript
function useMarkdownExtensions(content: string) {
    const bulletMarker = detectBulletMarker(content);
    return [
        StarterKit.configure({codeBlock: false}),
        Markdown.configure({...}),
        Typography, TaskList, TaskItem.configure({nested: true}),
        // ... more extensions
    ];
}
```

Despite the `use` prefix, this is not a React hook (it calls no hooks). Every render creates new extension instances
via `.configure()` and re-runs `detectBulletMarker` (regex scanning the full content). The `content` prop never changes
after mount (the parent uses `key` for remounting), so the result is always identical.

**Impact:** Wasted allocations on every keystroke (Tiptap's `onUpdate` triggers re-render). No functional bug.

**Fix:** Memoize with `useMemo`:
```typescript
const extensions = useMemo(() => {
    const bulletMarker = detectBulletMarker(content);
    return [StarterKit.configure({codeBlock: false}), ...];
}, [content]);
```

---

### I6. Video Preview in DriveDetail Only Handles Two MIME Types
**File:** `packages/ui/src/components/layout/drive/drive-detail.tsx:164`

```typescript
{(path.mimeType === "video/mp4" || path.mimeType === "video/mpeg") && (
```

Only `video/mp4` and `video/mpeg` get the inline `<video>` player. Modern browsers also support `video/webm`,
`video/quicktime` (MOV on Safari), and `video/ogg`. The audio check on line 175 covers 5 types but uses `==` instead
of `===` (loose equality -- not a bug for strings, but inconsistent with the codebase).

**Impact:** WebM and MOV uploads will not show the inline video player in the detail panel.

**Fix:** Use `path.mimeType.startsWith("video/")` for the video check, consistent with the preview overlay.

---

### I7. Unsafe Cast of `$to` Param to Union Type

**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:35`

```typescript
} = useSharedPaths(ownerId, to as 'by-me' | 'with-me');
```

The `$to` URL parameter is a free-form string. It is cast to `'by-me' | 'with-me'` without validation. Navigating to
`/shared/invalid` will call `useSharedPaths` with an invalid `to` value.

**Impact:** No crash, but unexpected API behavior on malformed URLs.

**Fix:** Validate in `beforeLoad`, redirecting to `/shared/by-me` if value is invalid.

---

### I8. `"use client"` Directives in Non-Next.js Codebase

**File:** `packages/ui/src/components/layout/drive/drive-access-list.tsx:1`
**File:** `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:1`

Both files have `"use client"` as the first line. Per CLAUDE.md: "No `'use client'` directives -- this is a Vite
project, not Next.js. The directive is a no-op."

**Impact:** No functional impact. Confusing to developers.

**Fix:** Remove the directives.

---

## Minor Issues

### M1. `interface` Used Instead of `type`
**File:** `apps/drive/src/routes/__root.tsx:15` -- `interface MyRouterContext`
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx:43` -- `interface DriveSidebarProps`
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:168` -- `interface DriveListProps`

Per CONTRIBUTING.md: "Always `type` over `interface` (except when methods needed)". These are property-only shapes.

---

### M2. Commented-Out Code
**File:** `apps/drive/src/components/editor/editor-toolbar.tsx:29` -- Commented-out back navigation button
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:357-360` -- Commented-out new item button in empty
state

Dead code adds noise. Should be removed or restored with a TODO comment.

---

### M3. No-Op `onSave` Callbacks in Sidebar Dialogs
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx:306-369`

Six dialog components receive `onSave={() => {}}`. Each allocates a fresh function on every render. The sidebar uses
`onAfterAction` for its post-action behavior, making `onSave` dead. Either pass `undefined` or make `onSave` optional.

---

### M4. `DriveSearchParams` Type Assertion in All Three Route Validators

**File:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:17`
**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx:15`
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:16`

All use `as DriveSearchParams` to cast the validator return. Using `satisfies DriveSearchParams` would preserve
TypeScript's structural checking and catch mismatches between the returned object and the type.

---

### M5. Edit Route Renders `null` While Loading Path Info
**File:** `apps/drive/src/routes/_auth.edit.$ownerId.$mountId.$pathId.tsx:14`

```typescript
if (!path) return null;
```

Causes a flash of empty content while `usePathInfo` loads. Every other loading state in the app shows `<EigenLoader/>`.

---

### M6. `DriveContext` Defined in Root Route File
**File:** `apps/drive/src/routes/__root.tsx:10-13`

`DriveContext` is created and exported from the root route file. Other files import it via `'./__root'`. Contexts are
conventionally in their own file to avoid coupling to the route module.

---

### M7. Error Message Tone Inconsistency

**File:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:127`
**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx:79`
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:79`
**File:** `apps/drive/src/routes/__root.tsx:47-48`

Sub-routes use `text-muted-foreground` with "Encountering the null vector: a rendezvous with nothing at all." The root
uses `text-destructive` with "Error loading drive content" and shows `error.message`. They should use a consistent
style and actionable messaging.

---

### M8. `DriveLayout` Props `error` and `data` Typed as `any`
**File:** `packages/ui/src/components/layout/drive/drive-layout.tsx:29, 35`

```typescript
error: any;
onAfterAction?: (actionType: string, data: any) => void;
```

These should be `Error | null` and a typed discriminated union respectively.

---

### M9. DriveListToolbar Renders Raw `<div>` Instead of `<Toolbar>`
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:137`

The toolbar uses `<div className="flex items-center justify-between w-full">` instead of the shared `<Toolbar>`
component. Inconsistent padding/height with other toolbars.

---

### M10. Sidebar Dead `<input type="file">` Inside Upload Menu Item
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx:198-206`

The hidden file input inside the dropdown menu item is never triggered. Clicking the menu item calls
`setUploadOpen(true)`, which opens `DriveUploadFiles` (which has its own file input). The `handleFileChange` function
(line 136-141) and its associated `uploadFiles`/`setUploadFiles` state are dead code.

---

### M11. `DriveDialogsState` Type Is Stale

**File:** `packages/ui/src/components/layout/drive/use-drive-dialogs.ts:4-12`

The exported `DriveDialogsState` type only includes `createFolder`, `createDoc`, `createStickies`, `delete`, `rename`,
`share`, and `upload`. The actual hook also returns `createChat`, `createSlides`, and `createSheets`. The type appears
unused, but if anyone imports it, it will be incomplete.

---

### M12. Inherited Access List Uses `any` Type

**File:** `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:242`

```typescript
{inheritedList.map((access: any) => {
```

The `inheritedList` already has proper typing from `useDriveAccess` (`InheritedAccessItem[]`). The `any` annotation
silences type checking unnecessarily.

---

### M13. Loose Equality in Audio MIME Check
**File:** `packages/ui/src/components/layout/drive/drive-detail.tsx:175`

```typescript
(path.mimeType == "audio/mpeg" || path.mimeType == "audio/wav" || ...)
```

Uses `==` instead of `===`. Not a bug (both sides are strings), but inconsistent with the codebase.

---

## Strengths

**Architecture compliance is strong.** All data hooks are properly centralized in `packages/lib`. No direct
`useQuery`/`useMutation` in the app layer. SSE handlers correctly call shared invalidation functions. Query keys are
hierarchically structured with `ownerId` scoping and exported for reuse.

**Lazy loading is well-done.** Heavy editors (Tiptap + CodeMirror) are lazy-loaded via `React.lazy()` in
`native-file-editor.tsx` (lines 13-14), keeping the initial drive bundle small. The `Suspense` boundary on line 114
provides a loading fallback.

**Conflict resolution is thorough.** The `useEditorSave` hook implements optimistic concurrency with `updatedAt`
tokens, `Cmd+S` hotkey binding, `beforeunload` protection, and a three-option conflict dialog (Overwrite / Reload /
Download). This is production-quality.

**Drag-and-drop is well-implemented.** External file drops use a ref counter (`dragCounter`) to correctly handle
enter/leave events on nested DOM elements. Internal drag-and-drop for moving files validates drop targets.

**Keyboard navigation is complete.** The `DriveTable` supports arrow key navigation, Enter to open, Space for Quick
Look, and multi-select.

**Team drives integration is clean.** The sidebar dynamically loads team mounts via `usePeopleTeams` and
`useTeamMounts`, rendering each enabled mount as a sidebar link with the team avatar.

**The `useEditorSave` hook correctly handles the save lifecycle.** The `beforeunload` listener prevents accidental
data loss. The `Cmd+S` hotkey is properly prevented from triggering the browser's save dialog. The `confirmClose`
function gates navigation on unsaved changes.

**ACL UI is comprehensive.** The access list edit component supports adding users by email (with autosuggest from
contacts), team sharing, permission changes (editor/viewer/remove), inherited access display, and visibility toggling.
All of this is properly backed by `useDriveAccess` which correctly computes direct vs. inherited entries.

**The breadcrumb hook call in `DriveListToolbar` has been fixed.** Line 58 now correctly passes
`showBreadcrumb ? pathId : undefined` to `useBreadcrumb`, using the hook's `enabled` guard instead of a conditional
hook call. This was a critical Rules of Hooks violation that has been resolved.

---

## File Index

### Drive App (`apps/drive/src/`)

- `main.tsx` -- App bootstrap with EigenApp provider and TanStack Router
- `routes/__root.tsx` -- Root route with AppShell, DriveContext, sidebar
- `routes/_auth.tsx` -- Auth guard
- `routes/index.tsx` -- Redirect to `/fs/{userId}/default/root`
- `routes/login.tsx` -- Login page
- `routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` -- Main folder browser
- `routes/_auth.edit.$ownerId.$mountId.$pathId.tsx` -- Inline text file editor
- `routes/_auth.shared.$to.tsx` -- Shared files
- `routes/_auth.mime.$mimeType.tsx` -- MIME-filtered files
- `components/drive/drive-sidebar.tsx` -- Sidebar with navigation and create actions
- `components/editor/native-file-editor.tsx` -- Editor dispatcher (lazy loads Tiptap/CodeMirror)
- `components/editor/markdown-editor.tsx` -- Tiptap WYSIWYG + source mode
- `components/editor/markdown-toolbar.tsx` -- Markdown formatting buttons
- `components/editor/code-editor.tsx` -- CodeMirror 6 wrapper
- `components/editor/editor-toolbar.tsx` -- View/Edit toolbar bars
- `components/editor/use-editor-save.ts` -- Save logic (concurrency, Cmd+S, beforeunload)
- `components/editor/conflict-dialog.tsx` -- Conflict resolution dialog
- `css/globals.css` -- Tiptap editor styles

### Drive Hooks (`packages/lib/src/core/drive/`)

- `hooks/use-drive.ts` -- All drive data hooks and invalidation functions
- `hooks/use-drive-access.ts` -- ACL computation (direct + inherited entries)
- `sse-handlers.ts` -- SSE event dispatcher
- `media-resolver.tsx` -- Media URL resolution context provider

### Editor Hooks (`packages/lib/src/core/editor/`)

- `hooks/use-file-content.ts` -- File content query hook
- `hooks/use-file-save.ts` -- File save mutation hook

### Shared Drive UI (`packages/ui/src/components/layout/drive/`)

- `drive-layout.tsx` -- Main orchestrator
- `drive-list.tsx` -- File list with drag-drop
- `drive-detail.tsx` -- File detail panel
- `drive-access-list.tsx` -- Read-only access list
- `drive-access-list-edit.tsx` -- Editable access list
- `drive-upload-files.tsx` -- Upload component
- `use-drive-dialogs.ts` -- Dialog state management

### Relevant Docs

- [CLAUDE.md](/Users/reinder/Documents/GitHub/eigen/CLAUDE.md) -- Project rules and patterns
- [LAYOUT-UI-DRIVE.md](/Users/reinder/Documents/GitHub/eigen/docs/LAYOUT-UI-DRIVE.md) -- Drive UI component reference
- [INLINE-EDITING.md](/Users/reinder/Documents/GitHub/eigen/docs/INLINE-EDITING.md) -- Inline editor architecture
- [PREVIEWS.md](/Users/reinder/Documents/GitHub/eigen/docs/PREVIEWS.md) -- Preview system
- [ACL.md](/Users/reinder/Documents/GitHub/eigen/docs/ACL.md) -- ACL design
- [CLIPBOARD.md](/Users/reinder/Documents/GitHub/eigen/docs/CLIPBOARD.md) -- Clipboard system
