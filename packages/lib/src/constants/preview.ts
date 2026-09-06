import {
    CODE_EXTENSIONS,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_VECTOR,
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
    const ext = getExtension(fileName);
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (CODE_MIMES.some((prefix) => mimeType.startsWith(prefix))) return 'code';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return null;
}

// The subset of text preview modes whose RAW BODY is indexed by drive-wide content
// search. Eigen container modes (eigendoc/eigenslides/eigensheets/eigenvector) are excluded
// here — their bodies come from the Yjs loaders via the content-reindex sweep, not a raw read.
export function isSearchableTextFile(mimeType: string, fileName: string): boolean {
    const mode = getTextPreviewMode(mimeType, fileName);
    return mode === 'markdown' || mode === 'plaintext' || mode === 'code';
}

export function isExiftoolExtension(fileName: string): boolean {
    return EXIFTOOL_EXTENSIONS.has(getExtension(fileName));
}
