# Slides Export (HTML/PDF) & Quick Preview

## Goal

Add HTML and PDF export plus Drive quick preview for `.eigenslides` files. Follow the established eigendoc
export/preview pattern. Minimize duplication by extracting shared slide types to `packages/lib` and reusing
the font embedding, WeasyPrint, and preview cache infrastructure.

## Shared Types Extraction

Move from `apps/slides/src/components/slides/types.ts` to `packages/lib/src/slides/types.ts`:

| What | Notes |
|------|-------|
| `BaseObject`, `TextObject`, `ImageObject`, `SlideObject` | Type definitions |
| `SlideItem`, `DeckData` | Type definitions |
| `SLIDE_BASE_WIDTH`, `SLIDE_BASE_HEIGHT`, `SLIDE_ASPECT_RATIO` | Constants (1920, 1080, 16/9) |
| `BORDER_RADIUS_ROUND` | Constant (9999) |
| `pxToPercent(val, axis)`, `percentToPx(val, axis)` | Pure coordinate math |

**Stay in `apps/slides/`**: `DEFAULT_TEXT_OBJECT`, `DEFAULT_IMAGE_OBJECT` (editor-only defaults).

Frontend `apps/slides/` updates imports to `@workspace/lib/slides`. No behavior change.

## Content Loading

New file: `apps/api/src/lib/export/slides/content.ts`

Mirrors `export/doc/content.ts`. Loads Yjs state → plain `DeckData` + media map.

```
loadSlidesContent(mount, drivePath)
  → mount.getChildByName(drivePath.id, 'data.db')
  → mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id)
  → loadYjsState(managedDb)
  → extract slideOrder (Y.Array.toArray()), slides (Y.Map entries), objects (Y.Map entries)
  → normalize to DeckData (plain JS objects, same shape as useDeck() output)
  → mount.getChildByName(drivePath.id, 'media') → mount.listFolder()
  → build mediaByName: Map<string, { pathId, name, mimeType }>
  → return { deck, mediaByName }
```

Reuses `loadYjsState()` from `collab/yjs-loader.ts` and `COLLAB_DB_CONFIG` from `collab/db-config.ts`.

## Slide HTML Rendering

New file: `apps/api/src/lib/export/slides/render.ts`

Pure functions with zero side effects. Produces HTML strings from slide data.

### Size unit abstraction

The only difference between responsive (preview/HTML export) and fixed (PDF) rendering is how
font-size, border-width, border-radius, and letter-spacing are expressed. Positioning is always
percentages.

```typescript
type SizeUnit = (px: number, axis: 'x' | 'y') => string;

// For preview + HTML export (browser): container query units
const responsiveSizeUnit: SizeUnit = (px, axis) => {
    const base = axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT;
    const unit = axis === 'x' ? 'cqw' : 'cqh';
    return `${(px / base) * 100}${unit}`;
};

// For PDF (WeasyPrint): pre-computed pixel values for the page dimensions
const fixedSizeUnit = (pageWidth: number, pageHeight: number): SizeUnit =>
    (px, axis) => {
        const base = axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT;
        const dim = axis === 'x' ? pageWidth : pageHeight;
        return `${(px / base) * dim}px`;
    };
```

### Core render functions

```typescript
type ImgSrcResolver = (mediaName: string) => string | null;

renderSlideObjectHtml(obj: SlideObject, sizeUnit: SizeUnit, resolveImgSrc: ImgSrcResolver): string
renderSlideHtml(slide: SlideItem, objects: SlideObject[], sizeUnit: SizeUnit, resolveImgSrc: ImgSrcResolver): string
```

`renderSlideObjectHtml` mirrors the style logic in `slide-object.tsx`'s `getObjectPositionStyle`,
`getTextStyle`, and `getVerticalAlignStyle` — but outputs CSS strings. It handles:

- **Position/size**: percentage-based (`left`, `top`, `width`, `height`)
- **Rotation**: `transform: rotate(Ndeg)`
- **Text**: font-family (via `getFontFamily()`), font-size (via `sizeUnit`), font-weight, font-style,
  text-decoration, text-align, color, line-height, letter-spacing (via `sizeUnit`), vertical-align
  (flexbox), highlight color (inline `<span>` with background), background color
