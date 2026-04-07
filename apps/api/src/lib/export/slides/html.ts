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
