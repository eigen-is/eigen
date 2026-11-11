// Eigen's own clipboard payload: the items one app copies, such as an image, a text box or a chart, with their
// geometry on typed fields, carried in the HTML and SVG beside what other apps paste. The apps' copy and paste hooks
// build and read every item through these helpers, and a paste drops any item that doesn't match its own shape.

import { toast } from 'sonner';
import { exceedsChartSpecDepth } from '../../charts/limits';
import { readChartLook } from '../../charts/look';
import { chartSpecTexts, readChartSpec } from '../../charts/spec';
import type { ChartSpecTexts } from '../../types/chart';
import { isChartSpecPartKey } from '../../types/chart';
import type {
    EigenClipboardChartItem,
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTextItem,
    EigenClipboardTypography,
} from '../../types/clipboard';
import type { DrivePath } from '../../types/drive';
import {
    listEigenMediaRefs,
    replaceEigenMediaHrefs,
    rewriteEigenMediaRefs,
    stripEigenMediaRefs,
} from '../../vector/media-refs';
import { getDriveDownloadUrl } from '../api';
import { onMutationError } from '../api-error';
import { bytesToBase64 } from '../format';
import { isRecord } from '../guards';

const EIGEN_CLIPBOARD_MIME = 'application/eigen-clipboard';
const HTML_MARKER = 'data-eigen-clipboard';

// Marks the `<img>` a vector copy appends for hosts that are not Eigen. hasRichHtmlBeyondMarker ignores it, or a
// shape-only copy would read as rich HTML and land in a doc as a stored figure.
export const EIGEN_CLIPBOARD_RENDER_ATTR = 'data-eigen-clipboard-render';

// An item's size in the source app's document units. A producer that stores one dimension measures the other first.
export type ClipboardBox = { width: number; height: number; angle?: number };

// `source` is the media file's path, which a paste into another document re-uploads from.
export function buildImageClipboardItem(args: {
    mediaName: string;
    source: DrivePath;
    box: ClipboardBox;
    caption?: string;
}): EigenClipboardImageItem {
    return {
        type: 'image',
        mediaName: args.mediaName,
        sourcePathId: args.source.id,
        sourceParentId: args.source.parentId,
        sourceOwnerId: args.source.ownerId,
        sourceMountId: args.source.mountId,
        caption: args.caption,
        width: args.box.width,
        height: args.box.height,
        angle: args.box.angle,
    };
}

export function buildTextClipboardItem(args: {
    text: string;
    box: ClipboardBox;
    typography?: EigenClipboardTypography;
}): EigenClipboardTextItem {
    return {
        type: 'text',
        text: args.text,
        width: args.box.width,
        height: args.box.height,
        angle: args.box.angle,
        typography: args.typography,
    };
}

// One of the eight parts' keys, under its text.
const isPartText = (entry: [string, unknown]): entry is [string, string] =>
    isChartSpecPartKey(entry[0]) && typeof entry[1] === 'string';

// The builder and the reader share this test, since a paste stores the parts as they came: only part keys, each a
// text, within the spec's byte and depth limits, with inline data that reads.
function isInlineChartParts(parts: unknown): parts is ChartSpecTexts {
    if (!isRecord(parts)) return false;
    const texts = Object.entries(parts);
    if (!texts.every(isPartText)) return false;
    // readChartSpec counts the bytes, so only a chart within them is walked for its depth.
    if (readChartSpec(parts).spec?.data.source !== 'inline') return false;
    return !texts.some(([, text]) => exceedsChartSpecDepth(text));
}

// Null for parts no consumer could draw, such as range data. The parts ride as their holder stores them, never
// serialized again, so one that doesn't parse arrives as it left.
export function buildChartClipboardItem(args: {
    chart: Readonly<Record<string, unknown>>;
    box: Pick<ClipboardBox, 'width' | 'height'>;
    look: Record<string, unknown>;
}): EigenClipboardChartItem | null {
    const parts = chartSpecTexts(args.chart);
    if (!isInlineChartParts(parts)) return null;
    const look = readChartLook(args.look);
    return { type: 'chart', parts, width: args.box.width, height: args.box.height, look };
}

