# Proposal: Inline Editing of Native Files in Eigen Docs

> **TLDR**: Let users edit `.md`, `.txt`, `.csv`, `.json`, and `.yaml` files directly from Drive without format
> conversion. Markdown gets WYSIWYG via Tiptap + `tiptap-markdown`; everything else gets CodeMirror. DOCX gets
> read-only preview with a convert-to-eigendoc escape hatch. Collaboration on native files is deferred entirely --
> single-user with file locking only. This is deliberately conservative to avoid the round-trip fidelity trap.

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

3. **DOCX editing (Phase 2 in the research) via mammoth.js + html-to-docx is not worth building.** mammoth.js is
   deliberately lossy by design -- it strips tracked changes, headers/footers, page numbers, footnotes, text boxes,
   shapes, SmartArt, embedded charts, custom fonts, and precise spacing. The `html-to-docx` path back produces a
   completely different DOCX structure. Users who care about DOCX fidelity will be frustrated. Users who do not care
   should just convert to eigendoc. Editable DOCX is a trap -- we should offer read-only preview and conversion only.

4. **External file conflicts are unaddressed for the locking model.** The research mentions file locking but does not
   address the scenario where a `.md` file on a mounted drive is edited simultaneously by an external tool (VS Code,
   git pull, rsync). The locking mechanism only covers Eigen-internal access. This is acceptable for Phase 1 but must
   be documented as a known limitation.

5. **Auto-save write amplification.** The research proposes 5-second debounced auto-save. For a mounted network drive
   or S3 backend, writing the full file on every keystroke pause creates unnecessary I/O. This is fine for local storage
   but needs rate-limiting for remote backends.

## Scope: What We WILL and WON'T Support

### WILL support (in scope)

- WYSIWYG editing of `.md` files with toolbar restricted to markdown-safe features
- Source mode toggle for `.md` files (WYSIWYG <-> raw markdown in CodeMirror)
- Plain text editing of `.txt` files via CodeMirror
- Syntax-highlighted editing of `.json`, `.yaml`, `.csv`, `.xml` via CodeMirror
- Read-only DOCX preview via mammoth.js
- "Convert to Eigen Doc" for DOCX and markdown files
- Single-user file locking (Eigen-internal only)
- Frontmatter preservation for markdown
- Auto-save with debounce (local storage only; explicit save for remote)
- Format badge in toolbar indicating file type
- Relative image path resolution for markdown

### WON'T support (out of scope, with rationale)

| Feature | Rationale |
|---|---|
| Collaborative editing of native files | Serialization drift makes Yjs-on-markdown fundamentally fragile. Not worth the complexity. Users who need collab should convert to eigendoc. |
| Editable DOCX | mammoth.js + html-to-docx round-trip produces a different document. Frustrating UX. Read-only + convert is better. |
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
| `.docx` | Tiptap (read-only) | **N/A (read-only)** | mammoth.js conversion. "Convert to Eigen Doc" offered. |

**Fidelity rating definitions:**
- **Lossless**: Byte-identical output (save for trailing newline normalization)
- **Good with caveats**: Semantic content preserved, cosmetic formatting may change
- **N/A**: No write-back to original format

## Concrete Changes Needed

### Backend (apps/api)

**New router: `apps/api/src/routes/editor.ts`**

```
GET  /editor/:ownerId/:mountId/:pathId/content
     Returns: { editMode, content: string, frontmatter?: string, mimeType: string, locked?: { userId, userName } }
     - Reads file bytes via mount.readFile()
     - Detects encoding (reject non-UTF-8)
     - For markdown: extracts frontmatter, returns body separately
     - For DOCX: converts via mammoth.js, returns HTML string
     - Checks file size limits

PUT  /editor/:ownerId/:mountId/:pathId/content
     Body: { content: string, frontmatter?: string }
     - Validates lock ownership
     - For markdown: re-attaches frontmatter, writes full file
     - For text/code: writes content directly
     - Updates path metadata (size, modifiedAt)

POST /editor/:ownerId/:mountId/:pathId/lock
     - Creates in-memory lock entry: { userId, userName, acquiredAt }
     - Returns 409 if already locked by another user
     - Locks auto-expire after 30 minutes of inactivity (no PUT received)

DELETE /editor/:ownerId/:mountId/:pathId/lock
     - Releases lock (only if held by current user)

POST /editor/:ownerId/:mountId/:pathId/convert
     Body: { targetFormat: 'eigendoc' }
     - Reads file content
     - Creates eigendoc folder structure (data.db, media/, chat/)
     - Initializes Y.Doc with parsed content
     - Copies sibling images to media/ folder for markdown
     - Returns new path ID
```

**Lock storage**: In-memory Map on the Drive instance. Locks are not persisted -- if the server restarts, all locks
are released. This is acceptable because the worst case is two users editing simultaneously without collaboration,
which just means last-write-wins.

**DOCX conversion**: mammoth.js runs server-side (Bun-compatible, pure JS). The HTML output is sanitized before
sending to the client.

### Frontend (apps/docs)

**New route: `apps/docs/src/routes/_auth.edit.$ownerId.$mountId.$pathId.tsx`**

Parallel to the existing `_auth.doc.$ownerId.$mountId.$pathId.tsx` route. Fetches file content via the new
`/editor/.../content` endpoint and renders the appropriate editor.

**New components:**

