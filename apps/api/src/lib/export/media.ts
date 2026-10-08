import type { DrivePath } from '@workspace/lib/types/drive';
import { listDocumentMedia } from '../document/media';
import { type ExportMedia, type ExportTransformJob, toTransferableBuffer } from '../document/transform/protocol';
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
        const prepared = await Promise.all([...media].map(([name, file]) => prepareMedia(mount, name, file, false)));
        return prepared.filter((item) => item !== null);
    }
    // A docx re-encodes every image, uncached, on the thumbnail semaphore uploads and previews share: one at a time, so
    // one export holds at most one of its slots, and none once the client is gone (the runner then cancels the job).
    const prepared: ExportMedia[] = [];
    for (const [name, file] of media) {
        if (signal?.aborted) break;
        const item = await prepareMedia(mount, name, file, true);
        if (item) prepared.push(item);
    }
    return prepared;
}

// The screen preview's largest side.
const DOCX_MAX_SIZE = 2560;

async function prepareMedia(mount: Mount, name: string, file: DrivePath, docx: boolean): Promise<ExportMedia | null> {
    const mime = file.mimeType || '';
    if (docx && mime !== 'image/svg+xml') {
        // What getScreenPreview shows as an image, and nothing else.
        if (isScreenPreviewRedirect(mime) || !isExiftoolCandidate(mime, file.name)) return null;
        const source = await mount.readFile(file.id);
        if (!source) return null;
        // From the source, never the lossy WebP preview; sharp's re-encode drops the EXIF, GPS included.
        const encode = (format: 'png' | 'jpeg') =>
            generateImagePreview(source, mime, file.name, '', file.id, { format, maxSize: DOCX_MAX_SIZE });
        let format: 'png' | 'jpeg' = (await takesJpeg(mount, file, mime)) ? 'jpeg' : 'png';
        let result = await encode(format);
        // JPEG has no alpha: a photo's type that holds one anyway (a PNG stored as JPEG, a HEIF with alpha) takes PNG.
        if (result?.hasAlpha && format === 'jpeg') {
            format = 'png';
            result = await encode(format);
        }
        if (!result) return null;
        const { data, width, height } = result;
        return { name, contentType: `image/${format}`, data: workerBuffer(data), width, height };
    }

    // Empty embedUrl: only the redirect branch reads it, and the next line drops redirects.
    const result = await getScreenPreview(mount, file, '');
    if (result?.type !== 'image') return null;
    // The preview Buffer can be a view over a larger pool, and a transfer hands over
    // the WHOLE backing buffer — copy into an exact standalone one first.
    if (result.contentType !== 'image/svg+xml') {
        return { name, contentType: result.contentType, data: toTransferableBuffer(result.data) };
    }
    // The file's own bytes, its siblings inlined: the transform Worker sanitizes them (sanitizeExportMedia), seconds of
    // jsdom for a big drawing. The inliner caps only what it builds, so a drawing with nothing to inline gets its cap here.
    if (result.data.byteLength > SVG_INLINE_MAX_BYTES) return null;
    const data = toTransferableBuffer(result.data);
    if (!docx) return { name, contentType: result.contentType, data };
    // The PNG every reader but Word draws, at the SVG's own size. librsvg fetches no reference from a buffer, which has no
    // base URI, so the unsanitized bytes draw only what they inline.
    const fallback = await generateImagePreview(result.data, result.contentType, file.name, '', file.id, {
        format: 'png',
        maxSize: DOCX_MAX_SIZE,
    });
    if (!fallback) return null;
    return {
        name,
        contentType: result.contentType,
        data,
        png: workerBuffer(fallback.data),
        width: fallback.width,
        height: fallback.height,
    };
}

// Lossy codings, which JPEG keeps as they are. Every other type takes PNG, which keeps alpha and every pixel.
const JPEG_SOURCES = new Set(['image/jpeg', 'image/heic', 'image/heif']);

// A WebP's first chunk names its coding, which the thumbnail Worker doesn't report: only a plain lossy VP8 is a
// photo; VP8L is lossless and VP8X carries alpha, animation or ICC.
async function takesJpeg(mount: Mount, file: DrivePath, mime: string): Promise<boolean> {
    if (JPEG_SOURCES.has(mime)) return true;
    if (mime !== 'image/webp') return false;
    const header = await mount.readBytes(file.id, 16);
    return header !== null && Buffer.from(header).toString('latin1', 12, 16) === 'VP8 ';
}

// The thumbnail Worker's Buffer wraps exactly the ArrayBuffer it transferred back, so it is handed on uncopied.
function workerBuffer(data: Buffer): ArrayBuffer {
    const { buffer } = data;
    return buffer instanceof ArrayBuffer && buffer.byteLength === data.byteLength ? buffer : toTransferableBuffer(data);
}
