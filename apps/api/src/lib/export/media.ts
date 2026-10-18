import type { DrivePath } from '@workspace/lib/types/drive';
import { listDocumentMedia } from '../document/media';
import { type ExportMedia, type ExportTransformJob, toTransferableBuffer } from '../document/transform/protocol';
import type { Mount } from '../mount';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { getScreenPreview, isScreenPreviewRedirect } from '../preview/preview-cache';
import { generateImagePreview } from '../shared/thumbnails';
import { encodeOfficeImage, WEBP_SCAN_BYTES } from './office-image';

// The formats an Office reader opens, which take a PNG or JPEG from the source file.
const OFFICE_FORMATS = new Set<ExportTransformJob['format']>(['docx', 'pptx']);

// Main-thread media preparation for doc/slides exports: the screen-res preview of
// every media child, as exact buffers the transform process gets a copy of (an SVG's
// sanitizing, base64 and the data: URIs happen there). All Mount I/O — and the globally capped thumbnail
// path behind getScreenPreview — stays here: the transform never receives a Mount
// and never spawns thumbnail Workers. A docx or pptx takes PNG or JPEG from the source file
// instead, since Word and PowerPoint for the web and Google Docs show no WebP, with the thumbnail
// Worker's width and height for its extent.
export async function collectExportMedia(
    mount: Mount,
    drivePath: DrivePath,
    format: ExportTransformJob['format'],
    signal?: AbortSignal,
): Promise<ExportMedia[]> {
    const media = await listDocumentMedia(mount, drivePath);
    if (!OFFICE_FORMATS.has(format)) {
        const prepared = await Promise.all([...media].map(([name, file]) => prepareMedia(mount, name, file)));
        return prepared.filter((item) => item !== null);
    }
    // An Office export re-encodes every image, uncached, on the thumbnail semaphore uploads and previews share: one at a
    // time, so one export holds at most one of its slots, and none once the client is gone (the runner then cancels the
    // job).
    const prepared: ExportMedia[] = [];
    for (const [name, file] of media) {
        if (signal?.aborted) break;
        const item = await prepareOfficeMedia(mount, name, file);
        if (item) prepared.push(item);
    }
    return prepared;
}

async function prepareMedia(mount: Mount, name: string, file: DrivePath): Promise<ExportMedia | null> {
    // Empty embedUrl: only the redirect branch reads it, and the next line drops redirects.
    const result = await getScreenPreview(mount, file, '');
    if (result?.type !== 'image') return null;
    // The preview Buffer can be a view over a larger pool, and IPC serializes the WHOLE backing buffer — copy into an
    // exact standalone one first. An SVG is the file's own bytes, its siblings inlined: the transform process
    // sanitizes them (sanitizeExportMedia), seconds of jsdom for a big drawing.
    return { name, contentType: result.contentType, data: toTransferableBuffer(result.data) };
}

async function prepareOfficeMedia(mount: Mount, name: string, file: DrivePath): Promise<ExportMedia | null> {
    const mime = file.mimeType || '';
    if (mime === 'image/svg+xml') return prepareMedia(mount, name, file);
    // What getScreenPreview shows as an image, and nothing else.
    if (isScreenPreviewRedirect(mime) || !isExiftoolCandidate(mime, file.name)) return null;
    const source = await mount.readFile(file.id);
    if (!source) return null;
    // From the source, never the lossy WebP preview.
    const webp = mime === 'image/webp' ? await mount.readBytes(file.id, WEBP_SCAN_BYTES) : null;
    return encodeOfficeImage(name, mime, webp && Buffer.from(webp), (options) =>
        generateImagePreview(source, mime, file.name, '', file.id, options),
    );
}