export function readClipboardBox(item: EigenClipboardItem): ClipboardBox {
    // An elements item's box is its selection's bounds, which has no rotation, and a chart has none.
    const angle = item.type === 'text' || item.type === 'image' ? item.angle : undefined;
    return { width: item.width, height: item.height, angle };
}

// The canvas writes a text item for every text box, an empty one too, which no consumer may land as a blank paragraph
// or cell.
export function clipboardTextItemHasContent(item: EigenClipboardTextItem): boolean {
    return item.text.trim().length > 0;
}

// Any web page can write the wire, and every consumer reads the typed fields with no fallback, so an item that
// doesn't match its own variant is dropped here and costs the paste nothing else.
function isValidItem(item: unknown): item is EigenClipboardItem {
    if (!isRecord(item)) return false;
    if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) return false;
    if (item.angle !== undefined && !Number.isFinite(item.angle)) return false;
    switch (item.type) {
        case 'text':
            return typeof item.text === 'string';
        case 'image':
            return (
                typeof item.mediaName === 'string' &&
                typeof item.sourcePathId === 'string' &&
                (item.sourceParentId === null || typeof item.sourceParentId === 'string') &&
                typeof item.sourceOwnerId === 'string' &&
                typeof item.sourceMountId === 'string'
            );
        case 'elements':
            // The canvas reads each record through its own element reader, which holds hostile values to their ranges.
            return Array.isArray(item.elements) && typeof item.sourceFrameId === 'string';
        case 'chart':
            return isInlineChartParts(item.parts);
        default:
            return false;
    }
}

// A chart's look through the chart look validators, so every consumer stores what a canvas reader would keep.
function withChartLook(item: EigenClipboardItem): EigenClipboardItem {
    if (item.type !== 'chart') return item;
    return { ...item, look: readChartLook(isRecord(item.look) ? item.look : {}) };
}

function parseEigenJson(raw: string): EigenClipboardData | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null; /* invalid data */
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return {
        version: 1,
        items: parsed.items.filter(isValidItem).map(withChartLook),
        svg: typeof parsed.svg === 'string' ? parsed.svg : undefined,
    };
}

// The items ride in the SVG's `<metadata>` block, which renderers ignore, so an SVG that travels alone pastes back
// as elements. The `svg` field stays out, or the SVG would nest a copy of itself.
export function embedClipboardSvgMetadata(svg: string, data: EigenClipboardData): string {
    const encoded = encodeURIComponent(JSON.stringify({ version: 1, items: data.items }));
    const block = `<metadata ${HTML_MARKER}="${encoded}"></metadata>`;
    const open = svg.indexOf('>');
    return open === -1 ? svg : svg.slice(0, open + 1) + block + svg.slice(open + 1);
}

// Null for an SVG without the marker, which a paste inserts as an image.
export function extractClipboardSvgMetadata(svg: string): EigenClipboardData | null {
    const match = svg.match(new RegExp(`<metadata[^>]*${HTML_MARKER}="([^"]*?)"`));
    if (!match?.[1]) return null;
    try {
        return parseEigenJson(decodeURIComponent(match[1]));
    } catch {
        /* invalid encoding */
    }
    return null;
}

export function svgToImageFile(svg: string, name = 'drawing.svg'): File {
    return new File([svg], name, { type: 'image/svg+xml' });
}

