# FE Code Review: Docs (Document Editor)

## Summary

The Docs frontend is a Tiptap-based collaborative document editor with custom extensions for resizable images, comment
marks, clipboard integration, and revision history. The codebase is generally well-structured and follows most project
patterns. However, there are numerous hardcoded colors that break dark mode, missing error feedback on mutations,
an `interface` used where `type` is required, a type cast that bypasses Eden Treaty safety, and the CSS file contains
many hardcoded hex colors instead of theme tokens.

## Critical Issues

### 1. Missing error feedback on all three mutation calls

- **File**: `apps/docs/src/components/docs/editor.tsx`, lines 272-278 (`handleImageUpload`)
- **File**: `apps/docs/src/components/docs/editor.tsx`, lines 281-295 (`handleEigenImagePaste`)
- **File**: `apps/docs/src/components/docs/comment-dialog.tsx`, lines 33-53 (`handleSubmit`)
- **Issue**: All three async functions call `mutateAsync` without a `catch` block that shows a `toast.error()` to the
  user. In `handleImageUpload`, if `uploadFile.mutateAsync` fails, the error propagates unhandled. In
  `handleEigenImagePaste`, `reUploadImage` catches internally but the outer `uploadFile.mutateAsync` path has no error
  handling. In `handleSubmit`, the `try` block has no `catch` with `toast.error()` -- errors are silently swallowed by
  the `finally` block which just resets state and closes the dialog.
- **Why it matters**: CLAUDE.md requires every mutation to have error feedback via `toast.error()` or `onError`. Users
  get no indication when image upload or comment creation fails.
- **Suggested fix**: Wrap each `mutateAsync` call in try/catch with `toast.error('Failed to upload image')` etc., or
  add `onError` callbacks to the mutation hooks.

### 2. `as DrivePath` cast bypasses Eden Treaty type safety

- **File**: `apps/docs/src/components/docs/comment-dialog.tsx`, line 40
- **Issue**: `const chatPath = result as DrivePath;` casts the mutation result to `DrivePath` instead of letting the
  type flow from the API definition. This violates the project rule against `as any` and type casting that breaks
  Eden Treaty's end-to-end type safety.
- **Why it matters**: CLAUDE.md explicitly forbids `as any` and says to fix the type at the source. If the API response
  shape changes, this cast will silently produce incorrect types.
- **Suggested fix**: Check the return type of `createChat.mutateAsync` and fix the hook's return type if needed, rather
  than casting at the call site.

### 3. Direct API call bypasses hook pattern

- **File**: `apps/docs/src/components/docs/comment-dialog.tsx`, lines 43-46
- **Issue**: The component dynamically imports `chatApi` and makes a direct API call
  (`chatApi({ownerId})({mountId})({chatId}).messages.post(...)`) instead of using a hook from
  `packages/lib/src/core/chat/hooks/`. CLAUDE.md states: "Never use `useQuery`/`useMutation` directly in apps -- all
  data hooks live in `packages/lib/src/core/[domain]/hooks/`". While this isn't a hook call, it's a direct API call
  from a component, which violates the same principle of centralizing data access.
- **Why it matters**: The pattern exists to ensure consistent cache invalidation, error handling, and type safety. A
  direct API call bypasses all of these.
- **Suggested fix**: Create or use a `useSendChatMessage` hook in `packages/lib/src/core/chat/hooks/` and call it
  from the component.

## Pattern Violations

### `interface` used instead of `type`

- **File**: `apps/docs/src/components/docs/docs-sidebar.tsx`, line 12
- **Issue**: `interface DocsSidebarProps` should be `type DocsSidebarProps` per CLAUDE.md.
- **File**: `apps/docs/src/routes/__root.tsx`, line 14
- **Issue**: `interface MyRouterContext` should be `type MyRouterContext`.
- **Why it matters**: Project convention requires `type` over `interface` except when methods are needed.
- **Suggested fix**: Change `interface` to `type` with `=` syntax.

### Hardcoded colors in components (breaks dark mode)

- **File**: `apps/docs/src/components/docs/editor.tsx`, line 135
    - `color: '#3b82f6'` (dropcursor) -- should use a theme token or CSS variable.
- **File**: `apps/docs/src/components/docs/editor.tsx`, line 156
    - `class: 'text-blue-600 underline cursor-pointer'` (link style) -- should use theme token like
      `text-primary` or a semantic color.
- **File**: `apps/docs/src/components/docs/editor.tsx`, line 184
    - `color: '#9810fa'` (collaboration cursor) -- hardcoded purple for all users.
