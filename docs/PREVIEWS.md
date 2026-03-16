# File Preview System

> **TLDR**: Server-side preview generation with tmp-dir cache. Images served as screen-res WebP (max 2560px), text/code/markdown
> as JSON body snippets rendered client-side with shared `eigen-prose` styles. Video/audio/PDF redirect to embed URL for native
> playback. Preview overlay in `packages/ui` with keyboard nav and sibling browsing.

## Route Structure

| Route                     | Content                                                        | Use case                        |
|---------------------------|----------------------------------------------------------------|---------------------------------|
| `GET .../download`        | Original file, `Content-Disposition: attachment`               | User hits "Download"            |
| `GET .../embed/:fileName` | Original file, `Content-Disposition: inline`                   | Video/audio playback, PDF iframe, server-side export |
| `GET .../preview`         | Screen-res WebP for images; redirect to embed for video/audio/PDF | Preview overlay image display |
| `GET .../text-preview`    | JSON `{ body, mode }` — sanitized HTML body for text/code/md  | Quick look + inline editor read-only mode |
| `GET .../thumb/:fileName` | 512px WebP                                                     | Drive file list row icons       |

## Cache Strategy

Everything in `mount.previewsDir` (`tmpDir/previews/`). Cache key: `{pathId}-{updatedAt}.{ext}`.

- Image previews: `{pathId}-{updatedAt}.screen.webp`
- Text previews: `{pathId}-{updatedAt}.json`
- Cache hit = serve directly, no regeneration
- Cleanup: files older than 7 days, run at `mount.init()`

## Text Previews

`text-preview.ts` returns `{ body: string, mode: TextPreviewMode }`. Modes:

| Mode       | Rendering                                        |
|------------|--------------------------------------------------|
| `markdown` | `markdown-it` → HTML, sanitized with DOMPurify  |
| `code`     | `lowlight` syntax highlighting → HTML spans      |
| `html`     | Raw HTML, sanitized with DOMPurify               |
| `plaintext`| `<pre>` wrapped, HTML-escaped                    |

Body is consumed via `useTextPreview()` hook (TanStack Query, 5min staleTime) and rendered with
`dangerouslySetInnerHTML` inside a `.eigen-prose` container. No iframe, no shadow DOM.

Shared `eigen-prose.css` in `packages/ui/src/styles/` provides prose typography + Catppuccin code highlighting,
used by both previews and the docs editor.

## Image Previews

`image-preview.ts` generates screen-res WebP (max 2560px) via sharp. Special handling:

- RAW/PSD/AI: extract embedded JPEG via exiftool if available
- PDF: extract first-page thumbnail via `pdftocairo` if available
- Regular images: sharp resize + WebP conversion

## Frontend Overlay

```
FilePreview (fixed, z-[100])
  Header   — filename, ← → nav, close ✕
  Content  — dispatch by previewMode:
    image:    <img src={previewUrl}>
    video:    <video src={embedUrl} controls>
    audio:    <audio src={embedUrl} controls>
    pdf:      <iframe src={embedUrl}>
    text:     TextPreviewContent (useTextPreview → eigen-prose div)
    fallback: file icon + "No preview available" + Download button
  Footer   — Open, Download buttons
```

**Keyboard:** Escape = close, ArrowLeft/ArrowRight = prev/next sibling.

**PreviewProvider** stores `DrivePath` + `siblings[]`, exposes `openPreview(path, siblings?)`.

`previewMode` determined client-side from `DrivePath.mimeType` + `DrivePath.name` via `getPreviewMode()`.

## Inline Editor Integration

`native-file-editor.tsx` in Drive shows text preview (nicely formatted via `useTextPreview`) in read-only mode.
Heavy editors (Tiptap for markdown, CodeMirror for code) are lazy-loaded only when user clicks Edit.

## Files

| File                                                                      | Purpose                                          |
|---------------------------------------------------------------------------|--------------------------------------------------|
| `apps/api/src/lib/preview/preview-cache.ts`                               | Orchestration: check cache, generate, serve      |
| `apps/api/src/lib/preview/image-preview.ts`                               | Screen-res WebP generation                       |
| `apps/api/src/lib/preview/text-preview.ts`                                | markdown-it + lowlight → HTML body + DOMPurify   |
| `apps/api/src/lib/preview/exiftool-preview.ts`                            | Embedded JPEG extraction for RAW/PSD/AI          |
| `apps/api/src/lib/drive/drive.ts`                                         | `getPreview()` + `getTextPreview()` methods      |
| `apps/api/src/routes/drive.ts`                                            | `/preview` + `/text-preview` routes              |
| `packages/ui/src/styles/eigen-prose.css`                                  | Shared prose + code highlight styles             |
| `packages/ui/src/components/layout/drive/file-preview.tsx`                | Preview overlay component                        |
| `packages/ui/src/components/layout/preview-provider/preview-provider.tsx` | Context: open/close/navigate previews            |
| `packages/lib/src/core/drive/hooks/use-drive.ts`                          | `useTextPreview()` hook                          |
| `packages/lib/src/core/drive/media-resolver.tsx`                          | Uses `getDrivePreviewUrl` for editor images      |
| `apps/drive/src/components/editor/native-file-editor.tsx`                 | Inline editor with text preview in read-only     |

## Future

- CSV table rendering (currently treated as plaintext)
- Eigen native type previews (eigendoc, eigenslides, eigensheets, eigenstickies)
- Video thumbnail frames (FFmpeg dependency)
- DOCX/XLSX/PPTX preview


---

### Phase 3 — Audio + CSV

**Goal:** Audio with native player. CSV as a scrollable table (generated server-side to keep the frontend clean).

| File                                                       | Change                                                                                                                     |
|------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/preview/text-preview.ts`                 | Extend to handle `text/csv` — parse with a lightweight server-side CSV parser, render HTML table (max 500 rows × 50 cols). |
| `apps/api/src/routes/drive.ts`                             | Add audio/CSV to preview endpoint dispatch                                                                                 |
| `packages/ui/src/components/layout/drive/file-preview.tsx` | Add `audio` viewer: `<audio controls src={embedUrl} className="w-full">`                                                   |

---

### Phase 4 — Eigen Native Types (eigendoc, eigenslides, eigensheets, eigenstickies)

**Goal:** Preview Eigen native files without opening them. Shares heavy infrastructure with import/export Phase 2.

| Type | Server approach | Prerequisite |
|------|----------------|--------------|
| eigendoc | Load Y.Doc (same as `DbProvider.loadState()`), `yDocToProsemirrorJSON()`, `generateHTML(json, serverExtensions)`, cache as HTML | `packages/lib/src/core/docs/server-extensions.ts` from import/export Phase 2; `y-prosemirror` in API |
| eigenslides | Load slides JSON, render each slide as styled HTML div | None |
| eigensheets | Load sheet JSON, render as HTML table | None |
| eigenstickies | Load stickies JSON, render simplified kanban columns as HTML | None |

eigendoc preview HTML generation is **identical** to eigendoc HTML export (PROPOSAL_DOC_IMPORT_EXPORT.md Phase 2). Build export first, then the preview endpoint calls the same function and caches the result.

---
