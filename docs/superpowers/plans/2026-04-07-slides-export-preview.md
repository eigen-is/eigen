# Slides Export (HTML/PDF) & Quick Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HTML and PDF export plus Drive quick preview for `.eigenslides` files, following the established eigendoc export/preview pattern.

**Architecture:** Shared slide types move to `packages/lib/src/slides/`. Server-side rendering in `apps/api/src/lib/export/slides/` produces HTML strings from Yjs data using a `SizeUnit` abstraction (container queries for browser, fixed px for WeasyPrint PDF). Font embedding extracted to shared utility. Preview reuses the same render functions with embed URLs instead of data URIs.

**Tech Stack:** Yjs, WeasyPrint (PDF), DOMPurify, `getFontFamily()` from `@workspace/lib/constants/fonts`

**Spec:** `docs/superpowers/specs/2026-04-07-slides-export-preview-design.md`

---

### Task 1: Extract shared types to `packages/lib`

**Files:**
- Create: `packages/lib/src/slides/types.ts`
- Create: `packages/lib/src/slides/index.ts`
- Modify: `apps/slides/src/components/slides/types.ts`

- [ ] **Step 1: Create `packages/lib/src/slides/types.ts`**

Move the shared types and functions. Keep `DEFAULT_TEXT_OBJECT` and `DEFAULT_IMAGE_OBJECT` in apps/slides (editor-only).

```typescript
// packages/lib/src/slides/types.ts

type BaseObject = {
    id: string;
    slideId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
    borderColor: string;
    borderWidth: number;
    borderRadius: number;
    commentChatNames: string[];
};

export type TextObject = BaseObject & {
    type: 'text';
    text: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    fontStyle: 'normal' | 'italic';
    textDecoration: 'none' | 'underline' | 'line-through';
    textAlign: 'left' | 'center' | 'right' | 'justify';
    verticalAlign: 'top' | 'center' | 'bottom';
    color: string;
    letterSpacing: number;
    lineHeight: number;
    highlightColor: string;
    backgroundColor: string;
};

export type ImageObject = BaseObject & {
    type: 'image';
    mediaName: string;
    objectFit: 'contain' | 'cover' | 'fill';
};

export type SlideObject = TextObject | ImageObject;

export type SlideItem = {
    id: string;
    objectIds: string[];
    backgroundColor: string;
    backgroundMediaName: string;
};

export type DeckData = {
    slides: Record<string, SlideItem>;
    objects: Record<string, SlideObject>;
    slideOrder: string[];
};

export const SLIDE_ASPECT_RATIO = 16 / 9;
export const SLIDE_BASE_WIDTH = 1920;
export const SLIDE_BASE_HEIGHT = 1080;

export function pxToPercent(val: number, axis: 'x' | 'y'): number {
    return (val / (axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT)) * 100;
}

export function percentToPx(val: number, axis: 'x' | 'y'): number {
    return (val / 100) * (axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT);
}

export const BORDER_RADIUS_ROUND = 9999;
```

- [ ] **Step 2: Create barrel export**

```typescript
// packages/lib/src/slides/index.ts
export * from './types';
```

- [ ] **Step 3: Update `apps/slides/src/components/slides/types.ts`**

Replace the moved content with re-exports + the editor-only defaults:

```typescript
// apps/slides/src/components/slides/types.ts
export type { TextObject, ImageObject, SlideObject, SlideItem, DeckData } from '@workspace/lib/slides';
export {
    SLIDE_ASPECT_RATIO,
    SLIDE_BASE_WIDTH,
    SLIDE_BASE_HEIGHT,
    BORDER_RADIUS_ROUND,
    pxToPercent,
    percentToPx,
} from '@workspace/lib/slides';

const DEFAULT_BORDER = {
    borderColor: '',
    borderWidth: 0,
    borderRadius: 0,
};

export const DEFAULT_TEXT_OBJECT: Omit<TextObject, 'id' | 'slideId'> = {
    type: 'text',
    x: 192,
    y: 108,
    w: 1536,
    h: 162,
    rotation: 0,
    text: 'New text',
    fontFamily: 'Inter',
    fontSize: 48,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'center',
    verticalAlign: 'center',
    color: '#000000',
    letterSpacing: 0,
    lineHeight: 1.2,
    highlightColor: '',
    backgroundColor: '',
    ...DEFAULT_BORDER,
    commentChatNames: [],
};

export const DEFAULT_IMAGE_OBJECT: Omit<ImageObject, 'id' | 'slideId' | 'mediaName'> = {
    type: 'image',
    x: 384,
    y: 162,
    w: 1152,
    h: 756,
    rotation: 0,
    objectFit: 'contain',
    ...DEFAULT_BORDER,
    commentChatNames: [],
};
```

