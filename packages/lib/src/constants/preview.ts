import { CODE_EXTENSIONS } from '../types/drive';

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

export type TextPreviewMode = 'markdown' | 'plaintext' | 'code' | 'eigendoc' | 'eigenslides' | 'eigensheets';

function getExtension(fileName: string): string {
    return fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
}

export function getTextPreviewMode(mimeType: string, fileName: string): TextPreviewMode | null {
    if (mimeType === 'application/eigendoc') return 'eigendoc';
    if (mimeType === 'application/eigenslides') return 'eigenslides';
    if (mimeType === 'application/eigensheets') return 'eigensheets';
    const ext = getExtension(fileName);
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (CODE_MIMES.some((prefix) => mimeType.startsWith(prefix))) return 'code';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return null;
}

// The subset of text preview modes whose RAW BODY is indexed by drive-wide content
// search. Eigen container modes (eigendoc/eigenslides/eigensheets) are excluded here —
// their bodies come from the Yjs loaders via the content-reindex sweep, not a raw read.
export function isSearchableTextFile(mimeType: string, fileName: string): boolean {
    const mode = getTextPreviewMode(mimeType, fileName);
    return mode === 'markdown' || mode === 'plaintext' || mode === 'code';
}

export function isExiftoolExtension(fileName: string): boolean {
    return EXIFTOOL_EXTENSIONS.has(getExtension(fileName));
}
