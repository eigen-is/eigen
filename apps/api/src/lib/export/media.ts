import type { DrivePath } from '@workspace/lib/types/drive';
import { listDocumentMedia } from '../document/media';
import { type ExportMedia, type ExportTransformJob, toTransferableBuffer } from '../document/transform/protocol';
import type { Mount } from '../mount';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { getScreenPreview } from '../preview/preview-cache';
import { generateImagePreview } from '../shared/thumbnails';
import { sanitizeSvgMedia } from './sanitize';

// Main-thread media preparation for doc/slides exports: the screen-res preview of
// every media child, as standalone buffers the Worker takes ownership of (base64 and
// the data: URIs are built there). All Mount I/O — and the globally capped thumbnail
// path behind getScreenPreview — stays here: a document Worker never receives a Mount
// and never spawns thumbnail Workers. A docx takes PNG or JPEG from the source file
// instead, since Word for the web and Google Docs show no WebP, with the thumbnail
// Worker's width and height for its extent.
export async function collectExportMedia(
    mount: Mount,
    drivePath: DrivePath,
    format: ExportTransformJob['format'],
): Promise<ExportMedia[]> {
    const media = await listDocumentMedia(mount, drivePath);
    const prepared = await Promise.all([...media].map(([name, file]) => prepareMedia(mount, name, file, format)));
    return prepared.filter((item) => item !== null);
}

// The screen preview's largest side.
const DOCX_MAX_SIZE = 2560;

async function prepareMedia(
    mount: Mount,
    name: string,
    file: DrivePath,
    format: ExportTransformJob['format'],
): Promise<ExportMedia | null> {
    const mime = file.mimeType || '';
    if (format === 'docx' && mime !== 'image/svg+xml') {
        // getScreenPreview's image rule: video, audio and PDF media show no image.
        if (!isExiftoolCandidate(mime, file.name)) return null;
        const source = await mount.readFile(file.id);
        if (!source) return null;
        // From the source, never the lossy WebP preview; sharp's re-encode drops the EXIF, GPS included.
        const lossless = mime === 'image/png' || mime === 'image/gif' || (await isLosslessWebp(mount, file));
        const result = await generateImagePreview(source, mime, file.name, '', file.id, {
            format: lossless ? 'png' : 'jpeg',
            maxSize: DOCX_MAX_SIZE,
        });
        if (!result) return null;
        const { data, width, height } = result;
        const contentType = lossless ? 'image/png' : 'image/jpeg';
        return { name, contentType, data: toTransferableBuffer(data), width, height };
    }

    // Empty embedUrl: only the redirect branch reads it, and the next line drops redirects.
    const result = await getScreenPreview(mount, file, '');
    if (result?.type !== 'image') return null;
    // The preview Buffer can be a view over a larger pool, and a transfer hands over
    // the WHOLE backing buffer — copy into an exact standalone one first.
    if (result.contentType !== 'image/svg+xml') {
        return { name, contentType: result.contentType, data: toTransferableBuffer(result.data) };
    }
    // SVG media is served as-is (raw user bytes, an uploaded or pasted drawing). Embedded as a data:
    // URI it still reaches WeasyPrint's fetcher — a nested `<image href>` is the same SSRF the
    // assembled document closes in sanitizeExportHtml — so it gets the same data-only pass here.
    const svg = Buffer.from(sanitizeSvgMedia(result.data.toString('utf8')));
    if (format !== 'docx') return { name, contentType: result.contentType, data: toTransferableBuffer(svg) };
    // The PNG every reader but Word draws, from the inlined SVG at its own size.
    const fallback = await generateImagePreview(svg, result.contentType, file.name, '', file.id, {
        format: 'png',
        maxSize: DOCX_MAX_SIZE,
    });
    if (!fallback) return null;
    return {
        name,
        contentType: result.contentType,
        data: toTransferableBuffer(svg),
        png: toTransferableBuffer(fallback.data),
        width: fallback.width,
        height: fallback.height,
    };
}

// A WebP's first chunk names its coding: VP8L is lossless; VP8 and VP8X take the photo's JPEG (R31).
async function isLosslessWebp(mount: Mount, file: DrivePath): Promise<boolean> {
    if (file.mimeType !== 'image/webp') return false;
    const header = await mount.readBytes(file.id, 16);
    return header !== null && Buffer.from(header).toString('latin1', 12, 16) === 'VP8L';
}
