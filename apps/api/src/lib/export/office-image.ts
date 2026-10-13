import { type ExportMedia, toTransferableBuffer } from '../document/transform/protocol';
import { THUMBNAIL_TIMEOUT_SECONDS } from '../shared/thumbnail-timeout';
import type { ImageResult, WorkerInput } from '../shared/thumbnail-worker';

// An image in a docx or pptx: the media item, and for an SVG the PNG a reader without SVG draws. The PNG is drawn and
// read inside the transform process, so it never crosses the boundary on ExportMedia.
export type OfficeMedia = ExportMedia & { png?: ArrayBuffer };

// An Office image's largest side: the raster the main thread re-encodes and the PNG an SVG falls back to.
export const OFFICE_IMAGE_MAX_SIZE = 2560;

// The part extension of each type encodeOfficeImage writes, which an Office package embeds as is.
export const RASTER_EXTENSIONS = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
]);

// Lossless codings, which PNG keeps pixel for pixel. Every other type takes JPEG, a photo's size; one with alpha
// retries as PNG.
const PNG_SOURCES = new Set(['image/png', 'image/gif']);

// How far into a WebP the chunk walk reads.
export const WEBP_SCAN_BYTES = 64 * 1024;

// An Office image is a PNG or JPEG made from its source, since Word and PowerPoint for the web and Google Docs show no
// WebP. `encode` is sharpResize, in the thumbnail Worker for a media file and in the transform process for a data:
// src; its re-encode drops the EXIF, GPS included. `webp` is the start of a WebP source, at least WEBP_SCAN_BYTES of it.
export async function encodeOfficeImage(
    name: string,
    mime: string,
    webp: Buffer | null,
    encode: (options: WorkerInput['options']) => Promise<ImageResult | null>,
): Promise<ExportMedia | null> {
    let format: 'png' | 'jpeg' = PNG_SOURCES.has(mime) ? 'png' : 'jpeg';
    // A WebP's image chunk names its coding, which the thumbnail Worker doesn't report: VP8L is lossless; VP8 is lossy.
    // An ICC profile, EXIF or alpha puts a VP8X header and other chunks first, so the walk reads past them.
    const head = mime === 'image/webp' ? webp : null;
    for (let at = 12; head && at + 8 <= head.byteLength; ) {
        const chunk = head.toString('latin1', at, at + 4);
        if (chunk === 'VP8L') format = 'png';
        if (chunk === 'VP8L' || chunk === 'VP8 ') break;
        const size = head.readUInt32LE(at + 4);
        at += 8 + size + (size & 1);
    }
    const encodeAs = (format: 'png' | 'jpeg') =>
        encode({ format, maxSize: OFFICE_IMAGE_MAX_SIZE, quality: 80, fit: 'inside' });
    let result = await encodeAs(format);
    // JPEG has no alpha: a source that holds one (a VP8X WebP, an AVIF, a PNG stored as JPEG) takes PNG.
    if (result?.hasAlpha && format === 'jpeg') {
        format = 'png';
        result = await encodeAs(format);
    }
    if (!result) return null;
    const { data, width, height } = result;
    return { name, contentType: `image/${format}`, data: toTransferableBuffer(data), width, height };
}

// The PNG a reader without SVG draws, from the sanitized XML the svgBlip carries, so both draw one picture. One at a
// time, for one decode's memory; sharp loads only for an SVG.
export async function withSvgFallbacks(media: ExportMedia[]): Promise<OfficeMedia[]> {
    if (!media.some((item) => item.contentType === 'image/svg+xml')) return media;
    const { default: sharp } = await import('sharp');
    const prepared: OfficeMedia[] = [];
    for (const item of media) {
        if (item.contentType !== 'image/svg+xml') {
            prepared.push(item);
            continue;
        }
        try {
            const svg = Buffer.from(item.data);
            const image = sharp(svg);
            const { width = 0, height = 0 } = await image.metadata();
            const png = await image
                .resize(OFFICE_IMAGE_MAX_SIZE, OFFICE_IMAGE_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
                .png()
                .timeout({ seconds: THUMBNAIL_TIMEOUT_SECONDS })
                .toBuffer();
            prepared.push({ ...item, png: toTransferableBuffer(png), ...cssSize(svg, width, height) });
        } catch {
            // One librsvg can't read, or not in time, leaves the file; a docx keeps its caption.
        }
    }
    return prepared;
}

const PHYSICAL_LENGTH = /^\s*[\d.e+-]+\s*(in|cm|mm|pt|pc)\s*$/i;

// sharp reads an SVG's physical units at 72 dpi and CSS at 96, so a 4in drawing is 288 px to it and 384 in the HTML
// export. Scaled per side, read off the root's start tag; a side the root leaves out follows the other, as sharp
// derives it from the viewBox.
function cssSize(svg: Buffer, width: number, height: number): { width: number; height: number } {
    const root = svg.toString('utf8', 0, svg.indexOf('>') + 1);
    const scale = (value: string | undefined) =>
        value === undefined ? undefined : PHYSICAL_LENGTH.test(value) ? 96 / 72 : 1;
    const x = scale(root.match(/\swidth="([^"]*)"/)?.[1]);
    const y = scale(root.match(/\sheight="([^"]*)"/)?.[1]);
    return { width: width * (x ?? y ?? 1), height: height * (y ?? x ?? 1) };
}
