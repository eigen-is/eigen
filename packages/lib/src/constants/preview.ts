const CODE_EXTENSIONS = new Set([
    '.json',
    '.yaml',
    '.yml',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.csv',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.py',
    '.rs',
    '.go',
    '.rb',
    '.php',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.swift',
    '.kt',
    '.scala',
    '.sql',
    '.graphql',
    '.gql',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.conf',
    '.cfg',
    '.ini',
    '.toml',
    '.env',
    '.gitignore',
    '.dockerignore',
    '.editorconfig',
    '.log',
    '.diff',
    '.patch',
    '.svelte',
    '.vue',
    '.astro',
    '.dockerfile',
    '.r',
    '.lua',
    '.zig',
    '.dart',
]);

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

export type TextPreviewMode = 'markdown' | 'plaintext' | 'code';

function getExtension(fileName: string): string {
    return fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
}

export function getTextPreviewMode(mimeType: string, fileName: string): TextPreviewMode | null {
    const ext = getExtension(fileName);
    if (mimeType === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
    if (mimeType === 'text/plain' || ext === '.txt') return 'plaintext';
    if (CODE_MIMES.some((prefix) => mimeType.startsWith(prefix))) return 'code';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return null;
}

export function isExiftoolExtension(fileName: string): boolean {
    return EXIFTOOL_EXTENSIONS.has(getExtension(fileName));
}
