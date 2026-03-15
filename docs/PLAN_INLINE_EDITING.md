# Plan: Inline Editing of Native Files in Drive

Step-by-step implementation plan derived from PROPOSAL_INLINE_EDITING.md. Phase 1 only (markdown editing).
Phase 2 (CodeMirror / plain text / code files) and Phase 3 (polish) are not covered here.

## Dependencies

Install before starting (ask user):

- `tiptap-markdown` in `apps/drive`

Tiptap core packages are already available via `packages/ui` but may need to be added as a direct dependency of
`apps/drive` since Drive does not currently use Tiptap.

## Step 1: Backend — Editor Router

**Create `apps/api/src/routes/editor.ts`**

New Elysia router with `{auth: true}`. Three endpoints:

### GET `/editor/:ownerId/:mountId/:pathId/content`

1. Resolve drive via `getSharedDrive(ownerId, mountId, userId)` (same pattern as `drive.ts` routes)
2. Get path metadata: `mount.getPath(pathId)` — need `mimeType`, `name`, `size`, `updatedAt`
3. Determine `editMode` from MIME type and file name:
   - `text/markdown` or `.md`/`.markdown` extension -> `'markdown'`
   - `text/plain` or `.txt` -> `'plaintext'`
   - `application/json`, `text/yaml`, `text/xml`, `text/html`, `text/css`, `text/csv` -> `'code'`
   - Everything else -> return 400 "File type not supported for inline editing"
4. Check file size limits: 2MB for markdown, 5MB for text/code. Return 413 if exceeded.
5. Read file bytes: `mount.readFile(pathId)`
6. Detect encoding: check for UTF-8 BOM or validate UTF-8. Return 400 if not UTF-8.
7. For markdown: extract frontmatter (regex: `/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/`). Return `frontmatter`
   and `body` separately.
8. Return `{ editMode, content, frontmatter?, mimeType, updatedAt: path.updatedAt.toISOString() }`

### PUT `/editor/:ownerId/:mountId/:pathId/content`

1. Resolve drive, get current path metadata
2. Compare `body.expectedUpdatedAt` against `path.updatedAt.toISOString()`
3. If mismatch and `!body.force`: return 409 `{ conflict: true, currentUpdatedAt }`
4. For markdown with frontmatter: re-attach `---\n{frontmatter}\n---\n{content}`
5. Write file: `mount.writeFile(pathId, Buffer.from(fullContent, 'utf-8'))`
   - This calls `updatePath({size})` internally which bumps `updatedAt`
6. Re-fetch path to get new `updatedAt`
7. Return `{ success: true, updatedAt: path.updatedAt.toISOString() }`

Body schema: `t.Object({ content: t.String(), frontmatter: t.Optional(t.String()), expectedUpdatedAt: t.String(), force: t.Optional(t.Boolean()) })`

### POST `/editor/:ownerId/:mountId/:pathId/convert`

Deferred — implement last within Phase 1 or defer to Phase 2. The convert-to-eigendoc flow requires server-side
ProseMirror schema setup which is complex. Mark as optional for Phase 1.

### Wire up

Register router in `apps/api/src/index.ts` alongside existing `.use(drive)`, `.use(collab)`, etc.

**Files to create:**
- `apps/api/src/routes/editor.ts`

**Files to modify:**
- `apps/api/src/index.ts` (register router)

## Step 2: Backend — `isInlineEditable` Helper

**Add to `packages/lib/src/core/api.ts`**

```typescript
const INLINE_EDITABLE_MIMES = new Set([
    'text/markdown',
    'text/plain',
    'text/csv',
    'application/json',
    'text/yaml',
    'application/x-yaml',
    'text/xml',
    'application/xml',
    'text/html',
    'text/css',
])

const INLINE_EDITABLE_EXTENSIONS = new Set([
    '.md', '.markdown', '.txt', '.csv', '.json',
    '.yaml', '.yml', '.xml', '.html', '.css',
])

function isInlineEditable(mimeType: string, name: string): boolean {
    if (INLINE_EDITABLE_MIMES.has(mimeType)) return true
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    return INLINE_EDITABLE_EXTENSIONS.has(ext)
}
```

