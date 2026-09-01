import { toast } from 'sonner';
import type {
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTextItem,
    EigenClipboardTypography,
} from '../../types/clipboard';
import type { DrivePath } from '../../types/drive';
import {
    eigenMediaHref,
    listEigenMediaRefs,
    rewriteEigenMediaRefs,
    stripEigenMediaRefs,
} from '../../vector/media-refs';
import { getDriveDownloadUrl } from '../api';

const EIGEN_CLIPBOARD_MIME = 'application/eigen-clipboard';
const HTML_MARKER = 'data-eigen-clipboard';

// Geometry carried on every placeable clipboard item, in the source app's document-space units.
// Both dims are mandatory (see the type's contract note) — a producer that stores only one measures
// the other before it writes.
export type ClipboardBox = { width: number; height: number; angle?: number };

// Build an image item so producers never hand-assemble the five source-path fields (slides + docs
// wrote the same block verbatim) and geometry lands on the typed fields, never in `meta`. `source`
// is the media file's DrivePath; `meta` is app-private extras only (borders, objectFit).
export function buildImageClipboardItem(args: {
    mediaName: string;
    source: DrivePath;
    box: ClipboardBox;
    caption?: string;
    meta?: Record<string, unknown>;
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
        meta: args.meta,
    };
}

// Build a text item with geometry + typography on typed fields. `text` is plain text (see the type's
// contract note); `meta` is app-private extras only (slides borders + text-box background + rich html).
export function buildTextClipboardItem(args: {
    text: string;
    box: ClipboardBox;
    typography?: EigenClipboardTypography;
    meta?: Record<string, unknown>;
}): EigenClipboardTextItem {
    return {
        type: 'text',
        text: args.text,
        width: args.box.width,
        height: args.box.height,
        angle: args.box.angle,
        typography: args.typography,
        meta: args.meta,
    };
}

// Read the typed geometry off any item. Consumers size/rotate from this — there is no `meta` sniff
// to fall back to (geometry is only ever on the typed fields).
export function readClipboardBox(item: EigenClipboardItem): ClipboardBox {
    return { width: item.width, height: item.height, angle: item.angle };
}

// A text item with a real payload, not an empty carrier. Vector shapes ride the wire as empty text
// items (buildTextClipboardItem with text: ''); every consumer skips those so a foreign shape never
// lands as a blank paragraph/cell. The one home for that carrier convention.
export function clipboardTextItemHasContent(item: EigenClipboardTextItem): boolean {
    return item.text.trim().length > 0;
}

function parseEigenJson(raw: string): EigenClipboardData | null {
    try {
        const data = JSON.parse(raw) as EigenClipboardData;
        if (data.version !== 1 || !Array.isArray(data.items)) return null;
        // The wire is forgeable by any web page, and consumers place items straight from the typed
        // box with no fallbacks — so a missing/NaN dim must be dropped here, not written into a doc.
        return {
            version: 1,
            items: data.items.filter((i) => Number.isFinite(i.width) && Number.isFinite(i.height)),
            svg: typeof data.svg === 'string' ? data.svg : undefined,
        };
    } catch {
        /* invalid data */
    }
    return null;
}

// Embed an eigen payload into an SVG's `<metadata>` block (Excalidraw's svg-source pattern) so a
// self-contained SVG that travels alone still round-trips back to native elements. The JSON is
// URI-encoded (attribute-safe: no quotes/`<`/`&`), and the block is inserted right after the opening
// `<svg …>` tag; SVG renderers ignore `<metadata>`, so the drawing is unchanged. Callers embed the
// items-only payload (never the `svg` field itself) to avoid nesting a copy of the SVG in its own text.
export function embedClipboardSvgMetadata(svg: string, data: EigenClipboardData): string {
    const encoded = encodeURIComponent(JSON.stringify({ version: 1, items: data.items }));
    const block = `<metadata ${HTML_MARKER}="${encoded}"></metadata>`;
    const open = svg.indexOf('>');
    return open === -1 ? svg : svg.slice(0, open + 1) + block + svg.slice(open + 1);
}

// The inverse: pull an eigen payload back out of an SVG's `<metadata>` block. Returns null for any SVG
// without our marker (a foreign drawing), so a paste consumer can tell "our SVG" (restore elements)
// from "someone else's" (insert as an image).
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

