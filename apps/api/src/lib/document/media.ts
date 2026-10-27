// The media of eigen documents: the main thread lists a document's media folder and prepares its URLs or bytes, and
// the transform process turns the bytes into the data: URIs the export renders. The transform process loads this
// module, so it imports nothing heavy, such as the preview cache and the sheet engine behind it.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../mount';
import type { ExportMedia, TransformMedia } from './transform/protocol';

export async function listDocumentMedia(mount: Mount, drivePath: DrivePath): Promise<Map<string, DrivePath>> {
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const children = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    return new Map(children.map((file) => [file.name, file]));
}

// The media names a document read for an export holds: every document kind names a file in `media/` by a `mediaName`
// field (docs/MEDIA-REFERENCES.md), wherever it sits in the tree.
export function mediaNamesIn(tree: unknown): Set<string> {
    const names = new Set<string>();
    const stack = [tree];
    while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        for (const [key, child] of Object.entries(value)) {
            if (key === 'mediaName' && typeof child === 'string' && child) names.add(child);
            else stack.push(child);
        }
    }
    return names;
}

// Public-facing API URL for preview HTML embedded in exported documents. The frontend
// convention switched to relative VITE_API_HOST (e.g. "/eigen"), so resolve against the
// absolute API_URL here — these <img src=...> URLs end up in HTML that may be rendered
// in contexts (PDF export, mail) where there is no current origin to splice in.
function resolvePublicApiUrl(): string {
    const apiHost = process.env['VITE_API_HOST'] || '';
    const apiUrl = process.env['API_URL'] || 'http://localhost:8000';
    if (/^https?:\/\//.test(apiHost)) return apiHost;
    if (!apiHost) return apiUrl;
    return `${apiUrl}${apiHost.startsWith('/') ? apiHost : `/${apiHost}`}`;
}
const PUBLIC_API_URL = resolvePublicApiUrl();

// Preview media prep: the name → embed-URL map a preview transform carries. Previews
// reference media by URL, so no bytes cross into the transform process. A Map, so a
// mediaName that is document data (`constructor`, `toString`) can never resolve to
// something off Object.prototype.
export async function buildPreviewUrlMap(mount: Mount, drivePath: DrivePath): Promise<Map<string, string>> {
    const media = await listDocumentMedia(mount, drivePath);
    return new Map(
        [...media].map(([name, file]) => [
            name,
            `${PUBLIC_API_URL}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.id}/preview`,
        ]),
    );
}

// The transform process's side of export media: the transferred buffers become the data: URIs the export renderers
// embed.
export function toDataUriMap(media: TransformMedia[]): Map<string, string> {
    return new Map(
        media.map((item) => [
            item.name,
            `data:${item.contentType};base64,${Buffer.from(item.data).toString('base64')}`,
        ]),
    );
}

// SVG media arrives as the file's own bytes. The sanitizer loads only for one, so an xlsx export never evaluates jsdom.
export async function sanitizeMedia(media: ExportMedia[]): Promise<ExportMedia[]> {
    if (!media.some((item) => item.contentType === 'image/svg+xml')) return media;
    const { sanitizeExportMedia } = await import('../export/sanitize');
    return sanitizeExportMedia(media);
}