Note: Phase 1 only handles markdown. The helper returns true for all supported types (forward-looking), but
`onRowActivate` in the Drive route can further gate on markdown-only until Phase 2.

**Files to modify:**
- `packages/lib/src/core/api.ts`

## Step 3: Frontend — Data Hooks

**Create `packages/lib/src/core/editor/hooks/use-file-content.ts`**

Query hook using Eden Treaty to call `GET /editor/:ownerId/:mountId/:pathId/content`.

```typescript
export const editorKeys = {
    all: ['editor'] as const,
    content: (ownerId: string, mountId: string, pathId: string) =>
        [...editorKeys.all, 'content', ownerId, mountId, pathId] as const,
}
```

Return `{ data: { editMode, content, frontmatter?, mimeType, updatedAt }, isLoading, error }`.

**Create `packages/lib/src/core/editor/hooks/use-file-save.ts`**

Mutation hook for `PUT /editor/:ownerId/:mountId/:pathId/content`.

- Accepts `{ content, frontmatter?, expectedUpdatedAt, force? }` as mutation variables
- On success (200): returns new `updatedAt` for the caller to update its ref
- On conflict (409): returns `{ conflict: true, currentUpdatedAt }` — caller shows ConflictDialog
- Debounced auto-save wrapper: 5-second debounce after last edit. Stores `updatedAt` in a ref that updates after
  each successful save. The debounce timer resets on each keystroke.

**Create `packages/lib/src/core/editor/hooks/index.ts`**

Re-export both hooks.

**Files to create:**
- `packages/lib/src/core/editor/hooks/use-file-content.ts`
- `packages/lib/src/core/editor/hooks/use-file-save.ts`
- `packages/lib/src/core/editor/hooks/index.ts`

## Step 4: Frontend — MarkdownEditor Component

**Create `apps/drive/src/components/editor/markdown-editor.tsx`**

Tiptap editor configured for markdown editing. This is the core component.

Props: `{ content: string, frontmatter: string | null, updatedAt: string, ownerId: string, mountId: string, pathId: string, onClose: () => void }`

**Editor setup:**
1. Initialize Tiptap `useEditor` with the markdown extension set (see proposal for full list):
   - StarterKit with `history: true`, `codeBlock: false`
   - `Markdown.configure({ html: true, tightLists: true, bulletListMarker: detectedMarker, transformPastedText: true, transformCopiedText: true })`
   - Typography, CharacterCount, TaskList + TaskItem, Link, Image (standard, not ResizableImage),
     CodeBlockLowlight, Table + TableRow + TableCell + TableHeader, History
   - Do NOT include: Underline, Subscript, Superscript, TextStyle, Color, TextAlign, Highlight, CommentMark,
     Collaboration, CollaborationCursor
2. Set initial content via `editor.commands.setContent(content)` (tiptap-markdown parses it)
3. Store original raw content in a ref for zero-edit detection

**Bullet marker detection** (on load):
- Scan `content` for list markers with regex `/^[\s]*([*+-])\s/gm`
- Count occurrences of each marker, use the most common one
- Pass to `Markdown.configure({ bulletListMarker })`

**Save logic:**
- Use `useFileSave` hook from Step 3
- Track `updatedAt` in a ref, initialized from props, updated after each successful save
- Track `isDirty` via editor's `onUpdate` callback
- Debounced auto-save: 5 seconds after last edit
- Cmd+S / Ctrl+S keybinding for explicit save
- On save: call `editor.storage.markdown.getMarkdown()` to serialize

**Line ending preservation:**
- On load: detect `\r\n` vs `\n` from raw content
- On save: after serialization, replace line endings to match original

