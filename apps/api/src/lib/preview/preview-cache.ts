import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBytesTextPreviewMode, TEXT_PREVIEW_MAX_BYTES } from '@workspace/lib/constants';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { type DrivePath, isCollabType, isEmlFile, isIcsFile, isVCardFile } from '@workspace/lib/types/drive';
import type { EmlPreview, IcsPreview, TextPreviewResult, VCardPreview } from '@workspace/lib/types/preview';
import { ApiError } from '../core/errors';
import { NOT_A_CALENDAR_FILE, NOT_A_VCARD_FILE, NOT_AN_EMAIL_FILE } from '../core/transfer';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import type { EmlPreviewJob, IcsPreviewJob, VCardPreviewJob } from '../document/transform/protocol';
import { runBytesTransformToText, runFileTransformToText } from '../document/transform/run-transform';
import type { TransformPriority } from '../document/transform/runner';
import { decodeCharset } from '../mail/mail-parser/decode';
import type { Mount } from '../mount';
import { generateImagePreview } from '../shared/thumbnails';
import { parseEmlPreview } from './eml-preview';
import { isExiftoolCandidate } from './exiftool-preview';
import { parseIcsPreview } from './ics-preview';
import { generateDocumentPreview } from './preview-document';
import { inlineSvgMediaRefs } from './svg-media-inline';
import { generateTextPreview } from './text-preview';
import { parseVCardPreview } from './vcard-preview';

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
export const TEXT_FORMAT = 'f5';

// The three typed previews below are each a different artifact for the same path — contact cards, a
// message, a calendar's events, never a rendered body — so each carries its own format and none of them
// ever reads another's file as its stale predecessor. (pruneOldVersions is not format-scoped, but each of
// the three has exactly one cached artifact: getTextPreviewMode declines its mimes and getScreenPreview
// does not answer for them.) A cached body is JSON this process wrote from a value it built, so the read
// back is a typed assignment nothing else checks: change one of the payload types and bump its format
// here, or a restored previewsDir serves the old shape. The payloads are built inside the transform
// Worker (worker.ts owns execution, this module the main-thread orchestration), which is why no builder
// may reach the Mount or the transform seam.
export const VCARD_FORMAT = 'vcard-f1';

// One more reason to bump this one: the payload's html is what a DOMPurify upgrade filters, so a cached
// body predates every sanitizer fix (PREVIEWS.md).
// eml-f2: CSS is refused on the `url(` token, and a data: reference survives only as a raster image.
// eml-f3: the parts past the cap are counted as `remainingAttachments`.
// eml-f4: CSS is read again as the color-scheme deletion a viewer makes would leave it, and a repeated
//         To:/Cc: keeps every recipient.
export const EML_FORMAT = 'eml-f4';

// ics-f2: `dropped` is the unreadable masters alone, and an event counts its `remainingAttendees`.
export const ICS_FORMAT = 'ics-f2';