- **File**: `apps/docs/src/components/docs/editor.tsx`, line 368
    - `bg-white text-black` -- hardcodes light mode colors. Should use `bg-background text-foreground` or similar theme
      tokens. (Note: this is the document canvas, so `bg-white text-black` may be intentional for print fidelity, but it
      should at least be documented as intentional.)
- **File**: `apps/docs/src/components/docs/extensions/resizable-image.tsx`, line 72
    - `border border-blue-500` -- should use `border-primary` or `border-ring`.
- **File**: `apps/docs/src/components/docs/extensions/resizable-image.tsx`, line 81
    - `bg-white rounded-md shadow-md` -- should use `bg-popover` or `bg-card`.
- **File**: `apps/docs/src/components/docs/editor-toolbar.tsx`, line 416
    - `'#000'` fallback color -- should use a CSS variable.
- **Why it matters**: CLAUDE.md states "Use theme tokens, not hardcoded colors". All hardcoded colors break dark mode.

### Hardcoded colors in CSS (12 hex values)

- **File**: `apps/docs/css/globals.css`, multiple lines
- **Issue**: The CSS file contains 12+ hardcoded hex colors: `#1d4ed8`, `#7c3aed`, `#9ca3af`, `#dbeafe`, `#3b82f6`,
  `#fef08a`, `#eab308`, `#fde047`, `#bfdbfe`, `#6b7280`, `#1f2937`. These should use CSS custom properties from the
  theme system (e.g., `hsl(var(--primary))`, `hsl(var(--accent))`, `hsl(var(--muted-foreground))`).
- **Why it matters**: The entire editor becomes a light-mode-only experience. Comment highlights, selection colors,
  table selection, task list checkmarks, and link hover colors all break in dark mode.
- **Suggested fix**: Replace hex colors with `var(--...)` theme tokens throughout the CSS file.

### Collaboration cursor color is hardcoded and identical for all users

- **File**: `apps/docs/src/components/docs/editor.tsx`, line 184
- **Issue**: `color: '#9810fa'` means every collaborator sees the same purple cursor for all other users, making it
  impossible to distinguish between multiple collaborators.
- **Suggested fix**: Use a deterministic color assignment based on user ID or index (e.g., hash the user ID to pick
  from `EIGEN_ACCENT_COLORS` defined in `packages/lib/src/constants/colors.ts`).

## Security Concerns

### 1. No sanitization of `linkUrl` before applying

- **File**: `apps/docs/src/components/docs/editor-toolbar.tsx`, lines 118-123
- **Issue**: `applyLink()` applies `linkUrl` directly as an `href` without validating the URL scheme. A user could
  enter `javascript:alert(1)` as a link URL, which Tiptap's Link extension may or may not sanitize depending on
  configuration.
- **Why it matters**: XSS vector if the link extension does not strip dangerous protocols.
- **Suggested fix**: Validate that the URL starts with `http://`, `https://`, or `mailto:` before applying. Tiptap's
  Link extension has `validate` option that can be configured to reject non-http(s) URLs.

### 2. `transformPastedHTML` parses untrusted HTML

- **File**: `apps/docs/src/components/docs/editor.tsx`, lines 208-231
- **Issue**: `transformPastedHTML` uses `DOMParser` to parse pasted HTML and manipulates it. While it strips font
  families and constrains image widths, it does not sanitize against script injection or event handlers in the pasted
  HTML. Tiptap generally handles this by only allowing known nodes/marks, but the raw HTML manipulation happens before
  Tiptap's sanitization.
- **Why it matters**: If any path exists where raw HTML is inserted without going through Tiptap's schema
  transformation, this could be an XSS vector.
- **Suggested fix**: This is low risk since Tiptap's schema is the final gatekeeper, but consider adding a DOMPurify
  pass for defense in depth.

### 3. Comment `chatName` attribute is user-influenced

- **File**: `apps/docs/src/components/docs/extensions/comment-mark.ts`, lines 29-38
- **Issue**: The `chatName` attribute is stored as a `data-chat-name` HTML attribute and read back via
  `element.getAttribute('data-chat-name')`. If a malicious user crafts a Yjs update that includes a `chatName` value
  with special characters, it could potentially break the attribute parsing.
- **Why it matters**: Low risk since the value is used as a lookup key against folder contents (not rendered as HTML),
  but should be validated.
- **Suggested fix**: Sanitize the `chatName` value on read to ensure it matches expected patterns (alphanumeric +
  hyphens + dots).

## Data Integrity

### 1. Y.Doc created outside the provider lifecycle

