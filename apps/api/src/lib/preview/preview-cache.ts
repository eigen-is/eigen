// The preview cache: a file's previews, each built once per version and kept in the mount's previewsDir. The drive and
// mail routes call it, for example through getTextPreview, getScreenPreview and getEmlPreview. A collab document's or
// a card's preview is built in the transform process, a plain text file's and an image's here. A name stamped with
// updatedAt and the format lets a new version or renderer write a new file, so a response can be cached long.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBytesTextPreviewMode, TEXT_PREVIEW_MAX_BYTES } from '@workspace/lib/constants';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isCollabType } from '@workspace/lib/types/drive';
import { isEmlFile, isIcsFile, isVCardFile } from '@workspace/lib/types/file-kinds';
import type { EmlPreview, IcsPreview, TextPreviewResult, VCardPreview } from '@workspace/lib/types/preview';
import { ApiError } from '../core/errors';
import { NOT_A_CALENDAR_FILE, NOT_A_VCARD_FILE, NOT_AN_EMAIL_FILE } from '../core/transfer';
import { COLLAB_DOCUMENT_TYPES } from '../document/collab-types';
import type { EmlPreviewJob, IcsPreviewJob, PreviewResult, VCardPreviewJob } from '../document/transform/protocol';
import {
    runBytesTransformToText,
    runFileTransformToText,
    TransformFailedError,
} from '../document/transform/run-transform';
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

function screenCacheName(drivePath: DrivePath, ext: 'webp' | 'svg'): string {
    return `${drivePath.id}-${drivePath.updatedAt.getTime()}.screen.${ext}`;
}

// A format names the shape of its renderer's output and is part of the cache name. Bump it whenever that shape or a
// typed payload's type changes: a parser refuses only a body it can't read, so the old shape would be served.
export const TEXT_FORMAT = 'f8';
export const VCARD_FORMAT = 'vcard-f1';
// Bumped on every DOMPurify upgrade too: a cached message is HTML the previous sanitizer filtered.
export const EML_FORMAT = 'eml-f5';
export const ICS_FORMAT = 'ics-f2';

// The largest side of an image's screen preview.
const SCREEN_PREVIEW_MAX_SIZE = 2560;

function textCacheName(drivePath: DrivePath, format: string): string {
    return `${drivePath.id}-${drivePath.updatedAt.getTime()}.${format}.json`;
}

// A job that ran out of time or memory will again, holding the only transform slot, so an empty marker beside its
// cache file remembers the failure. A loaded host or a since-fixed crash fails the same way, so it counts for an hour.
const FAILED_MARKER_MS = 60 * 60 * 1000;

function failedMarker(cacheFile: string): string {
    return `${cacheFile}.failed`;
}

function failedRecently(cacheFile: string): boolean {
    const marker = fs.statSync(failedMarker(cacheFile), { throwIfNoEntry: false });
    return marker !== undefined && Date.now() - marker.mtimeMs < FAILED_MARKER_MS;
}

async function rememberIfRepeatable(cacheFile: string, err: unknown): Promise<void> {
    if (!(err instanceof TransformFailedError && err.repeats)) return;
    await writeCacheFile(failedMarker(cacheFile), '').catch(() => {});
}

async function pruneOldVersions(previewsDir: string, pathId: string, keep: string): Promise<void> {
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
    const tempFile = path.join(path.dirname(cacheFile), `.${path.basename(cacheFile)}.tmp-${crypto.randomUUID()}`);
    try {
        await Bun.write(tempFile, data);
        await fs.promises.rename(tempFile, cacheFile);
    } catch (err) {
        await fs.promises.unlink(tempFile).catch(() => {});
        throw err;
    }
}

// The generation running for each cache name, so a folder grid of N tiles for one just-added image or
// just-edited doc starts one job instead of N. A request that joins a job waits at that job's priority.
const inFlightImages = new Map<string, Promise<Buffer | null>>();
const inFlightTexts = new Map<string, Promise<PreviewResult | null>>();