// Wrap an SVG string as an `image/svg+xml` File so a paste consumer can feed it straight into its
// existing OS-image upload path (previews serve SVG as-is; `<image href>` renders it). One home for
// the conversion, shared by docs/sheets/slides/vector.
export function svgToImageFile(svg: string, name = 'drawing.svg'): File {
    return new File([svg], name, { type: 'image/svg+xml' });
}

// Base64 `data:` URI for a Blob's bytes. Cross-environment (browser + the bun test runtime): neither
// FileReader nor Node's Buffer is available in both, so we go through Blob.arrayBuffer + btoa over a
// chunked binary string. Private — callers reach it via inlineSvgMediaRefs / svgToImageDataUri.
async function blobToDataUri(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000; // stay well under the spread arg-count limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// A whole SVG string as a base64 `data:image/svg+xml` URI — the `src` for the foreign-visible `<img>`
// flavour the async menu-copy path writes. Goes through blobToDataUri so UTF-8 text in the drawing is
// encoded correctly (a naive btoa over the raw string throws on non-Latin1 characters).
export async function svgToImageDataUri(svg: string): Promise<string> {
    return blobToDataUri(new Blob([svg], { type: 'image/svg+xml' }));
}

// Soft cap on the total inlined payload (the sum of the image data-URIs). Beyond it the async copy
// path skips the foreign `<img>` flavour entirely rather than put a multi-MB, clipboard-rejectable
// blob on the clipboard — the eigen name-ref svg still travels for every eigen host. base64 inflates
// the raw bytes ~1.37×, so a ~3MB image already lands here.
const INLINE_SVG_SOFT_CAP_BYTES = 4 * 1024 * 1024;

// Inline an image-bearing vector SVG's `eigen-media:` name refs into self-contained base64 data URIs,
// for the foreign-visible copy flavour (an `<img src="data:image/svg+xml…">` that no eigen server-side
// inliner will serve). `resolve` fetches a ref's bytes — the caller wires it to the credentialed media
// resolver; a null/failed fetch STRIPS that image's ref exactly as materializeClipboardSvg strips a
// failed re-upload, so the svg never references bytes it can't show. Returns the svg unchanged when it
// has no refs, or null when the total inlined payload would exceed the soft cap (the caller then skips
// the foreign flavour). React-free: the browser fetch belongs to the caller, passed in as `resolve`.
export async function inlineSvgMediaRefs(
    svg: string,
    resolve: (name: string) => Promise<Blob | null>,
): Promise<string | null> {
    const refs = listEigenMediaRefs(svg);
    if (refs.length === 0) return svg;

    const resolved = await Promise.all(
        refs.map(async (name) => {
            const blob = await resolve(name).catch(() => null);
            return { name, dataUri: blob ? await blobToDataUri(blob) : null };
        }),
    );

    const dataUris = new Map<string, string>();
    const failed = new Set<string>();
    let total = 0;
    for (const { name, dataUri } of resolved) {
        if (!dataUri) {
            failed.add(name);
            continue;
        }
        total += dataUri.length;
        if (total > INLINE_SVG_SOFT_CAP_BYTES) return null;
        dataUris.set(name, dataUri);
    }

    // Swap each resolved ref's exact `href="…"` for its data URI (the same token-precise replace as
    // stripEigenMediaRefs, only the target is a data URI instead of removal), then strip the failures.
    let out = svg;
    for (const [name, dataUri] of dataUris) {
        out = out.split(` href="${eigenMediaHref(name)}"`).join(` href="${dataUri}"`);
    }
    return stripEigenMediaRefs(out, failed);
}

// The SVG a paste consumer should treat as an image: vector's copy flavour (the `svg` field on the
// eigen payload) first, then a `text/plain` that is a whole SVG document (a foreign drawing). Null when
// neither is present. eigen-aware hosts call this BEFORE consuming the typed items so a vector selection
// lands as one image, not N shape carriers — and consuming the paste there is what prevents a
// double-paste. The plain-text arm requires the SVG namespace on the root tag — every real SVG export
// (ours, Excalidraw's, an .svg file's text) carries it, while a hand-pasted `<svg>` code snippet
// usually doesn't and must stay text.
export function readSvgClipboard(clipboardData: DataTransfer): string | null {
    return readSvgClipboardWithItems(clipboardData)?.svg ?? null;
}

// The SVG a paste consumer should materialize, together with the typed items that back its
// `eigen-media:` refs — the re-upload manifest `materializeClipboardSvg` fetches from. One read for
// the host, so it never parses the payload twice (readSvgClipboard delegates here). Mirrors that
// function's two arms: a vector copy's `svg` field arrives with its image items; a foreign SVG on
// text/plain has none. Null when there's no SVG to paste. The plain-text arm requires the SVG
// namespace on the root tag (a hand-pasted `<svg>` snippet without it stays text).
export function readSvgClipboardWithItems(
    clipboardData: DataTransfer,
): { svg: string; items: EigenClipboardItem[] } | null {
    const eigen = readEigenClipboard(clipboardData);
    if (eigen?.svg) return { svg: eigen.svg, items: eigen.items };
    const plain = clipboardData.getData('text/plain').trimStart();
    if (/^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(plain)) return { svg: plain, items: [] };
    return null;
}

// True when the clipboard's `text/html` carries real content beyond the eigen marker span — i.e. a
// rich-HTML producer wrote `marker + html` (docs figures, sheets tables) rather than a marker-only
// write (slides objects, which pass no html). Consumers use it to choose between letting the platform
// parse the HTML (rich content present — a sheets <table> lands as a real table) and consuming the
// typed eigen items directly (marker-only — platform fallthrough would paste nothing). Wrapper noise
// the OS clipboard adds (`<meta charset>`, `<html>`/`<body>`) is ignored: the marker element is
// removed from a parsed document, then the body is tested for text or an embedded/structural element.
export function hasRichHtmlBeyondMarker(clipboardData: DataTransfer): boolean {
    const html = clipboardData.getData('text/html');
    if (!html) return false;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll(`[${HTML_MARKER}]`)) el.remove();
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

// Async read of eigen data via the Async Clipboard API, for handlers with no ClipboardEvent to read
// (a context-menu Paste row). Symmetric with writeEigenClipboardAsync: the payload rides the
// `text/html` marker span (custom MIME types can't survive navigator.clipboard). Returns null when
// the read is denied/unavailable or no marker is present.
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
    // html may resolve later (the svg data-URI inliner fetches media): hand ClipboardItem a promise
    // so navigator.clipboard.write starts inside the user gesture — Safari/Firefox reject a write
    // whose activation window expired while awaiting the fetch.
    const items: Record<string, Blob | Promise<Blob>> = {
        'text/html': Promise.resolve(html).then((h) => new Blob([h ? marker + h : marker], { type: 'text/html' })),
    };
    if (plainText) {
        items['text/plain'] = new Blob([plainText], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(items)]);
}

