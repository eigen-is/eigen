import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../mount';
import type { ExportMedia } from './transform/protocol';

// Media helpers for eigen documents, shared by the main-thread transform wrappers
// and the Worker-side converters. This module must stay light: the modules the
// transform Worker imports (preview/export renderers) import it, so a static edge
// from here into the preview cache would drag the whole screen-preview pipeline —
// and the sheet engine behind it — into every document Worker.

export async function listDocumentMedia(mount: Mount, drivePath: DrivePath): Promise<Map<string, DrivePath>> {
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const children = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    return new Map(children.map((file) => [file.name, file]));
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
// reference media by URL, so no bytes cross the Worker boundary.
export async function buildPreviewUrlMap(mount: Mount, drivePath: DrivePath): Promise<Record<string, string>> {
    const media = await listDocumentMedia(mount, drivePath);
    return Object.fromEntries(
        [...media].map(([name, file]) => [
            name,
            `${PUBLIC_API_URL}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.id}/preview`,
        ]),
    );
}

// A figure/slide-object mediaName is document data, so the preview URL map is looked
// up by own key only — an unknown name like `constructor` must resolve to null, not
// to something off Object.prototype.
export function resolveMediaUrl(mediaUrls: Record<string, string>, mediaName: string): string | null {
    return Object.hasOwn(mediaUrls, mediaName) ? mediaUrls[mediaName] : null;
}

// The Worker side of export media: the transferred buffers become the data: URIs the
// export renderers embed.
export function toDataUriMap(media: ExportMedia[]): Map<string, string> {
    return new Map(
        media.map((item) => [
            item.name,
            `data:${item.contentType};base64,${Buffer.from(item.data).toString('base64')}`,
        ]),
    );
}
