import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { listDocumentMedia } from '../document/media';
import { type ExportMedia, type ExportTransformJob, toTransferableBuffer } from '../document/transform/protocol';
import type { Mount } from '../mount';
import { MAX_DECOMPRESSED_BYTES } from '../ooxml/zip';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { getScreenPreview, isScreenPreviewRedirect } from '../preview/preview-cache';
import { generateImagePreview } from '../shared/thumbnails';
import { encodeOfficeImage, WEBP_SCAN_BYTES } from './office-image';

// The formats an Office reader opens, which take a PNG or JPEG from the source file.
const OFFICE_FORMATS = new Set<ExportTransformJob['format']>(['docx', 'pptx', 'xlsx']);

const TOO_LARGE = "This document's images are too large to export";

// Main-thread media preparation for an export: the screen-res preview of each media file the
// document names, as exact buffers the transform process gets a copy of (an SVG's sanitizing, base64
// and the data: URIs happen there). All Mount I/O — and the globally capped thumbnail path behind
// getScreenPreview — stays here: the transform never receives a Mount and never spawns thumbnail
// Workers. A docx, pptx or xlsx takes PNG or JPEG from the source file instead, since Office for the web and
// Google's editors show no WebP, with the thumbnail Worker's width and height for its extent.
//
// The bytes are held in the API's heap and copied over IPC, so what is sent is held to
// MAX_DECOMPRESSED_BYTES, an import source's cap, as it is prepared. An SVG travels as its own bytes,
// so the SVGs' declared sizes are charged before any read; a raster's preview is at most 2560 px,
// and an Office format's source is read whole, one at a time, so only a source past the cap alone is
// refused unread. One file at a time, so a docx holds at most one of the thumbnail slots uploads and
// previews share, and none once the job ends.
export async function collectExportMedia(
    mount: Mount,
    drivePath: DrivePath,
    format: ExportTransformJob['format'],
    names: string[],
    signal: AbortSignal,
): Promise<ExportMedia[]> {
    const wanted = new Set(names);
    const named = [...(await listDocumentMedia(mount, drivePath))].filter(([name]) => wanted.has(name));
    const svgBytes = named.reduce((sum, [, file]) => sum + (file.mimeType === 'image/svg+xml' ? file.size : 0), 0);
    if (svgBytes > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, TOO_LARGE);
    const prepare = OFFICE_FORMATS.has(format) ? prepareOfficeMedia : prepareMedia;
    const prepared: ExportMedia[] = [];
    let held = 0;
    for (const [name, file] of named) {
        if (signal.aborted) break;
        const item = await prepare(mount, name, file);
        if (!item) continue;
        held += item.data.byteLength;
        if (held > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, TOO_LARGE);
        prepared.push(item);
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
    if (file.size > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, TOO_LARGE);
    const source = await mount.readFile(file.id);
    if (!source) return null;
    // From the source, never the lossy WebP preview.
    const webp = mime === 'image/webp' ? await mount.readBytes(file.id, WEBP_SCAN_BYTES) : null;
    return encodeOfficeImage(name, mime, webp && Buffer.from(webp), (options) =>
        generateImagePreview(source, mime, file.name, '', file.id, options),
    );
}
