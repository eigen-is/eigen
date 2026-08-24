import { toast } from 'sonner';
import type {
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTextItem,
    EigenClipboardTypography,
} from '../../types/clipboard';
import type { DrivePath } from '../../types/drive';
import { getDriveDownloadUrl } from '../api';

const EIGEN_CLIPBOARD_MIME = 'application/eigen-clipboard';
const HTML_MARKER = 'data-eigen-clipboard';

// Geometry carried on every placeable clipboard item, in the source app's document-space units.
export type ClipboardBox = { width?: number; height?: number; angle?: number };

// Build an image item so producers never hand-assemble the five source-path fields (slides + docs
// wrote the same block verbatim) and geometry lands on the typed fields, never in `meta`. `source`
// is the media file's DrivePath; `meta` is app-private extras only (borders, objectFit).
export function buildImageClipboardItem(args: {
    mediaName: string;
    source: DrivePath;
    box?: ClipboardBox;
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
        width: args.box?.width,
        height: args.box?.height,
        angle: args.box?.angle,
        meta: args.meta,
    };
}

// Build a text item with geometry + typography on typed fields. `meta` is app-private extras only
// (slides borders + text-box background).
export function buildTextClipboardItem(args: {
    text: string;
    box?: ClipboardBox;
    typography?: EigenClipboardTypography;
    meta?: Record<string, unknown>;
}): EigenClipboardTextItem {
    return {
        type: 'text',
        text: args.text,
        width: args.box?.width,
        height: args.box?.height,
        angle: args.box?.angle,
        typography: args.typography,
        meta: args.meta,
    };
}

// Read the typed geometry off any item. Consumers size/rotate from this — there is no `meta` sniff
// to fall back to (geometry is only ever on the typed fields).
export function readClipboardBox(item: EigenClipboardItem): ClipboardBox {
    return { width: item.width, height: item.height, angle: item.angle };
}

function parseEigenJson(raw: string): EigenClipboardData | null {
    try {
        const data = JSON.parse(raw) as EigenClipboardData;
        if (data.version === 1 && Array.isArray(data.items)) return data;
    } catch {
        /* invalid data */
    }
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

export async function writeEigenClipboardAsync(data: EigenClipboardData, plainText?: string) {
    const json = JSON.stringify(data);
    const encoded = encodeURIComponent(json);
    const html = `<span ${HTML_MARKER}="${encoded}"></span>`;
    const items: Record<string, Blob> = {
        'text/html': new Blob([html], { type: 'text/html' }),
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
    _targetOwnerId: string,
    _targetMountId: string,
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
