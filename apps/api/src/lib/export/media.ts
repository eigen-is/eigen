import type { Mount } from '../mount';

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