No other files in `apps/slides/` need import changes — they all import from `./types` or `../types`, which now re-exports from `@workspace/lib/slides`.

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No new errors (all existing imports still resolve through re-exports).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/slides/ apps/slides/src/components/slides/types.ts
git commit -m "refactor: extract shared slide types to packages/lib/src/slides"
```

---

### Task 2: Extract shared font embedding

**Files:**
- Create: `apps/api/src/lib/export/fonts.ts`
- Modify: `apps/api/src/lib/export/doc/html.ts`

- [ ] **Step 1: Create `apps/api/src/lib/export/fonts.ts`**

Move the font embedding logic from `doc/html.ts`:

```typescript
// apps/api/src/lib/export/fonts.ts
import * as fs from 'node:fs';
import fontExcalifont from '../../../../../packages/ui/src/assets/fonts/excalifont/Excalifont-Regular.woff2' with {
    type: 'file',
};
import fontInterRegular from '../../../../../packages/ui/src/assets/fonts/inter/Inter-Variable.woff2' with {
    type: 'file',
};
import fontInterItalic from '../../../../../packages/ui/src/assets/fonts/inter/Inter-Variable-Italic.woff2' with {
    type: 'file',
};
import fontMonoRegular from '../../../../../packages/ui/src/assets/fonts/jetbrains-mono/JetBrainsMono-Variable.woff2' with {
    type: 'file',
};
import fontSerifRegular from '../../../../../packages/ui/src/assets/fonts/source-serif/SourceSerif4-Variable.woff2' with {
    type: 'file',
};
import fontSerifItalic from '../../../../../packages/ui/src/assets/fonts/source-serif/SourceSerif4-Variable-Italic.woff2' with {
    type: 'file',
};

const FONT_FILES = [
    { family: 'Inter', path: fontInterRegular, weight: '100 900', style: 'normal' },
    { family: 'Inter', path: fontInterItalic, weight: '100 900', style: 'italic' },
    { family: 'Source Serif 4', path: fontSerifRegular, weight: '200 900', style: 'normal' },
    { family: 'Source Serif 4', path: fontSerifItalic, weight: '200 900', style: 'italic' },
    { family: 'JetBrains Mono', path: fontMonoRegular, weight: '100 800', style: 'normal' },
    { family: 'Excalifont', path: fontExcalifont, weight: '400', style: 'normal' },
] as const;

let _fontCSS: string | undefined;

export function getFontCSS(): string {
    return (_fontCSS ??= buildFontFaceCSS());
}

function buildFontFaceCSS(): string {
    return FONT_FILES.map((font) => {
        try {
            const buf = fs.readFileSync(font.path);
            const dataUri = `data:font/woff2;base64,${buf.toString('base64')}`;
            return `@font-face {
    font-family: "${font.family}";
    src: url("${dataUri}") format("woff2");
    font-weight: ${font.weight};
    font-style: ${font.style};
    font-display: swap;
}`;
        } catch {
            console.warn(`[export/fonts] Failed to read font: ${font.path}`);
            return '';
        }
    })
        .filter(Boolean)
        .join('\n');
}
```

Note: The relative path prefix is `../../../../../` (one level less `../` than `doc/html.ts` since `fonts.ts` is at `export/` level, not `export/doc/`).

- [ ] **Step 2: Update `apps/api/src/lib/export/doc/html.ts`**

Remove the font-related imports and code. Replace with import from the shared module.

**Remove** these imports (lines 1, 8-26):
- `import * as fs from 'node:fs';`
- All six `import font...` lines with `{ type: 'file' }`

**Remove** (lines 202-232):
- The `FONT_FILES` array
- The `buildFontFaceCSS()` function

**Replace** the `_fontCSS` cache and `getFontCSS()` function (lines 47, 51) with:
```typescript
import { getFontCSS } from '../fonts';
```

Keep: `_proseCSS`, `getProseCSS()`, `flattenEigenProseCSS()`, `flattenNestedBlock()` — these are doc-specific.

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/export/fonts.ts apps/api/src/lib/export/doc/html.ts
git commit -m "refactor: extract shared font embedding to export/fonts.ts"
```

---

### Task 3: Slides content loading

**Files:**
- Create: `apps/api/src/lib/export/slides/content.ts`

- [ ] **Step 1: Create `apps/api/src/lib/export/slides/content.ts`**