function generateOnce<T>(
    inFlight: Map<string, Promise<T | null>>,
    previewsDir: string,
    pathId: string,
    cacheName: string,
    generate: () => Promise<T | null>,
    serialize: (result: T) => Buffer | string,
): Promise<T | null> {
    const existing = inFlight.get(cacheName);
    if (existing) return existing;
    const task = (async () => {
        const result = await generate();
        if (result === null) return null;
        await writeCacheFile(path.join(previewsDir, cacheName), serialize(result));
        pruneOldVersions(previewsDir, pathId, cacheName).catch(() => {});
        return result;
    })().finally(() => inFlight.delete(cacheName));
    inFlight.set(cacheName, task);
    return task;
}

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

    const data = await generateOnce(inFlightImages, previewsDir, pathId, cacheName, generate, (bytes) => bytes);
    return data === null ? null : { type: 'image', data, contentType };
}

// A stale value is an earlier version's, served while the current one regenerates.
type Served<T> = { value: T; stale: boolean };

// A first miss is foreground work the request waits on, a stale regeneration background work the runner may drop
// under load. A plain file's generator ignores it.
type TextPreviewGenerator = (priority: TransformPriority) => Promise<PreviewResult | null>;

// A body the parser rejects counts as a corrupt file.
type CachedTextParser<T> = (cached: PreviewResult) => T;

// The typed previews' payload is the JSON their body holds.
function bodyOnly(body: string | null): PreviewResult | null {
    return body === null ? null : { body };
}

// An unusable file is deleted: it is the current version, so it would be read again on every request, and a stale
// read starts no regeneration of a cache name that exists.
async function readCachedText<T>(cacheFile: string, parse: CachedTextParser<T>): Promise<T | null> {
    if (!fs.existsSync(cacheFile)) return null;
    try {
        const cached: PreviewResult = await Bun.file(cacheFile).json();
        return parse(cached);
    } catch (err) {
        console.error(`[preview] Discarding unreadable cache file ${cacheFile}:`, err);
        await fs.promises.unlink(cacheFile).catch(() => {});
        return null;
    }
}

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
    const failed = failedRecently(cacheFile);
    const generateText = (priority: TransformPriority) =>
        generateOnce(
            inFlightTexts,
            previewsDir,
            pathId,
            cacheName,
            async () => {
                try {
                    const result = await generate(priority);
                    return result?.body ? result : null;
                } catch (err) {
                    // Overload is not "no preview", and neither is a file the renderer refused: a controlled
                    // status reaches the client instead of being cached as a 404.
                    if (err instanceof ApiError) throw err;
                    console.error(`[preview] Failed to generate ${format} preview for ${pathId}:`, err);
                    await rememberIfRepeatable(cacheFile, err);
                    return null;
                }
            },
            JSON.stringify,
        );

    // A cached previous version is served while the current one regenerates in the background.
    const stale = await readNewestStaleText(previewsDir, pathId, cacheName, format, parse);
    if (stale !== null) {
        if (!failed) generateText('background').catch(() => {});
        return { value: stale, stale: true };
    }
    if (failed) return null;

    const generated = await generateText('foreground');
    return generated === null ? null : { value: parse(generated), stale: false };
}

async function readNewestStaleText<T>(
    previewsDir: string,
    pathId: string,
    cacheName: string,
    format: string,
    parse: CachedTextParser<T>,
): Promise<T | null> {
    const prefix = `${pathId}-`;
    const files = await fs.promises.readdir(previewsDir);
    // Current-format names only: a body another format wrote has another shape, which the client would lay out wrong.
    const suffix = `.${format}.json`;
    const candidates = files
        .filter((name) => name !== cacheName && name.startsWith(prefix) && name.endsWith(suffix))
        .map((name) => ({ name, stamp: Number(name.slice(prefix.length, -suffix.length)) }))
        .filter((c) => Number.isFinite(c.stamp))
        .sort((a, b) => b.stamp - a.stamp);

    for (const { name } of candidates) {
        try {
            const cached: PreviewResult = await Bun.file(path.join(previewsDir, name)).json();
            return parse(cached);
        } catch {
            // Pruned between readdir and read, or of a shape the parser refuses — try the next-newest.
        }
    }
    return null;
}

export function isScreenPreviewRedirect(mime: string): boolean {
    return mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf';
}

