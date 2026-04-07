import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../mount';
import type { MediaFile } from './doc/content';

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export async function readFileAsDataUri(mount: Mount, pathId: string, mimeType: string): Promise<string | null> {
    try {
        const file = await mount.readFile(pathId);
        if (!file) return null;
        const buffer = Buffer.from(await file.arrayBuffer());
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
        return null;
    }
}

export async function buildDataUriMap(mount: Mount, mediaByName: Map<string, MediaFile>): Promise<Map<string, string>> {
    const entries = await Promise.all(
        [...mediaByName].map(
            async ([name, file]) => [name, await readFileAsDataUri(mount, file.pathId, file.mimeType)] as const,
        ),
    );
    return new Map(entries.filter((e): e is [string, string] => e[1] !== null));
}

export function buildEmbedUrl(baseUrl: string, drivePath: DrivePath, file: MediaFile): string {
    return `${baseUrl}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.pathId}/embed/${encodeURIComponent(file.name)}`;
}