function textCacheName(drivePath: DrivePath, format: string): string {
    return `${drivePath.id}-${drivePath.updatedAt.getTime()}.${format}.json`;
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

// Temp + rename: readCachedText deletes a file it can't parse, so a reader catching a half-written one
// would unlink the landed regeneration. Dot-prefixed so pruneOldVersions and stale reads never see it.
async function writeCacheFile(cacheFile: string, data: string | Buffer): Promise<void> {
    const tempFile = path.join(path.dirname(cacheFile), `.${path.basename(cacheFile)}.tmp-${randomUUID()}`);
    try {
        await Bun.write(tempFile, data);
        await fs.promises.rename(tempFile, cacheFile);
    } catch (err) {
        await fs.promises.unlink(tempFile).catch(() => {});
        throw err;
    }
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
        await writeCacheFile(cacheFile, data);
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

// A served preview plus whether it's the current version. `stale` previews are the
// previous version, returned immediately while the current one regenerates in the
// background — the route marks them no-store so the client refetches the fresh copy.
type Served<T> = { value: T; stale: boolean };
type ServedTextPreview = Served<TextPreviewResult>;

// Collab generators run through the document-transform runner: a first cache miss
// is foreground work (the request waits on it), a stale regeneration is background
// work the runner may drop under load. Plain-file generators ignore the priority.
type TextPreviewGenerator = (priority: TransformPriority) => Promise<string | null>;

// In-flight background regenerations keyed by cache filename, so a folder grid of N tiles
// for one just-edited doc triggers a single regeneration instead of N.
const inFlightText = new Map<string, Promise<void>>();

// In-flight first-ever generations, so concurrent misses for the same cache key
// share one generation (mirrors inFlightImage above). It holds the generated body, not the parsed
// value, so one generation serves callers whatever each of them parses it into.
const inFlightFirstText = new Map<string, Promise<string | null>>();

// The JSON envelope every generated text artifact is cached in. What is served on top of it is the
// caller's business — the text preview adds the mode it already knows — so only the body is stored.
type CachedText = { body: string };

// A stored body turned into what the caller serves. It is the only check this module makes on a file
// it reads back, so a body the parser rejects counts as a corrupt cache file.
type CachedTextParser<T> = (body: string) => T;

// The cached current version, or null when the file is missing, corrupt or of a shape the
// parser refuses. An unusable file is deleted rather than left behind: it is the CURRENT version, so it
// would be read again on every request, and regenerateTextInBackground skips a cache name that exists.
async function readCachedText<T>(cacheFile: string, parse: CachedTextParser<T>): Promise<T | null> {
    if (!fs.existsSync(cacheFile)) return null;
    try {
        const cached: CachedText = await Bun.file(cacheFile).json();
        return parse(cached.body);
    } catch (err) {
        console.error(`[preview] Discarding unreadable cache file ${cacheFile}:`, err);
        await fs.promises.unlink(cacheFile).catch(() => {});
        return null;
    }
}

// Read-through cache for a generated text artifact, versioned by `format` so a shape change (and a
// second artifact for the same path) regenerates instead of being read back wrong.
async function getOrCacheText<T>(
    previewsDir: string,
    drivePath: DrivePath,
    format: string,
    parse: CachedTextParser<T>,
    generate: TextPreviewGenerator,
): Promise<Served<T> | null> {
    const pathId = drivePath.id;
    const cacheName = textCacheName(drivePath, format);
    const cacheFile = path.join(previewsDir, cacheName);
    const current = await readCachedText(cacheFile, parse);
    if (current !== null) return { value: current, stale: false };

    // Current version missing. If a previous version is cached, serve it immediately and
    // regenerate the current one in the background (stale-while-revalidate).
    const stale = await readNewestStaleText(previewsDir, pathId, cacheName, format, parse);
    if (stale !== null) {
        regenerateTextInBackground(previewsDir, pathId, cacheName, format, generate);
        return { value: stale, stale: true };
    }

    // No previous version either. A regeneration that landed during the reads above pruned
    // the previous version and wrote the current one: join it rather than start a foreground
    // generation of a file that exists (or is about to).
    await inFlightText.get(cacheName);
    const landed = await readCachedText(cacheFile, parse);
    if (landed !== null) return { value: landed, stale: false };

    // First-ever preview for this path: nothing to serve, so generate synchronously.
    const existing = inFlightFirstText.get(cacheName);
    if (existing) return served(await existing, parse);

    const task = (async (): Promise<string | null> => {
        try {
            const body = await generate('foreground');
            if (!body) return null;
            const result: CachedText = { body };
            await writeCacheFile(cacheFile, JSON.stringify(result));
            pruneOldVersions(previewsDir, pathId, cacheName).catch(() => {});
            return body;
        } catch (err) {
            // Overload is not "no preview", and neither is a file the renderer refused: a controlled
            // status reaches the client instead of being cached as a 404.
            if (err instanceof ApiError) throw err;
            console.error(`[preview] Failed to generate ${format} preview for ${pathId}:`, err);
            return null;
        }
    })();
    inFlightFirstText.set(cacheName, task);
    try {
        return served(await task, parse);
    } finally {
        inFlightFirstText.delete(cacheName);
    }
}

function served<T>(body: string | null, parse: CachedTextParser<T>): Served<T> | null {
    return body === null ? null : { value: parse(body), stale: false };
}

// Find and read the newest previously-cached version of this path's text preview. Returns
// null if none exists (first preview) or every candidate was pruned mid-read by a concurrent
// regeneration — callers then fall back to synchronous generation.
async function readNewestStaleText<T>(
    previewsDir: string,
    pathId: string,
    cacheName: string,
    format: string,
    parse: CachedTextParser<T>,
): Promise<T | null> {
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
    const suffix = `.${format}.json`;
    const candidates = files
        .filter((name) => name !== cacheName && name.startsWith(prefix) && name.endsWith(suffix))
        .map((name) => ({ name, stamp: Number(name.slice(prefix.length, -suffix.length)) }))
        .filter((c) => Number.isFinite(c.stamp))
        .sort((a, b) => b.stamp - a.stamp);

    for (const { name } of candidates) {
        try {
            const cached: CachedText = await Bun.file(path.join(previewsDir, name)).json();
            return parse(cached.body);
        } catch {
            // Pruned between readdir and read, or of a shape the parser refuses — try the next-newest.
        }
    }
    return null;
}

// Fire-and-forget regeneration of the current-version text preview, deduped on cacheName so
// concurrent requests for the same stale path share one generation. A failed or dropped
// (runner-overload) regeneration leaves the stale file in place — a later request retries.
// Checked synchronously: the caller read the cache before its stale read, and a regeneration
// that landed in between has either its in-flight entry or its finished file to show for it.
function regenerateTextInBackground(
    previewsDir: string,
    pathId: string,
    cacheName: string,
    format: string,
    generate: TextPreviewGenerator,
): void {
    const cacheFile = path.join(previewsDir, cacheName);
    if (inFlightText.has(cacheName) || fs.existsSync(cacheFile)) return;
    const task = (async () => {
        try {
            const body = await generate('background');
            if (!body) return;
            const result: CachedText = { body };
            await writeCacheFile(cacheFile, JSON.stringify(result));
            pruneOldVersions(previewsDir, pathId, cacheName).catch(() => {});
        } catch (err) {
            console.error(`[preview] Background regeneration failed for ${format} preview ${pathId}:`, err);
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
                const bytes = await mount.readBytes(drivePath.id);
                if (!bytes) return null;
                const svg = Buffer.from(bytes);
                return drivePath.parentId ? inlineSvgMediaRefs(mount, drivePath.parentId, svg) : svg;
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
    const mode = documentType ?? getBytesTextPreviewMode(drivePath.mimeType || '', drivePath.name);
    if (mode === null) return null;
    // Refused off the row's size, before any read; a container's size is its databases, not its body.
    if (!documentType && drivePath.size > TEXT_PREVIEW_MAX_BYTES) return null;

    // A body is served exactly as it was stored; the mode is composed here, where it is already known.
    const cached = await getOrCacheText(
        mount.previewsDir,
        drivePath,
        TEXT_FORMAT,
        (body) => body,
        (priority) =>
            documentType
                ? generateDocumentPreview(documentType, mount, drivePath, priority)
                : generateFileTextPreview(mount, drivePath),
    );
    return cached && { value: { body: cached.value, mode }, stale: cached.stale };
}

async function generateFileTextPreview(mount: Mount, drivePath: DrivePath): Promise<string | null> {
    const bytes = await mount.readBytes(drivePath.id);
    if (!bytes) return null;
    const preview = await getBytesTextPreview(bytes, drivePath.name, drivePath.mimeType || '');
    return preview?.body ?? null;
}

// The one text renderer: Drive reaches it through the per-version cache above, a mail part calls it directly.
export async function getBytesTextPreview(
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
    contentType: string,
    charset?: string,
): Promise<TextPreviewResult | null> {
    const mode = getBytesTextPreviewMode(contentType, fileName);
    if (mode === null) return null;
    if (bytes.byteLength > TEXT_PREVIEW_MAX_BYTES) return null;
    // A mail part carries the charset its sender declared; Drive bytes have none and read as UTF-8.
    const buffer = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return generateTextPreview(decodeCharset(buffer, charset ?? 'utf-8'), mode, fileName);
}

const VCARD_PREVIEW_JOB: VCardPreviewJob = { kind: 'preview', documentType: 'vcard' };

// Each of the three previews parses the whole file like an import does, so it shares the import's ceiling.
export function assertVCardPreviewable(fileName: string, contentType: string, size: number): void {
    if (!isVCardFile(contentType, fileName)) throw new ApiError(400, NOT_A_VCARD_FILE);
    if (size > VCARD_MAX_BYTES) throw new ApiError(413, 'File too large to preview');
}

// A .vcf reads as contact cards, never as its raw text — which is why getTextPreviewMode declines it and
// its preview is its own route, cached per file version like every other preview; the caller admits the
// file's size before asking.
export async function getVCardPreview(mount: Mount, drivePath: DrivePath): Promise<Served<VCardPreview> | null> {
    return getOrCacheText(mount.previewsDir, drivePath, VCARD_FORMAT, parseVCardPreview, (priority) =>
        runFileTransformToText(mount, drivePath, VCARD_PREVIEW_JOB, { priority }),
    );
}

// The same cards from bytes the caller holds (a mail part): same Worker job, no cache.
export async function getBytesVCardPreview(data: ArrayBuffer): Promise<VCardPreview> {
    return parseVCardPreview(await runBytesTransformToText(VCARD_PREVIEW_JOB, data, {}));
}

const EML_PREVIEW_JOB: EmlPreviewJob = { kind: 'preview', documentType: 'eml' };

export function assertEmlPreviewable(fileName: string, contentType: string, size: number): void {
    if (!isEmlFile(contentType, fileName)) throw new ApiError(400, NOT_AN_EMAIL_FILE);
    if (size > EML_MAX_BYTES) throw new ApiError(413, 'File too large to preview');
}

// An .eml reads as the message it holds, never as its raw MIME source.
export async function getEmlPreview(mount: Mount, drivePath: DrivePath): Promise<Served<EmlPreview> | null> {
    return getOrCacheText(mount.previewsDir, drivePath, EML_FORMAT, parseEmlPreview, (priority) =>
        runFileTransformToText(mount, drivePath, EML_PREVIEW_JOB, { priority }),
    );
}

export async function getBytesEmlPreview(data: ArrayBuffer): Promise<EmlPreview> {
    return parseEmlPreview(await runBytesTransformToText(EML_PREVIEW_JOB, data, {}));
}

const ICS_PREVIEW_JOB: IcsPreviewJob = { kind: 'preview', documentType: 'ics' };

export function assertIcsPreviewable(fileName: string, contentType: string, size: number): void {
    if (!isIcsFile(contentType, fileName)) throw new ApiError(400, NOT_A_CALENDAR_FILE);
    if (size > ICS_MAX_BYTES) throw new ApiError(413, 'File too large to preview');
}

// An .ics reads as the events it holds, never as its raw property lines.
export async function getIcsPreview(mount: Mount, drivePath: DrivePath): Promise<Served<IcsPreview> | null> {
    return getOrCacheText(mount.previewsDir, drivePath, ICS_FORMAT, parseIcsPreview, (priority) =>
        runFileTransformToText(mount, drivePath, ICS_PREVIEW_JOB, { priority }),
    );
}

export async function getBytesIcsPreview(data: ArrayBuffer): Promise<IcsPreview> {
    return parseIcsPreview(await runBytesTransformToText(ICS_PREVIEW_JOB, data, {}));
}
