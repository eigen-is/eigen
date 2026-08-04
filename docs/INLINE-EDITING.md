# Inline File Editing in Drive

> **TLDR**: Native text files (markdown, JSON, YAML, XML, HTML, CSS, CSV, TypeScript, etc.) can be edited inline in the
> Drive app via `/drive/edit/:ownerId/:mountId/:pathId`. Markdown gets a Tiptap WYSIWYG editor with source mode toggle.
> All other text formats use CodeMirror 6. Saving is explicit (`Mod+S` or the Save button) — there is no
> auto-save. Optimistic concurrency via `updatedAt` timestamps. Both editors host the shared `⌘F` bar.

## How It Works

1. User clicks a text file in Drive → `isInlineEditable(mimeType, name)` check
2. Navigates to `/drive/edit/:ownerId/:mountId/:pathId` route
3. File opens in **view mode** (read-only) with breadcrumb toolbar + "Edit" button
4. "Edit" button shown only if user has write permission (checked via `useCheckPermissions`)
5. Clicking "Edit" switches to **edit mode** with formatting toolbar + Cancel/Save buttons
6. Save persists content via `PUT /editor/...` with concurrency check, then returns to view mode
7. "Cancel" drops the buffer and returns to view mode — no confirmation
8. Back arrow (←) leaves the editor for the parent folder; with unsaved changes it asks to confirm
   the discard first

## Supported File Types

Markdown, plain text, web formats, the common programming languages, shell scripts, config files
and diffs. The list itself lives in code, not here — `isInlineEditable()` in
`packages/lib/src/types/drive.ts` is the source of truth (extension-based), alongside
`INLINE_EDITABLE_MIMES` (MIME-based). Edit mode (`markdown` / `plaintext` / `code`) is determined
by `getTextPreviewMode()` in `packages/lib/src/constants/preview.ts`.

## API

### GET `/editor/:ownerId/:mountId/:pathId/content`

Returns file content for editing. Uses `getTextPreviewMode()` to determine `editMode`. For markdown, extracts
frontmatter separately. Content is decoded with strict UTF-8 validation (`TextDecoder('utf-8', { fatal: true })`).

```typescript
{ editMode: 'markdown' | 'plaintext' | 'code', content: string, frontmatter: string | null, mimeType: string, updatedAt: Date }
```

Errors: 400 "File type not supported for inline editing" (unsupported type), 400 "File contains invalid UTF-8
encoding" (binary/non-UTF-8 file), 404 (not found), 413 (>5MB).

### PUT `/editor/:ownerId/:mountId/:pathId/content`

Saves file content. Uses `expectedUpdatedAt` for optimistic concurrency.

```typescript
// Request
{ content: string, frontmatter?: string, expectedUpdatedAt: string, force?: boolean }

// Response (success)
{ conflict: false, updatedAt: string }

// Response (conflict)
{ conflict: true, currentUpdatedAt: string }
```

Before writing, the route runs `enforceMountQuota()` with the encoded buffer length and the file's
old size — a save can fail on quota, not only on conflict.

## Concurrency

- `updatedAt` is the concurrency token
- On save, compare `expectedUpdatedAt` with current file's `updatedAt`
- Mismatch returns conflict response (unless `force: true`)
- ConflictDialog offers: Overwrite / Reload / Download your version

## Editors

**Markdown**: Tiptap WYSIWYG with source mode toggle (CodeMirror). Extensions: StarterKit, Markdown
(tiptap-markdown), Typography, TaskList, TaskItem, Link, Image, CodeBlockLowlight, Table.

**Code/Plaintext**: CodeMirror 6 with syntax highlighting for 14 languages, dark mode (oneDark), line wrapping,
undo/redo via toolbar buttons.

## Saving

There is **no auto-save**. `use-editor-save.ts` owns the whole save story:

- `Mod+S` saves; the toolbar Save button runs the same `doSave()`, then exits edit mode.
- A `beforeunload` guard warns when the buffer is dirty and the tab is closing.
- `confirmClose()` gates **leaving the editor** (the Back arrow) behind a discard-confirm dialog when
  dirty, and passes straight through when not. The Cancel button does not go through it — Cancel is
  an explicit discard.
- A conflict response flips the state to `conflict` and opens `ConflictDialog`.

## Find and Replace

Both inline editors host the shared `⌘F` find/replace bar. The markdown editor implements the
`DocSearchController` contract with `useProseMirrorSearchController` (the same controller the docs
app uses) for WYSIWYG mode and a CodeMirror controller (`use-codemirror-search-controller.ts`) for
source mode; the code editor uses the CodeMirror one. Both wrap their subtree in `DocSearchProvider`.
See [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md).

## Where the Code Lives

**Backend.** Routes in `apps/api/src/routes/editor.ts` — thin, ACL through `getSharedDrive()`, quota
through `enforceMountQuota()`, persistence through `Drive.writeFileContent()`. The editor logic
itself is in `apps/api/src/lib/drive/inline-edit.ts`: `getEditableContent()` (read + UTF-8 validation
+ frontmatter split), `prepareSaveContent()` (conflict check + reattach + size cap),
`extractFrontmatter()` / `reattachFrontmatter()`, `MAX_INLINE_EDIT_SIZE`. There is no
`saveEditableContent()` — the route composes `prepareSaveContent` with `Drive.writeFileContent`.

**Shared hooks.** `packages/lib/src/core/editor/hooks/` — `use-file-content.ts` (GET query) and
`use-file-save.ts` (PUT mutation + cache invalidation). `getTextPreviewMode()` in
`packages/lib/src/constants/preview.ts` picks the edit mode on both sides.

**Frontend.** The route is `apps/drive/src/routes/_auth.edit.$ownerId.$mountId.$pathId.tsx`;
everything else sits in `apps/drive/src/components/editor/` — `native-file-editor.tsx` dispatches
view/edit mode and lazy-loads the heavy editors, `markdown-editor.tsx` and `code-editor.tsx` are the
two editors (each with its read-only viewer), plus the toolbars, `use-editor-save.ts` and
`conflict-dialog.tsx`.
