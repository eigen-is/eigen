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

// Public-facing API URL for client-rendered preview HTML. VITE_API_HOST includes reverse
// proxy prefixes (e.g. /eigen), API_URL is the internal URL without prefix.
const PUBLIC_API_URL = process.env['VITE_API_HOST'] || process.env['API_URL'] || 'http://localhost:8000';

export function buildPreviewUrl(drivePath: DrivePath, file: DrivePath): string {
    return `${PUBLIC_API_URL}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.id}/preview`;
}