async function blobToDataUri(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

// Through a Blob, since btoa over the raw string throws on a character outside Latin-1.
export async function svgToImageDataUri(svg: string): Promise<string> {
    return blobToDataUri(new Blob([svg], { type: 'image/svg+xml' }));
}

// Past either cap a canvas copy skips its SVG flavor, which repeats every record. The count is checked before the
// render, and the bytes catch a few huge elements, such as long freehand lines.
export const CLIPBOARD_SVG_MAX_ELEMENTS = 300;
export const CLIPBOARD_SVG_MAX_BYTES = 512 * 1024;

// The most the inlined images may add up to, as base64. Past it the copy skips the flavor for other hosts, since a
// clipboard may refuse a write that large.
const INLINE_SVG_SOFT_CAP_BYTES = 4 * 1024 * 1024;

// The SVG with each image it names inlined as a data URI, for a host that can't fetch them. An image `resolve` can't
// fetch is taken out, so the SVG names nothing it can't show. Null past the cap.
export async function inlineClipboardSvgMedia(
    svg: string,
    resolve: (name: string) => Promise<Blob | null>,
): Promise<string | null> {
    const { dataUris, failed } = await resolveSvgMedia(svg, resolve);
    let total = 0;
    for (const dataUri of dataUris.values()) {
        total += dataUri.length;
        if (total > INLINE_SVG_SOFT_CAP_BYTES) return null;
    }
    return stripEigenMediaRefs(replaceEigenMediaHrefs(svg, dataUris), failed);
}

// The same inline with no cap, for a downloaded image: a file, not a clipboard entry.
export async function inlineSvgMedia(svg: string, resolve: (name: string) => Promise<Blob | null>): Promise<string> {
    const { dataUris, failed } = await resolveSvgMedia(svg, resolve);
    return stripEigenMediaRefs(replaceEigenMediaHrefs(svg, dataUris), failed);
}

async function resolveSvgMedia(
    svg: string,
    resolve: (name: string) => Promise<Blob | null>,
): Promise<{ dataUris: Map<string, string>; failed: Set<string> }> {
    const resolved = await Promise.all(
        listEigenMediaRefs(svg).map(async (name) => {
            const blob = await resolve(name).catch(() => null);
            return { name, dataUri: blob ? await blobToDataUri(blob) : null };
        }),
    );
    const dataUris = new Map<string, string>();
    const failed = new Set<string>();
    for (const { name, dataUri } of resolved) {
        if (dataUri) dataUris.set(name, dataUri);
        else failed.add(name);
    }
    return { dataUris, failed };
}

// The SVG to paste, with the image items its names resolve through: a vector copy's own, or one on text/plain with
// none. Plain text counts only with the SVG namespace on its root, which an export has and a typed snippet lacks.
export function readSvgClipboardWithItems(
    clipboardData: DataTransfer,
    eigen: EigenClipboardData | null = readEigenClipboard(clipboardData),
): { svg: string; items: EigenClipboardItem[] } | null {
    if (eigen?.svg) return { svg: eigen.svg, items: eigen.items };
    const plain = clipboardData.getData('text/plain').trimStart();
    if (/^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(plain)) return { svg: plain, items: [] };
    return null;
}

// Whether the HTML holds content beside the marker, such as a doc's figure or a sheet's table, which a consumer lets
// the platform parse. With the marker alone it reads the typed items.
export function hasRichHtmlBeyondMarker(clipboardData: DataTransfer): boolean {
    const html = clipboardData.getData('text/html');
    if (!html) return false;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll(`[${HTML_MARKER}], [${EIGEN_CLIPBOARD_RENDER_ATTR}]`)) el.remove();
    if ((doc.body.textContent ?? '').trim().length > 0) return true;
    return doc.body.querySelector('img, table, figure, hr, picture, svg, video, li') != null;
}

export function readEigenClipboard(clipboardData: DataTransfer): EigenClipboardData | null {
    const raw = clipboardData.getData(EIGEN_CLIPBOARD_MIME);
    if (raw) return parseEigenJson(raw);

    const html = clipboardData.getData('text/html');
    if (html) {
        const match = html.match(new RegExp(`${HTML_MARKER}="([^"]*?)"`));
        if (match?.[1]) {
            try {
                return parseEigenJson(decodeURIComponent(match[1]));
            } catch {
                /* invalid encoding */
            }
        }
    }
    return null;
}

// For a handler with no ClipboardEvent, such as a menu's Paste row. Only the marker in `text/html` is read, since
// navigator.clipboard carries no custom MIME type.
export async function readEigenClipboardAsync(): Promise<EigenClipboardData | null> {
    try {
        const clipItems = await navigator.clipboard.read();
        for (const clip of clipItems) {
            if (!clip.types.includes('text/html')) continue;
            const html = await (await clip.getType('text/html')).text();
            const match = html.match(new RegExp(`${HTML_MARKER}="([^"]*?)"`));
            if (match?.[1]) {
                try {
                    return parseEigenJson(decodeURIComponent(match[1]));
                } catch {
                    /* invalid encoding */
                }
            }
        }
    } catch {
        /* clipboard read denied or unavailable */
    }
    return null;
}

