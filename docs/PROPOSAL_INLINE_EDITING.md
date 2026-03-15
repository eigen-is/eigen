# Proposal: Inline Editing of Native Files in Drive

> **TLDR**: Let users edit `.md`, `.txt`, `.csv`, `.json`, and `.yaml` files inline in Drive without format
> conversion or app-switching. The editor replaces the file table in Drive's first column. Markdown gets WYSIWYG via
> Tiptap + `tiptap-markdown`; everything else gets CodeMirror. Collaboration on native files is deferred entirely --
> single-user with optimistic concurrency only. This is deliberately conservative to avoid the round-trip fidelity
> trap.

## Summary of Key Findings from Research

The research document (RESEARCH_INLINE_EDITING.md) is thorough and generally sound. After reading the actual codebase,
the following findings stand out:

**What the research gets right:**
- The current pipeline (Drive -> eigendoc route -> WebSocket -> Yjs -> DbProvider -> SQLite) is well-understood and
  accurately described.
- The editor extension inventory is correct and complete.
- The file-opening flow analysis (onRowActivate -> isDocumentType -> openDocument, else download) is accurate.
- The phased approach is sensible, especially starting with single-user editing before attempting collaboration.
- The identification of `tiptap-markdown` as the right library for the markdown path is correct.

**What the research underestimates:**

1. **Markdown round-trip fidelity is worse than documented.** The research lists "safe round-trip" features optimistically.
   In practice, `tiptap-markdown` (which wraps `markdown-it` + `prosemirror-markdown`) has additional issues:
   - **Indented code blocks** are parsed differently from fenced blocks and may not round-trip cleanly.
   - **Setext-style headings** (`Heading\n===`) are normalized to ATX (`# Heading`).
   - **HTML blocks** (not just inline HTML) have unpredictable behavior when they contain block-level elements.
   - **Escaped characters** (`\*not bold\*`) may be unescaped during parsing and re-escaped differently.
   - **Blank lines** between list items affect tight/loose list rendering and may be altered.
   - **Trailing newlines, leading BOM markers, and `\r\n` line endings** will all be normalized silently.

2. **The ephemeral Yjs layer for native file collaboration is riskier than presented.** The research acknowledges the
   serialization drift problem but proposes it for Phase 4. The real issue is deeper: the Yjs CRDT merge semantics
   operate on a ProseMirror document tree, but the canonical format is a serialized string. Two users editing the same
   markdown paragraph simultaneously will produce valid Yjs merges that may serialize to invalid or surprising markdown.
   This is not a bug to fix later -- it is a fundamental architectural mismatch.

3. **External file conflicts need optimistic concurrency, not locking.** The research proposes file locking, but locks
   only cover Eigen-internal access -- they cannot detect edits from external tools (VS Code, git pull, rsync).
   Optimistic concurrency (compare `updatedAt` before save, reject on mismatch) is simpler and handles both internal
   and Eigen-mediated external conflicts. Note: edits that bypass the Drive API entirely (e.g., direct filesystem
   writes) still cannot be detected unless we also compare filesystem mtime -- a future enhancement.

4. **Auto-save write amplification.** The research proposes 5-second debounced auto-save. For a mounted network drive
   or S3 backend, writing the full file on every keystroke pause creates unnecessary I/O. This is fine for local storage
   but needs rate-limiting for remote backends.

## Scope: What We WILL and WON'T Support

### WILL support (in scope)

- WYSIWYG editing of `.md` files with toolbar restricted to markdown-safe features
- Source mode toggle for `.md` files (WYSIWYG <-> raw markdown in CodeMirror)
- Plain text editing of `.txt` files via CodeMirror
- Syntax-highlighted editing of `.json`, `.yaml`, `.csv`, `.xml` via CodeMirror
- "Convert to Eigen Doc" for markdown files
- Optimistic concurrency control with conflict resolution dialog
- Frontmatter preservation for markdown
- Auto-save with debounce (local storage only; explicit save for remote)
- Format badge in toolbar indicating file type
- Relative image path resolution for markdown

### WON'T support (out of scope, with rationale)