**Render:**
- `MarkdownToolbar` at the top
- `EditorContent` from Tiptap filling the remaining space
- Full width of the column, no A4 paper styling

**Files to create:**
- `apps/drive/src/components/editor/markdown-editor.tsx`

## Step 5: Frontend — MarkdownToolbar

**Create `apps/drive/src/components/editor/markdown-toolbar.tsx`**

Toolbar for the markdown editor. Compose using the same UI primitives as the eigendoc toolbar in
`apps/docs/src/components/docs/editor-toolbar.tsx` (TooltipButton, DropdownMenu, Separator, etc. from
`packages/ui`).

**Layout:**
```
[← Back] [Undo] [Redo] | [Bold] [Italic] [Strike] [Code] | [H1] [H2] [H3] | [BulletList] [OrderedList] [TaskList] | [Blockquote] [CodeBlock] [HorizontalRule] | [Link] [Image] [Table] | [FormatBadge] [SaveIndicator]
```

**Back arrow:** Calls `onClose` prop. Before closing, check if there are unsaved changes — if so, show a
confirmation dialog ("You have unsaved changes. Discard?").

**Props:** `{ editor: Editor, onClose: () => void, saveState: 'saved' | 'saving' | 'unsaved' | 'conflict', formatLabel: string }`

**Files to create:**
- `apps/drive/src/components/editor/markdown-toolbar.tsx`

## Step 6: Frontend — SaveIndicator and FormatBadge

**Create `apps/drive/src/components/editor/save-indicator.tsx`**

Small text indicator. States:
- `saved`: "All changes saved" (muted text)
- `saving`: "Saving..." (muted text)
- `unsaved`: "Unsaved changes" (warning color)
- `conflict`: "Conflict" (error color, clickable to open ConflictDialog)

**Create `apps/drive/src/components/editor/format-badge.tsx`**

Badge showing file format: "MD", "TXT", "JSON", etc. Clickable dropdown with:
- File name and path
- "Convert to Eigen Doc" action (Phase 1: markdown only)
- "Download original" action
- "Open in source mode" (Phase 2, disabled for now)

**Files to create:**
- `apps/drive/src/components/editor/save-indicator.tsx`
- `apps/drive/src/components/editor/format-badge.tsx`

## Step 7: Frontend — ConflictDialog

**Create `apps/drive/src/components/editor/conflict-dialog.tsx`**

Dialog shown when a save returns 409.

**Content:** "This file was modified since you opened it."

**Actions:**
- **Overwrite**: Re-submit PUT with `force: true`. Closes dialog on success.
- **Reload**: Discard local changes, re-fetch content via GET, reinitialize editor.
- **Download your version**: Create a Blob from the current editor content, trigger a browser download
  (`filename.md`), then reload the server version.

Use the existing `Dialog` component from `packages/ui`.

**Files to create:**
- `apps/drive/src/components/editor/conflict-dialog.tsx`

## Step 8: Frontend — NativeFileEditor (Dispatcher)

**Create `apps/drive/src/components/editor/native-file-editor.tsx`**

Wrapper component that fetches file content and dispatches to the right editor. Returns both a toolbar
(for the Column's `toolbar` prop) and the editor content (for the Column's children).

Props: `{ path: DrivePath, onClose: () => void }`

The component provides two things to its parent:
1. **toolbar**: The `MarkdownToolbar` or `CodeToolbar` (Phase 2) to render in the Column header
2. **children**: The editor content area

Use a pattern that exposes the toolbar separately — either via render props, a compound component, or by
having `NativeFileEditor` return the full `<Column>` itself. The simplest approach: `NativeFileEditor` renders
the entire Column content including its toolbar integration, and the parent just conditionally renders it vs
`DriveList`.