- **File**: `apps/docs/src/components/docs/editor.tsx`, lines 51-67
- **Issue**: `yDoc` is created via `useMemo(() => new Y.Doc(), [])` and the WebSocket provider connects to it in a
  `useEffect`. There's a window between Y.Doc creation and provider connection where local changes could be made to the
  doc that would not be synchronized. Additionally, `yDoc` has an empty dependency array, so it persists across
  re-renders,
  but the effect depends on `[yDoc, path.ownerId, path.mountId, path.id]`. When path changes (navigating between
  documents), the effect runs cleanup and creates a new provider for the same Y.Doc instance, which still contains the
  previous document's state.
- **Why it matters**: Navigating between documents without unmounting the component could cause document state bleed.
  The `useMemo(() => new Y.Doc(), [])` with empty deps means the same Y.Doc is reused for different documents.
- **Suggested fix**: Include the path identifiers in the Y.Doc useMemo deps (which would create a new doc per path),
  or ensure the component unmounts/remounts when path changes (which it likely does due to TanStack Router, but should
  be verified). Consider adding a `key` prop based on `pathId` to force remounting.

### 2. Revision restore replaces content without confirmation

- **File**: `apps/docs/src/components/docs/editor-toolbar.tsx`, lines 102-108
- **Issue**: `handleRestore` applies a revision state by converting it to ProseMirror JSON and calling
  `editor.commands.setContent(json)`. This replaces the entire document content for all collaborators without any
  confirmation dialog. In a collaborative setting, this is destructive for all connected users.
- **Why it matters**: One user can accidentally destroy another user's in-progress work by restoring an old revision.
- **Suggested fix**: Add a confirmation dialog before restoring. Consider creating a snapshot before restore so the
  action is reversible.

### 3. `useFolderContent` for media resolution could return stale data

- **File**: `apps/docs/src/components/docs/editor.tsx`, lines 36-42; `packages/lib/src/core/drive/media-resolver.tsx`
- **Issue**: `mediaFolderId` and `chatFolderId` are derived from the initial `/collab/.../info` response. If new media
  files are uploaded during the editing session, the `useFolderContent` query in `MediaResolverProvider` will eventually
  refetch, but there could be a window where newly uploaded images don't resolve (showing empty `src`).
- **Why it matters**: After uploading an image, there's a brief period where it may not render in the document.
- **Suggested fix**: Invalidate the folder content query after a successful image upload in `handleImageUpload`.

## Code Quality

### 1. Large `TiptapEditor` component (300+ lines)

- **File**: `apps/docs/src/components/docs/editor.tsx`, lines 89-399
- **Issue**: The `TiptapEditor` component handles editor setup, image upload, clipboard integration, comment management,
  and rendering. This is a lot of responsibility for a single component.
- **Suggested fix**: Extract `useClipboardHandler`, `useImageUpload`, and `useCommentManager` custom hooks to reduce
  component complexity.

### 2. Large `EditorToolbar` component (715+ lines)

- **File**: `apps/docs/src/components/docs/editor-toolbar.tsx`
- **Issue**: The toolbar file is over 700 lines with deeply nested JSX for menus, popovers, and dialogs. Much of the
  desktop and mobile toolbar markup is duplicated.
- **Suggested fix**: Extract `TextFormattingToolbar`, `InsertToolbar`, `AlignmentToolbar` as sub-components. The mobile
  menu and desktop toolbar share the same operations -- consider a shared action list that renders differently per
  breakpoint.

### 3. `useEditor` dependency array only contains `[handleCommentClick]`

- **File**: `apps/docs/src/components/docs/editor.tsx`, line 268
- **Issue**: The `useEditor` hook depends on `[handleCommentClick]`, but the editor config references `mediaFolderId`,
  `getEditorMaxWidth`, and the upload/paste handlers via closures. Changes to `mediaFolderId` (e.g., if it resolves
  after initial render) would not re-create the editor, meaning drop/paste handlers could reference a stale
  `mediaFolderId`.
- **Why it matters**: If `mediaFolderId` is null initially and resolves later, the `handleDrop` and `handlePaste`
  closures will always see `null` and silently skip image uploads.
- **Suggested fix**: Add `mediaFolderId` to the `useEditor` dependency array, or use a ref for `mediaFolderId` that the
  handlers read at call time.

### 4. `editorRef.current = editor` assignment on every render

- **File**: `apps/docs/src/components/docs/editor.tsx`, line 270
- **Issue**: `editorRef.current = editor;` is assigned directly in the render body rather than in a `useEffect`. While
  this works in practice (refs are mutable), it's unconventional and could cause issues with concurrent React features.
- **Suggested fix**: Use `useEffect` to assign the ref, or use `editor` directly in the handlers since they're defined
  in the same component.

### 5. `useRootFolder` called with empty string when user is null

- **File**: `apps/docs/src/routes/__root.tsx`, line 21
- **Issue**: `useRootFolder(user?.id || '', mountId)` passes empty string when user is null. The hook will fire a query
  with empty ownerId. While `enabled` guards typically prevent this, it depends on the hook's implementation.