export function writeEigenClipboard(e: ClipboardEvent, data: EigenClipboardData, plainText?: string, html?: string) {
    e.clipboardData?.setData(EIGEN_CLIPBOARD_MIME, JSON.stringify(data));
    const encoded = encodeURIComponent(JSON.stringify(data));
    const marker = `<span data-eigen-clipboard="${encoded}"></span>`;
    e.clipboardData?.setData('text/html', html ? marker + html : marker);
    if (plainText) {
        e.clipboardData?.setData('text/plain', plainText);
    }
}

export async function writeEigenClipboardAsync(
    data: EigenClipboardData,
    plainText?: string,
    html?: string | Promise<string | null | undefined>,
) {
    const json = JSON.stringify(data);
    const encoded = encodeURIComponent(json);
    const marker = `<span ${HTML_MARKER}="${encoded}"></span>`;
    // The write must start inside the user's gesture, which Safari and Firefox let expire during a fetch, so html
    // that resolves later goes in as a promise. One that rejects still writes the marker and the plain text.
    const items: Record<string, Blob | Promise<Blob>> = {
        'text/html': Promise.resolve(html)
            .catch(() => undefined)
            .then((h) => new Blob([h ? marker + h : marker], { type: 'text/html' })),
    };
    if (plainText) {
        items['text/plain'] = new Blob([plainText], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(items)]);
}

export function copyToClipboard(text: string, message = 'Copied to clipboard'): Promise<void> {
    return navigator.clipboard.writeText(text).then(() => {
        toast.success(message);
    }, onMutationError);
}

// A wire item with no source folder (forged or incomplete) resolves nowhere, so it re-uploads.
export function needsReUpload(sourceParentId: string | null | undefined, targetMediaFolderId: string | null): boolean {
    if (!targetMediaFolderId) return false;
    return sourceParentId !== targetMediaFolderId;
}

export async function reUploadImage(
    sourcePathId: string,
    sourceOwnerId: string,
    sourceMountId: string,
    mediaFolderId: string,
    uploadFn: (args: { parentId: string; file: File }) => Promise<DrivePath | null>,
    fileName: string,
): Promise<{ mediaName: string; pathId: string; parentId: string } | null> {
    let file: File;
    try {
        const downloadUrl = getDriveDownloadUrl(sourceOwnerId, sourceMountId, sourcePathId);
        const response = await fetch(downloadUrl, { credentials: 'include' });
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const blob = await response.blob();
        file = new File([blob], fileName, { type: blob.type || 'image/png' });
    } catch (e) {
        // The fetch is no mutation, so it reports its own failure. A failed upload reports through its hook.
        console.error('Image re-upload download failed:', e);
        toast.error('Could not load the pasted image');
        return null;
    }
    try {
        const result = await uploadFn({ parentId: mediaFolderId, file });
        if (result) {
            return {
                mediaName: result.name,
                pathId: result.id,
                parentId: mediaFolderId,
            };
        }
    } catch {
        // The upload hook reported it.
    }
    return null;
}

// The SVG as a file for the target's image upload, each image it names uploaded to the target's media folder first.
// A name is rewritten to the one its upload got, and taken out when the upload failed or no item backs it.
export async function materializeClipboardSvg(
    svg: string,
    items: EigenClipboardItem[],
    mediaFolderId: string,
    uploadFn: (args: { parentId: string; file: File }) => Promise<DrivePath | null>,
): Promise<File> {
    const refs = listEigenMediaRefs(svg);
    if (refs.length === 0) return svgToImageFile(svg);

    const imagesByName = new Map<string, EigenClipboardImageItem>();
    for (const item of items) {
        if (item.type === 'image' && !imagesByName.has(item.mediaName)) imagesByName.set(item.mediaName, item);
    }

    const renames = new Map<string, string>();
    const failed = new Set<string>();
    await Promise.all(
        refs.map(async (name) => {
            const item = imagesByName.get(name);
            if (!item) {
                failed.add(name);
                return;
            }
            if (!needsReUpload(item.sourceParentId, mediaFolderId)) return;
            const result = await reUploadImage(
                item.sourcePathId,
                item.sourceOwnerId,
                item.sourceMountId,
                mediaFolderId,
                uploadFn,
                item.mediaName,
            );
            if (result) renames.set(name, result.mediaName);
            else failed.add(name);
        }),
    );

    return svgToImageFile(stripEigenMediaRefs(rewriteEigenMediaRefs(svg, renames), failed));
}
