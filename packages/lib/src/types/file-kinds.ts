// What kind of file a plain Drive file is, read from its MIME type and name: whether it opens in the inline text
// editor, is code, is an image, or is a vCard, a saved message or a calendar that previews as its own content.
// Uploaders lie about MIME types, so most readers also trust the extension. The inline editor's read and save
// shapes sit here beside the test that decides which files it opens.

import type { BytesTextPreviewMode } from '../constants/preview';
import type { DrivePathType } from './drive';

const INLINE_EDITABLE_MIMES = new Set([
    'text/markdown',
    'text/plain',
    'text/csv',
    'application/json',
    'text/yaml',
    'application/x-yaml',
    'text/xml',
    'application/xml',
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    'text/typescript',
    'application/typescript',
    'text/x-python',
    'text/x-rust',
    'text/x-sql',
    'text/x-shellscript',
    'application/x-sh',
    'text/x-toml',
    'application/toml',
]);

// The extensions that mark a code file. isInlineEditable reads them, and so does the 'code' preview mode.
export const CODE_EXTENSIONS = new Set([
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

const INLINE_EDITABLE_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.md', '.markdown', '.txt']);

// A vCard, a calendar and a saved message are text, but the server previews them as the cards, events and
// message they hold, not as their raw lines, and has no edit mode for them.
export function isStructuredTextFile(mimeType: string, name: string): boolean {
    return isVCardFile(mimeType, name) || isIcsFile(mimeType, name) || isEmlFile(mimeType, name);
}

export function isInlineEditable(mimeType: string, name: string): boolean {
    if (isStructuredTextFile(mimeType, name)) return false;
    if (INLINE_EDITABLE_MIMES.has(mimeType)) return true;
    const dot = name.lastIndexOf('.');
    if (dot === -1) return false;
    return INLINE_EDITABLE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// A binary file, such as an image or a PDF, opens in the preview lightbox instead.
export function isOpenable(path: { type: DrivePathType; mimeType: string; name: string }): boolean {
    return path.type !== 'file' || isInlineEditable(path.mimeType, path.name);
}

// Every image picker takes the whole image/* family, so no caller spells the prefix test itself.
export function isImageMime(mimeType: string): boolean {
    return mimeType.startsWith('image/');
}

export const VCARD_MIMES = ['text/vcard', 'text/x-vcard'] as const;

// The `accept` list for a file input that takes a vCard, named so the picker never re-spells the fact.
export const VCARD_ACCEPT = `.vcf,${VCARD_MIMES.join(',')}`;

// Exporters disagree on the MIME (Apple writes text/vcard, older clients text/x-vcard, browsers
// often application/octet-stream), so the .vcf extension counts on its own.
export function isVCardFile(mimeType: string, name: string): boolean {
    return name.toLowerCase().endsWith('.vcf') || VCARD_MIMES.some((m) => m === mimeType);
}

// The media type of one whole mail message wherever it travels, such as the download route, a message attached to
// another message and a stored .eml file.
export const EML_MIME = 'message/rfc822';

// Mail clients that write a saved message to disk disagree on the MIME the way vCard exporters do
// (Outlook drags out application/octet-stream), so the .eml extension counts on its own.
export function isEmlFile(mimeType: string, name: string): boolean {
    return name.toLowerCase().endsWith('.eml') || mimeType === EML_MIME;
}

// The media type an iCalendar body is carried under, everywhere: a stored .ics file, a calendar part of
// an invitation mail, a CalDAV resource.
export const ICS_MIME = 'text/calendar';

// The `accept` list for a file input that takes a calendar file, the twin of VCARD_ACCEPT.
export const ICS_ACCEPT = `.ics,${ICS_MIME}`;

// The media type an iCalendar byte stream is served under (CalDAV GET, PROPFIND getcontenttype, export).
export const ICS_CONTENT_TYPE = `${ICS_MIME}; charset=utf-8`;

// A calendar body names its purpose in parameters, such as `text/calendar; method=REQUEST`, but a type that only
// starts with the same letters is another type.
export function isIcsMime(mimeType: string): boolean {
    return mimeType === ICS_MIME || mimeType.startsWith(`${ICS_MIME};`);
}

// A part of an invitation carries no filename at all, so the media type is all there is to go on; the
// .ics extension counts on its own, as it does for the other two formats.
export function isIcsFile(mimeType: string, name: string): boolean {
    return name.toLowerCase().endsWith('.ics') || isIcsMime(mimeType);
}

export type FileEditorContent = {
    editMode: BytesTextPreviewMode;
    content: string;
    frontmatter: string | null;
    mimeType: string;
    // The file's HTTP etag when it was read. A save sends it back, and conflicts when the file moved on.
    etag: string;
};

export type EditorSaveResult = { conflict: true; currentEtag: string } | { conflict: false; etag: string };