Mirrors `export/doc/content.ts`. Loads Yjs state and converts Y.Map structures to plain `DeckData`. The Y.Map extraction logic mirrors `use-deck.ts`'s `updateReactState()` and `yMapToObject()`.

```typescript
// apps/api/src/lib/export/slides/content.ts
import type { DeckData, SlideObject } from '@workspace/lib/slides';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../../collab/db-config';
import { loadYjsState } from '../../collab/yjs-loader';
import type { Mount } from '../../mount';
import type { MediaFile } from '../doc/content';

export type SlidesContent = {
    deck: DeckData;
    mediaByName: Map<string, MediaFile>;
};

const OBJECT_FIELDS = [
    'id', 'slideId', 'type', 'x', 'y', 'w', 'h', 'rotation',
    'borderColor', 'borderWidth', 'borderRadius',
    'text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'textDecoration', 'textAlign', 'verticalAlign', 'color',
    'letterSpacing', 'lineHeight', 'highlightColor', 'backgroundColor',
    'mediaName', 'objectFit', 'commentChatNames',
] as const;

function yMapToSlideObject(yMap: Y.Map<unknown>): SlideObject {
    const obj: Record<string, unknown> = {};
    for (const field of OBJECT_FIELDS) {
        const val = yMap.get(field);
        if (val !== undefined) obj[field] = val;
    }
    const raw = obj.commentChatNames;
    if (raw && typeof (raw as Y.Array<string>).toArray === 'function') {
        obj.commentChatNames = (raw as Y.Array<string>).toArray();
    } else if (!Array.isArray(raw)) {
        obj.commentChatNames = [];
    }
    return obj as SlideObject;
}

export async function loadSlidesContent(mount: Mount, drivePath: DrivePath): Promise<SlidesContent | null> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return null;

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc: ydoc } = loadYjsState(managedDb);

    const slidesMap = ydoc.getMap('slides');
    const objectsMap = ydoc.getMap('objects');
    const slideOrderArray = ydoc.getArray('slideOrder');

    const deck: DeckData = { slides: {}, objects: {}, slideOrder: slideOrderArray.toArray() as string[] };

    for (const [slideId, slideMapValue] of slidesMap) {
        const slideMap = slideMapValue as Y.Map<unknown>;
        const objIdsArray = slideMap.get('objectIds') as Y.Array<string>;
        const objIds = objIdsArray ? (objIdsArray.toArray() as string[]) : [];
        deck.slides[slideId] = {
            id: slideId,
            objectIds: objIds,
            backgroundColor: (slideMap.get('backgroundColor') as string) || '#ffffff',
            backgroundMediaName: (slideMap.get('backgroundMediaName') as string) || '',
        };
    }

    for (const [objId, objMapValue] of objectsMap) {
        deck.objects[objId] = yMapToSlideObject(objMapValue as Y.Map<unknown>);
    }

    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const mediaChildren = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    const mediaByName = new Map(
        mediaChildren.map((f) => [f.name, { pathId: f.id, name: f.name, mimeType: f.mimeType }]),
    );

    return { deck, mediaByName };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/export/slides/content.ts
git commit -m "feat: add slides content loader (Yjs → DeckData + media)"
```

---

### Task 4: Slide HTML rendering

**Files:**
- Create: `apps/api/src/lib/export/slides/render.ts`

- [ ] **Step 1: Create `apps/api/src/lib/export/slides/render.ts`**

Pure functions producing HTML strings. The `SizeUnit` abstraction handles the difference between responsive (browser) and fixed (PDF) rendering. The style logic mirrors `slide-object.tsx`'s `getObjectPositionStyle`, `getTextStyle`, and `getVerticalAlignStyle`.