| Feature | Rationale |
|---|---|
| Collaborative editing of native files | Serialization drift makes Yjs-on-markdown fundamentally fragile. Not worth the complexity. Users who need collab should convert to eigendoc. |
| DOCX support (preview or editing) | mammoth.js is deliberately lossy (strips tracked changes, headers/footers, footnotes, shapes, charts, custom fonts). Not worth the complexity for any level of support. |
| LaTeX rendering in markdown | Requires MathJax/KaTeX integration and a `markdown-it-katex` plugin. Scope creep. |
| Mermaid diagram rendering | Requires Mermaid.js integration. Scope creep. Add later if demand warrants it. |
| Full IDE features (LSP, terminal, git) | We are building a document editor, not VS Code. |
| Non-UTF-8 text files | Detect encoding on load, reject with "This file is not UTF-8 encoded. Download to edit." |
| Files > 2MB (markdown) / > 5MB (text/code) | ProseMirror and CodeMirror performance degrades. Show a download prompt. |
| Split view (side-by-side source + preview) | Phase 2+ polish. Not MVP. |
| Version history for native files | Requires a unified version store. Phase 2+. |
| Code file editing (.js, .py, .ts, etc.) | Natural extension of CodeMirror work, but keep Phase 1 focused on document-oriented files. |

## File Type Support Matrix

| Extension | Editor | Round-trip Fidelity | Notes |
|---|---|---|---|
| `.md`, `.markdown` | Tiptap + tiptap-markdown | **Good with caveats** -- whitespace normalization, setext heading conversion, reference link inlining, tight/loose list changes. Frontmatter preserved verbatim. | Users warned on first save if content will be normalized. |
| `.txt` | CodeMirror (plain) | **Lossless** | Raw text in, raw text out. |
| `.json` | CodeMirror + lang-json | **Lossless** | Syntax highlighting, bracket matching. |
| `.yaml`, `.yml` | CodeMirror + lang-yaml | **Lossless** | Syntax highlighting. |
| `.csv` | CodeMirror (plain) | **Lossless** | Optional: table view toggle in Phase 2. |
| `.xml` | CodeMirror + lang-xml | **Lossless** | Syntax highlighting. |
| `.html` | CodeMirror + lang-html | **Lossless** | Syntax highlighting. No rendered preview in Phase 1. |

**Fidelity rating definitions:**
- **Lossless**: Byte-identical output (save for trailing newline normalization)
- **Good with caveats**: Semantic content preserved, cosmetic formatting may change

## Concrete Changes Needed

### Backend (apps/api)

**New router: `apps/api/src/routes/editor.ts`**

```
GET  /editor/:ownerId/:mountId/:pathId/content
     Returns: { editMode, content: string, frontmatter?: string, mimeType: string, updatedAt: string }
     - Reads file bytes via mount.readFile()
     - Detects encoding (reject non-UTF-8)
     - For markdown: extracts frontmatter, returns body separately
     - Checks file size limits
     - Returns path.updatedAt as ISO 8601 string (concurrency token)

PUT  /editor/:ownerId/:mountId/:pathId/content
     Body: { content: string, frontmatter?: string, expectedUpdatedAt: string, force?: boolean }
     - Compares expectedUpdatedAt against current path.updatedAt
     - If mismatch and !force: returns 409 with { conflict: true, currentUpdatedAt: string }
     - If match or force: writes file, returns { success: true, updatedAt: string }
     - For markdown: re-attaches frontmatter, writes full file
     - For text/code: writes content directly
     - writeFile() automatically updates path metadata (size, updatedAt)

POST /editor/:ownerId/:mountId/:pathId/convert
     Body: { targetFormat: 'eigendoc' }
     - Reads file content
     - Creates eigendoc folder structure (data.db, media/, chat/)
     - Initializes Y.Doc with parsed content
     - Copies sibling images to media/ folder for markdown
     - Returns new path ID
```

**Concurrency model**: Optimistic concurrency via `updatedAt` comparison. The `updatedAt` column in the mount schema
is an integer (unix epoch seconds) that is bumped automatically by `writeFile()` -> `updatePath()`. No server-side
state is needed -- the concurrency token is the file's own timestamp in SQLite. If the server restarts, nothing is
lost. If two users open the same file, the first to save succeeds and the second gets a 409 with a conflict dialog.

### Frontend (apps/drive)

**No new route.** The editor renders inline in the Drive app's existing `_auth.fs.$ownerId.$mountId.$pathId.tsx` route.
When the user activates an editable file, the file table in the "list" column is replaced by the editor. The "detail"
column (400px) continues to show file details alongside the editor. Closing the editor (via a back arrow in the editor
toolbar) restores the file table.

The Drive route already uses `ColumnLayout` with two columns:

```
ColumnLayout
├── Column id="list" width="flex"    ← file table (replaced by editor when editing)
└── Column id="detail" width="400px" ← file details (stays visible)
```

**State management**: The route gains an `editingPath: DrivePath | null` state. When set, the "list" column renders
`NativeFileEditor` instead of `DriveList`. The `editingPath` object includes `updatedAt` which is captured at the
moment the file is opened and used as the initial concurrency token for saves. On mobile, the editor takes full width
via the existing `mobileColumn` mechanism.