Alternatively, `NativeFileEditor` can expose the toolbar via a ref or callback so `DriveLayout` can pass it
to the Column's `toolbar` prop. The cleanest pattern: `NativeFileEditor` returns `{ toolbar, content }` via
a hook-like pattern, but since it needs to render JSX, use a wrapper that renders both:

```typescript
function NativeFileEditor({ path, onClose }: Props) {
    const { data, isLoading, error } = useFileContent(path.ownerId, path.mountId, path.id)

    if (isLoading) return <EigenLoader />
    if (error) return <ErrorState ... />

    switch (data.editMode) {
        case 'markdown':
            return <MarkdownEditor content={data.content} frontmatter={data.frontmatter}
                     updatedAt={data.updatedAt} ownerId={path.ownerId} mountId={path.mountId}
                     pathId={path.id} onClose={onClose} />
        case 'plaintext':
        case 'code':
            return null // Phase 2 — CodeEditor
        default:
            return null
    }
}
```

Each editor component (e.g., `MarkdownEditor`) renders its own toolbar at the top of its content area. This
is simpler than trying to thread the toolbar back up to the Column's `toolbar` prop — see Step 9 for how the
Column is configured.

**Files to create:**
- `apps/drive/src/components/editor/native-file-editor.tsx`

## Step 9: Frontend — DriveLayout Integration

**Modify `DriveLayout`** to accept a `listOverride` prop — a `ReactNode` that replaces the entire first
Column when set. `DriveLayout` does not need to know anything about editors.

**Modify `packages/ui/src/components/layout/drive/drive-layout.tsx`:**

Add prop:
```typescript
export type DriveLayoutProps = {
    // ... existing props ...
    listOverride?: ReactNode;
}
```

Replace the list Column rendering:
```typescript
<ColumnLayout mobileColumn={listOverride ? 'list' : mobileShowDetail ? 'detail' : 'list'}>
    {listOverride ?? (
        <Column id="list" width="flex" toolbar={listToolbar}>
            <DriveList {...listProps} />
        </Column>
    )}
    {showDetail && (
        <Column id="detail" width={isMobile ? 'flex' : '400px'} onBack={onBackToList}
                toolbar={detailToolbar}>
            <DriveDetail {...detailProps} />
        </Column>
    )}
</ColumnLayout>
```

When `listOverride` is set, `mobileColumn` is forced to `'list'` so mobile always shows the override
(the editor) at full width. The detail column is hidden on mobile during editing.

That's the entire change to `DriveLayout`. It stays generic.

**Modify the editor components** to render the full Column. `MarkdownEditor` renders:
```typescript
<Column id="list" width="flex" toolbar={<MarkdownToolbar editor={editor} onClose={onClose} ... />}>
    <EditorContent editor={editor} />
</Column>
```

The toolbar has natural access to the editor instance — no ref threading needed.

