// An export's media, prepared on the main thread beside the Mount for the transform process, which has none: for the
// HTML download the screen preview of each media file the document names, and for every other format a PNG or JPEG
// made from the source of each raster. An SVG goes as its own bytes. What is sent is held to an import source's cap.

import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { listDocumentMedia } from '../document/media';
import type { ExportMedia, ExportTransformJob } from '../document/transform/protocol';
import { toTransferableBuffer } from '../document/transform/protocol';
import type { Mount } from '../mount';
import { MAX_DECOMPRESSED_BYTES } from '../ooxml/zip';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { getScreenPreview, isScreenPreviewRedirect } from '../preview/preview-cache';
import { generateImagePreview } from '../shared/thumbnails';
import { encodeExportImage, WEBP_SCAN_BYTES } from './export-image';

const TOO_LARGE = "This document's images are too large to export";

// The transform process gets exact buffers, and sanitizes an SVG and makes the data: URIs there. The HTML download
// takes the viewer's cached WebP, which a browser draws, an animated GIF still moving. The bytes are held in the API's
// heap and copied over IPC, so what is sent is held to MAX_DECOMPRESSED_BYTES as it is prepared. An SVG travels as its
// own bytes, so the SVGs' declared sizes are charged before any read. One file at a time, so an export holds at most
// one of the thumbnail slots uploads and previews share.
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
    const prepare = format === 'html' ? previewMedia : prepareMedia;
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

async function previewMedia(mount: Mount, name: string, file: DrivePath): Promise<ExportMedia | null> {
    // Empty embedUrl: only the redirect branch reads it, and the next line drops redirects.
    const result = await getScreenPreview(mount, file, '');
    if (result?.type !== 'image') return null;
    // The preview Buffer can be a view over a larger pool, and IPC serializes the WHOLE backing buffer, so it goes as
    // an exact copy. An SVG is the file's own bytes, its siblings inlined, which the transform process sanitizes
    // (sanitizeExportMedia).
    return { name, contentType: result.contentType, data: toTransferableBuffer(result.data) };
}

// A raster is made again from its source, never from the lossy WebP the viewer shows: Office for the web and Google's
// editors draw no WebP, and WeasyPrint embeds a JPEG as it is but decodes a WebP and writes it out as a PNG. The source
// is read whole, so one past the cap alone is left out unread, and the document counts it as an image it dropped.
async function prepareMedia(mount: Mount, name: string, file: DrivePath): Promise<ExportMedia | null> {
    const mime = file.mimeType || '';
    if (mime === 'image/svg+xml') return previewMedia(mount, name, file);
    // What the viewer shows as an image, and nothing else.
    if (isScreenPreviewRedirect(mime) || !isExiftoolCandidate(mime, file.name)) return null;
    if (file.size > MAX_DECOMPRESSED_BYTES) return null;
    const source = await mount.readFile(file.id);
    if (!source) return null;
    const webp = mime === 'image/webp' ? await mount.readBytes(file.id, WEBP_SCAN_BYTES) : null;
    return encodeExportImage(name, mime, webp && Buffer.from(webp), (options) =>
        generateImagePreview(source, mime, file.name, '', file.id, options),
    );
}