**New components in `apps/drive/src/components/editor/`:**

| Component | File | Purpose |
|---|---|---|
| `NativeFileEditor` | `native-file-editor.tsx` | Dispatches to MarkdownEditor or CodeEditor based on editMode. Passes `onClose` to restore file table. |
| `MarkdownEditor` | `markdown-editor.tsx` | Tiptap with tiptap-markdown, History extension, reduced toolbar, save logic |
| `CodeEditor` | `code-editor.tsx` | CodeMirror 6 wrapper with configurable language, line numbers, save binding |
| `MarkdownToolbar` | `markdown-toolbar.tsx` | Back arrow + markdown-safe formatting buttons + format badge + save indicator |
| `CodeToolbar` | `code-toolbar.tsx` | Back arrow + format badge + save indicator (no formatting buttons) |
| `FormatBadge` | `format-badge.tsx` | Shows "MD", "TXT", "JSON", etc. with dropdown for convert/download/source-toggle |
| `SaveIndicator` | `save-indicator.tsx` | "All changes saved" / "Saving..." / "Unsaved changes" / "Conflict" |
| `ConflictDialog` | `conflict-dialog.tsx` | Shown on 409: "This file was modified since you opened it." Actions: Overwrite, Reload, Download your version |

**Toolbar**: A new `MarkdownToolbar` component for markdown files, composing the same building blocks used in the
eigendoc toolbar (TooltipButton, DropdownMenu, etc.) but with only markdown-safe actions and a back arrow to close the
editor. A simpler `CodeToolbar` for text/code files (just back arrow, format badge, save indicator). The eigendoc
toolbar in `apps/docs` stays untouched.

**MarkdownEditor extension set** (compared to eigendoc editor):

| Extension | Keep? | Notes |
|---|---|---|
| StarterKit | Yes | `history: true` (re-enable), `codeBlock: false` |
| Markdown (tiptap-markdown) | **Add** | `html: true`, `tightLists: true`, `bulletListMarker: '-'` |
| Underline | **Remove** | No markdown equivalent |
| Subscript | **Remove** | No markdown equivalent |
| Superscript | **Remove** | No markdown equivalent |
| Typography | Keep | Smart quotes work in markdown |
| TextStyle | **Remove** | Only used for Color |
| Color | **Remove** | No markdown equivalent |
| CharacterCount | Keep | Word/char counts |
| TextAlign | **Remove** | No markdown equivalent |
| TaskList + TaskItem | Keep | GFM task lists |
| Link | Keep | Standard markdown links |
| ResizableImage | **Replace** | Use standard Tiptap Image node (no width/alignment attributes) |
| Highlight | **Remove** | No markdown equivalent |
| CodeBlockLowlight | Keep | Fenced code blocks with language |
| Table + TableRow + TableCell + TableHeader | Keep | GFM tables |
| CommentMark | **Remove** | No markdown equivalent |
| Collaboration | **Remove** | Single-user only |
| CollaborationCursor | **Remove** | Single-user only |
| History | **Add** | Re-enable from StarterKit |

### Frontend (packages/lib)

**New hooks in `packages/lib/src/core/editor/hooks/`:**

| Hook | Purpose |
|---|---|
| `useFileContent(ownerId, mountId, pathId)` | Fetches file content via `/editor/.../content` |
| `useFileSave()` | Mutation for `PUT /editor/.../content` with `expectedUpdatedAt`, debounced auto-save. Updates local `updatedAt` ref on success. On 409, surfaces conflict to UI. |

**Extend `packages/lib/src/core/api.ts`:**

Add helper `isInlineEditable(mimeType, name)` that returns true for supported file types.

**Modify `onRowActivate` in `_auth.fs.$ownerId.$mountId.$pathId.tsx`:**

Insert a new branch before the download fallback. Instead of navigating to a different app, set local state to swap
the file table for the editor:

```typescript
const [editingPath, setEditingPath] = useState<DrivePath | null>(null);

const onRowActivate = (path: DrivePath) => {
    if (path.type === 'folder') {
        navigate({...});
    } else if (isDocumentType(path.type)) {
        openDocument(path);
    } else if (isInlineEditable(path.mimeType, path.name)) {  // NEW
        setEditingPath(path);                                    // NEW — captures path.updatedAt as concurrency token
    } else if (canPreview(path)) {
        openPreview(path);
    } else {
        window.open(getDriveDownloadUrl(...), "_blank");
    }
};
```

In the "list" column, render the editor or the file table based on `editingPath`:

```typescript
<Column id="list" width="flex">
    {editingPath ? (
        <NativeFileEditor path={editingPath} onClose={() => setEditingPath(null)} />
    ) : (
        <DriveList ... />
    )}
</Column>
```

The `onClose` callback (triggered by the back arrow in the editor toolbar) sets `editingPath` back to null, restoring
the file table. The detail column remains visible with the edited file's metadata.

The same `isInlineEditable` check needs to be applied in `_auth.shared.$to.tsx` and `_auth.mime.$mimeType.tsx` which
have similar `onRowActivate` handlers.

## Markdown Round-Trip Strategy

This is the hardest part of the proposal. Honest assessment:

### What will change on round-trip (unavoidable)

1. **Setext headings** (`Heading\n===`) become ATX (`# Heading`)
2. **Reference-style links** (`[text][ref]`) become inline (`[text](url)`)
3. **Indented code blocks** may become fenced blocks
4. **Whitespace**: trailing spaces, inconsistent indentation, extra blank lines -- all normalized
5. **Bullet markers**: mixed `*`, `+`, `-` normalized to configured marker (`-`)
6. **Horizontal rules**: `***`, `___`, `* * *` all become `---`
7. **Emphasis markers**: `*italic*` and `_italic_` normalized to `*italic*`

### Mitigation strategy

1. **First-save warning**: On the first save of any markdown file, compute a diff between the original content and
   the serialized output. If they differ (they almost always will), show a dialog: "Saving will normalize formatting
   in this file. Content is preserved but whitespace and syntax style may change. [Show diff] [Save] [Cancel]".
   After the first save, suppress the warning for that file (the user has accepted the normalization).

2. **Original content preservation for zero-edit sessions**: Store the original raw text in a React ref. If the user
   opens a file, reads it, and closes without editing, write back the original bytes unchanged. Only serialize through
   tiptap-markdown if the user actually made edits. Detect edits via the editor's `update` event.

3. **Bullet marker detection**: On load, scan the first 20 list items to detect the dominant bullet marker (`-`, `*`,
   or `+`). Configure `tiptap-markdown`'s `bulletListMarker` accordingly.

4. **Line ending preservation**: Detect original line endings (`\r\n` vs `\n`). After serialization, convert output
   to match. Store detected line ending in the editor state.

5. **Trailing newline**: Ensure output ends with exactly one newline (POSIX convention).

### What we explicitly accept as limitations

- Files under git version control will show diffs on first save due to normalization. This is the same behavior as
  running `prettier` on a file for the first time. It is a one-time cost.
- HTML blocks in markdown files will be preserved when `html: true` is set, but complex HTML-within-markdown
  (e.g., `<details><summary>` blocks, `<table>` with rowspan/colspan) may be altered.
- Footnotes (`[^1]`) are not supported by `tiptap-markdown` out of the box. They will be treated as regular text
  and will break on round-trip. We accept this and document it.
- Definition lists, abbreviations, and other markdown-it plugins beyond GFM are not supported.

## Testing Strategy

### Round-trip test suite

Create `apps/api/src/lib/editor/__tests__/markdown-roundtrip.test.ts` with:

1. **Canonical fixtures**: A set of 20+ markdown files covering every GFM feature:
   - Headings (ATX h1-h6)
   - Paragraphs with inline formatting (bold, italic, strikethrough, code)
   - Links (inline, autolink)
   - Images
   - Ordered lists (various starting numbers)
   - Unordered lists (nested, tight, loose)
   - Task lists
   - Blockquotes (nested)
   - Fenced code blocks (with and without language)
   - Tables (with alignment)
   - Horizontal rules
   - HTML blocks (`<div>`, `<details>`)
   - Frontmatter (YAML)
   - Mixed content (headers + lists + code + tables in one file)

2. **Round-trip assertion**: For each fixture, load into tiptap-markdown, serialize back, load again, serialize again.
   Assert that the second serialization equals the first (i.e., the format is stable after one normalization pass).
   This is the key invariant: **idempotent serialization**. We do not assert byte-identity with the original (that
   would fail for normalization reasons), but we assert that `serialize(parse(serialize(parse(input)))) === serialize(parse(input))`.

3. **Content preservation assertion**: For each fixture, assert that the semantic content (headings, paragraphs, links,
   images, lists, code blocks) is preserved after round-trip. Use ProseMirror JSON comparison, not string comparison.

4. **Real-world files**: Include 5-10 real markdown files from popular open-source projects (README.md files from
   React, Vue, Rust, etc.) as regression fixtures. These tend to exercise edge cases that synthetic fixtures miss.

### Integration tests

