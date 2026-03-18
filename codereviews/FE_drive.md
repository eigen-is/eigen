# Frontend Code Review: Drive App

## Summary

The Drive app is a file management frontend with inline editing, MIME-filtered views, shared-file views, and team drive
support. The codebase is well-structured overall, with most data hooks properly centralized in `packages/lib` and shared
UI components in `packages/ui`. The app follows the project's architectural patterns for routing, layout, and SSE
invalidation. However, there are several issues ranging from a rules-of-hooks violation to type safety gaps, dark mode
breakage, and missing edge-case handling.

**Files reviewed:**

- `apps/drive/src/` -- all 17 source files (routes, components, main, routeTree.gen)
- `apps/drive/css/globals.css`
- `packages/lib/src/core/drive/` -- hooks, SSE handlers, media resolver, index
- `packages/lib/src/core/editor/` -- hooks, index
- `packages/ui/src/components/layout/drive/` -- DriveLayout, DriveList, DriveTable, DriveDetail, DriveUploadFiles,
  useDriveDialogs

---

## Architecture Compliance

**Hooks in packages/lib (PASS):** The app correctly delegates all `useQuery`/`useMutation` calls to hooks in
`packages/lib/src/core/drive/hooks/` and `packages/lib/src/core/editor/hooks/`. No direct `useQuery` or `useMutation`
calls exist in `apps/drive/src/`. The single `useQueryClient` import in `native-file-editor.tsx` (line 6) is used only
for cache invalidation, which is acceptable.

**Routing (PASS):** File-based TanStack Router with `_auth.tsx` guard using `beforeLoad` redirect. The root `index.tsx`
redirects to `/fs/$ownerId/$mountId/$pathId` with sensible defaults.

**Layout system (PASS):** Uses `AppShell` at the root, `DriveLayout` (which wraps `ColumnLayout` + `Column`) for all
main views, and the inline editor uses `ColumnLayout` directly with proper column IDs.

**SSE integration (PASS):** `sse-handlers.ts` correctly handles all drive event types and calls the shared invalidation
functions exported from `use-drive.ts`.

**Query keys (PASS):** Well-structured hierarchical key scheme in `driveKeys`. Invalidation functions are exported for
reuse. Editor keys follow the same pattern.

---

## Issues Found

### Critical

#### 1. Rules of Hooks Violation: Conditional Hook Call in DriveListToolbar

**File:** `packages/ui/src/components/layout/drive/drive-list.tsx`, line 58

```typescript
const {data: breadcrumbPaths = []} = showBreadcrumb ? useBreadcrumb(ownerId, mountId, pathId) : {data: []};
```

This is a conditional hook call, which violates React's Rules of Hooks. Hooks must be called unconditionally at the
top level of a component. If `showBreadcrumb` changes between renders, React's hook ordering will break, causing
undefined behavior or crashes.

**Fix:** Always call the hook but pass an empty/disabled condition:
```typescript
const {data: breadcrumbPaths = []} = useBreadcrumb(ownerId, mountId, showBreadcrumb ? pathId : undefined);
```
Since `useBreadcrumb` already has `enabled: !!pathId`, passing `undefined` will simply skip the query.

#### 2. Search Params Type Mismatch: `uid` Not Validated in Shared Route

**File:** `apps/drive/src/routes/_auth.shared.$to.tsx`, lines 13-16, 22

The `validateSearch` function only extracts `pid` from the search params:
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

The `DriveSearchParams` type in `packages/lib/src/types/drive.ts` does declare `uid?: string`, but the validator never
extracts or validates it. This means `uid` will always be `undefined` at runtime, which breaks the "shared with me"
detail panel -- clicking a shared file will fail to load its path info because `usePathInfo` is called with `uid || ''`
(line 26), and the file's actual `ownerId` (set via `uid: path.ownerId` on line 47) is discarded by the validator.

**Fix:** Add `uid` extraction to the validator:
```typescript
validateSearch: (search: Record<string, unknown>) => {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    const uid = typeof search.uid === 'string' ? search.uid : undefined;
    return {pid, uid} as DriveSearchParams;
},
```

---

### Important

#### 3. CodeEditorView Ignores Content/Language/onChange Changes

**File:** `apps/drive/src/components/editor/code-editor.tsx`, lines 135-147

The `useEffect` that creates the CodeMirror editor instance only depends on `[isDark]`:
```typescript
useEffect(() => {
    // ...creates EditorView with content, language, onChange...
    return () => view.destroy();
}, [isDark]);
```