```typescript
// apps/api/src/lib/export/slides/render.ts
import { getFontFamily } from '@workspace/lib/constants/fonts';
import {
    BORDER_RADIUS_ROUND,
    SLIDE_BASE_HEIGHT,
    SLIDE_BASE_WIDTH,
    pxToPercent,
    type SlideItem,
    type SlideObject,
} from '@workspace/lib/slides';

export type SizeUnit = (px: number, axis: 'x' | 'y') => string;
export type ImgSrcResolver = (mediaName: string) => string | null;

export const responsiveSizeUnit: SizeUnit = (px, axis) => {
    const base = axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT;
    const unit = axis === 'x' ? 'cqw' : 'cqh';
    return `${(px / base) * 100}${unit}`;
};

export function fixedSizeUnit(pageWidth: number, pageHeight: number): SizeUnit {
    return (px, axis) => {
        const base = axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT;
        const dim = axis === 'x' ? pageWidth : pageHeight;
        return `${(px / base) * dim}px`;
    };
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function renderSlideObjectHtml(obj: SlideObject, sizeUnit: SizeUnit, resolveImgSrc: ImgSrcResolver): string {
    const styles: string[] = [
        'position:absolute',
        `left:${pxToPercent(obj.x, 'x')}%`,
        `top:${pxToPercent(obj.y, 'y')}%`,
        `width:${pxToPercent(obj.w, 'x')}%`,
        `height:${pxToPercent(obj.h, 'y')}%`,
    ];

    if (obj.rotation) styles.push(`transform:rotate(${obj.rotation}deg)`, 'transform-origin:center center');
    if (obj.borderWidth && obj.borderColor) {
        styles.push(`border:${sizeUnit(obj.borderWidth, 'y')} solid ${obj.borderColor}`);
    }
    if (obj.borderRadius) {
        styles.push(
            obj.borderRadius >= BORDER_RADIUS_ROUND
                ? 'border-radius:50%'
                : `border-radius:${sizeUnit(obj.borderRadius, 'x')}`,
        );
        styles.push('overflow:hidden');
    }

    if (obj.type === 'text') {
        if (obj.backgroundColor) styles.push(`background-color:${obj.backgroundColor}`);
        const vAlign = obj.verticalAlign || 'top';
        const alignItems = vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start';

        const textStyles: string[] = [
            `font-size:${sizeUnit(obj.fontSize, 'y')}`,
            `line-height:${obj.lineHeight || 1.2}`,
            `color:${obj.color || '#000000'}`,
        ];
        if (obj.fontFamily) textStyles.push(`font-family:${getFontFamily(obj.fontFamily)}`);
        if (obj.fontWeight && obj.fontWeight !== 'normal') textStyles.push(`font-weight:${obj.fontWeight}`);
        if (obj.fontStyle && obj.fontStyle !== 'normal') textStyles.push(`font-style:${obj.fontStyle}`);
        if (obj.textDecoration && obj.textDecoration !== 'none') textStyles.push(`text-decoration:${obj.textDecoration}`);
        if (obj.textAlign) textStyles.push(`text-align:${obj.textAlign}`);
        if (obj.letterSpacing) textStyles.push(`letter-spacing:${sizeUnit(obj.letterSpacing, 'x')}`);

        const text = escapeHtml(obj.text);
        const textContent = obj.highlightColor
            ? `<span style="background-color:${obj.highlightColor};box-decoration-break:clone;-webkit-box-decoration-break:clone">${text}</span>`
            : text;

        return `<div style="${styles.join(';')}"><div style="width:100%;height:100%;display:flex;align-items:${alignItems}"><p style="white-space:pre-wrap;word-break:break-word;width:100%;margin:0;${textStyles.join(';')}">${textContent}</p></div></div>`;
    }

    if (obj.type === 'image') {
        const src = resolveImgSrc(obj.mediaName);
        if (!src) return `<div style="${styles.join(';')}"></div>`;
        return `<div style="${styles.join(';')}"><img src="${escapeHtml(src)}" alt="" style="width:100%;height:100%;object-fit:${obj.objectFit || 'contain'}" /></div>`;
    }

    return '';
}

export function renderSlideHtml(
    slide: SlideItem,
    objects: SlideObject[],
    sizeUnit: SizeUnit,
    resolveImgSrc: ImgSrcResolver,
    options?: { fillPage?: boolean },
): string {
    const fillPage = options?.fillPage ?? false;
    const containerStyles: string[] = [
        'position:relative',
        'width:100%',
        fillPage ? 'height:100%' : 'aspect-ratio:16/9',
        'overflow:hidden',
        'container-type:size',
    ];

    if (slide.backgroundColor) containerStyles.push(`background-color:${slide.backgroundColor}`);

    if (slide.backgroundMediaName) {
        const bgSrc = resolveImgSrc(slide.backgroundMediaName);
        if (bgSrc) {
            containerStyles.push(
                `background-image:url('${escapeHtml(bgSrc)}')`,
                'background-size:cover',
                'background-position:center',
            );
        }
    }

    const objectsHtml = objects.map((obj) => renderSlideObjectHtml(obj, sizeUnit, resolveImgSrc)).join('\n');

    return `<div class="slide" style="${containerStyles.join(';')}">\n${objectsHtml}\n</div>`;
}

export function stripSlidesExtension(name: string): string {
    return name.replace(/\.eigenslides$/, '');
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/export/slides/render.ts
git commit -m "feat: add slide HTML rendering with SizeUnit abstraction"
```

---

### Task 5: HTML export