- **File**: `apps/docs/src/components/docs/editor-toolbar.tsx`, line 98
- **Issue**: Same pattern: `useRootFolder(user?.id || '')`.
- **Suggested fix**: Add `enabled: !!user?.id` or check the hook's implementation to ensure it handles empty strings.

### 6. Non-null assertion on `auth.user!`

- **File**: `apps/docs/src/routes/_auth._sidebar.mime.$mimeType.tsx`, line 25
- **Issue**: `const ownerId = auth.user!.id;` uses non-null assertion. The route is behind an auth guard, but TypeScript
  can't verify this. If the auth guard fails, this would crash.
- **File**: `apps/docs/src/routes/_auth._sidebar.shared.$to.tsx`, line 26
- **Issue**: Same pattern.
- **Suggested fix**: Add early return or redirect if `!auth.user`, or use `auth.user?.id ?? ''` with an enabled guard.

### 7. Dead code: unused `DrivePath` import in comment-dialog

- **File**: `apps/docs/src/components/docs/comment-dialog.tsx`, line 7
- **Issue**: `import type {DrivePath} from "@workspace/lib/types/drive"` is used only for the `as DrivePath` cast
  (line 40). If the cast is removed (as recommended), this import becomes unused.

## Architecture

### Extension architecture is clean

The custom Tiptap extensions (`ResizableImage`, `CommentMark`) follow best practices: they declare commands via module
augmentation, use `ReactNodeViewRenderer` for complex views, and store name-based references consistent with the
media reference design documented in `MEDIA-REFERENCES.md`.

### MediaResolverProvider integration is well-designed

Wrapping the editor in `MediaResolverProvider` and using `useMediaResolver()` in the image node view creates a clean
separation between name-based Yjs storage and URL-based rendering. This matches the documented pattern exactly.

### Clipboard integration follows the documented pattern

Copy/paste uses `readEigenClipboard`/`writeEigenClipboard` with `needsReUpload` and `reUploadImage` for cross-document
media transfer, matching the design in `CLIPBOARD.md`.

### Route structure is well-organized

The separation between sidebar routes (`_auth._sidebar.mime.$mimeType`, `_auth._sidebar.shared.$to`) and the
full-screen editor route (`_auth.doc.$ownerId.$mountId.$pathId`) is a good pattern. The root route conditionally hides
the sidebar when in editor mode.

## Positive Patterns

1. **Name-based media references**: Images are stored by name in Yjs, resolved at render time via
   `MediaResolverProvider`. This enables document copy without Yjs rewriting.
2. **Read-only mode**: The editor correctly sets `editable: access.canWrite` and conditionally shows toolbar elements,
   with `DocumentModeButton` indicating read-only state.
3. **`transformPastedHTML`**: Strips font families and constrains oversized images on paste, improving paste quality
   from
   external sources.
4. **`DriveLayout` reuse**: The sidebar routes reuse `DriveLayout` from the shared UI library rather than building
   custom list views.
5. **Revision history**: Clean integration via the shared `RevisionHistory` component with lazy-loaded revision data.
6. **Comment system**: Inline comments via Tiptap marks with embedded chat rooms is a creative and functional design.

## Recommendations

### P0 (Fix immediately)

- Add `toast.error()` to all three mutation call sites (`handleImageUpload`, `handleEigenImagePaste`,
  `handleSubmit` in comment dialog)
- Remove `as DrivePath` cast and fix the type at the hook level
- Add `mediaFolderId` to the `useEditor` dependency array (or use a ref) to prevent stale closure

### P1 (Fix soon)

- Replace all hardcoded colors in components with theme tokens (`text-primary`, `bg-background`, `border-ring`, etc.)
- Replace all hardcoded hex colors in `apps/docs/css/globals.css` with CSS custom properties
- Assign unique colors to collaboration cursors based on user identity
- Validate link URLs before applying (reject `javascript:` protocol)
- Change `interface` to `type` for `DocsSidebarProps` and `MyRouterContext`
- Move the direct `chatApi` call to a proper hook in `packages/lib/src/core/chat/hooks/`
- Add confirmation dialog before revision restore in collaborative editing

### P2 (Improve when touching)

- Extract `TiptapEditor` into smaller focused hooks (`useClipboardHandler`, `useImageUpload`, `useCommentManager`)
- Extract `EditorToolbar` sub-components to reduce the 700+ line file
- Invalidate folder content query after image upload for immediate resolution
- Add a `key={pathId}` to force component remount when navigating between documents
- Replace `auth.user!` non-null assertions with proper null checks
- Remove unused `DrivePath` import after fixing the cast
