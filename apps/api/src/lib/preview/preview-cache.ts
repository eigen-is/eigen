import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { Mount } from '../mount';
import { generateImagePreview } from '../shared/thumbnails';
import { generateEigendocPreview } from './eigendoc-preview';
import { isExiftoolCandidate } from './exiftool-preview';
import { generateTextPreview, isTextPreviewSupported, type TextPreviewResult } from './text-preview';

type PreviewResult = { type: 'image'; data: Buffer; contentType: string } | { type: 'redirect'; url: string } | null;

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

    // Video/audio/PDF → redirect to embed
    if (mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf') {
        return { type: 'redirect', url: embedUrl };
    }

    // SVG → serve as-is (no rasterisation to WebP), cached locally for S3 mounts
    if (mime === 'image/svg+xml') {
        const cacheFile = path.join(
            mount.previewsDir,
            getScreenCacheKey(drivePath.id, drivePath.updatedAt).replace('.webp', '.svg'),
        );

        if (fs.existsSync(cacheFile)) {
            return {
                type: 'image',
                data: Buffer.from(await Bun.file(cacheFile).arrayBuffer()),
                contentType: 'image/svg+xml',
            };
        }

        const file = await mount.readFile(drivePath.id);
        if (!file) return null;
        const data = Buffer.from(await file.arrayBuffer());
        await Bun.write(cacheFile, data);
        return { type: 'image', data, contentType: 'image/svg+xml' };
    }

    // Image (any format — sharp first, exiftool fallback)
    if (isExiftoolCandidate(mime, drivePath.name)) {
        const cacheFile = path.join(mount.previewsDir, getScreenCacheKey(drivePath.id, drivePath.updatedAt));

        // Cache hit
        if (fs.existsSync(cacheFile)) {
            return {
                type: 'image',
                data: Buffer.from(await Bun.file(cacheFile).arrayBuffer()),
                contentType: 'image/webp',
            };
        }

        // Pass the storage file reference directly to avoid an extra copy
        const file = await mount.readFile(drivePath.id);
        if (!file) return null;

        const result = await generateImagePreview(file, mime, drivePath.name, mount.previewsDir, drivePath.id, {
            maxSize: 2560,
            quality: 85,
        });
        if (!result) return null;

        await Bun.write(cacheFile, result.data);
        return { type: 'image', data: result.data, contentType: 'image/webp' };
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

    // Read file as text directly — no intermediate ArrayBuffer
    const file = await mount.readFile(drivePath.id);
    if (!file) return null;

    let content: string;
    try {
        content = await file.text();
    } catch {
        return null;
    }

    const result = await generateTextPreview(content, mime, drivePath.name);

    // Write to cache
    await Bun.write(cacheFile, JSON.stringify(result));
    return result;
}

export async function getCollabPreviewData(
    mount: Mount,
    drivePath: DrivePath,
    baseUrl?: string,
): Promise<TextPreviewResult | null> {
    const mime = drivePath.mimeType || '';

    // Eigendoc previews are fast (pure CPU) and Yjs edits don't update drivePath.updatedAt,
    // so we always regenerate instead of caching
    if (mime === DRIVE_MIME_DOC) {
        try {
            const body = await generateEigendocPreview(mount, drivePath, baseUrl);
            return body ? { body, mode: 'eigendoc' } : null;
        } catch (err) {
            console.error(`[preview] Failed to generate eigendoc preview for ${drivePath.id}:`, err);
            return null;
        }
    }

    return null;
}
