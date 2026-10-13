import type { FigureAttrs } from '@workspace/lib/docs/eigendoc';
import { DOCX_IMAGE_MAX_SIZE, type ExportMedia, toTransferableBuffer } from '../../document/transform/protocol';
import { splitDataUri } from '../../shared/data-uri';
import type { ImageResult, WorkerInput } from '../../shared/thumbnail-worker';

// Lossless codings, which PNG keeps pixel for pixel. Every other type takes JPEG, a photo's size; one with alpha
// retries as PNG.
const PNG_SOURCES = new Set(['image/png', 'image/gif']);

// How far into a WebP the chunk walk reads.
export const WEBP_SCAN_BYTES = 64 * 1024;

// A docx image is a PNG or JPEG made from its source, since Word for the web and Google Docs show no WebP. `encode` is
// sharpResize, in the thumbnail Worker for a media file and in the transform Worker for a data: src; its re-encode
// drops the EXIF, GPS included. `webp` is the start of a WebP source, at least WEBP_SCAN_BYTES of it.
export async function encodeDocxImage(
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
        encode({ format, maxSize: DOCX_IMAGE_MAX_SIZE, quality: 80, fit: 'inside' });
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

// The media item a figure draws in a docx: its media file, else a pasted data: src, which the transform Worker encodes
// under that src. A media name holds no `/`, so the two never meet.
export function figureMediaKey({ mediaName, src }: FigureAttrs): string | null {
    return mediaName ?? (src && splitDataUri(src) ? src : null);
}