This means if `content`, `language`, or `onChange` change, the editor will not rebuild. While `content` is unlikely to
change during editing (it's the initial value), the `onChange` callback created via `useCallback` in the parent *could*
have a new identity. More importantly, `language` and `content` are both used inside the effect but missing from the
dependency array. If the component is ever remounted with different props but the same `isDark` value, the editor will
show stale content.

The current code works because `key={reloadKey}` on the parent forces full remounting when reloads happen. This is
fragile -- the correctness depends on the parent always using the key prop correctly.

#### 4. Non-Null Assertion on `auth.user` in Guarded Routes

**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx`, line 23
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx`, line 24

```typescript
const ownerId = auth.user!.id;
```

Both routes use the non-null assertion operator on `auth.user`. While the `_auth.tsx` route guard ensures the user is
authenticated, the guard uses `context.auth.isAuthenticated` which is evaluated during `beforeLoad`. If there is ever a
race condition where the auth state changes between route load and component render (e.g., session expiry), the `!`
assertion could cause a runtime crash. A safer pattern would be:

```typescript
const ownerId = auth.user?.id ?? '';
```

This is how `__root.tsx` handles it (line 22: `user?.id || ''`).

#### 5. Sidebar "Upload file" Menu Item Does Not Trigger File Picker

**File:** `apps/drive/src/components/drive/drive-sidebar.tsx`, lines 198-208

The "Upload file" dropdown menu item has a hidden `<input type="file">` inside it, but clicking the menu item calls
`setUploadOpen(true)` rather than triggering the file input. The hidden input has an `onChange` handler but no
mechanism to be clicked. Since the `DriveUploadFiles` component (which `setUploadOpen` opens) shows its own native
file picker, the hidden input inside the dropdown is dead code that will never fire.

```typescript
<DropdownMenuItem onClick={() => setUploadOpen(true)}>
    <UploadIcon className="h-4 w-4 mr-2"/>
    Upload file
    <input
        type="file"
        className="hidden"
        onChange={handleFileChange}   // <-- never triggered
    />
</DropdownMenuItem>
```

**Fix:** Remove the dead `<input>` element from the dropdown item.

#### 6. Dark Mode Not Supported in Tiptap Editor Styles

**File:** `apps/drive/css/globals.css`

All Tiptap styles use hardcoded light-mode colors (e.g., `#f3f4f6` for inline code background, `#dc2626` for inline
code color, `#d1d5db` for blockquote borders, `#6b7280` for blockquote text, `#f9fafb` for table headers, `#e5e7eb`
for horizontal rules). There are zero `.dark` selectors or CSS variable usages for these styles, meaning the markdown
editor is broken/unreadable in dark mode.

The project already has a shared `eigen-prose.css` in `packages/ui/src/styles/` that handles dark mode correctly
(per PREVIEWS.md and the CLAUDE.md feedback about shared stylesheets). The Tiptap styles should either use CSS
variables or duplicate with `.dark` variants.

#### 7. Video Preview in DriveDetail Only Handles Two MIME Types

**File:** `packages/ui/src/components/layout/drive/drive-detail.tsx`, line 164

```typescript
{(path.mimeType === "video/mp4" || path.mimeType === "video/mpeg") && (
```

This only renders the inline video player for MP4 and MPEG. Common video types like `video/webm`, `video/quicktime`
(MOV), and `video/ogg` are excluded. Similarly, the audio check on line 175 uses loose equality (`==`) instead of
strict (`===`), which is a minor inconsistency but not a bug since both operands are strings.

#### 8. `DriveSearchParams` Loose Type Assertion

**File:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`, line 15
**File:** `apps/drive/src/routes/_auth.mime.$mimeType.tsx`, line 13
**File:** `apps/drive/src/routes/_auth.shared.$to.tsx`, line 15

All three routes use `as DriveSearchParams` to cast the returned object from `validateSearch`. Since
`DriveSearchParams` has optional fields (`pid?`, `uid?`), the cast is not dangerous today, but it suppresses
TypeScript's structural checking. Using `satisfies DriveSearchParams` would be safer and would catch if the return
shape diverges from the type.

---

### Minor

#### 9. `interface` Used Instead of `type` in Two Places

**File:** `apps/drive/src/routes/__root.tsx`, line 15: `interface MyRouterContext`
**File:** `apps/drive/src/components/drive/drive-sidebar.tsx`, line 43: `interface DriveSidebarProps`

Per CONTRIBUTING.md: "Always `type` over `interface` (except when methods needed)". These are simple property-only
shapes and should use `type`.

#### 10. Commented-Out Code in Multiple Files

**File:** `apps/drive/src/components/editor/editor-toolbar.tsx`, line 29: Commented-out `TooltipButton` for back
navigation.

**File:** `packages/ui/src/components/layout/drive/drive-list.tsx`, lines 357-360: Commented-out "new item button"
in empty state.

These should either be restored or removed.

#### 11. No-Op `onSave` Callbacks in Sidebar Dialogs

**File:** `apps/drive/src/components/drive/drive-sidebar.tsx`, lines 306-369

All create dialogs in the sidebar receive `onSave={() => {}}` (empty arrow function). These allocate a new function
on every render. Since the sidebar also passes `onAfterAction={handleAfterAction}`, the `onSave` prop is effectively
unused. Consider either passing `undefined` or removing the prop if the dialog components support it.

#### 12. Error Message Style Inconsistency

**File:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`, line 126: Uses `text-muted-foreground`
with a whimsical message ("Encountering the null vector...").

**File:** `apps/drive/src/routes/__root.tsx`, line 47: Uses `text-red-500` with a standard message ("Error loading
drive content").

Error states should use a consistent visual style. The `__root.tsx` approach (red color + technical message) is more
standard; the whimsical messages in the sub-routes are charming but may confuse users who encounter real errors.

#### 13. `DriveLayout` Prop `error` Typed as `any`

**File:** `packages/ui/src/components/layout/drive/drive-layout.tsx`, line 29

```typescript
error: any;
```

This should be `Error | null` for type safety. The same applies to `onAfterAction` on line 35:
```typescript
onAfterAction?: (actionType: string, data: any) => void;
```

#### 14. Missing `Toolbar` Import in `drive-list.tsx`

**File:** `packages/ui/src/components/layout/drive/drive-list.tsx`

The `DriveListToolbar` component renders a raw `<div>` instead of using the shared `<Toolbar>` component that all other
toolbars use (e.g., `editor-toolbar.tsx` uses `<Toolbar>`). This leads to slightly inconsistent toolbar styling.

#### 15. `DriveContext` Created in Root Route Instead of a Dedicated File

**File:** `apps/drive/src/routes/__root.tsx`, lines 10-13

The `DriveContext` is created and exported from the root route file. Other route files import it from `./__root`.
This works but is unconventional -- contexts are typically in their own file or in a shared location. If the route
file is refactored, all imports would break.

---

## UX/UI Quality

**Good:**
- Mobile responsiveness is handled well via `ColumnLayout` + `mobileColumn` switching in all routes.
- The `onBack` handler is provided for mobile navigation in both the main file browser and inline editor.
- Drag-and-drop file upload has a polished overlay with animation.
- Internal drag-and-drop for moving files between folders works correctly.
- Quick Look (preview) is available from the file list with sibling navigation.
- Breadcrumb navigation works in both the file browser and editor toolbars.
- The inline editor has proper unsaved-changes protection (beforeunload + confirm dialog).
- Conflict resolution dialog for concurrent edits is well-implemented.
- Lazy loading of heavy editors (Tiptap, CodeMirror) keeps initial bundle small.

**Needs attention:**
- The edit route (`_auth.edit.$ownerId.$mountId.$pathId.tsx`, line 14) renders `null` while loading the path info,
  causing a flash of empty content. A loading spinner would be better.
- The sidebar's "New" dropdown always creates items in the *currently viewed* folder. When viewing a mime-filtered or
  shared-items view, `targetPath` falls back to `rootPath`, which may surprise users.
- The mime-type route (`_auth.mime.$mimeType.tsx`) navigates to the same route on folder activation (line 57), which is
  a no-op since mime views do not contain folders. The context menu still shows "Open" for folders in this view.
- The empty state message ("Within this void, all possibilities are yet unobserved") provides no actionable guidance to
  new users about how to create or upload files.

---

## Recommendations

1. **Fix the conditional hook call in `DriveListToolbar`** -- this is a correctness bug that violates React rules and
   could cause crashes in future React versions.

2. **Fix the `uid` validation in `_auth.shared.$to.tsx`** -- without this, clicking shared files in "shared with me"
   cannot load the file detail panel correctly since the owner ID is lost.

3. **Add dark mode support to Tiptap editor styles** -- either extend `globals.css` with `.dark` variants or migrate
   to CSS variables. This is a significant visual regression for dark-mode users.

4. **Add the `content` and `language` dependencies to the CodeEditorView effect** or add a comment explaining why the
   omission is intentional (parent uses `key` for remounting).

5. **Replace `auth.user!` assertions** with safe optional chaining to match the pattern used in `__root.tsx`.

6. **Clean up dead code** -- the hidden file input in the sidebar upload menu item, commented-out code blocks, and no-op
   `onSave` callbacks add confusion without value.

7. **Consider extracting `DriveContext`** to a dedicated file in `apps/drive/src/` for cleaner imports and separation
   of concerns.