export function copyToClipboard(text: string, message = 'Copied to clipboard') {
    navigator.clipboard.writeText(text);
    toast.success(message);
}

export function needsReUpload(sourceParentId: string | null | undefined, targetMediaFolderId: string | null): boolean {
    if (!sourceParentId || !targetMediaFolderId) return false;
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
        // The source fetch isn't a mutation, so surface it here; upload-leg failures
        // already toast via useUploadFile's onMutationError.
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
        // Upload failure already toasts via useUploadFile's onMutationError.
    }
    return null;
}

// Materialize an image-bearing vector SVG (its images referenced BY NAME via `eigen-media:` hrefs)
// into a File ready for the target container's normal image-upload path. For
// each ref, its typed image item is the fetch manifest: cross-container refs re-upload through the
// existing credentialed `reUploadImage` seam (in parallel), same-folder refs keep their name, and the
// stored SVG's refs are rewritten old→final (collision renames) or stripped for uploads that failed or
// have no typed item — the drawing only ever references names that exist in the target's media/. Undo
// is the host's single svg-insert step, exactly as an image paste today; the uploads are not undoable.
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
            // A ref with no typed item (e.g. its item was dropped as forged) has no fetch manifest —
            // strip it so the stored svg never references a name that won't exist in media/.
            if (!item) {
                failed.add(name);
                return;
            }
            // Same-folder paste: the name already resolves against the target's own siblings.
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

    // Rewrite successes (still under their original token), then strip failures by their original name.
    return svgToImageFile(stripEigenMediaRefs(rewriteEigenMediaRefs(svg, renames), failed));
}