- **Image**: `<img>` with `object-fit`, resolved `src`
- **Border**: width (via `sizeUnit`), color, radius (via `sizeUnit`, `50%` for round)

`renderSlideHtml` wraps objects in a slide container:

```html
<div class="slide" style="position:relative; width:100%; aspect-ratio:16/9;
    container-type:size; overflow:hidden; background-color:#fff;
    background-image:url(...); background-size:cover; background-position:center;">
  <!-- rendered objects in objectIds order -->
</div>
```

For PDF mode, `aspect-ratio` is replaced with `height:100%` (slide fills the page).

## Font Embedding Extraction

Extract font embedding from `apps/api/src/lib/export/doc/html.ts` into a shared utility:

New file: `apps/api/src/lib/export/fonts.ts`

```typescript
export function getFontCSS(): string  // Base64-encoded @font-face rules for all Eigen fonts
```

Moves the `FONT_FILES` array, `buildFontFaceCSS()`, and lazy `_fontCSS` cache to the shared file.
Both `export/doc/html.ts` and `export/slides/html.ts` import `getFontCSS()` from here.

The same four font families are used by both docs and slides: Inter, Source Serif 4, JetBrains Mono,
Excalifont.

## HTML Export

New file: `apps/api/src/lib/export/slides/html.ts`

```
loadSlidesContent() → DeckData + media map
        ↓
for each slide in slideOrder:
  - resolve media to data URIs (same as eigendoc: readFileAsDataUri)
  - renderSlideHtml(slide, objects, dataUriResolver, responsiveSizeUnit)
        ↓
join slides with spacing divs
        ↓
wrapInDocument() → full standalone HTML:
  - Embedded WOFF2 fonts (via shared getFontCSS())
  - CSS reset (box-sizing, margin:0)
  - .slide styling (container-type: size for responsive font scaling)
  - Slide spacing for screen (margin-bottom between slides, centered, light background)
  - @media print: page-break-after for each slide, no spacing, no background
```

Entry point:

```typescript
export async function exportSlidesToHtml(mount: Mount, drivePath: DrivePath): Promise<ExportResult>
```

Returns `{ data: Buffer, contentType: 'text/html', fileName: 'Deck Name.html' }`.

The `.eigenslides` extension is stripped from the filename (like eigendoc strips `.eigendoc`).

## PDF Export

New file: `apps/api/src/lib/export/slides/pdf.ts`

```
loadSlidesContent() → DeckData + media map
        ↓
for each slide in slideOrder:
  - resolve media to data URIs
  - renderSlideHtml(slide, objects, dataUriResolver, fixedSizeUnit(pageWidth, pageHeight))
        ↓
wrapInPdfDocument() → HTML with:
  - @page { size: 254mm 142.875mm; margin: 0; } (16:9 landscape, ~960x540px at 96dpi)
  - Embedded fonts (via shared getFontCSS())
  - Each .slide fills the page (width:100%; height:100%; position:relative)
  - page-break-after: always between slides
  - Fixed px font sizes computed for the page dimensions
        ↓
htmlToPdf() (existing WeasyPrint wrapper from export/weasyprint.ts)
```

Entry point:

```typescript
export async function exportSlidesToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult>
```

### Why different HTML for PDF?

WeasyPrint doesn't support CSS container queries (`cqh`/`cqw`). The HTML export uses container queries
for responsive browser rendering. The PDF export uses pre-computed pixel values for the known page
dimensions. The `SizeUnit` abstraction in `render.ts` handles this — same render functions, different
unit parameter.

## Quick Preview

New file: `apps/api/src/lib/preview/eigenslides-preview.ts`

Mirrors `eigendoc-preview.ts`:

```typescript
export async function generateEigenslidesPreview(
    mount: Mount, drivePath: DrivePath, baseUrl: string
): Promise<string>
```

