import * as path from 'path';
import * as fs from 'node:fs';
import type {Mount} from '../mount';
import type {DrivePath} from '@workspace/lib/types/drive';
import {generateImagePreview} from '../shared/thumbnails';
import {isExiftoolCandidate} from './exiftool-preview';
import {generateTextPreview, isTextPreviewSupported, type TextPreviewResult} from './text-preview';

type PreviewResult =
    | { type: 'image'; data: Buffer; contentType: string }
    | { type: 'redirect'; url: string }
    | null;

function getScreenCacheKey(pathId: string, updatedAt: Date | string): string {
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
    return `${pathId}-${ts}.screen.webp`;
}

function getTextCacheKey(pathId: string, updatedAt: Date | string): string {
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
    return `${pathId}-${ts}.json`;
}

export async function getScreenPreview(mount: Mount, drivePath: DrivePath, embedUrl: string): Promise<PreviewResult> {
    const mime = drivePath.mimeType || '';

    // Video/audio → redirect to embed
    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
        return {type: 'redirect', url: embedUrl};
    }

    // PDF → redirect to embed
    if (mime === 'application/pdf') {
        return {type: 'redirect', url: embedUrl};
    }

    // SVG → serve as-is (no rasterisation to WebP), cached locally for S3 mounts
    if (mime === 'image/svg+xml') {
        const cacheFile = path.join(mount.previewsDir, getScreenCacheKey(drivePath.id, drivePath.updatedAt).replace('.webp', '.svg'));

        if (fs.existsSync(cacheFile)) {
            return {
                type: 'image',
                data: Buffer.from(await Bun.file(cacheFile).arrayBuffer()),
                contentType: 'image/svg+xml'
            };
        }

        const fileData = await mount.readFile(drivePath.id);
        if (!fileData) return null;
        const data = Buffer.from(fileData);
        await Bun.write(cacheFile, data);
        return {type: 'image', data, contentType: 'image/svg+xml'};
    }

    // Image (any format — sharp first, exiftool fallback)
    if (isExiftoolCandidate(mime, drivePath.name)) {
        const cacheFile = path.join(mount.previewsDir, getScreenCacheKey(drivePath.id, drivePath.updatedAt));

        // Cache hit
        if (fs.existsSync(cacheFile)) {
            return {type: 'image', data: Buffer.from(await Bun.file(cacheFile).arrayBuffer()), contentType: 'image/webp'};
        }

        const fileData = await mount.readFile(drivePath.id);
        if (!fileData) return null;

        const result = await generateImagePreview(
            Buffer.from(fileData), mime, drivePath.name, mount.previewsDir, drivePath.id,
            {maxSize: 2560, quality: 85}
        );
        if (!result) return null;

        await Bun.write(cacheFile, result.data);
        return {type: 'image', data: result.data, contentType: 'image/webp'};
    }

    return null;
}

export async function getTextPreviewData(mount: Mount, drivePath: DrivePath): Promise<TextPreviewResult | null> {
    const mime = drivePath.mimeType || '';
    if (!isTextPreviewSupported(mime, drivePath.name)) return null;

    const cacheFile = path.join(mount.previewsDir, getTextCacheKey(drivePath.id, drivePath.updatedAt));

    // Cache hit
    if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(await Bun.file(cacheFile).text());
        return cached as TextPreviewResult;
    }

    // Read file content
    const fileData = await mount.readFile(drivePath.id);
    if (!fileData) return null;

    let content: string;
    try {
        content = new TextDecoder('utf-8', {fatal: true}).decode(fileData);
    } catch {
        return null;
    }

    const result = await generateTextPreview(content, mime, drivePath.name);

    // Write to cache
    await Bun.write(cacheFile, JSON.stringify(result));
    return result;
}
