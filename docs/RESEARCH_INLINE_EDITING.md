# Research: Inline Editing of Native Files in Eigen Docs

> **TLDR**: Edit `.md`, `.txt`, `.csv`, `.json`, `.yaml`, and `.docx` files directly in the Docs app without converting
> them to `.eigendoc` on disk. Files stay in their native format. For markdown: Tiptap + `tiptap-markdown` for WYSIWYG
> with round-trip serialization. For plain text and structured data files: CodeMirror 6. For DOCX: read-only preview
> first, then lossy editing with clear warnings. Collaboration on native files uses single-user locking initially, with
> an optional ephemeral Yjs layer later (see analysis of trade-offs in section 5).

## 1. Current State Analysis

### How .eigendoc Works Today

An `.eigendoc` file is a **Drive folder** (type `doc`, MIME `application/eigendoc`) containing:

```
my-document.eigendoc/
  data.db          # SQLite: Yjs updates + snapshots (collab schema)
  media/           # Uploaded images
  chat/            # Embedded comment threads (*.eigenchat/)
```

The Yjs document state is stored as binary updates/snapshots in `data.db` using the collab schema
(`doc_updates` table for incremental updates, `doc_snapshots` table for periodic consolidated snapshots, capped at 50
revisions). A `DbProvider` class in `collabDocument.ts` manages loading state from the latest snapshot plus subsequent
updates, storing new updates, and periodically consolidating them (every 100 updates). There is no human-readable
intermediate format -- the canonical representation IS the Yjs binary state, which encodes a ProseMirror document tree.

### Editor Architecture

The editing pipeline (in `apps/docs/src/components/docs/editor.tsx`):

1. **Route** (`_auth.doc.$ownerId.$mountId.$pathId.tsx`) resolves the document via `useCollabDocumentInfo`
2. **CollaborativeEditor** creates a `Y.Doc`, connects via `WebsocketProvider` to `/ws/collab/:ownerId/:mountId/:pathId`
3. **TiptapEditor** initializes Tiptap with `Collaboration` extension bound to the Y.Doc
4. **Backend** (`CollabDocument`) loads Yjs state from `data.db`, syncs via the Yjs WebSocket protocol, persists updates

Extensions loaded by the editor (verified from `editor.tsx`):

| Extension | Config notes |
|---|---|
| StarterKit | `history: false`, `codeBlock: false` (replaced by CodeBlockLowlight) |
| Underline | Default |
| Subscript | Default |
| Superscript | Default |
| Typography | Smart quotes, dashes |
| TextStyle | Prerequisite for Color |
| Color | Text color |
| CharacterCount | Word/char counts |
| TextAlign | Configured for `heading` and `paragraph` types |
| TaskList + TaskItem | `nested: true` |
| Link | `openOnClick: true`, styled with Tailwind classes |
| ResizableImage | Custom node: `src`, `alt`, `title`, `width`, `alignment` attributes |
| Highlight | `multicolor: true` |
| CodeBlockLowlight | Uses `lowlight` with `common` language set |
| Table + TableRow + TableCell + TableHeader | `resizable: true` |
| CommentMark | Custom mark: `chatId` attribute, click handler opens comment thread |
| Collaboration | Bound to the Y.Doc |
| CollaborationCursor | Shows remote cursors with user name/color |

### How Files Are Opened from Drive

The file opening flow in `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`:

```
onRowActivate(path):
  if folder         -> navigate into folder
  if isDocumentType  -> openDocument(path)    [eigendoc, stickies, slides, sheets, chat]
  if canPreview      -> openPreview(path)     [image, video, PDF]
  else               -> download via window.open(downloadUrl)
```

`openDocument()` in `packages/lib/src/core/api.ts` uses `getDocumentUrl()` which maps by `path.type`:
`doc` -> Docs app, `stickies` -> Stickies, `slides` -> Slides, `sheets` -> Sheets, `chat` -> Chat. Regular files
(type `file`) fall through to preview or download. There is **no mechanism today** to open a regular file in an editor.

`isPreviewable()` in `preview-provider.tsx` only returns true for `image/*`, `video/*`, and `application/pdf`.
So `.md`, `.txt`, `.csv`, `.json`, `.yaml`, and `.docx` files currently just download.

### Storage Layer

Drive files use `StorageBackend` (LocalStorage wraps Bun.file, S3Storage for cloud). The metadata database tracks `id`,
`name`, `type`, `mimeType`, `parentId`, etc. Regular files have type `file` and their actual MIME type.

## 2. Markdown Editing

