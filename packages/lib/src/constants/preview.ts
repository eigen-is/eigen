import {
    CODE_EXTENSIONS,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_VECTOR,
    isVCardFile,
} from '../types/drive';
import type { FileSubject } from '../types/file-subject';

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

// The image mimes a browser decodes on its own. A subject whose <img> points at the original bytes
// (no Drive /preview route behind it) is only an image preview for one of these — an <img> never runs
// script, so serving these inline is safe, and a HEIC gets the fallback card instead of a broken box.
export const BROWSER_IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp',
    'image/svg+xml',
]);

export type TextPreviewMode =
    | 'markdown'
    | 'plaintext'
    | 'code'
    | 'eigendoc'
    | 'eigenslides'
    | 'eigensheets'
    | 'eigenvector';

// The logical box a canvas preview body is composed at: the drive hero scales a preview from its
// intrinsic width (drive-preview.tsx), so a drawing of any size previews through one known number,
// and the height caps how far a tall, narrow drawing may be magnified. 16:9, the hero's own ratio.
export const CANVAS_PREVIEW_WIDTH = 960;
export const CANVAS_PREVIEW_HEIGHT = 540;

export function getExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

export function getTextPreviewMode(mimeType: string, fileName: string): TextPreviewMode | null {
    if (mimeType === DRIVE_MIME_DOC) return 'eigendoc';
    if (mimeType === DRIVE_MIME_SLIDES) return 'eigenslides';
    if (mimeType === DRIVE_MIME_SHEETS) return 'eigensheets';
    if (mimeType === DRIVE_MIME_VECTOR) return 'eigenvector';
    // A vCard is text, but its raw body is mostly base64 photo: it previews as contact cards instead.
    if (isVCardFile(mimeType, fileName)) return null;
    const ext = getExtension(fileName);
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (CODE_MIMES.some((prefix) => mimeType.startsWith(prefix))) return 'code';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return null;
}

// Which files drive-wide content search indexes from their own bytes: the text preview modes whose RAW
// BODY is the content, plus a .vcf, whose names and organisations the extractor pulls out of the cards
// rather than the raw body (docs/SEARCH.md). Eigen container modes (eigendoc/eigenslides/eigensheets/
// eigenvector) are excluded — their bodies come from the Yjs loaders via the content-reindex sweep.
export function isSearchableTextFile(mimeType: string, fileName: string): boolean {
    if (isVCardFile(mimeType, fileName)) return true;
    const mode = getTextPreviewMode(mimeType, fileName);
    return mode === 'markdown' || mode === 'plaintext' || mode === 'code';
}

export function isExiftoolExtension(fileName: string): boolean {
    return EXIFTOOL_EXTENSIONS.has(getExtension(fileName));
}

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'vcard' | 'fallback';

// How the preview overlay renders a file. Every server-rendered mode needs a mount to query, so it
// gates on `drive`. Without one the <img> shows the original bytes instead of a resized WebP, which
// only a browser-decodable mime survives.
export function getPreviewMode(subject: FileSubject): PreviewMode {
    const mime = subject.mimeType || '';

    if (subject.drive ? mime.startsWith('image/') || isExiftoolExtension(subject.name) : BROWSER_IMAGE_MIMES.has(mime))
        return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    // A .vcf reads as contact cards, never as its raw text — which is why getTextPreviewMode declines it.
    if (subject.drive && isVCardFile(mime, subject.name)) return 'vcard';
    if (subject.drive && getTextPreviewMode(mime, subject.name) !== null) return 'text';
    return 'fallback';
}