- Optimistic concurrency: save succeeds when `expectedUpdatedAt` matches
- Optimistic concurrency: save returns 409 when `expectedUpdatedAt` is stale
- Optimistic concurrency: force-save overwrites despite stale `expectedUpdatedAt`
- Content endpoint for each supported MIME type
- Save endpoint with frontmatter re-attachment
- Convert-to-eigendoc endpoint
- File size limit enforcement
- Non-UTF-8 file rejection

### Frontend tests

- Toolbar renders correct buttons for markdown mode vs code mode
- Inline editor replaces file table when `editingPath` is set, restores on close
- Save indicator state transitions
- Format badge displays correct label
- Auto-save triggers after debounce period
- Conflict dialog appears on 409 and actions (overwrite, reload, download) work correctly

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| tiptap-markdown has undiscovered round-trip bugs | High | Medium | Build the round-trip test suite FIRST, before any integration work. Run it against real-world files. If it fails badly, reconsider the approach (fallback: source-only editing for markdown, no WYSIWYG). |
| Users edit markdown files concurrently via external tools | Medium | Low | Optimistic concurrency detects conflicts from any save that goes through the Drive API. Edits that bypass the API entirely (direct filesystem writes) are not detected -- document as known limitation. |
| Large markdown files cause editor lag | Medium | Medium | Enforce 2MB limit. ProseMirror becomes noticeably slow above ~1MB with complex documents. Test with files at the limit. |
| Tiptap/CodeMirror bundle size bloats the Drive app | Low | Medium | Lazy-load editor components via dynamic import. Only loaded when user opens an editable file. |
| Users expect collaborative editing on markdown | Medium | Low | Clear UX messaging: format badge, "Single user editing" indicator, "Convert to Eigen Doc for collaboration" prompt. |
| Auto-save data loss on browser crash | Medium | Medium | Use `beforeunload` event to attempt final save. Store unsaved content in `localStorage` as crash recovery buffer. On next open, check for recovery data and offer to restore. |
| Frontmatter corruption | Low | High | Preserve frontmatter as verbatim string. Never parse or modify it. Re-attach byte-for-byte on save. Test with multi-line YAML, nested objects, special characters. |

## Phases

### Phase 1: Markdown Editing (4-6 weeks)

**Goal**: Open `.md` files from Drive, edit in WYSIWYG mode, save back as `.md`.

**Deliverables**:
1. Backend: `/editor/.../content` endpoint with optimistic concurrency (`expectedUpdatedAt` check)
2. `MarkdownEditor` component in `apps/drive/src/components/editor/`
3. `MarkdownToolbar` with back arrow + markdown-safe features only
4. Inline editor in Drive's "list" column (`editingPath` state replaces file table)
5. `onRowActivate` routes `.md` files to inline editor
6. Frontmatter handling (extract/reattach)
7. Auto-save with debounce + save indicator
8. Format badge ("MD")
9. First-save normalization warning
10. Conflict resolution dialog (overwrite / reload / download your version)
11. Round-trip test suite (run before integration, gate on idempotent serialization)
12. Markdown image relative path resolution

**Dependencies**: `tiptap-markdown` (npm package)

**Exit criteria**: 20+ fixture files pass idempotent serialization. Real-world README files from 5 major
open-source projects pass content preservation assertion.

### Phase 2: Plain Text, Code, and Source Mode (2-3 weeks)

**Goal**: Edit `.txt`, `.json`, `.yaml`, `.csv`, `.xml` files. Source mode toggle for markdown.

**Deliverables**:
1. `CodeEditor` component (CodeMirror 6)
2. Language support: json, yaml, xml, markdown, html, css
3. Source mode toggle in MarkdownEditor
4. Extended MIME-to-editMode mapping
5. Drive integration for new file types

**Dependencies**: `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-json`, `@codemirror/lang-yaml`,
`@codemirror/lang-xml`, `@codemirror/lang-markdown`, `@codemirror/lang-html`, `@codemirror/lang-css`

### Phase 3: Polish (2 weeks)

**Goal**: Refinements based on Phase 1-2 usage.

**Deliverables**:
1. Docs sidebar: show markdown files alongside eigendocs
2. Export eigendoc -> markdown
3. CSV table view toggle
4. `beforeunload` crash recovery
5. File size limit UX (graceful error for oversized files)
6. Code file editing (.js, .py, .ts, etc.) -- CodeMirror with appropriate language packs

### NOT planned

- Collaborative editing on native files (use eigendoc for collaboration)
- Split view (source + preview side by side)
- Version history for native files
- LaTeX / Mermaid rendering
- DOCX support (preview or editing)
