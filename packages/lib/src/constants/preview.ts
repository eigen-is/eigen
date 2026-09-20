import {
    CODE_EXTENSIONS,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_VECTOR,
    isIcsFile,
    isVCardFile,
} from '../types/drive';

const CODE_MIMES = [
    'text/',
    'application/json',
    'application/javascript',
    'application/typescript',
    'application/xml',
    'application/x-yaml',
    'application/x-sh',
    'application/toml',
];

const EXIFTOOL_EXTENSIONS = new Set([
    '.cr2',
    '.cr3',
    '.nef',
    '.arw',
    '.dng',
    '.orf',
    '.rw2',
    '.raf',
    '.pef',
    '.srw',
    '.rwl',
    '.psd',
    '.psb',
    '.ai',
    '.heic',
    '.heif',
]);

// What a browser decodes in an <img> by itself; SVG included, an <img> never runs script.
export const BROWSER_IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp',
    'image/svg+xml',
]);

// What loose bytes render as; the other TextPreviewModes are collab documents rendered from Yjs.
export type BytesTextPreviewMode = 'markdown' | 'plaintext' | 'code';

export type TextPreviewMode = BytesTextPreviewMode | 'eigendoc' | 'eigenslides' | 'eigensheets' | 'eigenvector';

// The logical box a canvas preview body is composed at: the drive hero scales a preview from its
// intrinsic width (drive-preview.tsx), so a drawing of any size previews through one known number,
// and the height caps how far a tall, narrow drawing may be magnified. 16:9, the hero's own ratio.
export const CANVAS_PREVIEW_WIDTH = 960;
export const CANVAS_PREVIEW_HEIGHT = 540;

// Above this a text preview is refused, Drive and mail alike: decode + highlight run on the API event loop per request.
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export function getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

// A mime is the sender's word, so loose bytes are only what their name and a plain text mime say.
export function getBytesTextPreviewMode(mimeType: string, fileName: string): BytesTextPreviewMode | null {
    // A vCard is text, but its raw body is mostly base64 photo: it previews as contact cards instead.
    if (isVCardFile(mimeType, fileName)) return null;
    // A calendar is text too, and reads as folded property lines nobody wants: it previews as its events.
    if (isIcsFile(mimeType, fileName)) return null;
    const ext = getExtension(fileName);
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (CODE_MIMES.some((prefix) => mimeType.startsWith(prefix))) return 'code';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return null;
}

export function getTextPreviewMode(mimeType: string, fileName: string): TextPreviewMode | null {
    if (mimeType === DRIVE_MIME_DOC) return 'eigendoc';
    if (mimeType === DRIVE_MIME_SLIDES) return 'eigenslides';
    if (mimeType === DRIVE_MIME_SHEETS) return 'eigensheets';
    if (mimeType === DRIVE_MIME_VECTOR) return 'eigenvector';
    return getBytesTextPreviewMode(mimeType, fileName);
}

// Which files drive-wide content search indexes from their own bytes: the text preview modes whose RAW
// BODY is the content, plus a .vcf, whose names and organizations the extractor pulls out of the cards
// rather than the raw body (docs/SEARCH.md), and an .ics, whose raw body carries the summaries and
// locations a search is after. Eigen container modes (eigendoc/eigenslides/eigensheets/eigenvector) are
// excluded — their bodies come from the Yjs loaders via the content-reindex sweep.
export function isSearchableTextFile(mimeType: string, fileName: string): boolean {
    if (isVCardFile(mimeType, fileName) || isIcsFile(mimeType, fileName)) return true;
    const mode = getTextPreviewMode(mimeType, fileName);
    return mode === 'markdown' || mode === 'plaintext' || mode === 'code';
}

export function isExiftoolExtension(fileName: string): boolean {
    return EXIFTOOL_EXTENSIONS.has(getExtension(fileName));
}
