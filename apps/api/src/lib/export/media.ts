import type { DrivePath } from '@workspace/lib/types/drive';
import { listDocumentMedia } from '../document/media';
import { type TransformMedia, toTransferableBuffer } from '../document/transform/protocol';
import type { Mount } from '../mount';
import { getScreenPreview } from '../preview/preview-cache';
import { sanitizeExportHtml } from './sanitize';

// Main-thread media preparation for doc/slides exports: the screen-res preview of
// every media child, as standalone buffers the Worker takes ownership of (base64 and
// the data: URIs are built there). All Mount I/O — and the globally capped thumbnail
// path behind getScreenPreview — stays here: a document Worker never receives a Mount
// and never spawns thumbnail Workers.
export async function collectExportMedia(mount: Mount, drivePath: DrivePath): Promise<TransformMedia[]> {
    const media = await listDocumentMedia(mount, drivePath);
    const prepared = await Promise.all([...media].map(([name, file]) => prepareMedia(mount, name, file)));
    return prepared.filter((item) => item !== null);
}

async function prepareMedia(mount: Mount, name: string, file: DrivePath): Promise<TransformMedia | null> {
    // Empty embedUrl: only the redirect branch reads it, and the next line drops redirects.
    const result = await getScreenPreview(mount, file, '');
    if (result?.type !== 'image') return null;
    // SVG media is served as-is (raw user bytes, an uploaded or pasted drawing). Embedded as a data:
    // URI it still reaches WeasyPrint's fetcher — a nested `<image href>` is the same SSRF the
    // assembled document closes in sanitizeExportHtml — so it gets the same data-only pass here.
    const data =
        result.contentType === 'image/svg+xml'
            ? Buffer.from(sanitizeExportHtml(result.data.toString('utf8')))
            : result.data;
    // The preview Buffer can be a view over a larger pool, and a transfer hands over
    // the WHOLE backing buffer — copy into an exact standalone one first.
    return { name, contentType: result.contentType, data: toTransferableBuffer(data) };
}
