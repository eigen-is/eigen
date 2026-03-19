# FE Code Review: Drive

## Summary

The frontend Drive code follows project patterns well: hooks live in `packages/lib/src/core/drive/hooks/`, query keys
include `ownerId`, SSE handlers properly invalidate caches, and the UI components use theme tokens. The editor system (
markdown + code) is well-architected with lazy loading and conflict resolution. Key issues are missing error feedback on
several mutations, a few `as any` casts in the markdown editor, and some inconsistencies in the shared paths route.

## Critical Issues

### 1. `handleMovePath` in `DriveLayout` has no error handling

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/drive/drive-layout.tsx`, lines
  110-113
- **Issue**: `movePath.mutateAsync` is called without try/catch or `onError` callback. If the move fails (e.g., name
  conflict, circular move, permission denied), the error is unhandled.
- **Why it matters**: Violates CLAUDE.md rule "Every mutation needs error feedback -- wrap `mutateAsync` in try/catch
  with `toast.error()`, or use the `onError` callback."
- **Suggested fix**: Wrap in try/catch with `toast.error()`.

### 2. `handleSave` in `DriveAccessDialog` has no error handling

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/drive/drive-access-dialog.tsx`,
  lines 26-31
- **Issue**: `updateACL.mutateAsync` is called without try/catch. On failure, `setIsSubmitting(false)` at line 30 never
  executes, leaving the dialog in a stuck "submitting" state with no error feedback.
- **Why it matters**: Both a UX bug (unrecoverable dialog state) and a CLAUDE.md violation.
- **Suggested fix**: Wrap in try/catch, add `toast.error()`, ensure `setIsSubmitting(false)` runs in a `finally` block.

### 3. `useSharedPaths` hook with `uid` parameter mismatch for `selectedPath`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/routes/_auth.shared.$to.tsx`, line 27
- **Issue**: `usePathInfo(uid || '', mountId, pid || '')` uses `uid` from the URL search params as the `ownerId`. But
  `mountId` is hardcoded to `DEFAULT_MOUNT_ID`. For shared items from other users, the actual `mountId` of the shared
  item may differ from the default mount. The shared path's `mountId` is stored in the shared DB but not passed to the
  URL.
- **Why it matters**: When selecting a shared item, the path info query uses the wrong mount ID, which could return null
  for items on non-default mounts.
- **Suggested fix**: Include `mountId` in the URL search params alongside `uid` and `pid`, or derive it from the
  selected shared path.

## Pattern Violations

### 1. `as any` usage in markdown editor

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/editor/markdown-editor.tsx`, lines 86 and
  101
- **Issue**: `(editor.storage as any).markdown.getMarkdown()` is used twice to access the tiptap-markdown extension's
  storage.
- **Why it matters**: CLAUDE.md rule: "Never use `as any` -- fix the type at the source."
- **Suggested fix**: Type the tiptap-markdown storage properly with a specific type instead of `any`. This is a known
  limitation of tiptap-markdown's typing, but the cast should be to a specific type, not `any`.

### 2. `CodeEditorView` effect dependency array missing `language` and `onChange`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/editor/code-editor.tsx`, line 147
- **Issue**: The `useEffect` that creates the CodeMirror `EditorView` only lists `[isDark]` in its dependency array, but
  also uses `language`, `onChange`, and `content`. When the language or onChange callback changes, the editor won't
  update.
- **Why it matters**: If the component is reused with different props, the editor won't reflect the changes. In the
  current usage, `language` and `content` are stable for the component's lifetime (keyed by `reloadKey`), so this
  doesn't cause bugs today. But it's fragile.
- **Suggested fix**: Include `language` in the dependency array. `content` is intentionally read only once (initial
  value). `onChange` should be wrapped in a ref to avoid unnecessary re-creation.

### 3. MIME type normalization happens in multiple places

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/drive/hooks/use-drive.ts`, lines 333-334
- **Issue**: `invalidateItemCreated` normalizes mimeType with `mimeType.replace('/', '-')`, but `useMimeContent` uses
  the raw mimeType from the URL (which is already hyphenated). The normalization is scattered.
- **Why it matters**: If anyone passes a slash-separated MIME type to `useMimeContent` directly, the cache key won't
  match the invalidation key.
- **Suggested fix**: Centralize MIME type normalization in `driveKeys.mime()` itself.

## Security Concerns

### 1. Server-generated HTML rendered via innerHTML for text preview

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/editor/native-file-editor.tsx`, line 83
- **Issue**: Server-generated preview HTML is rendered via innerHTML. The server sanitizes content with DOMPurify before
  returning it.
- **Why it matters**: The pattern is documented and intentional (see PREVIEWS.md). The server-side DOMPurify
  sanitization is the defense layer. This is acceptable as long as the server sanitization remains intact.
- **Suggested fix**: No change needed, but consider adding a Content-Security-Policy that restricts inline scripts as
  defense in depth.