**Files:**
- Create: `apps/api/src/lib/export/slides/html.ts`

- [ ] **Step 1: Create `apps/api/src/lib/export/slides/html.ts`**

```typescript
// apps/api/src/lib/export/slides/html.ts
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../doc/render';
import { getFontCSS } from '../fonts';
import { loadSlidesContent } from './content';
import { type ImgSrcResolver, renderSlideHtml, responsiveSizeUnit, stripSlidesExtension } from './render';

export async function exportSlidesToHtml(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateSlidesExportHtml(mount, drivePath);
    return {
        data: Buffer.from(html, 'utf-8'),
        contentType: 'text/html; charset=utf-8',
        fileName: `${stripSlidesExtension(drivePath.name)}.html`,
    };
}

async function generateSlidesExportHtml(mount: Mount, drivePath: DrivePath): Promise<string> {
    const content = await loadSlidesContent(mount, drivePath);
    if (!content) return wrapInDocument(drivePath.name, '');

    const { deck, mediaByName } = content;

    const entries = await Promise.all(
        [...mediaByName].map(
            async ([name, file]) => [name, await readFileAsDataUri(mount, file.pathId, file.mimeType)] as const,
        ),
    );
    const dataUriMap = new Map(entries.filter((e): e is [string, string] => e[1] !== null));
    const resolveImgSrc: ImgSrcResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;

    const slidesHtml = deck.slideOrder
        .map((slideId) => {
            const slide = deck.slides[slideId];
            if (!slide) return '';
            const objects = slide.objectIds.map((id) => deck.objects[id]).filter(Boolean);
            return renderSlideHtml(slide, objects, responsiveSizeUnit, resolveImgSrc);
        })
        .filter(Boolean)
        .join('\n');

    return wrapInDocument(drivePath.name, slidesHtml);
}

function wrapInDocument(title: string, slidesHtml: string): string {
    const escapedTitle = title
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapedTitle}</title>
    <style>${getFontCSS()}${SLIDES_CSS}</style>
</head>
<body>
    <div class="deck">
        ${slidesHtml}
    </div>
</body>
</html>`;
}

async function readFileAsDataUri(mount: Mount, pathId: string, mimeType: string): Promise<string | null> {
    try {
        const file = await mount.readFile(pathId);
        if (!file) return null;
        const buffer = Buffer.from(await file.arrayBuffer());
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}

const SLIDES_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { display: block; max-width: 100%; }

body {
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    background: #f5f5f5;
    margin: 0;
    padding: 2rem;
}

.deck {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
}

.slide {
    max-width: 960px;
    width: 100%;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    border-radius: 4px;
}

@media print {
    body { background: none; padding: 0; }
    .deck { gap: 0; }
    .slide {
        max-width: none;
        width: 100%;
        height: 100vh;
        box-shadow: none;
        border-radius: 0;
        page-break-after: always;
        aspect-ratio: auto;
        container-type: size;
    }
    .slide:last-child { page-break-after: auto; }
}
`;
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/export/slides/html.ts
git commit -m "feat: add slides HTML export with embedded fonts and base64 images"
```

---

### Task 6: PDF export

**Files:**
- Create: `apps/api/src/lib/export/slides/pdf.ts`

- [ ] **Step 1: Create `apps/api/src/lib/export/slides/pdf.ts`**

```typescript
// apps/api/src/lib/export/slides/pdf.ts
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../doc/render';
import { getFontCSS } from '../fonts';
import { htmlToPdf } from '../weasyprint';
import { loadSlidesContent } from './content';
import { type ImgSrcResolver, fixedSizeUnit, renderSlideHtml, stripSlidesExtension } from './render';

// 16:9 landscape page: 254mm x 142.875mm ~ 960 x 540 px at 96dpi
const PAGE_WIDTH_PX = 960;
const PAGE_HEIGHT_PX = 540;

export async function exportSlidesToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const content = await loadSlidesContent(mount, drivePath);
    const title = stripSlidesExtension(drivePath.name);

    if (!content) {
        const html = wrapInPdfDocument(title, '');
        return { data: await htmlToPdf(html), contentType: 'application/pdf', fileName: `${title}.pdf` };
    }

    const { deck, mediaByName } = content;

    const entries = await Promise.all(
        [...mediaByName].map(
            async ([name, file]) => [name, await readFileAsDataUri(mount, file.pathId, file.mimeType)] as const,
        ),
    );
    const dataUriMap = new Map(entries.filter((e): e is [string, string] => e[1] !== null));
    const resolveImgSrc: ImgSrcResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;

    const sizeUnit = fixedSizeUnit(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);

    const slidesHtml = deck.slideOrder
        .map((slideId) => {
            const slide = deck.slides[slideId];
            if (!slide) return '';
            const objects = slide.objectIds.map((id) => deck.objects[id]).filter(Boolean);
            return renderSlideHtml(slide, objects, sizeUnit, resolveImgSrc, { fillPage: true });
        })
        .filter(Boolean)
        .join('\n');

    const html = wrapInPdfDocument(title, slidesHtml);
    return { data: await htmlToPdf(html), contentType: 'application/pdf', fileName: `${title}.pdf` };
}

function wrapInPdfDocument(title: string, slidesHtml: string): string {
    const escapedTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapedTitle}</title>
    <style>${getFontCSS()}${PDF_CSS}</style>
</head>
<body>
    ${slidesHtml}
</body>
</html>`;
}

