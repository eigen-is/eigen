// The images a doc holds as a pasted data: src rather than as a media file. Every doc export draws a raster re-encoded,
// the docx and the HTML and PDF alike, and draws nothing for a data: src that is not base64 unless it is an SVG, so a
// photo's EXIF, GPS included, never leaves in a download. An SVG is sanitized, not re-encoded: a raster it embeds as an
// <image href="data:…"> keeps its EXIF. It runs in the transform process, as the main thread never reads the doc to
// prepare them with the media files.

import type { JSONContent } from '@tiptap/core';
import type { FigureAttrs } from '@workspace/lib/docs/eigendoc';
import { readFigureAttrs } from '@workspace/lib/docs/eigendoc';
import { sanitizeMedia } from '../../document/media';
import type { ExportMedia } from '../../document/transform/protocol';
import { toTransferableBuffer } from '../../document/transform/protocol';
import { splitDataUri } from '../../shared/data-uri';
import { encodeOfficeImage } from '../office-image';

// The media item a figure draws: its media file, else a pasted base64 data: src, which pastedFigureMedia encodes under
// that src. A media name holds no `/`, so no src can equal one.
export function figureMediaKey({ mediaName, src }: FigureAttrs): string | null {
    return mediaName ?? (src && splitDataUri(src) ? src : null);
}

// Each pasted src decoded once, through the encode a media file takes for an Office file: a PNG or a JPEG at most
// 2560 px, with no EXIF. An animated GIF draws its first frame. An SVG goes through the sanitizer the main thread's
// media took. A src that no image decodes from is left out, so its figure draws nothing.
export async function pastedFigureMedia(roots: JSONContent[]): Promise<ExportMedia[]> {
    const pasted = new Map<string, { mediaType: string | null; base64: string }>();
    const visit = (node: JSONContent) => {
        if (node.type === 'figure') {
            const attrs = readFigureAttrs(node.attrs ?? {});
            const key = figureMediaKey(attrs);
            const split = key && key === attrs.src ? splitDataUri(key) : null;
            if (key && split) pasted.set(key, split);
        }
        for (const child of node.content ?? []) visit(child);
    };
    for (const root of roots) visit(root);
    if (pasted.size === 0) return [];
    const { sharpResize } = await import('../../shared/sharp-resize');
    const media: ExportMedia[] = [];
    for (const [src, { mediaType, base64 }] of pasted) {
        const data = Buffer.from(base64, 'base64');
        if (mediaType === 'image/svg+xml') {
            media.push({ name: src, contentType: mediaType, data: toTransferableBuffer(data) });
            continue;
        }
        const item = await encodeOfficeImage(src, mediaType ?? '', data, (options) => sharpResize(data, options));
        if (item) media.push(item);
    }
    return sanitizeMedia(media);
}
