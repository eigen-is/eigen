# Inline File Editing in Drive

> **TLDR**: Native text files (markdown, JSON, YAML, XML, HTML, CSS, CSV, TypeScript, etc.) can be edited inline in the
> Drive app via `/drive/edit/:ownerId/:mountId/:pathId`. Markdown gets a Tiptap WYSIWYG editor with source mode toggle.
> All other text formats use CodeMirror 6. Optimistic concurrency via `updatedAt` timestamps. View/edit mode split.

## How It Works

1. User clicks a text file in Drive → `isInlineEditable(mimeType, name)` check
2. Navigates to `/drive/edit/:ownerId/:mountId/:pathId` route
3. File opens in **view mode** (read-only) with breadcrumb toolbar + "Edit" button
4. "Edit" button shown only if user has write permission (checked via `useCheckWritePermission`)
5. Clicking "Edit" switches to **edit mode** with formatting toolbar + Cancel/Save buttons
6. Save persists content via `PUT /editor/...` with concurrency check, then returns to view mode
7. "Cancel" discards changes and returns to view mode
8. Back arrow (←) navigates to the parent folder in Drive

## Supported File Types

Detected by `isInlineEditable()` in `packages/lib/src/types/drive.ts`. Covers ~70 extensions including:

| Category | Extensions |
|----------|-----------|
| Markdown | `.md`, `.markdown` |
| Plain text | `.txt`, `.csv`, `.log` |
| Web | `.html`, `.css`, `.json`, `.xml`, `.yaml`, `.yml` |
| Code | `.js`, `.jsx`, `.ts`, `.tsx`, `.py`, `.rs`, `.go`, `.java`, `.php`, `.sql` |
| Shell | `.sh`, `.bash`, `.zsh`, `.fish` |
| Config | `.conf`, `.cfg`, `.ini`, `.toml`, `.env`, `.gitignore`, `.editorconfig` |

## API

### GET `/editor/:ownerId/:mountId/:pathId/content`

Returns file content for editing. For markdown, extracts frontmatter separately.

```typescript
{ editMode: 'markdown' | 'plaintext' | 'code', content: string, frontmatter: string | null, mimeType: string, updatedAt: Date }
```

Errors: 400 (unsupported type / invalid UTF-8), 404 (not found), 413 (>5MB).

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

## Files

### Backend

| File | Purpose |
|------|---------|
| `apps/api/src/routes/editor.ts` | Editor API routes |
| `apps/api/src/lib/drive/drive.ts` | `writeFileContent()` method |

### Frontend — Hooks

| File | Purpose |
|------|---------|
| `packages/lib/src/core/editor/hooks/use-file-content.ts` | Query hook for GET content |
| `packages/lib/src/core/editor/hooks/use-file-save.ts` | Mutation hook for PUT content + cache invalidation |

### Frontend — Route & Components

| File | Purpose |
|------|---------|
| `apps/drive/src/routes/_auth.edit.$ownerId.$mountId.$pathId.tsx` | Edit route |
| `apps/drive/src/components/editor/native-file-editor.tsx` | View/edit mode dispatcher (lazy loads editors) |
| `apps/drive/src/components/editor/markdown-editor.tsx` | Tiptap WYSIWYG + source mode + MarkdownViewer |
| `apps/drive/src/components/editor/markdown-toolbar.tsx` | Formatting buttons for markdown |
| `apps/drive/src/components/editor/code-editor.tsx` | CodeMirror wrapper + CodeViewer |
| `apps/drive/src/components/editor/editor-toolbar.tsx` | ViewToolbar + EditToolbar |
| `apps/drive/src/components/editor/use-editor-save.ts` | Shared save logic (auto-save, Cmd+S, conflict, beforeunload) |
| `apps/drive/src/components/editor/conflict-dialog.tsx` | Conflict resolution dialog |