### 2. Link prompt in markdown toolbar allows arbitrary URLs

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/editor/markdown-toolbar.tsx`, lines 57-59
- **Issue**: `window.prompt('URL')` allows users to enter `javascript:` URLs, which tiptap would store as a link href.
  When rendered, this could execute JavaScript.
- **Why it matters**: Self-XSS vector -- the user is entering the URL themselves. But if the document is shared, other
  users could click the malicious link.
- **Suggested fix**: Validate that the URL starts with `http://`, `https://`, or `mailto:` before calling `setLink()`.

## Data Integrity

### 1. `useEditorSave` catch block swallows error details

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/editor/use-editor-save.ts`, lines 47-49
- **Issue**: The `catch` block in `doSave` catches errors and sets `saveState` to `'unsaved'` but does not show any
  error toast or log the error.
- **Why it matters**: Users may think save failed silently with no indication of why. CLAUDE.md requires error feedback
  on all mutations.
- **Suggested fix**: Add `toast.error('Failed to save')` in the catch block.

### 2. `Cmd+S` save doesn't await the save result

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/editor/use-editor-save.ts`, lines 53-56
- **Issue**: `useHotkey('Mod+S', (e) => { e.preventDefault(); doSave(); })` calls `doSave()` without `await`. Since
  `doSave` is async, its result is not awaited.
- **Why it matters**: CLAUDE.md rule: "Always `await` async calls." The save will still execute, but errors won't
  propagate to the hotkey handler. Since `doSave` internally handles errors (sets saveState), this is functionally OK
  but violates the pattern.
- **Suggested fix**: While the hotkey callback may not support async, the error handling inside `doSave` makes this
  safe. Add a comment explaining why `await` is omitted.

### 3. SSE handler doesn't invalidate text preview cache on file upload

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/drive/sse-handlers.ts`, lines 28-30
- **Issue**: When a `DRIVE_FILE_UPLOADED` event fires (e.g., after inline editing saves), `invalidateItemCreated` is
  called but this doesn't invalidate the text preview query key (`driveKeys.textPreview`). The stale preview will
  persist until its 5-minute staleTime expires.
- **Why it matters**: After saving a text file via the inline editor, the preview in the Drive view may show stale
  content.
- **Suggested fix**: In `invalidateItemCreated` (or in the SSE handler for file upload), also invalidate
  `driveKeys.textPreview(ownerId, mountId, pathId)`.

### 4. `DriveContext` provides a single `mountId` but team drives use different mounts

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/routes/__root.tsx`, lines 10-13, 67
- **Issue**: `DriveContext` stores `mountId: DEFAULT_MOUNT_ID` globally. When navigating to a team drive, the route
  params provide the correct `mountId`, but the context doesn't update.
- **Why it matters**: Not a bug because team drive navigation is URL-based, not context-based. But the
  `DriveContext.mountId` is misleading since it only reflects the user's own default mount.

## Code Quality

### 1. Route component naming collision

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/routes/_auth.shared.$to.tsx`, line 20,
  `_auth.mime.$mimeType.tsx`, line 19, and `_auth.fs.$ownerId.$mountId.$pathId.tsx`, line 21
- **Issue**: All three route files name their component `DriveRoute`. This makes stack traces and React DevTools harder
  to navigate.
- **Suggested fix**: Use descriptive names: `DriveFsRoute`, `DriveSharedRoute`, `DriveMimeRoute`.

### 2. Sidebar dialog state management is verbose

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/components/drive/drive-sidebar.tsx`, lines 100-107
- **Issue**: Seven separate `useState` calls for dialog open states. The `useDriveDialogs` hook in `packages/ui` already
  exists to manage this, but the sidebar duplicates the pattern.
- **Suggested fix**: Use `useDriveDialogs` in the sidebar as well.

### 3. `handleAfterAction` callback typing uses `any`

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/drive/drive-layout.tsx`, line 35
- **Issue**: `onAfterAction?: (actionType: string, data: any) => void` uses `any` for the data parameter.
- **Why it matters**: While not a direct `as any` cast, using `any` in public API types weakens type safety.
- **Suggested fix**: Define a discriminated union type for the action type and data.

### 4. `error: any` in `DriveLayoutProps`

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/ui/src/components/layout/drive/drive-layout.tsx`, line 29
- **Issue**: `error: any` in the props type.
- **Suggested fix**: Type as `Error | null`.

