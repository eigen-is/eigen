import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTextPreviewMode } from '@workspace/lib/constants';
import { type DrivePath, isCollabType } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import type { TransformPriority } from '../document/transform/runner';
import type { Mount } from '../mount';
import { generateImagePreview } from '../shared/thumbnails';
import { isExiftoolCandidate } from './exiftool-preview';
import { generateDocumentPreview } from './preview-document';
import { inlineSvgMediaRefs } from './svg-media-inline';
import { generateTextPreview, type TextPreviewResult } from './text-preview';

type ImagePreview = { type: 'image'; data: Buffer; contentType: string };
type ScreenPreviewResult = ImagePreview | { type: 'redirect'; url: string } | null;

// Cache filenames are content-addressed by updatedAt: a new version writes a new file
// instead of overwriting, so HTTP responses can use a long max-age (the URL carries the
// same stamp). Prior versions are pruned on write — see pruneOldVersions.
function screenCacheName(drivePath: DrivePath, ext: 'webp' | 'svg'): string {
    return `${drivePath.id}-${drivePath.updatedAt.getTime()}.screen.${ext}`;
}

// Renderer format version — bump when generated HTML changes shape (e.g. plaintext moved
// from <pre> to prose paragraphs) so cached previews regenerate despite an unchanged updatedAt.
// f3: sheets previews render off-thread with the row/column/cell budget.
// f4: merges and conditional formatting clip to the render window (spans, window-scoped
//     aggregates, formula-rule ceiling).
// f5: a deck previews as canvas compositor pages, not slide divs.
const TEXT_FORMAT = 'f5';

function textCacheName(drivePath: DrivePath): string {
    return `${drivePath.id}-${drivePath.updatedAt.getTime()}.${TEXT_FORMAT}.json`;
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
            const value: TextPreviewResult = await Bun.file(cacheFile).json();
            return { value, stale: false };
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

    // Current-format names only: a body a previous renderer wrote is a different SHAPE, and the
    // consumers that scale and lay it out have moved on. Stale-while-revalidate trades freshness of
    // CONTENT for latency, never correctness of shape — an older format regenerates synchronously.
    const suffix = `.${TEXT_FORMAT}.json`;
    const candidates = files
        .filter((name) => name !== cacheName && name.startsWith(prefix) && name.endsWith(suffix))
        .map((name) => ({ name, stamp: Number(name.slice(prefix.length, -suffix.length)) }))
        .filter((c) => Number.isFinite(c.stamp))
        .sort((a, b) => b.stamp - a.stamp);

    for (const { name } of candidates) {
        try {
            const cached: TextPreviewResult = await Bun.file(path.join(previewsDir, name)).json();
            return cached;
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

export async function getScreenPreview(
    mount: Mount,
    drivePath: DrivePath,
    embedUrl: string,
): Promise<ScreenPreviewResult> {
    const mime = drivePath.mimeType || '';

    if (mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf') {
        return { type: 'redirect', url: embedUrl };
    }

    // SVG → serve as-is (no rasterisation to WebP), cached locally for S3 mounts. An image-bearing
    // vector drawing references its images by name via `eigen-media:` hrefs;
    // inline each sibling's bytes as a data: URI at serve time so <img> renders them (an <img> SVG
    // never fetches external refs). The inlined result rides this same versioned cache key — a sibling
    // edit does not bump the svg's updatedAt, so a stale sibling can outlive the cached preview until
    // the svg itself changes (accepted; a media rename already breaks name refs everywhere today). The
    // content type stays image/svg+xml, so the route keeps serving it under the sandbox CSP.
    if (mime === 'image/svg+xml') {
        return getOrCacheImage(
            mount.previewsDir,
            drivePath.id,
            screenCacheName(drivePath, 'svg'),
            'image/svg+xml',
            async () => {
                const file = await mount.readFile(drivePath.id);
                if (!file) return null;
                const bytes = Buffer.from(await file.arrayBuffer());
                return drivePath.parentId ? inlineSvgMediaRefs(mount, drivePath.parentId, bytes) : bytes;
            },
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

// A collab container previews from its Yjs document, every other file from its bytes; the mime map
// is the one list of which is which. The CONTAINER type gates it: mimeType is caller-controlled on
// upload, and a plain file wearing an eigen mime must keep the preview its bytes deserve.
export async function getTextPreview(mount: Mount, drivePath: DrivePath): Promise<ServedTextPreview | null> {
    const documentType = isCollabType(drivePath.type) ? COLLAB_DOCUMENT_TYPES.get(drivePath.mimeType || '') : undefined;
    if (!documentType) return getFileTextPreview(mount, drivePath);
    return getOrCacheText(mount.previewsDir, drivePath.id, textCacheName(drivePath), documentType, (priority) =>
        generateDocumentPreview(documentType, mount, drivePath, priority),
    );
}

async function getFileTextPreview(mount: Mount, drivePath: DrivePath): Promise<ServedTextPreview | null> {
    const mode = getTextPreviewMode(drivePath.mimeType || '', drivePath.name);
    if (mode === null) return null;

    return getOrCacheText(mount.previewsDir, drivePath.id, textCacheName(drivePath), mode, async () => {
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
