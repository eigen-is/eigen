import * as path from 'path';
import * as fs from 'node:fs';
import {generateThumbnail} from '../shared/thumbnails';
import type {Mount} from '../mount';
import type {DrivePath} from '@workspace/lib/types/drive';

function getCacheKey(pathId: string, updatedAt: Date | string): string {
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
    return `${pathId}-${ts}.screen.webp`;
}

export async function getImagePreview(mount: Mount, drivePath: DrivePath): Promise<Buffer | null> {
    const cacheFile = path.join(mount.previewsDir, getCacheKey(drivePath.id, drivePath.updatedAt));

    // Cache hit
    if (fs.existsSync(cacheFile)) {
        return Buffer.from(await Bun.file(cacheFile).arrayBuffer());
    }

    // Generate screen-res WebP
    const fileData = await mount.readFile(drivePath.id);
    if (!fileData) return null;

    const buffer = Buffer.from(fileData);
    const preview = await generateThumbnail(buffer, drivePath.mimeType, {maxSize: 2560, quality: 85});
    if (!preview) return null;

    // Write to cache
    await Bun.write(cacheFile, preview);
    return preview;
}
