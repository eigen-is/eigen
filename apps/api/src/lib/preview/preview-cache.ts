import * as path from 'path';
import * as fs from 'node:fs';
import type {Mount} from '../mount';
import type {DrivePath} from '@workspace/lib/types/drive';
import {getImagePreview} from './image-preview';
import {cleanupExtract, extractEmbeddedPreview, isExiftoolSupported} from './exiftool-preview';
import {generateTextPreview, isTextPreviewSupported} from './text-preview';
import {generateThumbnail} from '../shared/thumbnails';

type PreviewResult =
    | { type: 'image'; data: Buffer; contentType: 'image/webp' }
    | { type: 'html'; data: string; contentType: 'text/html' }
    | { type: 'redirect'; url: string }
    | null;

function getHtmlCacheKey(pathId: string, updatedAt: Date | string): string {
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
    return `${pathId}-${ts}.html`;
}

function getScreenCacheKey(pathId: string, updatedAt: Date | string): string {
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
    return `${pathId}-${ts}.screen.webp`;
}

export async function getScreenPreview(mount: Mount, drivePath: DrivePath, embedUrl: string): Promise<PreviewResult> {
    const mime = drivePath.mimeType || '';

    // Video/audio → redirect to embed
    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
        return {type: 'redirect', url: embedUrl};
    }

    // PDF → redirect to embed (Phase 5 will add WebP thumbnail)
    if (mime === 'application/pdf') {
        return {type: 'redirect', url: embedUrl};
    }

    // Image (standard formats sharp can handle)
    if (mime.startsWith('image/') && !isExiftoolSupported(mime, drivePath.name)) {
        const data = await getImagePreview(mount, drivePath);
        if (data) return {type: 'image', data, contentType: 'image/webp'};
        return null;
    }

    // RAW/PSD/AI → exiftool extract → sharp → WebP
    if (isExiftoolSupported(mime, drivePath.name)) {
        const result = await getExiftoolPreview(mount, drivePath);
        if (result) return {type: 'image', data: result, contentType: 'image/webp'};
        return null;
    }

    // Text/code/markdown → HTML
    if (isTextPreviewSupported(mime, drivePath.name)) {
        return await getHtmlPreview(mount, drivePath);
    }

    return null;
}

async function getExiftoolPreview(mount: Mount, drivePath: DrivePath): Promise<Buffer | null> {
    const cacheFile = path.join(mount.previewsDir, getScreenCacheKey(drivePath.id, drivePath.updatedAt));

    // Cache hit
    if (fs.existsSync(cacheFile)) {
        return Buffer.from(await Bun.file(cacheFile).arrayBuffer());
    }

    // Need the file on disk for exiftool
    const storageFile = await mount.getStorageFile(drivePath.id);
    const filePath = storageFile.name!;

    const extractPath = await extractEmbeddedPreview(filePath, mount.previewsDir, drivePath.id);
    if (!extractPath) return null;

    try {
        const preview = await generateThumbnail(extractPath, 'image/jpeg', {maxSize: 2560, quality: 85});
        if (!preview) return null;

        await Bun.write(cacheFile, preview);
        return preview;
    } finally {
        await cleanupExtract(extractPath);
    }
}

async function getHtmlPreview(mount: Mount, drivePath: DrivePath): Promise<PreviewResult> {
    const cacheFile = path.join(mount.previewsDir, getHtmlCacheKey(drivePath.id, drivePath.updatedAt));

    // Cache hit
    if (fs.existsSync(cacheFile)) {
        const data = await Bun.file(cacheFile).text();
        return {type: 'html', data, contentType: 'text/html'};
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

    const html = await generateTextPreview(content, drivePath.mimeType, drivePath.name);

    // Write to cache
    await Bun.write(cacheFile, html);
    return {type: 'html', data: html, contentType: 'text/html'};
}