| Component | Location | Purpose |
|---|---|---|
| `NativeFileEditor` | `apps/docs/src/components/editor/native-file-editor.tsx` | Route component, dispatches to MarkdownEditor or CodeEditor based on editMode |
| `MarkdownEditor` | `apps/docs/src/components/editor/markdown-editor.tsx` | Tiptap with tiptap-markdown, History extension, reduced toolbar, save logic |
| `CodeEditor` | `apps/docs/src/components/editor/code-editor.tsx` | CodeMirror 6 wrapper with configurable language, line numbers, save binding |
| `EditorToolbar` (refactored) | `apps/docs/src/components/docs/editor-toolbar.tsx` | Accept a `features` prop that hides non-applicable buttons |
| `FormatBadge` | `apps/docs/src/components/editor/format-badge.tsx` | Shows "MD", "TXT", "JSON", etc. with dropdown for convert/download/source-toggle |
| `SaveIndicator` | `apps/docs/src/components/editor/save-indicator.tsx` | "All changes saved" / "Saving..." / "Unsaved changes" |

**Toolbar refactor**: The current `EditorToolbar` in `editor-toolbar.tsx` is a monolithic 718-line component. Rather
than adding a `features` prop to this (which would litter it with conditionals), create a new `MarkdownToolbar`
component that composes the same building blocks (TooltipButton, DropdownMenu, etc.) with only markdown-safe actions.
The eigendoc toolbar stays untouched.

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
| `useFileSave()` | Mutation for `PUT /editor/.../content`, with debounced auto-save |
| `useFileLock(ownerId, mountId, pathId)` | Acquires lock on mount, releases on unmount |

**Extend `packages/lib/src/core/api.ts`:**

Add `getEditUrl(ownerId, mountId, pathId)` alongside existing `getDocUrl()`. Add helper `isInlineEditable(mimeType, name)`
that returns true for supported file types.

### Frontend (apps/drive)

**Modify `onRowActivate` in `_auth.fs.$ownerId.$mountId.$pathId.tsx`:**

Insert a new branch before the download fallback:

```typescript
const onRowActivate = (path: DrivePath) => {
    if (path.type === 'folder') {
        navigate({...});
    } else if (isDocumentType(path.type)) {
        openDocument(path);
    } else if (isInlineEditable(path.mimeType, path.name)) {  // NEW
        openNativeEditor(path);                                 // NEW
    } else if (canPreview(path)) {
        openPreview(path);
    } else {
        window.open(getDriveDownloadUrl(...), "_blank");
    }
};
```

The same change needs to be applied in `_auth.shared.$to.tsx` and `_auth.mime.$mimeType.tsx` which have
similar `onRowActivate` handlers.

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

- File lock acquisition and release
- Lock expiry after timeout
- Lock conflict (409 response)
- Content endpoint for each supported MIME type
- Save endpoint with frontmatter re-attachment
- DOCX preview endpoint
- Convert-to-eigendoc endpoint
- File size limit enforcement
- Non-UTF-8 file rejection

### Frontend tests

- Toolbar renders correct buttons for markdown mode vs eigendoc mode
- Save indicator state transitions
- Format badge displays correct label
- Auto-save triggers after debounce period
- Lock acquired on mount, released on unmount

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| tiptap-markdown has undiscovered round-trip bugs | High | Medium | Build the round-trip test suite FIRST, before any integration work. Run it against real-world files. If it fails badly, reconsider the approach (fallback: source-only editing for markdown, no WYSIWYG). |
| Users edit markdown files concurrently via external tools | Medium | Low | Document as known limitation. Eigen locks are advisory only. Last writer wins. Consider adding file modification timestamp check before save (compare mtime, warn if changed). |
| Large markdown files cause editor lag | Medium | Medium | Enforce 2MB limit. ProseMirror becomes noticeably slow above ~1MB with complex documents. Test with files at the limit. |
| CodeMirror bundle size bloats the docs app | Low | Medium | Lazy-load CodeMirror via dynamic import. Only loaded when user opens a code/text file. |
| Users expect collaborative editing on markdown | Medium | Low | Clear UX messaging: format badge, "Single user editing" indicator, "Convert to Eigen Doc for collaboration" prompt. |
| Auto-save data loss on browser crash | Medium | Medium | Use `beforeunload` event to attempt final save. Store unsaved content in `localStorage` as crash recovery buffer. On next open, check for recovery data and offer to restore. |
| Frontmatter corruption | Low | High | Preserve frontmatter as verbatim string. Never parse or modify it. Re-attach byte-for-byte on save. Test with multi-line YAML, nested objects, special characters. |
| DOCX mammoth.js conversion misses critical content | High | Low | This is read-only, so no data loss risk. Show a prominent "Some formatting may not be displayed" banner. |

## Phases

### Phase 1: Markdown Editing (4-6 weeks)

**Goal**: Open `.md` files from Drive, edit in WYSIWYG mode, save back as `.md`.

**Deliverables**:
1. Backend: `/editor/.../content` and `/editor/.../lock` endpoints
2. Frontend: `MarkdownEditor` component with tiptap-markdown
3. Frontend: `MarkdownToolbar` with markdown-safe features only
4. Frontend: New route `/_auth/edit/$ownerId/$mountId/$pathId`
5. Drive integration: `onRowActivate` routes `.md` files to editor
6. Frontmatter handling (extract/reattach)
7. Auto-save with debounce + save indicator
8. Format badge ("MD")
9. First-save normalization warning
10. File locking (acquire/release/conflict)
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

### Phase 3: DOCX Preview and Conversion (2 weeks)

**Goal**: Preview `.docx` files read-only. Offer conversion to eigendoc.

**Deliverables**:
1. Server-side mammoth.js integration
2. `DocxViewer` component (read-only Tiptap with HTML content)
3. "Convert to Eigen Doc" flow (mammoth -> HTML -> ProseMirror -> Y.Doc -> data.db)
4. Image extraction from DOCX to eigendoc media folder
5. Conversion prompt UX

**Dependencies**: `mammoth` (npm package)

### Phase 4: Polish (2 weeks)

**Goal**: Refinements based on Phase 1-3 usage.

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
- Editable DOCX (read-only + convert only)
