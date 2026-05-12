import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../mount';
import { getScreenPreview } from '../preview/preview-cache';

export async function buildDataUriMap(mount: Mount, mediaByName: Map<string, DrivePath>): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    await Promise.all(
        [...mediaByName].map(async ([name, file]) => {
            const result = await getScreenPreview(mount, file, '');
            if (result?.type === 'image') {
                map.set(name, `data:${result.contentType};base64,${result.data.toString('base64')}`);
            }
        }),
    );
    return map;
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

export function buildPreviewUrl(drivePath: DrivePath, file: DrivePath): string {
    return `${PUBLIC_API_URL}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.id}/preview`;
}
