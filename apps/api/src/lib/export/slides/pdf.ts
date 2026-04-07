import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../doc/render';
import { getFontCSS } from '../fonts';
import { htmlToPdf } from '../weasyprint';
import { loadSlidesContent } from './content';
import { fixedSizeUnit, type ImgSrcResolver, renderSlideHtml, stripSlidesExtension } from './render';

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
