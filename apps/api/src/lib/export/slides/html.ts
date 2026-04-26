import { escapeHtml } from '@workspace/lib/html';
import type { DrivePath } from '@workspace/lib/types/drive';
// CSS embedded as string at build time by Bun's bundler — no runtime file resolution needed
import slideTextCSSRaw from '../../../../../../packages/ui/src/styles/slide-text.css' with { type: 'text' };
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { getFontCSS } from '../fonts';
import { buildDataUriMap } from '../media';
import { loadSlidesContent } from './content';
import {
    fixedSizeUnit,
    type ImgSrcResolver,
    renderDeckHtml,
    responsiveSizeUnit,
    type SizeUnit,
    stripSlidesExtension,
} from './render';

// 16:9 landscape page: 254mm x 142.875mm ~ 960 x 540 px at 96dpi
const PAGE_WIDTH_PX = 960;
const PAGE_HEIGHT_PX = 540;

export async function exportSlidesToHtml(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateSlidesExportHtml(mount, drivePath, 'html');
    return {
        data: Buffer.from(html, 'utf-8'),
        contentType: 'text/html; charset=utf-8',
        fileName: `${stripSlidesExtension(drivePath.name)}.html`,
    };
}

export async function generateSlidesExportHtml(
    mount: Mount,
    drivePath: DrivePath,
    mode: 'html' | 'pdf',
): Promise<string> {
    const title = stripSlidesExtension(drivePath.name);
    const content = await loadSlidesContent(mount, drivePath);
    if (!content) return wrapInDocument(title, '', mode);

    const { deck, mediaByName } = content;
    const dataUriMap = await buildDataUriMap(mount, mediaByName);
    const resolveImgSrc: ImgSrcResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;

    const isPdf = mode === 'pdf';
    const sizeUnit: SizeUnit = isPdf ? fixedSizeUnit(PAGE_WIDTH_PX, PAGE_HEIGHT_PX) : responsiveSizeUnit;
    const slideOptions = isPdf
        ? { fillPage: true, pageWidthPx: PAGE_WIDTH_PX, pageHeightPx: PAGE_HEIGHT_PX }
        : undefined;
    const slidesHtml = renderDeckHtml(deck, sizeUnit, resolveImgSrc, slideOptions);

    return wrapInDocument(title, slidesHtml, mode);
}

function wrapInDocument(title: string, slidesHtml: string, mode: 'html' | 'pdf'): string {
    const css = mode === 'pdf' ? PDF_CSS : SCREEN_CSS;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${css}${slideTextCSSRaw}</style>
</head>
<body>
    ${mode === 'html' ? `<div class="deck">${slidesHtml}</div>` : slidesHtml}
</body>
</html>`;
}

const SHARED_RESET = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { display: block; max-width: 100%; }
`;

const SCREEN_CSS = `${SHARED_RESET}
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

const PDF_CSS = `${SHARED_RESET}
@page {
    size: 254mm 142.875mm;
    margin: 0;
}

body {
    font-family: "Inter", system-ui, -apple-system, sans-serif;
    margin: 0;
    padding: 0;
}

.slide {
    page-break-after: always;
}

.slide:last-child {
    page-break-after: auto;
}
`;