```
loadSlidesContent() → DeckData + media map
        ↓
for each slide in slideOrder:
  renderSlideHtml(slide, objects, embedUrlResolver, responsiveSizeUnit)
    (images resolve to /drive/:ownerId/:mountId/file/:pathId/embed/:fileName URLs)
        ↓
join slides with spacing divs (margin-bottom between slides)
        ↓
DOMPurify.sanitize()
        ↓
return HTML body string
```

### Preview cache integration

Update `apps/api/src/lib/preview/preview-cache.ts`:

In `getCollabPreviewData()`, add a branch for `DRIVE_MIME_SLIDES`:

```typescript
if (mime === DRIVE_MIME_SLIDES) {
    // same cache-check + generate + write pattern as eigendoc
    const body = await generateEigenslidesPreview(mount, drivePath, baseUrl);
    return { body, mode: 'eigenslides' };
}
```

Dynamic import of `eigenslides-preview.ts` (same `--splitting` pattern as eigendoc) to avoid
DOM-global crashes at startup.

### Frontend preview display

Update `packages/ui/src/components/layout/drive/file-preview.tsx`:

Add `eigenslides` to the text preview mode handling. The container needs:
- Light gray background (`bg-muted` or similar)
- Padding around slides
- Each `.slide` div already has `aspect-ratio: 16/9` and `container-type: size`
- Max-width constraint so slides don't stretch too wide on large screens

The `TextPreviewMode` type in `packages/lib/src/constants/preview.ts` gains `'eigenslides'`.

## Export Route Integration

Update `apps/api/src/lib/export/export-document.ts`:

```typescript
import { DRIVE_MIME_SLIDES } from '@workspace/lib/types';

if (path.mimeType === DRIVE_MIME_SLIDES) {
    if (format === 'html') return exportSlidesToHtml(mount, path);
    if (format === 'pdf') return exportSlidesToPdf(mount, path);
}
```

## Frontend Export Integration

### Slides toolbar

Update `apps/slides/src/components/slides/toolbar.tsx`:

Add export options to the `FileMenu` — "Export as HTML" and "Export as PDF". Wire to
`useExportDocument()` hook. Same pattern as the docs editor toolbar.

### Drive context menu and file preview

Update `packages/ui/src/components/layout/drive/drive-table.tsx` and `file-preview.tsx`:

Add export submenu for `.eigenslides` files in the Drive context menu (HTML, PDF options).
Same `onExport` callback pattern as eigendoc.

## File Structure

```
packages/lib/src/slides/
  types.ts                              # Types, constants, pxToPercent (moved)

apps/api/src/lib/export/
  export-document.ts                    # + DRIVE_MIME_SLIDES dispatch
  fonts.ts                              # Shared font embedding (extracted from doc/html.ts)
  slides/
    content.ts                          # Yjs → DeckData + media map
    render.ts                           # Slide/object → HTML strings (SizeUnit abstraction)
    html.ts                             # Standalone HTML export
    pdf.ts                              # PDF via WeasyPrint

apps/api/src/lib/preview/
  preview-cache.ts                      # + eigenslides branch in getCollabPreviewData
  eigenslides-preview.ts                # Quick preview HTML body

packages/lib/src/constants/
  preview.ts                            # + 'eigenslides' TextPreviewMode

packages/ui/src/components/layout/drive/
  file-preview.tsx                      # + eigenslides preview container
```

## Edge Cases

- **Empty deck** (no slides): return minimal HTML with empty body / blank PDF
- **Slides with no objects**: render slide background only (color or image)
- **Missing media**: skip image (`resolveImgSrc` returns null → no `<img>` emitted)
- **Large media in export**: images read and base64-encoded one at a time (not all at once)
- **Background images**: resolved same as object images (data URI for export, embed URL for preview)
- **WeasyPrint not installed**: return 501 (existing behavior from `weasyprint.ts`)
- **Text with no fontFamily**: falls back to `getFontFamily()` default (Inter)
- **Round border radius** (≥ 9999): rendered as `border-radius: 50%`
- **Export during active collab**: loads last persisted Yjs state (may lag a few seconds)
- **DRIVE_MIME_SLIDES constant**: `'application/eigenslides'` — already defined in the codebase
