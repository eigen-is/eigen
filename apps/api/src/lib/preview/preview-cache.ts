import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTextPreviewMode } from '@workspace/lib/constants';
import { DRIVE_MIME_VECTOR, type DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import type { TransformPriority } from '../document/transform/runner';
import type { Mount } from '../mount';
import { generateImagePreview } from '../shared/thumbnails';
import { isExiftoolCandidate } from './exiftool-preview';
import { generateDocumentPreview } from './preview-document';
import { generateTextPreview, type TextPreviewResult } from './text-preview';

type ImagePreview = { type: 'image'; data: Buffer; contentType: string };
type PreviewResult = ImagePreview | { type: 'redirect'; url: string } | null;

function versionStamp(updatedAt: Date | string): number {
    return updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
}

// Cache filenames are content-addressed by updatedAt: a new version writes a new file
// instead of overwriting, so HTTP responses can use a long max-age (the URL carries the
// same stamp). Prior versions are pruned on write — see pruneOldVersions.
function screenCacheName(drivePath: DrivePath, ext: 'webp' | 'svg'): string {
    return `${drivePath.id}-${versionStamp(drivePath.updatedAt)}.screen.${ext}`;
}

// Renderer format version — bump when generated HTML changes shape (e.g. plaintext moved
// from <pre> to prose paragraphs) so cached previews regenerate despite an unchanged updatedAt.
// f3: sheets previews render off-thread with the row/column/cell budget.
// f4: merges and conditional formatting clip to the render window (spans, window-scoped
//     aggregates, formula-rule ceiling).
const TEXT_FORMAT = 'f4';

function textCacheName(drivePath: DrivePath): string {
    return `${drivePath.id}-${versionStamp(drivePath.updatedAt)}.${TEXT_FORMAT}.json`;
}

// Delete previously-cached versions of this path (older updatedAt stamps) so previewsDir
// doesn't accumulate one file per edit. Run fire-and-forget after a cache write: it scans
// the dir off the response path and never removes the just-written `keep` file, so an
// in-flight prune can't race a concurrent read. The 7-day init sweep covers paths that
// are written once and never again.
export async function pruneOldVersions(previewsDir: string, pathId: string, keep: string): Promise<void> {
    const prefix = `${pathId}-`;
    const files = await fs.promises.readdir(previewsDir);
    await Promise.all(
        files
            .filter((name) => name !== keep && name.startsWith(prefix))
            .map((name) => fs.promises.unlink(path.join(previewsDir, name)).catch(() => {})),
    );
}

// In-flight generations keyed by cache filename, so a folder grid of N tiles for one just-added
// image triggers a single generate() instead of N (mirrors inFlightText below).
const inFlightImage = new Map<string, Promise<ImagePreview | null>>();

// Read-through cache for a binary preview artifact (screen-res webp / raw svg).
async function getOrCacheImage(
    previewsDir: string,
    pathId: string,
    cacheName: string,
    contentType: string,
    generate: () => Promise<Buffer | null>,
): Promise<ImagePreview | null> {
    const cacheFile = path.join(previewsDir, cacheName);
    if (fs.existsSync(cacheFile)) {
        try {
            return { type: 'image', data: Buffer.from(await Bun.file(cacheFile).arrayBuffer()), contentType };
        } catch {
            // File pruned by pruneOldVersions between exists-check and read — regenerate below.
        }
    }

    const existing = inFlightImage.get(cacheName);
    if (existing) return existing;

    const task = (async (): Promise<ImagePreview | null> => {
        const data = await generate();
        if (!data) return null;
        await Bun.write(cacheFile, data);
        pruneOldVersions(previewsDir, pathId, cacheName).catch(() => {});
        return { type: 'image', data, contentType };
    })();
    inFlightImage.set(cacheName, task);
    try {
        return await task;
    } finally {
        inFlightImage.delete(cacheName);
    }
}

// A served text preview plus whether it's the current version. `stale` previews are the
// previous version, returned immediately while the current one regenerates in the
// background — the route marks them no-store so the client refetches the fresh copy.
type ServedTextPreview = { value: TextPreviewResult; stale: boolean };

// Collab generators run through the document-transform runner: a first cache miss
// is foreground work (the request waits on it), a stale regeneration is background
// work the runner may drop under load. Plain-file generators ignore the priority.
type TextPreviewGenerator = (priority: TransformPriority) => Promise<string | null>;

// In-flight background regenerations keyed by cache filename, so a folder grid of N tiles
// for one just-edited doc triggers a single regeneration instead of N.
const inFlightText = new Map<string, Promise<void>>();

// In-flight first-ever generations, so concurrent misses for the same cache key
// share one generation (mirrors inFlightImage above).
const inFlightFirstText = new Map<string, Promise<ServedTextPreview | null>>();

// Read-through cache for a text preview artifact (the JSON { body, mode } envelope).
async function getOrCacheText(
    previewsDir: string,
    pathId: string,
    cacheName: string,
    mode: TextPreviewResult['mode'],
    generate: TextPreviewGenerator,
): Promise<ServedTextPreview | null> {
    const cacheFile = path.join(previewsDir, cacheName);
    if (fs.existsSync(cacheFile)) {
        try {
            return { value: (await Bun.file(cacheFile).json()) as TextPreviewResult, stale: false };
        } catch {
            // File is mid-write or corrupt — fall through to serve a prior version / regenerate.
        }
    }

    // Current version missing. If a previous version is cached, serve it immediately and
    // regenerate the current one in the background (stale-while-revalidate).
    const stale = await readNewestStaleText(previewsDir, pathId, cacheName);
    if (stale) {
        regenerateTextInBackground(previewsDir, pathId, cacheName, mode, generate);
        return { value: stale, stale: true };
    }

    // First-ever preview for this path: nothing to serve, so generate synchronously.
    const existing = inFlightFirstText.get(cacheName);
    if (existing) return existing;

    const task = (async (): Promise<ServedTextPreview | null> => {
        try {
            const body = await generate('foreground');
            if (!body) return null;
            const result: TextPreviewResult = { body, mode };
            await Bun.write(cacheFile, JSON.stringify(result));
            pruneOldVersions(previewsDir, pathId, cacheName).catch(() => {});
            return { value: result, stale: false };
        } catch (err) {
            // Overload is not "no preview": surface the runner's 503 so the client
            // can retry, instead of caching the miss as a 404.
            if (err instanceof ApiError && err.status === 503) throw err;
            console.error(`[preview] Failed to generate ${mode} preview for ${pathId}:`, err);
            return null;
        }
    })();
    inFlightFirstText.set(cacheName, task);
    try {
        return await task;
    } finally {
        inFlightFirstText.delete(cacheName);
    }
}

// Find and read the newest previously-cached version of this path's text preview. Returns
// null if none exists (first preview) or every candidate was pruned mid-read by a concurrent
// regeneration — callers then fall back to synchronous generation.
async function readNewestStaleText(
    previewsDir: string,
    pathId: string,
    cacheName: string,
): Promise<TextPreviewResult | null> {
    const prefix = `${pathId}-`;
    let files: string[];
    try {
        files = await fs.promises.readdir(previewsDir);
    } catch {
        return null;
    }

    // Accept prior-format names too (plain `<stamp>.json` from before TEXT_FORMAT existed) —
    // a pre-bump copy is exactly what stale-while-revalidate is for.
    const candidates = files
        .filter((name) => name !== cacheName && name.startsWith(prefix) && name.endsWith('.json'))
        .map((name) => ({ name, stamp: Number(name.slice(prefix.length).replace(/(?:\.f\d+)?\.json$/, '')) }))
        .filter((c) => Number.isFinite(c.stamp))
        .sort((a, b) => b.stamp - a.stamp);

    for (const { name } of candidates) {
        try {
            return (await Bun.file(path.join(previewsDir, name)).json()) as TextPreviewResult;
        } catch {
            // Pruned between readdir and read — try the next-newest version.
        }
    }
    return null;
}

// Fire-and-forget regeneration of the current-version text preview, deduped on cacheName so
// concurrent requests for the same stale path share one generation. A failed or dropped
// (runner-overload) regeneration leaves the stale file in place — a later request retries.
function regenerateTextInBackground(
    previewsDir: string,
    pathId: string,
    cacheName: string,
    mode: TextPreviewResult['mode'],
    generate: TextPreviewGenerator,
): void {
    if (inFlightText.has(cacheName)) return;
    const task = (async () => {
        try {
            const body = await generate('background');
            if (!body) return;
            const result: TextPreviewResult = { body, mode };
            await Bun.write(path.join(previewsDir, cacheName), JSON.stringify(result));
            pruneOldVersions(previewsDir, pathId, cacheName).catch(() => {});
        } catch (err) {
            console.error(`[preview] Background regeneration failed for ${mode} preview ${pathId}:`, err);
        } finally {
            inFlightText.delete(cacheName);
        }
    })();
    inFlightText.set(cacheName, task);
}

export async function getScreenPreview(mount: Mount, drivePath: DrivePath, embedUrl: string): Promise<PreviewResult> {
    const mime = drivePath.mimeType || '';

    // Video/audio/PDF → redirect to embed for native playback
    if (mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf') {
        return { type: 'redirect', url: embedUrl };
    }

    // SVG → serve as-is (no rasterisation to WebP), cached locally for S3 mounts
    if (mime === 'image/svg+xml') {
        return getOrCacheImage(
            mount.previewsDir,
            drivePath.id,
            screenCacheName(drivePath, 'svg'),
            'image/svg+xml',
            async () => {
                const file = await mount.readFile(drivePath.id);
                return file ? Buffer.from(await file.arrayBuffer()) : null;
            },
        );
    }

    // Eigen-native vector drawings render to an SVG in the transform Worker and are then
    // served as-is on the same SVG-as-image path — the internal preview pipeline keeps
    // SVGs unrasterized. The text-preview registry is untouched: this is an image, not an
    // HTML body. Generation may throw the runner's 503 under overload, which the route
    // surfaces so the client retries — nothing is cached on failure.
    if (mime === DRIVE_MIME_VECTOR) {
        return getOrCacheImage(
            mount.previewsDir,
            drivePath.id,
            screenCacheName(drivePath, 'svg'),
            'image/svg+xml',
            async () => Buffer.from(await generateDocumentPreview('eigenvector', mount, drivePath)),
        );
    }

    // Image (any format — sharp first, exiftool fallback)
    if (isExiftoolCandidate(mime, drivePath.name)) {
        return getOrCacheImage(
            mount.previewsDir,
            drivePath.id,
            screenCacheName(drivePath, 'webp'),
            'image/webp',
            async () => {
                // Pass the storage file reference directly to avoid an extra copy
                const file = await mount.readFile(drivePath.id);
                if (!file) return null;
                const result = await generateImagePreview(file, mime, drivePath.name, mount.previewsDir, drivePath.id, {
                    maxSize: 2560,
                    quality: 85,
                });
                return result?.data ?? null;
            },
        );
    }

    return null;
}

export async function getTextPreview(mount: Mount, drivePath: DrivePath): Promise<ServedTextPreview | null> {
    if (drivePath.type === 'doc' || drivePath.type === 'slides' || drivePath.type === 'sheets')
        return getCollabPreview(mount, drivePath);
    return getFileTextPreview(mount, drivePath);
}

async function getFileTextPreview(mount: Mount, drivePath: DrivePath): Promise<ServedTextPreview | null> {
    const mode = getTextPreviewMode(drivePath.mimeType || '', drivePath.name);
    if (mode === null) return null;

    return getOrCacheText(mount.previewsDir, drivePath.id, textCacheName(drivePath), mode, async () => {
        // Read file as text directly — no intermediate ArrayBuffer
        const file = await mount.readFile(drivePath.id);
        if (!file) return null;
        let content: string;
        try {
            content = await file.text();
        } catch {
            return null;
        }
        return (await generateTextPreview(content, mode, drivePath.name)).body;
    });
}

async function getCollabPreview(mount: Mount, drivePath: DrivePath): Promise<ServedTextPreview | null> {
    const documentType = COLLAB_DOCUMENT_TYPES.get(drivePath.mimeType || '');
    // getTextPreview only routes doc/slides/sheets here, so eigenvector never occurs at
    // runtime — but the map still carries it (search extraction shares the list), and it is
    // not a TextPreviewResult['mode'], so exclude it to keep the text-preview envelope typed.
    if (!documentType || documentType === 'eigenvector') return null;
    return getOrCacheText(mount.previewsDir, drivePath.id, textCacheName(drivePath), documentType, (priority) =>
        generateDocumentPreview(documentType, mount, drivePath, priority),
    );
}
