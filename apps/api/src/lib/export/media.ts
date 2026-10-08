import type { DrivePath } from '@workspace/lib/types/drive';
import { listDocumentMedia } from '../document/media';
import {
    DOCX_IMAGE_MAX_SIZE,
    type ExportMedia,
    type ExportTransformJob,
    toTransferableBuffer,
} from '../document/transform/protocol';
import type { Mount } from '../mount';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { getScreenPreview, isScreenPreviewRedirect } from '../preview/preview-cache';
import { SVG_INLINE_MAX_BYTES } from '../preview/svg-media-inline';
import { generateImagePreview } from '../shared/thumbnails';

// Main-thread media preparation for doc/slides exports: the screen-res preview of
// every media child, as standalone buffers the Worker takes ownership of (an SVG's
// sanitizing, base64 and the data: URIs happen there). All Mount I/O — and the globally capped thumbnail
// path behind getScreenPreview — stays here: a document Worker never receives a Mount
// and never spawns thumbnail Workers. A docx takes PNG or JPEG from the source file
// instead, since Word for the web and Google Docs show no WebP, with the thumbnail
// Worker's width and height for its extent.
export async function collectExportMedia(
    mount: Mount,
    drivePath: DrivePath,
    format: ExportTransformJob['format'],
    signal?: AbortSignal,
): Promise<ExportMedia[]> {
    const media = await listDocumentMedia(mount, drivePath);
    if (format !== 'docx') {
        const prepared = await Promise.all([...media].map(([name, file]) => prepareMedia(mount, name, file)));
        return prepared.filter((item) => item !== null);
    }
    // A docx re-encodes every image, uncached, on the thumbnail semaphore uploads and previews share: one at a time, so
    // one export holds at most one of its slots, and none once the client is gone (the runner then cancels the job).
    const prepared: ExportMedia[] = [];
    for (const [name, file] of media) {
        if (signal?.aborted) break;
        const item = await prepareDocxMedia(mount, name, file);
        if (item) prepared.push(item);
    }
    return prepared;
}

async function prepareMedia(mount: Mount, name: string, file: DrivePath): Promise<ExportMedia | null> {
    // Empty embedUrl: only the redirect branch reads it, and the next line drops redirects.
    const result = await getScreenPreview(mount, file, '');
    if (result?.type !== 'image') return null;
    // The preview Buffer can be a view over a larger pool, and a transfer hands over the WHOLE backing buffer — copy
    // into an exact standalone one first. An SVG is the file's own bytes, its siblings inlined: the transform Worker
    // sanitizes them (sanitizeExportMedia), seconds of jsdom for a big drawing.
    return { name, contentType: result.contentType, data: toTransferableBuffer(result.data) };
}

// Lossless codings, which PNG keeps pixel for pixel. Every other type takes JPEG, a photo's size; one with alpha
// retries as PNG.
const PNG_SOURCES = new Set(['image/png', 'image/gif']);

// How far into a WebP the chunk walk reads.
const WEBP_SCAN_BYTES = 64 * 1024;

async function prepareDocxMedia(mount: Mount, name: string, file: DrivePath): Promise<ExportMedia | null> {
    const mime = file.mimeType || '';
    if (mime === 'image/svg+xml') {
        const item = await prepareMedia(mount, name, file);
        // The Worker also decodes it for the PNG fallback, and the inliner caps only what it builds.
        return item && item.data.byteLength <= SVG_INLINE_MAX_BYTES ? item : null;
    }
    // What getScreenPreview shows as an image, and nothing else.
    if (isScreenPreviewRedirect(mime) || !isExiftoolCandidate(mime, file.name)) return null;
    const source = await mount.readFile(file.id);
    if (!source) return null;
    let format: 'png' | 'jpeg' = PNG_SOURCES.has(mime) ? 'png' : 'jpeg';
    // A WebP's image chunk names its coding, which the thumbnail Worker doesn't report: VP8L is lossless; VP8 is lossy.
    // An ICC profile, EXIF or alpha puts a VP8X header and other chunks first, so the walk reads past them.
    const bytes = mime === 'image/webp' ? await mount.readBytes(file.id, WEBP_SCAN_BYTES) : null;
    const webp = bytes && Buffer.from(bytes);
    for (let at = 12; webp && at + 8 <= webp.byteLength; ) {
        const chunk = webp.toString('latin1', at, at + 4);
        if (chunk === 'VP8L') format = 'png';
        if (chunk === 'VP8L' || chunk === 'VP8 ') break;
        const size = webp.readUInt32LE(at + 4);
        at += 8 + size + (size & 1);
    }
    // From the source, never the lossy WebP preview; sharp's re-encode drops the EXIF, GPS included.
    const encode = (format: 'png' | 'jpeg') =>
        generateImagePreview(source, mime, file.name, '', file.id, { format, maxSize: DOCX_IMAGE_MAX_SIZE });
    let result = await encode(format);
    // JPEG has no alpha: a source that holds one (a VP8X WebP, an AVIF, a PNG stored as JPEG) takes PNG.
    if (result?.hasAlpha && format === 'jpeg') {
        format = 'png';
        result = await encode(format);
    }
    if (!result) return null;
    const { data, width, height } = result;
    return { name, contentType: `image/${format}`, data: toTransferableBuffer(data), width, height };
}