async function readFileAsDataUri(mount: Mount, pathId: string, mimeType: string): Promise<string | null> {
    try {
        const file = await mount.readFile(pathId);
        if (!file) return null;
        const buffer = Buffer.from(await file.arrayBuffer());
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}

const PDF_CSS = `
@page {
    size: 254mm 142.875mm;
    margin: 0;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { display: block; max-width: 100%; }

body {
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    margin: 0;
    padding: 0;
}

.slide {
    width: 100%;
    height: 100%;
    page-break-after: always;
}

.slide:last-child {
    page-break-after: auto;
}
`;
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/export/slides/pdf.ts
git commit -m "feat: add slides PDF export via WeasyPrint"
```

---

### Task 7: Export route integration

**Files:**
- Modify: `apps/api/src/lib/export/export-document.ts`

- [ ] **Step 1: Update `export-document.ts` to handle slides**

Replace the entire file content:

```typescript
// apps/api/src/lib/export/export-document.ts
import { DRIVE_MIME_DOC, DRIVE_MIME_SLIDES } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import { exportEigendocToDocx } from './doc/docx';
import { exportEigendocToHtml } from './doc/html';
import { exportEigendocToPdf } from './doc/pdf';
import type { ExportResult } from './doc/render';
import { exportSlidesToHtml } from './slides/html';
import { exportSlidesToPdf } from './slides/pdf';

export async function exportDocument(mount: Mount, path: DrivePath, format: string): Promise<ExportResult> {
    if (path.mimeType === DRIVE_MIME_DOC) {
        if (format === 'docx') return exportEigendocToDocx(mount, path);
        if (format === 'pdf') return exportEigendocToPdf(mount, path);
        if (format === 'html') return exportEigendocToHtml(mount, path);
    }
    if (path.mimeType === DRIVE_MIME_SLIDES) {
        if (format === 'pdf') return exportSlidesToPdf(mount, path);
        if (format === 'html') return exportSlidesToHtml(mount, path);
    }
    throw new ApiError(400, `Format "${format}" is not supported for ${path.mimeType}`);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/export/export-document.ts
git commit -m "feat: wire slides export (HTML/PDF) into export dispatcher"
```

---

### Task 8: Quick preview

**Files:**
- Create: `apps/api/src/lib/preview/eigenslides-preview.ts`
- Modify: `apps/api/src/lib/preview/preview-cache.ts`
- Modify: `packages/lib/src/constants/preview.ts`

- [ ] **Step 1: Add `'eigenslides'` to `TextPreviewMode` and detection**

In `packages/lib/src/constants/preview.ts`:

Change the type (line 89):
```typescript
export type TextPreviewMode = 'markdown' | 'plaintext' | 'code' | 'eigendoc' | 'eigenslides';
```

Add `'application/eigenslides'` to `EIGEN_COLLAB_MIMES` (line 91):
```typescript
const EIGEN_COLLAB_MIMES = new Set(['application/eigendoc', 'application/eigenslides']);
```

Update `getTextPreviewMode` (line 97-105) to return the specific mode per mime:
```typescript
export function getTextPreviewMode(mimeType: string, fileName: string): TextPreviewMode | null {
    if (mimeType === 'application/eigendoc') return 'eigendoc';
    if (mimeType === 'application/eigenslides') return 'eigenslides';
    const ext = getExtension(fileName);
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (CODE_MIMES.some((prefix) => mimeType.startsWith(prefix))) return 'code';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return null;
}
```

- [ ] **Step 2: Create `eigenslides-preview.ts`**

```typescript
// apps/api/src/lib/preview/eigenslides-preview.ts
import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { loadSlidesContent } from '../export/slides/content';
import { renderSlideHtml, responsiveSizeUnit } from '../export/slides/render';
import type { Mount } from '../mount';

export async function generateEigenslidesPreview(mount: Mount, drivePath: DrivePath, baseUrl = ''): Promise<string> {
    const content = await loadSlidesContent(mount, drivePath);
    if (!content) return '';

    const { deck, mediaByName } = content;

    const resolveImgSrc = (mediaName: string): string | null => {
        const file = mediaByName.get(mediaName);
        if (!file) return null;
        return `${baseUrl}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.pathId}/embed/${encodeURIComponent(file.name)}`;
    };

    const slidesHtml = deck.slideOrder
        .map((slideId) => {
            const slide = deck.slides[slideId];
            if (!slide) return '';
            const objects = slide.objectIds.map((id) => deck.objects[id]).filter(Boolean);
            return renderSlideHtml(slide, objects, responsiveSizeUnit, resolveImgSrc);
        })
        .filter(Boolean)
        .join('<div style="height:1rem"></div>');

    return DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
}
```

- [ ] **Step 3: Update `preview-cache.ts` — add eigenslides branch**

In `apps/api/src/lib/preview/preview-cache.ts`:

Add to the imports at the top of the file:
```typescript
import { DRIVE_MIME_SLIDES } from '@workspace/lib/types/drive';
```

In the `getCollabPreviewData` function, add this block after the `if (mime === DRIVE_MIME_DOC) { ... }` block (before the `return null;` at end):

```typescript
    if (mime === DRIVE_MIME_SLIDES) {
        const cacheFile = path.join(mount.previewsDir, getTextCacheKey(drivePath.id, drivePath.updatedAt));

        if (fs.existsSync(cacheFile)) {
            return JSON.parse(await Bun.file(cacheFile).text()) as TextPreviewResult;
        }

        try {
            const { generateEigenslidesPreview } = await import('./eigenslides-preview');
            const body = await generateEigenslidesPreview(mount, drivePath, baseUrl);
            if (!body) return null;
            const result: TextPreviewResult = { body, mode: 'eigenslides' };
            await Bun.write(cacheFile, JSON.stringify(result));
            return result;
        } catch (err) {
            console.error(`[preview] Failed to generate eigenslides preview for ${drivePath.id}:`, err);
            return null;
        }
    }
```

Note: dynamic `await import('./eigenslides-preview')` — same pattern as eigendoc preview to avoid loading DOM-heavy deps at startup (`--splitting` build flag).

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/constants/preview.ts apps/api/src/lib/preview/eigenslides-preview.ts apps/api/src/lib/preview/preview-cache.ts
git commit -m "feat: add eigenslides quick preview with cache integration"
```

---

### Task 9: Frontend preview display

**Files:**
- Modify: `packages/ui/src/components/layout/drive/file-preview.tsx`

- [ ] **Step 1: Add eigenslides rendering to `TextPreviewContent`**

In `packages/ui/src/components/layout/drive/file-preview.tsx`, update the `TextPreviewContent` component (around line 176-189). Replace the return statement with:

```tsx
    return (
        <div className="w-[80vw] h-[calc(100vh-7rem)] overflow-auto rounded bg-background">
            {data.mode === 'eigendoc' ? (
                <div className="p-[2cm] w-[210mm] mx-auto">
                    <div className="eigen-prose tiptap" dangerouslySetInnerHTML={{ __html: data.body }} />
                </div>
            ) : data.mode === 'eigenslides' ? (
                <div className="p-8 flex flex-col items-center gap-4 bg-muted/50 min-h-full">
                    <div
                        className="w-full max-w-[960px] [&>.slide]:w-full [&>.slide]:rounded [&>.slide]:shadow-md"
                        dangerouslySetInnerHTML={{ __html: data.body }}
                    />
                </div>
            ) : (
                <div
                    className="eigen-prose p-8 max-w-[52rem] mx-auto"
                    dangerouslySetInnerHTML={{ __html: data.body }}
                />
            )}
        </div>
    );
```

Note: All HTML content rendered here is sanitized server-side with `DOMPurify.sanitize()` in the preview generators. The `[&>.slide]` selector targets the `.slide` divs produced by `renderSlideHtml`. Each slide gets `container-type: size` from its inline styles, so `cqh`/`cqw` font sizes scale correctly.

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/layout/drive/file-preview.tsx
git commit -m "feat: add eigenslides preview rendering in Drive file preview"
```

---

### Task 10: Frontend export integration

**Files:**
- Modify: `packages/ui/src/components/layout/toolbar/file-menu.tsx`
- Modify: `apps/slides/src/components/slides/toolbar.tsx`
- Modify: `packages/ui/src/components/layout/drive/drive-table.tsx`

- [ ] **Step 1: Add `exportFormats` prop to `FileMenu`**

In `packages/ui/src/components/layout/toolbar/file-menu.tsx`:

Add `exportFormats` to the props type (line 31):
```typescript
    onExport?: (format: string) => void;
    exportFormats?: string[];
```

Add `exportFormats` to the destructuring (line 42):
```typescript
    onExport,
    exportFormats,
```

Replace the hardcoded format list (lines 95-99) with the prop:
```tsx
                            <DropdownMenuSubContent>
                                {(exportFormats ?? ['docx', 'pdf', 'html']).map((format) => (
                                    <DropdownMenuItem key={format} onClick={() => onExport(format)}>
                                        Export as {format.toUpperCase()}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
```

- [ ] **Step 2: Add export to slides toolbar**

In `apps/slides/src/components/slides/toolbar.tsx`:

Add import:
```typescript
import { useExportDocument } from '@workspace/lib/drive';
```

Inside the `Toolbar` component body, add:
```typescript
    const { exportDocument } = useExportDocument();
    const handleExport = (format: string) => exportDocument(path.ownerId, path.mountId, path.id, format);
```

Update the `FileMenu` usage (around line 69) to include `onExport` and `exportFormats`:
```tsx
                <FileMenu
                    path={path}
                    canWrite={canWrite}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onRestore={onRestore}
                    onExport={handleExport}
                    exportFormats={['pdf', 'html']}
                    createLabel="New slides"
                    CreateDialog={DriveCreateSlides}
                />
```

- [ ] **Step 3: Add slides to Drive context menu export**

In `packages/ui/src/components/layout/drive/drive-table.tsx`, update the export condition (around line 323). Replace `contextMenu.item?.type === 'doc'` with a check that includes slides, and use per-type format lists:

```tsx
                {isSingleSelect && (contextMenu.item?.type === 'doc' || contextMenu.item?.type === 'slides') && onExport && (
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <FileDown className="h-4 w-4 mr-2" />
                            Export
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            {(contextMenu.item?.type === 'doc'
                                ? ['docx', 'pdf', 'html']
                                : ['pdf', 'html']
                            ).map((format) => (
                                <DropdownMenuItem
                                    key={format}
                                    onClick={() => {
                                        onExport(contextMenu.item!, format);
                                        contextMenu.close();
                                    }}
                                >
                                    Export as {format.toUpperCase()}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                )}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Run full check**

Run: `bun run check`
Expected: Lint, typecheck, and tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/slides/src/components/slides/toolbar.tsx packages/ui/src/components/layout/toolbar/file-menu.tsx packages/ui/src/components/layout/drive/drive-table.tsx
git commit -m "feat: add slides export menu to toolbar and Drive context menu"
```

---

### Task 11: Update docs

**Files:**
- Modify: `docs/PREVIEWS.md`
- Modify: `docs/EXPORT.md`
- Modify: `docs/SLIDES.md`

- [ ] **Step 1: Update PREVIEWS.md**

Add `eigenslides` to the text preview modes table:

| Mode          | Rendering                                       |
|---------------|-------------------------------------------------|
| `eigenslides` | Server-side HTML: positioned divs with container query sizing |

Add `eigenslides-preview.ts` to the files table:

| `apps/api/src/lib/preview/eigenslides-preview.ts` | Slides Yjs → positioned HTML divs |

In the "Eigen Native Types" future section, mark eigenslides as **Done**.

- [ ] **Step 2: Update EXPORT.md**

Add a "Slides Export" section after the existing eigendoc content:

Document: supports `html` and `pdf` formats. HTML uses container queries (`cqh`/`cqw`) for responsive font sizing. PDF uses fixed pixel values computed for the WeasyPrint page (254mm x 142.875mm landscape). Shared font embedding via `export/fonts.ts`. File structure: `export/slides/{content,render,html,pdf}.ts`.

- [ ] **Step 3: Update SLIDES.md**

Add an "Export & Preview" section:

- HTML and PDF export via File menu and Drive context menu
- Quick preview in Drive file preview overlay (all slides, scrollable, with spacing)
- Shared render functions in `apps/api/src/lib/export/slides/render.ts`
- `SizeUnit` abstraction: `responsiveSizeUnit` for browser, `fixedSizeUnit` for PDF

- [ ] **Step 4: Commit**

```bash
git add docs/PREVIEWS.md docs/EXPORT.md docs/SLIDES.md
git commit -m "docs: update PREVIEWS, EXPORT, and SLIDES for eigenslides export/preview"
```
