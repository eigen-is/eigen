// The media of eigen documents, the files in a document's media folder. It finds which of them a document's content
// names. On the main thread it lists the folder and prepares the URLs or the bytes a transform needs. In the transform
// process it turns those bytes into the data: URIs an export embeds. The transform process loads this module, so it
// imports nothing heavy, such as the preview cache and the sheet engine behind it.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { VectorScene } from '@workspace/lib/vector';
import { parseBackgroundFill } from '@workspace/lib/vector/fill';
import type { Mount } from '../mount';
import type { ExportMedia, TransformMedia } from './transform/protocol';

export async function listDocumentMedia(mount: Mount, drivePath: DrivePath): Promise<Map<string, DrivePath>> {
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const children = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    return new Map(children.map((file) => [file.name, file]));
}

// The media names a document's content holds, for an export or a read of the parts it uses. Every document kind names a
// file in `media/` by a `mediaName` field, wherever it sits in the tree.
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

// The media a deck or drawing names: its images, and the frame backgrounds, which the scene keeps as stored JSON.
export function sceneMediaNames(scene: VectorScene): Set<string> {
    return mediaNamesIn([scene.elements, scene.frames.map((frame) => parseBackgroundFill(frame.background))]);
}

// The API's absolute public URL, for the preview HTML embedded in exported documents. VITE_API_HOST may be relative,
// such as "/eigen", so it is resolved against API_URL. These <img src> URLs end up in HTML that has no origin to
// resolve against, such as a PDF export or a mail.
function resolvePublicApiUrl(): string {
    const apiHost = process.env['VITE_API_HOST'] || '';
    const apiUrl = process.env['API_URL'] || 'http://localhost:8000';
    if (/^https?:\/\//.test(apiHost)) return apiHost;
    if (!apiHost) return apiUrl;
    return `${apiUrl}${apiHost.startsWith('/') ? apiHost : `/${apiHost}`}`;
}
const PUBLIC_API_URL = resolvePublicApiUrl();

// The map from each media name to the URL a preview embeds. A preview names its media by URL, so no bytes cross into
// the transform process. It is a Map, because a mediaName is document data, and a name such as `constructor` must
// never resolve to something on Object.prototype.
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
