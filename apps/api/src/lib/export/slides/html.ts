import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { getFontCSS } from '../fonts';
import { buildDataUriMap, escapeHtml } from '../media';
import { loadSlidesContent } from './content';
import { type ImgSrcResolver, renderDeckHtml, responsiveSizeUnit, stripSlidesExtension } from './render';

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
    if (!content) return wrapInDocument(stripSlidesExtension(drivePath.name), '');

    const { deck, mediaByName } = content;
    const dataUriMap = await buildDataUriMap(mount, mediaByName);
    const resolveImgSrc: ImgSrcResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;
    const slidesHtml = renderDeckHtml(deck, responsiveSizeUnit, resolveImgSrc);

    return wrapInDocument(stripSlidesExtension(drivePath.name), slidesHtml);
}

function wrapInDocument(title: string, slidesHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${SLIDES_CSS}</style>
</head>
<body>
    <div class="deck">
        ${slidesHtml}
    </div>
</body>
</html>`;
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