export async function getScreenPreview(
    mount: Mount,
    drivePath: DrivePath,
    embedUrl: string,
): Promise<ScreenPreviewResult> {
    const mime = drivePath.mimeType || '';

    if (isScreenPreviewRedirect(mime)) {
        return { type: 'redirect', url: embedUrl };
    }

    // An SVG is served as itself, its `eigen-media:` images inlined because an SVG in an <img> fetches nothing. A
    // sibling's edit keeps the svg's stamp, so the cached copy shows the old image until the svg itself changes.
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
                    maxSize: SCREEN_PREVIEW_MAX_SIZE,
                    quality: 85,
                });
                return result?.data ?? null;
            },
        );
    }

    return null;
}

// The container type decides, never the mime: an uploader picks the mime, and a plain file wearing an Eigen mime
// previews as its bytes.
export async function getTextPreview(mount: Mount, drivePath: DrivePath): Promise<Served<TextPreviewResult> | null> {
    const documentType = isCollabType(drivePath.type) ? COLLAB_DOCUMENT_TYPES.get(drivePath.mimeType || '') : undefined;
    const mode = documentType ?? getBytesTextPreviewMode(drivePath.mimeType || '', drivePath.name);
    if (mode === null) return null;
    // Refused off the row's size, before any read; a container's size is its databases, not its body.
    if (!documentType && drivePath.size > TEXT_PREVIEW_MAX_BYTES) return null;

    return getOrCacheText(
        mount.previewsDir,
        drivePath,
        TEXT_FORMAT,
        (cached) => ({ ...cached, mode }),
        (priority) =>
            documentType
                ? generateDocumentPreview(documentType, mount, drivePath, priority)
                : generateFileTextPreview(mount, drivePath),
    );
}

async function generateFileTextPreview(mount: Mount, drivePath: DrivePath): Promise<PreviewResult | null> {
    const bytes = await mount.readBytes(drivePath.id);
    if (!bytes) return null;
    const preview = await getBytesTextPreview(bytes, drivePath.name, drivePath.mimeType || '');
    return bodyOnly(preview?.body ?? null);
}

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

export async function getVCardPreview(mount: Mount, drivePath: DrivePath): Promise<Served<VCardPreview> | null> {
    return getOrCacheText(
        mount.previewsDir,
        drivePath,
        VCARD_FORMAT,
        ({ body }) => parseVCardPreview(body),
        (priority) => runFileTransformToText(mount, drivePath, VCARD_PREVIEW_JOB, { priority }).then(bodyOnly),
    );
}

export async function getBytesVCardPreview(data: ArrayBuffer): Promise<VCardPreview> {
    return parseVCardPreview(await runBytesTransformToText(VCARD_PREVIEW_JOB, data, {}));
}

const EML_PREVIEW_JOB: EmlPreviewJob = { kind: 'preview', documentType: 'eml' };

export function assertEmlPreviewable(fileName: string, contentType: string, size: number): void {
    if (!isEmlFile(contentType, fileName)) throw new ApiError(400, NOT_AN_EMAIL_FILE);
    if (size > EML_MAX_BYTES) throw new ApiError(413, 'File too large to preview');
}

export async function getEmlPreview(mount: Mount, drivePath: DrivePath): Promise<Served<EmlPreview> | null> {
    return getOrCacheText(
        mount.previewsDir,
        drivePath,
        EML_FORMAT,
        ({ body }) => parseEmlPreview(body),
        (priority) => runFileTransformToText(mount, drivePath, EML_PREVIEW_JOB, { priority }).then(bodyOnly),
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

export async function getIcsPreview(mount: Mount, drivePath: DrivePath): Promise<Served<IcsPreview> | null> {
    return getOrCacheText(
        mount.previewsDir,
        drivePath,
        ICS_FORMAT,
        ({ body }) => parseIcsPreview(body),
        (priority) => runFileTransformToText(mount, drivePath, ICS_PREVIEW_JOB, { priority }).then(bodyOnly),
    );
}

export async function getBytesIcsPreview(data: ArrayBuffer): Promise<IcsPreview> {
    return parseIcsPreview(await runBytesTransformToText(ICS_PREVIEW_JOB, data, {}));
}