### Library: tiptap-markdown

The `tiptap-markdown` package provides bidirectional Markdown <-> ProseMirror conversion as a Tiptap extension. It uses
`markdown-it` for parsing (CommonMark + GFM extensions) and `prosemirror-markdown`'s serializer infrastructure for
output.

**Configuration:**

```typescript
import { Markdown } from 'tiptap-markdown';

Markdown.configure({
  html: true,                // Parse HTML in markdown input
  tightLists: true,          // No <p> inside <li> for tight lists
  tightListClass: 'tight',   // CSS class for tight lists
  bulletListMarker: '-',     // '-', '*', or '+'
  linkify: false,            // Auto-detect URLs
  breaks: false,             // Treat newlines as <br>
  transformPastedText: true, // Parse pasted markdown
  transformCopiedText: true, // Copy as markdown
})

// Read markdown out
editor.storage.markdown.getMarkdown()

// Load markdown in
editor.commands.setContent('# Hello **world**')
```

**Important**: `tiptap-markdown` auto-discovers serializer rules from registered Tiptap extensions. If a node/mark has
no registered serializer, it falls back to HTML output (when `html: true`) or drops the content silently. Custom
extensions like `ResizableImage` and `CommentMark` need explicit serializer rules to survive a round-trip.

### Round-Trip Fidelity

This is the critical analysis. "Round-trip" means: load markdown into Tiptap, make zero edits, serialize back.
Differences between input and output represent data loss.

**Safe round-trip** (markdown -> Tiptap -> markdown):

| Feature | Fidelity | Notes |
|---|---|---|
| Headings (h1-h6) | Lossless | |
| Paragraphs | Lossless | |
| Bold / Italic / Strike | Lossless | Marker style may normalize (`*bold*` -> `**bold**`) |
| Links | Lossless | Reference-style links will be inlined: `[text][ref]` -> `[text](url)` |
| Images (standard) | Lossless | `![alt](url "title")` preserved |
| Code (inline + fenced blocks) | Lossless | Language annotation preserved |
| Blockquotes | Lossless | Nesting preserved |
| Ordered / Unordered lists | Lossless | Starting number may normalize |
| Task lists | Lossless | `- [x]` / `- [ ]` |
| Horizontal rules | Lossless | Style normalizes to `---` |
| HTML blocks (inline) | Good | Preserved when `html: true`, but may be reformatted |

**Lossy areas:**

| Area | What happens | Notes |
|---|---|---|
| Tables (GFM) | Column alignment survives, but whitespace padding is normalized | Cell content is fine; cosmetic formatting changes |
| Nested blockquotes | Generally fine, but deeply nested structures may shift | Test with 3+ levels |
| Link titles | Preserved in standard syntax, but some edge cases exist | `[text](url "title")` |
| Hard line breaks | Trailing spaces (`  \n`) may be normalized to `\` | Depends on `breaks` config |
| Reference-style links | Converted to inline links | `[foo][bar]` becomes `[foo](url)` |
| Footnotes | Not supported | No `markdown-it-footnote` plugin loaded by default |

**Tiptap features with no markdown equivalent:**

| Feature | What happens | Mitigation |
|---|---|---|
| Underline | Lost (no md syntax) | Serialize as `<u>` with `html: true` |
| Highlight | Lost | Serialize as `<mark>` with `html: true` |
| Text color | Lost | Serialize as `<span style="color:...">` |
| Text alignment | Lost | Could use `<div align="...">` but ugly |
| Superscript / Subscript | Lost | Serialize as `<sup>` / `<sub>` |
| ResizableImage (width, alignment) | Width and alignment lost | Need custom serializer: `<img src="..." width="..." />` |
| CommentMark | Lost entirely | No equivalent in markdown |

**Whitespace normalization**: `tiptap-markdown` will normalize whitespace. A markdown file with irregular spacing,
trailing whitespace, or unusual indentation will look different after a round-trip even with zero edits. This matters
for files under version control (git diffs). Mitigations:

- On first load, store the original raw text. On save, if the user made no edits, write back the original verbatim.
- Consider a "normalize on first save" approach: warn the user that whitespace will be normalized, then do not warn
  again after the first save.
- The `bulletListMarker` config should match the file's existing convention (detect on load).

### Approach: Transparent Markdown Editing

**On open:**
1. Backend reads the `.md` file bytes from storage
2. Returns the raw markdown string to the frontend
3. Frontend strips and preserves frontmatter (see below)
4. Frontend loads body into Tiptap via `tiptap-markdown`
5. Editor displays the WYSIWYG view with a reduced toolbar (markdown-compatible features only)

**On save:**
1. Frontend serializes ProseMirror -> markdown via `editor.storage.markdown.getMarkdown()`
2. Frontend re-attaches frontmatter
3. Sends the full markdown string to the backend via PUT
4. Backend writes the raw bytes back to the same file in storage

**The file stays `.md` on disk at all times.**

### Toolbar Configuration for Markdown

When editing `.md`, the toolbar must only expose markdown-safe features. Compared to the current eigendoc toolbar:

- **Keep**: Bold, Italic, Strikethrough, Code (inline), Headings (1-3), Bullet list, Ordered list, Task list,
  Blockquote, Code block, Horizontal rule, Link, Image, Table
- **Hide**: Underline, Text color, Highlight color, Subscript, Superscript, Text alignment, Comment
- **Disable undo/redo from Collaboration**: Use Tiptap's built-in `History` extension instead (since Phase 1 has
  no Yjs)

This means `MarkdownEditor` needs its own toolbar component (or a configurable `EditorToolbar` that accepts a feature
set). The existing toolbar in `editor-toolbar.tsx` is tightly coupled to the full feature set -- refactoring it to
accept a `features` prop is the cleanest path.

### Frontmatter Handling

Many markdown files contain YAML frontmatter. Strategy: strip before passing to Tiptap, preserve verbatim, re-prepend
on save.

```typescript
function extractFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match) return { frontmatter: match[1], body: match[2] };
  return { frontmatter: null, body: markdown };
}

