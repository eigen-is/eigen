import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_DOC, DRIVE_MIME_SLIDES } from '@workspace/lib/types/drive';
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

export async function getTextPreview(mount: Mount, drivePath: DrivePath): Promise<TextPreviewResult | null> {
    if (drivePath.type === 'doc' || drivePath.type === 'slides') return getCollabPreviewData(mount, drivePath);
    return getTextPreviewData(mount, drivePath);
}

async function getTextPreviewData(mount: Mount, drivePath: DrivePath): Promise<TextPreviewResult | null> {
    const mime = drivePath.mimeType || '';
    if (!isTextPreviewSupported(mime, drivePath.name)) return null;

    const cacheFile = path.join(mount.previewsDir, getTextCacheKey(drivePath.id, drivePath.updatedAt));

    // Cache hit
    if (fs.existsSync(cacheFile)) {
        return (await Bun.file(cacheFile).json()) as TextPreviewResult;
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

async function getOrCachePreview(
    mount: Mount,
    drivePath: DrivePath,
    mode: TextPreviewResult['mode'],
    generate: () => Promise<string>,
): Promise<TextPreviewResult | null> {
    const cacheFile = path.join(mount.previewsDir, getTextCacheKey(drivePath.id, drivePath.updatedAt));

    if (fs.existsSync(cacheFile)) {
        return (await Bun.file(cacheFile).json()) as TextPreviewResult;
    }

    try {
        const body = await generate();
        if (!body) return null;
        const result: TextPreviewResult = { body, mode };
        await Bun.write(cacheFile, JSON.stringify(result));
        return result;
    } catch (err) {
        console.error(`[preview] Failed to generate ${mode} preview for ${drivePath.id}:`, err);
        return null;
    }
}

async function getCollabPreviewData(mount: Mount, drivePath: DrivePath): Promise<TextPreviewResult | null> {
    const mime = drivePath.mimeType || '';

    if (mime === DRIVE_MIME_DOC) {
        return getOrCachePreview(mount, drivePath, 'eigendoc', () => generateEigendocPreview(mount, drivePath));
    }

    if (mime === DRIVE_MIME_SLIDES) {
        return getOrCachePreview(mount, drivePath, 'eigenslides', async () => {
            // Dynamic import: eigenslides-preview imports tiptap-adjacent code that references DOM
            // globals at module level. --splitting keeps it in a separate chunk loaded on demand.
            const { generateEigenslidesPreview } = await import('./eigenslides-preview');
            return generateEigenslidesPreview(mount, drivePath);
        });
    }

    return null;
}
