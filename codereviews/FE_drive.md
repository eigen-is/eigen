# Frontend Review: Drive App

**Scope:** `apps/drive/` (all source files), `apps/drive/css/globals.css`, plus shared components in
`packages/ui/src/components/layout/drive/`, `packages/lib/src/core/drive/`, `packages/lib/src/core/editor/`
**Reviewed:** 2026-03-18

---

## Critical Issues

### C1. Rules of Hooks Violation: Conditional Hook Call in DriveListToolbar
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:58`
**Status:** Confirmed from previous review (issue #1)

```typescript
const {data: breadcrumbPaths = []} = showBreadcrumb ? useBreadcrumb(ownerId, mountId, pathId) : {data: []};
```

`useBreadcrumb` is called conditionally. React requires hooks to be called unconditionally and in the same order on
every render. If `showBreadcrumb` ever flips between renders (it does not today -- the fs route passes `true`, the
mime/shared routes pass `false` -- but nothing enforces this statically), React's hook reconciliation will corrupt
state, causing crashes or silent data corruption.

**Impact:** Latent correctness bug. Any future code change that toggles `showBreadcrumb` at runtime will break the
component. React's linter and future Strict Mode will flag this.

**Fix:** Always call the hook; use the `enabled` mechanism already built into `useBreadcrumb`:
```typescript
const {data: breadcrumbPaths = []} = useBreadcrumb(ownerId, mountId, showBreadcrumb ? pathId : undefined);
```
Since `useBreadcrumb` has `enabled: !!pathId`, passing `undefined` disables the query without skipping the hook call.

---

### C2. Search Params `uid` Not Validated in Shared Route -- Detail Panel Broken for "Shared With Me"
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:13-16, 22, 26`
**Status:** Confirmed from previous review (issue #2)

The `validateSearch` function only extracts `pid`:
```typescript
validateSearch: (search: Record<string, unknown>) => {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    return {pid} as DriveSearchParams;
},
```

But line 22 destructures `uid` from the search result:
```typescript
const {uid, pid} = Route.useSearch();
```

And line 26 uses it to fetch the selected file's path info:
```typescript
const {data: selectedPath = null} = usePathInfo(uid || '', mountId, pid || '');
```

Since `uid` is never extracted by the validator, it is always `undefined`. When a user clicks a shared file (which sets
`uid: path.ownerId` in the navigation on line 47), the validator strips it, so `usePathInfo` is called with an empty
ownerId and returns nothing. The detail panel never loads for shared items.

**Impact:** The "shared with me" detail panel is non-functional. Users cannot see file metadata, thumbnails, or access
lists for files shared with them.

**Fix:** Add `uid` extraction to the validator:
```typescript
const pid = typeof search.pid === 'string' ? search.pid : undefined;
const uid = typeof search.uid === 'string' ? search.uid : undefined;
return {pid, uid} as DriveSearchParams;
```

---

### C3. `markDirty` Used Before Declaration in MarkdownEditor
**File:** `apps/drive/src/components/editor/markdown-editor.tsx:75-81, 93`
**Status:** New finding

```typescript
const editor = useEditor({
    extensions: useMarkdownExtensions(content),
    content,
    onUpdate: () => {
        markDirty();       // <-- line 79: references markDirty
    },
});
// ... lines 83-92 ...
const {saveState, showConflict, setShowConflict, markDirty, doSave, confirmClose} =
    useEditorSave({...});  // <-- line 93-94: markDirty declared here
```

The `onUpdate` callback on line 79 captures `markDirty` from line 93 via closure. This works at runtime because
`onUpdate` is not called during `useEditor` initialization -- it fires later when the user types -- and by that time
`markDirty` has been assigned. However, this is a fragile forward-reference pattern:

1. It silently violates the temporal dead zone contract of `const` -- if `onUpdate` were ever invoked synchronously
   during editor setup (which some Tiptap extensions can do), it would throw a `ReferenceError`.
2. It makes the code ordering dependency invisible: moving the `useEditorSave` call or the `useEditor` call will
   silently break the component with no TypeScript or lint warning.
3. ESLint's `no-use-before-define` rule (if enabled) would flag this.

**Impact:** Correctness risk. Works today but is one Tiptap update or refactor away from a runtime crash.

**Fix:** Use a ref to hold the markDirty function, assigned after useEditorSave returns:
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

## Important Issues

### I1. CodeEditorView useEffect Missing Dependencies
**File:** `apps/drive/src/components/editor/code-editor.tsx:135-147`
**Status:** Confirmed from previous review (issue #3), with additional analysis

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

Additionally, when `CodeEditorView` is used inside `MarkdownEditor`'s source mode (line 133-139), it receives a fresh
`onChange` arrow function on every render (`onChange={(val) => { ... }}`), but this is safe only because the effect
ignores onChange changes -- the stale `onChange` closure still calls the original `setSourceContent` and `markDirty`.

**Impact:** The stale `onChange` closure means that if a parent re-renders with a different `onChange` but the same
`isDark`, the new callback is silently ignored. In the `CodeEditor` usage this is currently safe because the parent
uses `key` for remounting. In the `MarkdownEditor` source-mode usage, the stale closure still works because
`setSourceContent` and `markDirty` are stable references. But it is fragile.

**Fix:** Either add the missing dependencies and properly rebuild on change, or document the intentional omission with
a comment explaining the `key`-based remounting contract.

---

### I2. DriveUploadFiles Has Render-Phase Side Effect
**File:** `packages/ui/src/components/layout/drive/drive-upload-files.tsx:47-55`
**Status:** New finding

```typescript
// Trigger file input click when open changes to true
if (open && fileInputRef.current && initialFiles.length === 0) {
    setTimeout(() => {
        fileInputRef.current?.click();
        onOpenChange(false);
    }, 0);
}
```

This code runs directly in the render body (not in a useEffect). Every re-render where `open` is true and
`initialFiles` is empty will schedule another `setTimeout` that clicks the file input and closes the dialog. In React
18+, renders can be interrupted and retried (concurrent features), meaning this side effect can fire multiple times.

The `useEffect` on lines 35-45 also has missing exhaustive dependencies: it references `processFiles`,
`onAfterUpload`, and `onOpenChange` but only depends on `[open, initialFiles]`.

**Impact:** Multiple file-picker dialogs could open in quick succession under concurrent rendering, or the file picker
could fail to open if the render is interrupted.

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
**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx:23`
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:24`
**Status:** Confirmed from previous review (issue #4)

```typescript
const ownerId = auth.user!.id;
```

Both routes use `!` to assert `auth.user` is non-null. The `_auth.tsx` guard redirects unauthenticated users during
`beforeLoad`, but this runs at navigation time, not render time. If the auth state changes between navigation and
render (e.g., session expiration, token invalidation), `auth.user` could be null, causing a runtime crash.

The root route (`__root.tsx:22`) correctly handles this with `user?.id || ''`.

**Impact:** Potential runtime crash on session expiry while viewing mime or shared routes.

**Fix:** Use optional chaining: `const ownerId = auth.user?.id ?? '';`

---

### I4. Dark Mode Not Supported in Tiptap Editor Styles
**File:** `apps/drive/css/globals.css`
**Status:** Confirmed from previous review (issue #6), verified against eigen-prose.css

All `.tiptap` styles use hardcoded light-mode colors:
- Inline code: `background-color: #f3f4f6`, `color: #dc2626` (line 155-161)
- Blockquote: `border-left: 3px solid #d1d5db`, `color: #6b7280` (lines 138-144)
- Table headers: `background-color: #f9fafb` (line 217)
- Table borders: `border: 1px solid #d1d5db` (line 209)
- Horizontal rule: `border-top: 2px solid #e5e7eb` (line 150)
- Selection highlight: `background-color: #bfdbfe` (line 240)
- Checked task items: `color: #9ca3af` (line 131)

There are zero `.dark .tiptap` rules. The shared `eigen-prose.css` at
`packages/ui/src/styles/eigen-prose.css` has full dark mode support (lines 213-242) for the identical set of elements,
demonstrating the expected pattern.

**Impact:** The markdown WYSIWYG editor (Tiptap) is unreadable in dark mode. Light gray text on light backgrounds,
invisible borders, wrong selection colors.

**Fix:** Add `.dark .tiptap` variants mirroring the `eigen-prose.css` dark mode rules, or refactor to share CSS
variables between the two.

---

### I5. `useMarkdownExtensions` Creates New Extension Instances Every Render
**File:** `apps/drive/src/components/editor/markdown-editor.tsx:40-53`
**Status:** New finding

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

Despite the `use` prefix, this is not a React hook -- it calls no hooks. It is called on line 76 inside `useEditor`:
```typescript
extensions: useMarkdownExtensions(content),
```

Every render creates new extension instances via `.configure()`. Tiptap's `useEditor` is designed to handle this
(it compares extensions by type), but it is wasteful -- `detectBulletMarker` re-scans the content, and all
`.configure()` calls allocate new objects. The `content` prop never changes (it comes from the initial load and the
parent uses `key` for remounting), so the bullet marker detection runs repeatedly for the same result.

**Impact:** Performance waste on every keystroke (Tiptap's `onUpdate` causes re-render, which re-runs this function).
No functional bug.

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
**Status:** Confirmed from previous review (issue #7)

```typescript
{(path.mimeType === "video/mp4" || path.mimeType === "video/mpeg") && (
```

Only `video/mp4` and `video/mpeg` get the inline `<video>` player. Modern browsers support `video/webm`,
`video/quicktime` (MOV on Safari), and `video/ogg`. These are excluded. The audio check on line 175 covers 5 types but
uses `==` instead of `===` (loose equality -- not a bug for string comparisons, but inconsistent).

**Impact:** Users uploading WebM or MOV files will not see the inline video player in the detail panel.

**Fix:** Use `path.mimeType.startsWith("video/")` for the video check, matching what the preview overlay already does.

---

### I7. Hardcoded `text-gray-500` Instead of Theme Token in Access Lists
**File:** `packages/ui/src/components/layout/drive/drive-access-list.tsx:60, 70`
**File:** `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:271`
**Status:** New finding

Three instances of `text-gray-500` instead of `text-muted-foreground`:
```typescript
// drive-access-list.tsx:60
<p className="text-xs text-gray-500">Only people with access can open with the link</p>
// drive-access-list.tsx:70
<p className="text-xs text-gray-500">
// drive-access-list-edit.tsx:271
<p className="text-xs text-gray-500">
```

The rest of the codebase consistently uses `text-muted-foreground` for secondary text. The `text-gray-500` class
bypasses the Tailwind theme system and won't adapt to dark mode or custom themes.

**Impact:** These text elements will have wrong contrast in dark mode.

**Fix:** Replace `text-gray-500` with `text-muted-foreground`.

---

### I8. Unsafe Cast of `$to` Param to Union Type
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:34`
**Status:** New finding

```typescript
} = useSharedPaths(ownerId, to as 'by-me' | 'with-me');
```

The `$to` URL parameter is a free-form string from the URL. It is cast to `'by-me' | 'with-me'` without validation.
If a user navigates to `/shared/invalid`, `useSharedPaths` will be called with `"invalid"` as the `to` parameter,
which passes it to the API and may return an error or unexpected results.

**Impact:** No crash, but unexpected API behavior on malformed URLs.

**Fix:** Validate in `beforeLoad` or `validateSearch`, redirecting to a default if the value is not `by-me` or
`with-me`.

---

## Minor Issues

### M1. `interface` Used Instead of `type`
**File:** `apps/drive/src/routes/__root.tsx:15` -- `interface MyRouterContext`
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx:43` -- `interface DriveSidebarProps`
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:168` -- `interface DriveListProps`
**Status:** Confirmed from previous review (issue #9), with additional instance found

Per CONTRIBUTING.md: "Always `type` over `interface` (except when methods needed)". These are property-only shapes.

---

### M2. Commented-Out Code
**File:** `apps/drive/src/components/editor/editor-toolbar.tsx:29` -- Commented-out back navigation button
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:357-360` -- Commented-out new item button in empty
state
**Status:** Confirmed from previous review (issue #10)

Dead code adds noise. Should be removed or restored with a TODO comment.

---

### M3. No-Op `onSave` Callbacks in Sidebar Dialogs
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx:306-369`
**Status:** Confirmed from previous review (issue #11)

Six dialog components receive `onSave={() => {}}`. Each allocates a fresh function on every render. The sidebar uses
`onAfterAction` for its post-action behavior, making `onSave` dead. Either pass `undefined` or, better, make `onSave`
optional in the dialog component props.

---

### M4. `DriveSearchParams` Type Assertion in All Three Route Validators
**File:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:16`
**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx:14`
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:15`
**Status:** Confirmed from previous review (issue #8)

All use `as DriveSearchParams` to cast the validator return. Using `satisfies DriveSearchParams` would preserve
TypeScript's structural checking and catch mismatches between the returned object and the type.

---

### M5. Edit Route Renders `null` While Loading Path Info
**File:** `apps/drive/src/routes/_auth.edit.$ownerId.$mountId.$pathId.tsx:14`
**Status:** Confirmed from previous review (UX section)

```typescript
if (!path) return null;
```

This causes a flash of empty content while `usePathInfo` loads. Every other loading state in the app shows
`<EigenLoader/>`.

**Fix:** Return a loading spinner instead of null.

---

### M6. `DriveContext` Defined in Root Route File
**File:** `apps/drive/src/routes/__root.tsx:10-13`
**Status:** Confirmed from previous review (issue #15)

`DriveContext` is created and exported from the root route file. Other files import it via `'./__root'`. Contexts are
conventionally in their own file. This creates an implicit dependency on the route file's path.

---

### M7. Error Message Style and Tone Inconsistency
**File:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:126`
**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx:74`
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx:79`
**File:** `apps/drive/src/routes/__root.tsx:47`
**Status:** Confirmed from previous review (issue #12)

The sub-routes use `text-muted-foreground` with "Encountering the null vector: a rendezvous with nothing at all."
The root uses `text-red-500` with "Error loading drive content". These should use a consistent visual style and tone.

---

### M8. `DriveLayout` Props `error` and `data` Typed as `any`
**File:** `packages/ui/src/components/layout/drive/drive-layout.tsx:29, 35`
**Status:** Confirmed from previous review (issue #13)

```typescript
error: any;
onAfterAction?: (actionType: string, data: any) => void;
```

These should be `Error | null` and a typed union respectively.

---

### M9. DriveListToolbar Renders Raw `<div>` Instead of `<Toolbar>`
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:137`
**Status:** Confirmed from previous review (issue #14)

The toolbar renders `<div className="flex items-center justify-between w-full">` instead of using the shared
`<Toolbar>` component that all other toolbars use. This leads to slightly inconsistent height and padding.

---

### M10. Sidebar Dead `<input type="file">` Inside Upload Menu Item
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx:198-206`
**Status:** Confirmed from previous review (issue #5), reclassified from Important to Minor

The hidden file input inside the dropdown menu item is never triggered. Clicking the menu item calls
`setUploadOpen(true)`, which opens `DriveUploadFiles` (which has its own file input). The `handleFileChange` function
(line 136-141) and its associated `uploadFiles` state are dead code.

**Fix:** Remove the hidden input, `handleFileChange`, and the `uploadFiles`/`setUploadFiles` state from the sidebar.

---

### M11. `newItemButton` Only Rendered on Mobile in DriveListToolbar
**File:** `packages/ui/src/components/layout/drive/drive-list.tsx:162`
**Status:** New finding

```typescript
<div className="flex gap-1">
    {isMobile && newItemButton}
</div>
```

The "New" button in the DriveListToolbar is only rendered when `isMobile` is true. On desktop, there is no way to
create folders/files from the list toolbar -- users must use the sidebar "New" dropdown or keyboard shortcuts. This is
likely intentional (the sidebar handles it on desktop), but means the sidebar must be visible for creation actions.

---

### M12. Loose Equality in Audio MIME Check
**File:** `packages/ui/src/components/layout/drive/drive-detail.tsx:175`
**Status:** Confirmed from previous review (part of issue #7)

```typescript
(path.mimeType == "audio/mpeg" || path.mimeType == "audio/wav" || ...)
```

Uses `==` instead of `===`. Not a bug (both sides are strings), but inconsistent with the rest of the codebase which
uses strict equality.

---

## Observations

**Architecture compliance is strong.** All data hooks are properly centralized in `packages/lib`. No direct
`useQuery`/`useMutation` in the app layer. SSE handlers correctly call shared invalidation functions. Query keys are
hierarchically structured and exported for reuse. The routing follows TanStack Router file-based conventions with proper
auth guards.

**Lazy loading is well-done.** Heavy editors (Tiptap + CodeMirror) are lazy-loaded via `React.lazy()` in
`native-file-editor.tsx` (lines 13-14), keeping the initial drive bundle small. The `Suspense` boundary on line 114
provides a loading fallback.

**Conflict resolution is thorough.** The `useEditorSave` hook implements optimistic concurrency with `updatedAt`
tokens, `Cmd+S` hotkey binding, `beforeunload` protection, and a three-option conflict dialog (Overwrite / Reload /
Download). This is production-quality.

**Drag-and-drop is well-implemented.** External file drops use a ref counter (`dragCounter`) to correctly handle
enter/leave events on nested DOM elements. Internal drag-and-drop for moving files between folders validates drop
targets (must be a folder, cannot drop onto itself). Multi-select drag is supported via the `useListDrag` hook.

**Keyboard navigation is complete.** The `DriveTable` supports arrow key navigation, Enter to open, Space for Quick
Look, and Shift/Cmd+click for multi-select via `useKeyboardListNavigation` and `useListSelection` hooks.

**The team drives integration is clean.** The sidebar dynamically loads team mounts via `usePeopleTeams` and
`useTeamMounts`, rendering each enabled mount as a sidebar link with the team avatar. The `teamOwnerId()` utility
correctly prefixes team IDs.

**The breadcrumb implementation in the editor toolbar is slightly different from the list toolbar.** The editor toolbar
(`editor-toolbar.tsx:24`) calls `useBreadcrumb` unconditionally (correctly), while the list toolbar (`drive-list.tsx:58`)
calls it conditionally (the Rules of Hooks issue above). They also handle navigation differently: the editor breadcrumb
calls `onClose` for all items (navigating back to the parent folder), while the list breadcrumb calls `onRowSelect` or
`onRowActivate` depending on whether the item is already active.

**The `useEditorSave` hook has a subtle `doSave` stability issue.** `doSave` is wrapped in `useCallback` with
dependencies `[fileSave, getContent, getFrontmatter]`. The `fileSave` mutation object from `useFileSave` is stable
across renders, but `getContent` in `MarkdownEditor` depends on `[sourceMode, sourceContent, editor, content]` and will
change frequently. This means `doSave` gets a new identity on every content change, which is fine since it's only
called in event handlers (not passed as a dependency to other hooks), but it would be more efficient to use a ref for
`getContent`.