function reattachFrontmatter(frontmatter: string | null, body: string): string {
  if (!frontmatter) return body;
  return `---\n${frontmatter}\n---\n${body}`;
}
```

Note: The regex must handle `\r\n` line endings (Windows files uploaded to Drive).

### Markdown Images

Markdown images (`![alt](url)`) require path resolution:

1. **Relative paths** (`![](./image.png)`): Images stored alongside the `.md` file in the same Drive folder. Backend
   resolves relative paths to Drive embed URLs on load, converts back to relative paths on save.
2. **Absolute Drive URLs** (`![](http://api/drive/.../embed/image)`): Works but makes the markdown non-portable.

**Recommended**: Hybrid. The file on disk uses relative paths. On load, the backend (or frontend) resolves them to
Drive embed URLs for display. On save, newly uploaded images are stored in the parent folder and referenced with
relative paths. This requires a new endpoint or modification to the content endpoint to resolve sibling files by name.

### Source Mode and Split View

Two sub-features for power users:

**Source toggle**: Switch between WYSIWYG and raw markdown in a monospace editor.
- Rich -> Source: serialize via `getMarkdown()`, display in CodeMirror
- Source -> Rich: parse markdown, load into Tiptap via `setContent()`
- The toggle serializes/deserializes on each switch, so it is not instant for large documents

**Split view** (side-by-side): Markdown source on the left, rendered preview on the right. This is the HackMD/CodiMD
model. Implementation options:
- Use CodeMirror for the source side and a read-only Tiptap instance (or raw HTML render) for the preview side
- Sync changes from CodeMirror -> preview on debounce
- This is a Phase 2+ feature; the toggle is sufficient for Phase 1

## 3. Plain Text and Code File Editing

### Plain Text (.txt)

Use CodeMirror 6 instead of Tiptap. Tiptap adds unnecessary overhead for files with no formatting:

- Monospace font, line numbers, no toolbar (just save/print)
- CodeMirror handles whitespace preservation correctly (Tiptap normalizes whitespace through ProseMirror)
- Load: `editor.dispatch({changes: {from: 0, insert: text}})`, Save: `editor.state.doc.toString()`
- Round-trip is trivially lossless

### Structured Data Files (.csv, .json, .yaml)

These are text files with structure. CodeMirror with syntax highlighting is the right editor:

| Format | MIME type | CodeMirror language | Notes |
|---|---|---|---|
| `.csv` | `text/csv` | `@codemirror/lang-csv` or plain text | Could offer table-view toggle (render CSV as HTML table) |
| `.json` | `application/json` | `@codemirror/lang-json` | Syntax highlighting, bracket matching, auto-indent |
| `.yaml` | `text/yaml` / `application/x-yaml` | `@codemirror/lang-yaml` | Used for config files, frontmatter |
| `.xml` | `text/xml` / `application/xml` | `@codemirror/lang-xml` | |
| `.html` | `text/html` | `@codemirror/lang-html` | Could also offer rendered preview toggle |

These are all lossless round-trips (raw text in, raw text out).

### Code Files

The `file-icon-helper.tsx` already classifies JavaScript, JSON, HTML, CSS, Python, Java, PHP, and shell scripts with the
`FileCode` icon. Offering CodeMirror-based editing for these is a natural extension:

- Syntax highlighting via CodeMirror language packages
- No formatting toolbar -- just save, undo/redo, find/replace
- Scope this to Phase 2+ to avoid scope creep

**Decision**: Do NOT build a full IDE. CodeMirror for quick edits is valuable. Anything beyond basic editing (LSP,
terminal, git integration) is out of scope.

### Editor Selection Logic

```
.md                    -> Tiptap + tiptap-markdown (WYSIWYG) with source toggle (CodeMirror)
.txt                   -> CodeMirror (plain, no syntax highlighting)
.csv                   -> CodeMirror (plain) + optional table preview toggle
.json / .yaml / .xml   -> CodeMirror (with syntax highlighting)
.js / .ts / .py / etc. -> CodeMirror (with syntax highlighting)  [Phase 2+]
.html                  -> CodeMirror (with syntax highlighting) + optional rendered preview
.docx                  -> Tiptap (rich mode, read-only first, then lossy editing)
```

## 4. DOCX Editing

DOCX is a ZIP archive of XML (Open XML). Full round-trip fidelity is not achievable with current open-source tooling.

### Reading: mammoth.js

Converts `.docx` to clean semantic HTML. Good for headings, paragraphs, bold/italic, links, images, tables, lists.
Deliberately lossy: produces clean HTML, not pixel-perfect reproduction.

**What mammoth.js loses**: tracked changes, headers/footers, page layout, footnotes (limited), text boxes, shapes,
SmartArt, complex table formatting, embedded charts, custom fonts, precise spacing.

### Writing: html-to-docx

Converts HTML back to `.docx`. Maps HTML elements to Open XML. Better than manually building via the `docx` package
(which cannot read existing files at all).

### Strategy

1. **Phase 1**: Read-only DOCX preview (mammoth.js -> HTML -> read-only Tiptap). Low risk.
2. **Phase 2**: Editable with warning: "Editing will simplify formatting. Some features may be lost." Save via
   `html-to-docx`. Keep the original `.docx` as a backup (e.g., `.filename.docx.backup`) on first edit.
3. **Phase 3**: Offer "Convert to Eigen Doc" to create a proper `.eigendoc` with full Tiptap feature support.

## 5. Collaborative Editing on Native Files

### The Fundamental Challenge

The current `.eigendoc` model works because the canonical format IS the Yjs binary state. For native files, there is a
mismatch: the canonical format is markdown/text/docx, but Yjs operates on a ProseMirror document tree. Every
serialization pass is a potential point of data loss or normalization.

### Approach A: Ephemeral Yjs Layer (Original Proposal)

```
[File on disk: notes.md]
  -> parse to ProseMirror
  -> initialize Y.Doc (in-memory)
  -> clients connect via WebSocket, collaborate via Yjs
  -> on save: serialize Y.Doc -> markdown -> write to disk
  -> on last disconnect: discard Y.Doc
```

**Strengths**: Reuses existing Yjs/Collaboration/CollaborationCursor infrastructure. Cursors, presence, and conflict
resolution work identically to eigendoc.

**Weaknesses**:
- **Serialization drift**: Every auto-save round-trip through `getMarkdown()` may normalize whitespace, reorder
  attributes, or lose unsupported features. Over a collaborative session with many saves, drift accumulates.
- **Crash recovery is complex**: If the server crashes while a Y.Doc is in-memory, edits since last save are lost.
  The original document suggested a `.collab` sidecar file for crash recovery, but this adds significant complexity
  (when to clean up? what if the sidecar is stale? what if the `.md` was edited externally between sessions?).
- **External edits conflict**: If someone edits the `.md` file outside Eigen (e.g., via git push, or another tool),
  the ephemeral Y.Doc becomes stale. No mechanism detects this.
- **Initialization race**: If two clients open the same `.md` file near-simultaneously, both may try to initialize
  the Y.Doc from the file. The `CollabDocument` singleton pattern (via `createAsyncSingleton` in `drive.ts`) handles
  this for eigendoc, but the ephemeral version needs the same treatment.

**Verdict**: Architecturally sound for short collaborative sessions, but fragile for long-running sessions with
auto-save. The serialization drift problem is the main risk.

### Approach B: Collaborate on the Source Text (Alternative)

Instead of collaborating at the ProseMirror level and serializing to markdown, collaborate directly on the raw markdown
text using Yjs's `Y.Text` type:

```
[File on disk: notes.md]
  -> load raw text into Y.Text
  -> clients connect, edit the raw text collaboratively
  -> each client renders their own WYSIWYG preview (read-only Tiptap or live HTML)
  -> on save: Y.Text.toString() -> write to disk
```

**Strengths**: Zero serialization drift (the raw text IS the canonical format). Lossless round-trip guaranteed. External
edits can be detected and merged as text patches.

**Weaknesses**: Editing happens in source mode, not WYSIWYG. The WYSIWYG view is read-only preview, updated on
debounce. This is the HackMD model. Less polished UX than true WYSIWYG collaboration.

### Recommended Path

**Phase 1**: Single-user editing with file locking (no Yjs at all). This sidesteps all collaboration complexity.
The History extension provides undo/redo.

**Phase 2**: If collaborative markdown editing is needed, use Approach A (ephemeral Yjs) but with these safeguards:
- Do not auto-save during active collaboration. Save only on explicit Cmd+S or when the last client disconnects.
- On first load, store a hash of the original file content. Before saving, re-read the file and compare hashes.
  If the file changed externally, warn and offer merge/overwrite/cancel.
- Set a session timeout (e.g., 1 hour of inactivity closes the collab session and saves).

### Single-User Editing Details

For Phase 1:

1. Load file content into Tiptap **without** Collaboration/CollaborationCursor extensions
2. Add the `History` extension (from StarterKit -- re-enable it since `history: false` is only needed when
   Collaboration is active)
3. Save on Cmd+S and/or debounced auto-save (5 seconds of inactivity)
4. Lock the file while editing: `POST /editor/:pathId/lock`, `DELETE /editor/:pathId/lock`
5. If another user tries to open, show "This file is being edited by {user}. Open read-only?"

## 6. Conversion Between Formats

### .md -> .eigendoc

A user may want to "upgrade" a markdown file to a full eigendoc for collaboration, comments, and rich formatting.

**Flow**:
1. User clicks "Convert to Eigen Doc" in the format badge menu
2. Backend creates a new `.eigendoc` folder structure (data.db, media/, chat/)
3. Backend reads the `.md` content, parses to ProseMirror JSON (using the same tiptap-markdown logic, but server-side)
4. Initializes a Y.Doc with the ProseMirror content and writes the initial state to `data.db`
5. If images exist as siblings, copies them to the `media/` subfolder and rewrites references
6. Optionally deletes or keeps the original `.md` file

**Server-side ProseMirror**: This requires running `tiptap-markdown` parsing on the server. Since Eigen uses Bun,
and Tiptap/ProseMirror are JavaScript, this is feasible but requires careful setup (ProseMirror schema must match
the frontend's schema exactly, or the resulting Y.Doc will not render correctly in the editor).

### .eigendoc -> .md

Export direction. Useful for users who want to take their content to other tools.

**Flow**:
1. Load the Y.Doc from `data.db`
2. Convert to ProseMirror JSON via `yDocToProsemirrorJSON()` (already used in `editor-toolbar.tsx` for revision restore)
3. Serialize to markdown via `tiptap-markdown`'s serializer
4. Extract images from the `media/` folder and save as siblings, rewriting URLs to relative paths
5. Save as `.md` file in Drive

**Lossy**: Features like comments, text color, highlights, and alignment will be lost. Warn the user.

## 7. Architecture

### FileEditMode

```typescript
type FileEditMode =
  | 'eigendoc'    // Existing path: Yjs-based collaborative editing
  | 'markdown'    // .md file: Tiptap with tiptap-markdown
  | 'plaintext'   // .txt file: CodeMirror, no syntax highlighting
  | 'code'        // .json, .yaml, .csv, .js, etc.: CodeMirror with syntax highlighting
  | 'docx'        // .docx file: Tiptap with HTML intermediate
  | 'readonly'    // Any file, view-only
```

### Backend: New Endpoints

In a new `editor.ts` router (separate from `collab.ts` which handles WebSocket-based Yjs editing):

```
GET  /editor/:ownerId/:mountId/:pathId/content
     -> Returns { editMode, content: string, frontmatter?: string, mimeType: string }

PUT  /editor/:ownerId/:mountId/:pathId/content
     -> Body: { content: string }
     -> Writes back to native format (re-attaches frontmatter for .md, etc.)

POST /editor/:ownerId/:mountId/:pathId/lock
     -> Acquires edit lock for the current user

DELETE /editor/:ownerId/:mountId/:pathId/lock
       -> Releases edit lock

POST /editor/:ownerId/:mountId/:pathId/convert
     -> Body: { targetFormat: 'eigendoc' | 'markdown' }
     -> Converts between formats
```

### MIME Type to Edit Mode Mapping

```typescript
const EDIT_MODE_MAP: Record<string, FileEditMode> = {
  'text/markdown': 'markdown',
  'text/plain': 'plaintext',
  'text/csv': 'code',
  'application/json': 'code',
  'text/yaml': 'code',
  'application/x-yaml': 'code',
  'text/xml': 'code',
  'application/xml': 'code',
  'text/html': 'code',
  'text/css': 'code',
  'application/javascript': 'code',
  'text/x-python': 'code',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function getEditMode(mimeType: string, name: string): FileEditMode | null {
  if (EDIT_MODE_MAP[mimeType]) return EDIT_MODE_MAP[mimeType];
  // Fallback to extension check for ambiguous MIME types
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.txt')) return 'plaintext';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.json') || name.endsWith('.yaml') || name.endsWith('.yml')) return 'code';
  if (name.endsWith('.csv')) return 'code';
  return null;
}
```

### Frontend: Modified File Opening Flow

The key change is in `onRowActivate` in the Drive route. Currently:

```typescript
// Current behavior for non-document, non-previewable files:
const url = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
window.open(url, "_blank");  // Downloads the file
```

This should become:

```typescript
const editMode = getEditMode(path.mimeType, path.name);
if (editMode) {
  openNativeEditor(path);  // Navigate to Docs app native editor route
} else {
  window.open(getDriveDownloadUrl(...), "_blank");
}
```

The `openDocument()` function in `packages/lib/src/core/api.ts` also needs extending. Currently `getDocumentUrl()`
only handles collab types and chat. It should gain a branch for editable file types.

### Frontend: New Route and Components

New route in Docs app: `/_auth/edit/$ownerId/$mountId/$pathId`

```typescript
function NativeFileEditor() {
  const { ownerId, mountId, pathId } = Route.useParams();
  const { data, isLoading } = useFileContent(ownerId, mountId, pathId);

  if (isLoading) return <EigenLoader />;

  switch (data?.editMode) {
    case 'markdown':
      return <MarkdownEditor content={data.content} frontmatter={data.frontmatter} />;
    case 'plaintext':
    case 'code':
      return <CodeEditor content={data.content} language={data.language} />;
    case 'docx':
      return <DocxViewer html={data.content} />;
    default:
      return <ReadOnlyViewer content={data.content} />;
  }
}
```

## 8. Cross-Cutting Concerns

### Previews

The current `isPreviewable()` function in `preview-provider.tsx` checks for image/video/PDF. For native file editing,
we need a parallel concept:

```typescript
function isInlineEditable(path: DrivePath): boolean {
  return getEditMode(path.mimeType, path.name) !== null;
}
```

The Drive detail panel (shown when a file is selected but not opened) could show a rendered preview of markdown files
using a lightweight markdown renderer (e.g., `markdown-it` to HTML, displayed in an iframe or sanitized div). This is
distinct from the full editor -- it is just a preview in the sidebar.

### Copy-Paste

The existing Eigen clipboard system (`packages/lib/src/core/clipboard/clipboard.ts`) uses a custom MIME type
(`application/eigen-clipboard`) to transfer rich content (images with metadata) between Eigen apps. For native file
editing:

- **Pasting into markdown editor**: If the user pastes Eigen clipboard data containing an image, the image should
  be uploaded to the parent folder (not a `media/` subfolder, since `.md` files do not have one) and inserted as
  `![](./filename.png)`.
- **Copying from markdown editor**: The `transformCopiedText: true` option in `tiptap-markdown` means copied text
  will be markdown-formatted in the clipboard. This interacts with the Eigen clipboard. Both should be set:
  the Eigen clipboard data (for cross-app paste) and the markdown text (for external paste).
- **Pasting between eigendoc and markdown**: Pasting rich content from an eigendoc into a markdown editor should
  degrade gracefully -- unsupported formatting (colors, highlights) is silently dropped.

### Version History

The current revision history (`RevisionHistory` component in `packages/ui/src/components/layout/collab/revision-history.tsx`)
uses Yjs snapshots from `data.db`. This does not apply to native files.

Options for native file version history:

1. **No version history** (simplest, Phase 1): Just save and overwrite. Rely on Drive's potential future versioning.
2. **Text-based diffs in a sidecar DB**: Store a `.<filename>.versions.db` alongside the file with timestamped
   text snapshots. Use a simple diff algorithm to show changes.
3. **Copy-on-write backups**: On each save, keep the previous version as `.<filename>.~1~`, `.<filename>.~2~`, etc.
   Simple but clutters the folder.
4. **Unified version store**: A per-mount or per-user DB that stores versions for all files. Cleaner than per-file
   sidecar DBs.

Recommendation: Option 1 for Phase 1. Option 4 for Phase 2+ (aligns with how Drive could offer versioning for all
file types, not just documents).

### Undo/Redo Across Save Boundaries

For eigendoc, undo/redo is managed by Yjs (which provides unlimited undo within the CRDT history). For native files
with the `History` extension:

- Undo/redo state is in-memory (ProseMirror transaction history)
- Closing and reopening the file loses undo history
- Saving does NOT clear undo history (you can still undo after saving)
- However, if you save, close, reopen, and want to undo -- you cannot. The file on disk is the new baseline.

This is the expected behavior for traditional file editors (like VS Code). No special handling needed.

### Print

The current `printDocument()` function in `packages/ui/src/lib/printElement.ts` prints the content of `[data-document]`
elements. For the markdown editor, this should work as-is if the editor renders into a similar container. For CodeMirror
editors (plain text, code), printing requires extracting the text and rendering it in a printable format.

## 9. UX Design

### Visual Indicators: How Does the User Know What They Are Editing?

This is critical. The user must always understand whether they are editing a `.md` file (with format constraints) or
an `.eigendoc` (with full features). Design elements:

**Format badge in the toolbar:**

```
[File v]  [Undo] [Redo]  |  MD  |  [Bold] [Italic] [Strikethrough] ...
                             ^^
                        Format badge (clickable)
```

The badge is a clickable button that opens a dropdown:
- Shows the file format and path (e.g., "Markdown file - notes.md")
- "Convert to Eigen Doc" action
- "Download original" action
- "Open in source mode" action (for .md)

Format badge colors:
- **MD** -- green background, for markdown
- **TXT** -- gray background, for plain text
- **JSON** / **YAML** / **CSV** -- blue background, for structured data
- **DOCX** -- blue background, for Word documents
- No badge for `.eigendoc` (it is the default, no indicator needed)

**Document container styling**: The current eigendoc editor renders in a white A4-like container
(`w-[210mm]` with `p-[2cm]` padding). For markdown files, use the same container to maintain visual consistency.
For code/text files, use a full-width container without the A4 styling.

**Title bar**: The `setAppName` call in the doc route (which strips `.eigendoc` from the title) should show the
full filename including extension for native files: "notes.md" not "notes".

### Auto-Save Indicator

Since native files use explicit save (not Yjs persistence), show the save state clearly:

```
"All changes saved"  |  "Saving..."  |  "Unsaved changes (Cmd+S to save)"
```

Place this next to the format badge in the toolbar. Use the existing `DocumentModeButton` pattern for styling
consistency.

### Conversion Prompt for DOCX

When opening a `.docx` file for the first time:

```
+----------------------------------------------------+
|  Word Document Preview                              |
|                                                     |
|  This document has been converted for viewing.      |
|  Some formatting may not be displayed.              |
|                                                     |
|  [View only]  [Convert to Eigen Doc]                |
+----------------------------------------------------+
```

"Convert to Eigen Doc" creates a full `.eigendoc` with collaborative editing, comments, etc. The original `.docx`
is kept as-is.

### Docs Sidebar Integration

The docs sidebar (`docs-sidebar.tsx`) currently shows "All docs" filtered to `application/eigendoc`. Add a new
sidebar item:

```
All docs        (eigendoc only -- existing)
All documents   (eigendoc + md + docx -- new)
Markdown files  (md only -- new, optional)
```

Or keep it simple: rename "All docs" to show both eigendocs and markdown files, with a format icon to distinguish
them. The existing `getFileIcon()` function returns `FileText` for both, so add a small badge or use a different icon
for markdown (e.g., a `FileCode` variant or a custom icon).

## 10. Implementation Phases

### Phase 1: Markdown Editing (MVP)

**Scope**: Open `.md` files from Drive in the Tiptap editor, edit, save back as `.md`. Single-user only.

**Tasks**:

1. Add `tiptap-markdown` dependency to the docs app
2. Create `MarkdownEditor` component (Tiptap with markdown extension, reduced toolbar, History extension)
3. Refactor `EditorToolbar` to accept a feature set config (or create `MarkdownToolbar`)
4. Add new route `/_auth/edit/$ownerId/$mountId/$pathId` in the docs app
5. Add backend endpoints: `GET/PUT /editor/:ownerId/:mountId/:pathId/content`, `POST/DELETE .../lock`
6. Implement frontmatter extraction and re-attachment (server-side)
7. Extend `getDocumentUrl()` and `openDocument()` to handle editable file types
8. Modify `onRowActivate` in Drive to route `.md` files to the editor
9. Implement auto-save with debounce and save state indicator
10. Add format badge ("MD") to toolbar
11. Handle markdown images with relative path resolution

**No collaboration, no source mode, no CodeMirror** in Phase 1.

**Dependencies**: `tiptap-markdown`.

### Phase 2: Source Mode, Plain Text, and Code Files

**Scope**: Add source mode toggle for markdown. Edit `.txt`, `.csv`, `.json`, `.yaml` files via CodeMirror.

**Tasks**:

1. Add CodeMirror 6 dependencies (`@codemirror/state`, `@codemirror/view`, relevant language packages)
2. Create `CodeEditor` component (CodeMirror with configurable language, line numbers, save binding)
3. Add source mode toggle to `MarkdownEditor` (switches between Tiptap and CodeMirror views)
4. Extend the MIME-to-edit-mode mapping for structured data types
5. Update `file-icon-helper.tsx` to show distinct icons for editable text file types

**Dependencies**: `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-json`, `@codemirror/lang-yaml`,
`@codemirror/lang-markdown`.

### Phase 3: DOCX Preview and Conversion

**Scope**: Preview `.docx` files. Offer "Convert to Eigen Doc" for full editing.

**Tasks**:

1. Add `mammoth` dependency (server-side)
2. Implement DOCX -> HTML conversion in the content endpoint
3. Create `DocxViewer` component (read-only Tiptap with HTML content)
4. Implement "Convert to Eigen Doc" flow (server-side: mammoth -> ProseMirror -> Y.Doc -> data.db)
5. Handle embedded images (extract, upload to Drive)

**Dependencies**: `mammoth`.

### Phase 4: Collaborative Editing on Native Files

**Scope**: Enable real-time collaboration on `.md` files via ephemeral Yjs.

**Tasks**:

1. Create `EphemeralCollabDocument` class (initializes Y.Doc from file content, serializes back on close)
2. Add WebSocket endpoint for ephemeral collab sessions
3. Implement external-edit detection (hash comparison before save)
4. Add session timeout and save-on-disconnect
5. Switch `MarkdownEditor` to use Collaboration extension when multiple users are present

### Phase 5: Polish

1. Version history for native files (unified version store)
2. Split view for markdown (source + preview side by side)
3. Export eigendoc -> markdown
4. Markdown-specific keybindings (Cmd+/ for source toggle)
5. CSV table view toggle
6. Drag-and-drop `.md`/`.docx` files onto the docs app

## 11. Open Questions

1. **Should `.md` files auto-open in the editor from Drive, or require an explicit "Edit" action?**
   Recommendation: Auto-open. The current behavior (download) is useless for most users.

2. **Should the markdown editor show a "normalized whitespace" warning on first save?**
   Recommendation: Yes, for files under 100KB. Show a diff of what will change. Allow the user to cancel.

3. **Should `html: true` be enabled in tiptap-markdown?**
   Recommendation: Yes, to preserve existing inline HTML in markdown files. But toolbar actions should generate
   markdown syntax, not HTML. Only fall back to HTML for features like `<u>`, `<mark>`, `<sup>`, `<sub>` if those
   toolbar buttons are ever exposed (which they should not be in Phase 1).

4. **How should we handle very large files?**
   Recommendation: Set limits. Markdown: 2MB (ProseMirror struggles above this). Code/text: 5MB (CodeMirror handles
   larger files better). DOCX: 20MB. Show "File too large for in-browser editing" and offer download.

5. **Should we detect the markdown flavor (CommonMark vs GFM vs custom)?**
   Recommendation: No. Standardize on GFM (GitHub Flavored Markdown), which is what `tiptap-markdown` uses via
   `markdown-it` with GFM plugins. This covers 95% of real-world markdown files.

6. **Should code file editing (`.js`, `.py`, etc.) be scoped to the Docs app or a separate app?**
   Recommendation: Docs app. It already has the editor infrastructure. Adding a CodeMirror component does not
   warrant a separate app. The route structure (`/edit/:ownerId/:mountId/:pathId`) works for all file types.