### 5. Unnecessary fragment wrappers

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/routes/_auth.shared.$to.tsx`, line 89 and
  `_auth.mime.$mimeType.tsx`, line 81
- **Issue**: `<>...</>` fragment wrapping a single `DriveLayout` component is unnecessary.
- **Suggested fix**: Remove the fragments.

### 6. `handleAfterAction` in `_auth.fs` route uses `any`

- **File**: `/Users/reinder/Documents/GitHub/eigen/apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`, line
  104
- **Issue**: `const handleAfterAction = (actionType: string, data: any) => {...}` uses `any`.
- **Suggested fix**: Use a typed callback matching the action types.

## Architecture

### 1. Drive app has minimal app-specific code

- **Issue**: Most Drive UI logic lives in `packages/ui/src/components/layout/drive/` (shared components). The app
  itself (`apps/drive/src/`) mainly provides routing and the sidebar. This is good architecture -- it means other apps (
  Docs, Stickies) can reuse the Drive UI.

### 2. Editor subsystem is well-separated

- **Issue**: The inline editor lives in `apps/drive/src/components/editor/` with hooks in
  `packages/lib/src/core/editor/`. This clean separation allows the editor to be reused or extracted. The lazy loading
  of heavy editor dependencies (Tiptap, CodeMirror) is well done.

### 3. Query key hierarchy is comprehensive

- **Issue**: `driveKeys` in `use-drive.ts` follows the documented pattern with `ownerId` at every level. The
  invalidation functions are exported and reused in SSE handlers. This is exemplary.

### 4. Missing `useCreateChat` hook

- **File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/core/drive/hooks/use-drive.ts`
- **Issue**: There are hooks for `useCreateDoc`, `useCreateStickies`, `useCreateSlides`, `useCreateSheets` but no
  `useCreateChat` hook. The chat creation dialog in `packages/ui` must be using an inline approach.
- **Suggested fix**: Add `useCreateChat` for consistency with the other creation hooks.

## Positive Patterns

1. **All data hooks in `packages/lib`**: `useFolderContent`, `usePathInfo`, `useCreateFolder`, etc. are all properly
   centralized. No raw `useQuery`/`useMutation` in app code.

2. **Query keys include `ownerId`**: Every key in `driveKeys` includes `ownerId`, preventing stale data when switching
   between personal and team contexts.

3. **SSE handlers properly invalidate all related caches**: `handleDriveSSEvent` covers all event types and invalidates
   parent folders, paths, and MIME type queries.

4. **Theme tokens used consistently**: All Drive components use `text-muted-foreground`, `text-destructive`, etc. No
   hardcoded colors found.

5. **Lazy loading of heavy editor dependencies**: `MarkdownEditor` and `CodeEditor` are `lazy()` loaded, keeping the
   initial Drive bundle small.

6. **Conflict resolution dialog**: The `ConflictDialog` with Overwrite/Reload/Download options is a thoughtful UX
   pattern for handling concurrent edits.

7. **`beforeunload` guard**: `useEditorSave` warns users before navigating away with unsaved changes.

8. **Keyboard shortcuts**: `Mod+S` for save, breadcrumb navigation, and editor toolbar buttons provide good keyboard UX.

9. **Error feedback on most mutations**: `DriveCreateFolder`, `DriveCreateDoc`, `DriveCreateStickies`,
   `DriveCreateChat`, `DriveCreateSlides`, `DriveCreateSheets`, `DriveDeleteItem`, `DriveRenameItem`, and
   `DriveUploadFiles` all have `toast.error()` calls.

## Recommendations

| Priority | Issue                                                                   | Location                                                 |
|----------|-------------------------------------------------------------------------|----------------------------------------------------------|
| P0       | Add try/catch with `toast.error()` to `handleMovePath`                  | `drive-layout.tsx:110`                                   |
| P0       | Add try/catch and `finally` block to `handleSave` in ACL dialog         | `drive-access-dialog.tsx:26`                             |
| P0       | Add `toast.error()` to `doSave` catch block in `useEditorSave`          | `use-editor-save.ts:47`                                  |
| P1       | Validate link URLs in markdown toolbar to prevent `javascript:` URIs    | `markdown-toolbar.tsx:57`                                |
| P1       | Invalidate text preview cache on `DRIVE_FILE_UPLOADED` SSE event        | `sse-handlers.ts:28`                                     |
| P1       | Fix `usePathInfo` for shared items to use correct `mountId`             | `_auth.shared.$to.tsx:27`                                |
| P1       | Replace `as any` with specific types for tiptap-markdown storage        | `markdown-editor.tsx:86,101`                             |
| P2       | Type `onAfterAction` callback with discriminated union instead of `any` | `drive-layout.tsx:35`                                    |
| P2       | Type `error` prop as `Error                                             | null` instead of `any`                                   | `drive-layout.tsx:29` |
| P2       | Add `useCreateChat` hook for consistency with other create hooks        | `use-drive.ts`                                           |
| P2       | Use `useDriveDialogs` in sidebar instead of manual `useState` calls     | `drive-sidebar.tsx:100`                                  |
| P2       | Remove unnecessary fragment wrappers                                    | `_auth.shared.$to.tsx:89`, `_auth.mime.$mimeType.tsx:81` |
| P2       | Rename route components to avoid naming collisions in DevTools          | Multiple route files                                     |