**Modify the route** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`:

1. Add state: `const [editingPath, setEditingPath] = useState<DrivePath | null>(null)`

2. Modify `onRowActivate`: add a markdown branch before the download fallback:
   ```typescript
   } else if (path.name.match(/\.(md|markdown)$/i)) {  // Phase 1: markdown only
       setEditingPath(path)  // captures path.updatedAt as concurrency token
   }
   ```

3. Pass to `DriveLayout`:
   ```typescript
   <DriveLayout
       {...existingProps}
       listOverride={editingPath ? (
           <NativeFileEditor path={editingPath} onClose={() => setEditingPath(null)} />
       ) : undefined}
   />
   ```

4. Clear `editingPath` on folder navigation (when `pathId` param changes).

**Files to modify:**
- `packages/ui/src/components/layout/drive/drive-layout.tsx` (add `listOverride` prop, one-line change in render)
- `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` (add `editingPath` state, modify `onRowActivate`)

## Step 10: First-Save Normalization Warning

When the user first edits a markdown file and triggers a save:

1. Serialize the editor content via `getMarkdown()`
2. Compare with the original raw content (stored in ref from Step 4)
3. If they differ (they almost always will on first save):
   - Show a dialog: "Saving will normalize formatting in this file. Content is preserved but whitespace and
     syntax style may change."
   - Offer [Show diff] [Save] [Cancel]
   - "Show diff" could use a simple inline diff view (or just show the two texts)
4. After the user accepts once, suppress the warning for subsequent saves of this file (tracked in component state)
5. If the user made no edits (detected via `isDirty` flag), write back the original bytes unchanged — skip
   serialization entirely

**Files to modify:**
- `apps/drive/src/components/editor/markdown-editor.tsx` (add normalization warning logic)

## Step 11: Markdown Image Path Resolution

Markdown images with relative paths (`![](./image.png)`) need resolution:

**On load (backend, in GET endpoint):**
- Scan markdown content for image references: `!\[.*?\]\((\.\/[^)]+)\)`
- For each relative path, resolve to a Drive embed URL: `/drive/:ownerId/:mountId/embed/:siblingPathId`
- Replace in the content before returning to frontend

**On save (backend, in PUT endpoint):**
- Scan content for Drive embed URLs
- Convert back to relative paths before writing to disk

This keeps the `.md` file portable (relative paths on disk) while images display correctly in the editor.

**Files to modify:**
- `apps/api/src/routes/editor.ts` (image path resolution in GET/PUT)

## Step 12: Round-Trip Test Suite

**Create `apps/api/src/lib/editor/__tests__/markdown-roundtrip.test.ts`**

Build this BEFORE integrating the frontend — it validates that tiptap-markdown is viable.

1. Create 20+ fixture `.md` files in a `__fixtures__/` directory covering:
   - Headings (ATX h1-h6)
   - Inline formatting (bold, italic, strikethrough, code)
   - Links (inline, autolink)
   - Images
   - Ordered/unordered lists (nested, tight, loose, various starting numbers)
   - Task lists
   - Blockquotes (nested)
   - Fenced code blocks (with/without language)
   - Tables (with alignment)
   - Horizontal rules
   - HTML blocks
   - Frontmatter (YAML)
   - Mixed content

2. **Idempotent serialization test**: For each fixture:
   ```
   parse(input) -> serialize -> result1
   parse(result1) -> serialize -> result2
   assert(result1 === result2)
   ```

3. **Content preservation test**: For each fixture, compare ProseMirror JSON before and after round-trip.
   Semantic content (headings, paragraphs, links, lists, code) must be preserved.

4. **Real-world fixtures**: Download README.md from 5 major open-source repos (React, Vue, Rust, Go, Svelte)
   and include as test fixtures.

**Exit criteria**: All fixtures pass idempotent serialization. All real-world files pass content preservation.
If this fails badly, reconsider the approach (fallback to source-only editing).

**Files to create:**
- `apps/api/src/lib/editor/__tests__/markdown-roundtrip.test.ts`
- `apps/api/src/lib/editor/__tests__/__fixtures__/*.md` (20+ files)

## Step 13: Integration Tests

**Create `apps/api/src/lib/editor/__tests__/editor.test.ts`**

Test the backend endpoints:

- GET content returns correct `editMode` for `.md`, `.txt`, `.json`, `.yaml` files
- GET content extracts frontmatter correctly
- GET content returns 400 for unsupported MIME types
- GET content returns 413 for files exceeding size limits
- GET content returns 400 for non-UTF-8 files
- PUT content succeeds when `expectedUpdatedAt` matches
- PUT content returns 409 when `expectedUpdatedAt` is stale
- PUT content succeeds with `force: true` despite stale `expectedUpdatedAt`
- PUT content re-attaches frontmatter correctly for markdown
- PUT content returns new `updatedAt` after successful save

**Files to create:**
- `apps/api/src/lib/editor/__tests__/editor.test.ts`

## Step 14: Apply to Shared and MIME Routes

The `isInlineEditable` check also needs to be applied in:
- `apps/drive/src/routes/_auth.shared.$to.tsx`
- `apps/drive/src/routes/_auth.mime.$mimeType.tsx`

These have similar `onRowActivate` handlers. Add the same `editingPath` state and inline editor rendering.

**Files to modify:**
- `apps/drive/src/routes/_auth.shared.$to.tsx`
- `apps/drive/src/routes/_auth.mime.$mimeType.tsx`

---

# Phase 2: CodeEditor + Source Mode Toggle

Adds CodeMirror 6 for plain text and structured data files (`.txt`, `.json`, `.yaml`, `.csv`, `.xml`, `.html`),
and a source mode toggle for markdown files.

## Dependencies

Install before starting (ask user):

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/lang-json`
- `@codemirror/lang-yaml`
- `@codemirror/lang-xml`
- `@codemirror/lang-markdown`
- `@codemirror/lang-html`
- `@codemirror/lang-css`

All in `apps/drive`.

## Step 15: Frontend — CodeEditor Component

**Create `apps/drive/src/components/editor/code-editor.tsx`**

CodeMirror 6 wrapper for plain text and syntax-highlighted editing.

Props: `{ content: string, language: string | null, updatedAt: string, ownerId: string, mountId: string, pathId: string, onClose: () => void }`

**Editor setup:**
1. Create a CodeMirror `EditorView` in a `useEffect` / `useRef`:
   ```typescript
   const editorRef = useRef<HTMLDivElement>(null)
   const viewRef = useRef<EditorView>()

   useEffect(() => {
       const state = EditorState.create({
           doc: content,
           extensions: [
               basicSetup,          // line numbers, bracket matching, etc.
               languageExtension,   // based on language prop
               keymap.of([...defaultKeymap, { key: 'Mod-s', run: () => { save(); return true } }]),
               EditorView.updateListener.of(update => {
                   if (update.docChanged) setIsDirty(true)
               }),
           ],
       })
       viewRef.current = new EditorView({ state, parent: editorRef.current! })
       return () => viewRef.current?.destroy()
   }, [])  // only on mount
   ```

2. Language extension mapping:
   ```typescript
   function getLanguageExtension(language: string | null) {
       switch (language) {
           case 'json': return json()
           case 'yaml': return yaml()
           case 'xml': return xml()
           case 'html': return html()
           case 'css': return css()
           case 'markdown': return markdown()
           default: return []  // plain text — no syntax highlighting
       }
   }
   ```

**Save logic:**
- Same pattern as MarkdownEditor: `useFileSave` hook with `expectedUpdatedAt`
- Get content via `viewRef.current!.state.doc.toString()`
- Debounced auto-save (5 seconds) + Cmd+S
- No frontmatter handling (that's markdown-only)
- Round-trip is lossless — raw text in, raw text out

**Render:** Renders a `<Column>` with `CodeToolbar` as toolbar, CodeMirror container as content.

```typescript
<Column id="list" width="flex" toolbar={<CodeToolbar onClose={onClose} ... />}>
    <div ref={editorRef} className="h-full overflow-auto" />
</Column>
```

**Files to create:**
- `apps/drive/src/components/editor/code-editor.tsx`

## Step 16: Frontend — CodeToolbar

**Create `apps/drive/src/components/editor/code-toolbar.tsx`**

Simpler toolbar than MarkdownToolbar — no formatting buttons needed.

**Layout:**
```
[← Back] | [FormatBadge] | [SaveIndicator]
```

Props: `{ onClose: () => void, saveState: 'saved' | 'saving' | 'unsaved' | 'conflict', formatLabel: string }`

Reuses `FormatBadge` and `SaveIndicator` from Phase 1 (Steps 5-6).

**Files to create:**
- `apps/drive/src/components/editor/code-toolbar.tsx`

## Step 17: Frontend — Wire CodeEditor into NativeFileEditor

**Modify `apps/drive/src/components/editor/native-file-editor.tsx`**

Add the `plaintext` and `code` cases to the dispatcher:

```typescript
switch (data.editMode) {
    case 'markdown':
        return <MarkdownEditor ... />
    case 'plaintext':
        return <CodeEditor content={data.content} language={null} ... />
    case 'code':
        return <CodeEditor content={data.content} language={getLanguage(path.name)} ... />
    default:
        return null
}
```

Language detection by extension:
```typescript
function getLanguage(name: string): string | null {
    if (name.endsWith('.json')) return 'json'
    if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml'
    if (name.endsWith('.xml')) return 'xml'
    if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
    if (name.endsWith('.css')) return 'css'
    if (name.endsWith('.csv')) return null  // plain text, no highlighting
    return null
}
```

**Files to modify:**
- `apps/drive/src/components/editor/native-file-editor.tsx`

## Step 18: Frontend — Expand Drive Route to All Editable Types

**Modify `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`**

Remove the Phase 1 markdown-only gate. Use the full `isInlineEditable` check:

```typescript
// Phase 1 was:
} else if (path.name.match(/\.(md|markdown)$/i)) {
    setEditingPath(path)
}

// Phase 2:
} else if (isInlineEditable(path.mimeType, path.name)) {
    setEditingPath(path)
}
```

Now `.txt`, `.json`, `.yaml`, `.csv`, `.xml`, `.html` files open inline in the CodeEditor.

**Files to modify:**
- `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`

## Step 19: Frontend — Markdown Source Mode Toggle

**Modify `apps/drive/src/components/editor/markdown-editor.tsx`**

Add a toggle between WYSIWYG (Tiptap) and source mode (CodeMirror) within the same MarkdownEditor.

**State:** `const [sourceMode, setSourceMode] = useState(false)`

**Toggle logic:**
- **WYSIWYG -> Source**: serialize via `editor.storage.markdown.getMarkdown()`, display the raw markdown string
  in a CodeMirror instance with `@codemirror/lang-markdown` syntax highlighting
- **Source -> WYSIWYG**: read CodeMirror content via `view.state.doc.toString()`, load into Tiptap via
  `editor.commands.setContent(markdown)`

Each toggle serializes/parses, so it is not instant for large documents. Accept this.

**Render:**
```typescript
<Column id="list" width="flex" toolbar={<MarkdownToolbar editor={editor} sourceMode={sourceMode}
    onToggleSource={() => setSourceMode(!sourceMode)} onClose={onClose} ... />}>
    {sourceMode ? (
        <div ref={codeMirrorRef} className="h-full overflow-auto" />
    ) : (
        <EditorContent editor={editor} />
    )}
</Column>
```

**Save in source mode:** Get content from CodeMirror (`view.state.doc.toString()`), send directly to
PUT endpoint. No tiptap-markdown serialization involved — the user is editing raw markdown. This is
lossless.

**MarkdownToolbar changes:** Add a source mode toggle button (e.g., `<Code2 />` icon). When in source
mode, hide the formatting buttons (bold, italic, etc.) since they don't apply to raw text. Show only:
back arrow, source toggle, format badge, save indicator.

**Files to modify:**
- `apps/drive/src/components/editor/markdown-editor.tsx` (add CodeMirror, toggle state)
- `apps/drive/src/components/editor/markdown-toolbar.tsx` (add source toggle button, conditional formatting buttons)

## Step 20: Apply Phase 2 to Shared and MIME Routes

Same as Step 14 but now covering all editable file types (not just markdown).

If Step 14 was already done during Phase 1, no additional changes needed — the `isInlineEditable` check
already covers all types, and `NativeFileEditor` dispatches to the right editor.

**Files to verify:**
- `apps/drive/src/routes/_auth.shared.$to.tsx`
- `apps/drive/src/routes/_auth.mime.$mimeType.tsx`

## Phase 2 Implementation Order

1. **Step 15** (CodeEditor component) — core component, can be tested standalone
2. **Step 16** (CodeToolbar)
3. **Step 17** (wire into NativeFileEditor)
4. **Step 18** (expand Drive route) — all text file types now open inline
5. **Step 19** (markdown source toggle) — depends on CodeMirror being available
6. **Step 20** (verify shared/MIME routes)

---

## Implementation Order (Both Phases)

### Phase 1 — Markdown editing

1. **Step 12** (round-trip tests) — validate tiptap-markdown viability FIRST. If this fails, everything else
   changes. This is the go/no-go gate.
2. **Step 1** (backend router) — GET and PUT endpoints
3. **Step 13** (integration tests) — validate backend works
4. **Step 2** (isInlineEditable helper)
5. **Step 3** (data hooks)
6. **Step 4** (MarkdownEditor) — core editor component
7. **Step 5** (MarkdownToolbar)
8. **Step 6** (SaveIndicator, FormatBadge)
9. **Step 7** (ConflictDialog)
10. **Step 8** (NativeFileEditor dispatcher)
11. **Step 9** (DriveLayout integration) — everything becomes testable end-to-end here
12. **Step 10** (first-save normalization warning)
13. **Step 11** (image path resolution)
14. **Step 14** (shared/MIME routes)

### Phase 2 — CodeEditor + source mode

15. **Step 15** (CodeEditor component)
16. **Step 16** (CodeToolbar)
17. **Step 17** (wire into NativeFileEditor)
18. **Step 18** (expand Drive route to all editable types)
19. **Step 19** (markdown source mode toggle)
20. **Step 20** (verify shared/MIME routes)

## File Summary

### Phase 1 — New files

| File | Step |
|---|---|
| `apps/api/src/routes/editor.ts` | 1 |
| `packages/lib/src/core/editor/hooks/use-file-content.ts` | 3 |
| `packages/lib/src/core/editor/hooks/use-file-save.ts` | 3 |
| `packages/lib/src/core/editor/hooks/index.ts` | 3 |
| `apps/drive/src/components/editor/markdown-editor.tsx` | 4 |
| `apps/drive/src/components/editor/markdown-toolbar.tsx` | 5 |
| `apps/drive/src/components/editor/save-indicator.tsx` | 6 |
| `apps/drive/src/components/editor/format-badge.tsx` | 6 |
| `apps/drive/src/components/editor/conflict-dialog.tsx` | 7 |
| `apps/drive/src/components/editor/native-file-editor.tsx` | 8 |
| `apps/api/src/lib/editor/__tests__/markdown-roundtrip.test.ts` | 12 |
| `apps/api/src/lib/editor/__tests__/__fixtures__/*.md` | 12 |
| `apps/api/src/lib/editor/__tests__/editor.test.ts` | 13 |

### Phase 1 — Modified files

| File | Step |
|---|---|
| `apps/api/src/index.ts` | 1 |
| `packages/lib/src/core/api.ts` | 2 |
| `packages/ui/src/components/layout/drive/drive-layout.tsx` | 9 |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` | 9 |
| `apps/drive/src/routes/_auth.shared.$to.tsx` | 14 |
| `apps/drive/src/routes/_auth.mime.$mimeType.tsx` | 14 |

### Phase 2 — New files

| File | Step |
|---|---|
| `apps/drive/src/components/editor/code-editor.tsx` | 15 |
| `apps/drive/src/components/editor/code-toolbar.tsx` | 16 |

### Phase 2 — Modified files

| File | Step |
|---|---|
| `apps/drive/src/components/editor/native-file-editor.tsx` | 17 |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` | 18 |
| `apps/drive/src/components/editor/markdown-editor.tsx` | 19 |
| `apps/drive/src/components/editor/markdown-toolbar.tsx` | 19 |
