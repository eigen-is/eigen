import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import { escapeHtml } from '../doc/render';
import type { ExportResult } from '../export-document';
import { getFontCSS } from '../fonts';
import { buildDataUriMap } from '../media';
import { htmlToPdf } from '../weasyprint';
import { loadSlidesContent } from './content';
import { fixedSizeUnit, type ImgSrcResolver, renderDeckHtml, stripSlidesExtension } from './render';

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
    const dataUriMap = await buildDataUriMap(mount, mediaByName);
    const resolveImgSrc: ImgSrcResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;
    const sizeUnit = fixedSizeUnit(PAGE_WIDTH_PX, PAGE_HEIGHT_PX);
    const slidesHtml = renderDeckHtml(deck, sizeUnit, resolveImgSrc, {
        fillPage: true,
        pageWidthPx: PAGE_WIDTH_PX,
        pageHeightPx: PAGE_HEIGHT_PX,
    });

    const html = wrapInPdfDocument(title, slidesHtml);
    return { data: await htmlToPdf(html), contentType: 'application/pdf', fileName: `${title}.pdf` };
}

function wrapInPdfDocument(title: string, slidesHtml: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${PDF_CSS}</style>
</head>
<body>
    ${slidesHtml}
</body>
</html>`;
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
    page-break-after: always;
}

.slide:last-child {
    page-break-after: auto;
}
`;
