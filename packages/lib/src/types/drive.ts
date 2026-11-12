// The Drive types the API serves and every app reads: a path and its ACL, the kinds of path and their
// MIME types, the Eigen document types with their extensions, export formats and Y.Doc roots, and the
// readers that classify a file by its name and MIME type. The API and the apps import them alike, so a
// new kind of path or format is added here once. The shape of a Drive view's capabilities lives here
// too, beside the path it gates.

import type { BytesTextPreviewMode } from '../constants/preview';
import { BAND_ROOTS } from '../docs/eigendoc/bands';
import { STYLE_ROOT } from '../docs/eigendoc/normal-style';
import { PAGE_ROOT } from '../docs/eigendoc/page';

export type DriveACL = {
    id: string;
    read: boolean;
    write: boolean;
};

// What a client sends the ACL route: only what changed, which the server merges into the current ACL. The route takes
// no full list, because replacing the whole list would drop the entries another sharer added at the same time.
export type DriveACLDelta = {
    add?: DriveACL[];
    remove?: string[];
};

export const DRIVE_TYPE_DOC = 'doc' as const;
export const DRIVE_TYPE_STICKIES = 'stickies' as const;
export const DRIVE_TYPE_SLIDES = 'slides' as const;
export const DRIVE_TYPE_SHEETS = 'sheets' as const;
export const DRIVE_TYPE_CHAT = 'chat' as const;
export const DRIVE_TYPE_VECTOR = 'vector' as const;
export const DRIVE_TYPE_FOLDER = 'folder' as const;
export const DRIVE_TYPE_FILE = 'file' as const;

export const DRIVE_MIME_FOLDER = 'folder' as const;
export const DRIVE_MIME_DOC = 'application/eigendoc' as const;
export const DRIVE_MIME_STICKIES = 'application/eigenstickies' as const;
export const DRIVE_MIME_SLIDES = 'application/eigenslides' as const;
export const DRIVE_MIME_SHEETS = 'application/eigensheets' as const;
export const DRIVE_MIME_CHAT = 'application/eigenchat' as const;
export const DRIVE_MIME_VECTOR = 'application/eigenvector' as const;

type DriveTypeDoc = typeof DRIVE_TYPE_DOC;
type DriveTypeStickies = typeof DRIVE_TYPE_STICKIES;
type DriveTypeSlides = typeof DRIVE_TYPE_SLIDES;
type DriveTypeSheets = typeof DRIVE_TYPE_SHEETS;
type DriveTypeChat = typeof DRIVE_TYPE_CHAT;
type DriveTypeVector = typeof DRIVE_TYPE_VECTOR;
type DriveTypeFolder = typeof DRIVE_TYPE_FOLDER;
type DriveTypeFile = typeof DRIVE_TYPE_FILE;

export type DrivePathType =
    | DriveTypeDoc
    | DriveTypeStickies
    | DriveTypeSlides
    | DriveTypeSheets
    | DriveTypeChat
    | DriveTypeVector
    | DriveTypeFolder
    | DriveTypeFile;
export type DriveVisibility = 'private' | 'public-read' | 'public-write';

export const EIGEN_DOC_TYPES = ['doc', 'stickies', 'slides', 'sheets', 'chat', 'vector'] as const;
export type EigenDocType = (typeof EIGEN_DOC_TYPES)[number];

export type YjsRootKind = 'map' | 'array' | 'text' | 'xmlfragment';

// Every download format the export route can produce. A type's own list is below and keeps this order,
// so ⌘K's per-format rows read like that type's Download menu.
const EXPORT_FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// What the convert route turns an office file into: the one format each target reads, by its extension alone, and the
// type of the document it makes. The file action offers a convert by the same extension the route refuses on.
export const CONVERT_SOURCES = {
    eigensheets: { format: 'xlsx', type: 'sheets' },
    eigendoc: { format: 'docx', type: 'doc' },
    eigenslides: { format: 'pptx', type: 'slides' },
} as const satisfies Record<string, { format: string; type: EigenDocType }>;
export type ConvertTarget = keyof typeof CONVERT_SOURCES;

export function isConvertTarget(t: string): t is ConvertTarget {
    return Object.hasOwn(CONVERT_SOURCES, t);
}

export function isConvertSource(name: string, target: ConvertTarget): boolean {
    return name.toLowerCase().endsWith(`.${CONVERT_SOURCES[target].format}`);
}

// What an import answers: `summary` says what the file held that did not come over, for a toast. A convert answers its
// new document's path alone, and shows no summary: the document opens at once.
export type ImportResult = { success: true; summary: string | null };

// An export answers with the file alone, so what the file left out rides in this header beside it, percent-encoded,
// for the toast after a download or a print. A file that lost nothing has no such header.
export const EXPORT_SUMMARY_HEADER = 'Eigen-Export-Summary';

// File › Import… puts the file beside what the document holds, such as slides after `afterFrameId`, or in its place
// after saving a version. A doc is only ever replaced: the file's page setup and headers can't sit beside the doc's.
export type ImportMode = 'insert' | 'replace';
export type DocumentImportOptions = { mode: ImportMode; afterFrameId?: string };

// `urlSlug` is the MIME type in a form that fits a URL, such as `application-eigendoc`. A version restore gives the
// live doc and the snapshot the `yjsRoots` types first, because Y.applyUpdate gives a root no concrete type.
type EigenDocTypeInfo = {
    type: EigenDocType;
    mime: string;
    urlSlug: string;
    extension: string;
    label: string;
    labelPlural: string;
    // The noun a share notification uses when the lowercase label reads wrong, such as "shared a board" for stickies.
    noun?: string;
    colorVar: string;
    softColorVar: string;
    appName: string;
    yjsRoots?: Record<string, YjsRootKind>;
    // The download formats this type offers, in menu order. The export route accepts only these, and every Download
    // menu is built from them. Omitted where there is nothing to export.
    exportFormats?: readonly ExportFormat[];
};

export const EIGEN_DOC_TYPE_INFO = {
    doc: {
        type: DRIVE_TYPE_DOC,
        mime: DRIVE_MIME_DOC,
        urlSlug: 'application-eigendoc',
        extension: '.eigendoc',
        label: 'Doc',
        labelPlural: 'Docs',
        colorVar: '--app-docs-color',
        softColorVar: '--app-docs-color-soft',
        appName: 'docs',
        yjsRoots: {
            default: 'xmlfragment',
            [PAGE_ROOT]: 'map',
            [STYLE_ROOT]: 'map',
            ...Object.fromEntries(BAND_ROOTS.map((root) => [root, 'xmlfragment' as const])),
        },
        exportFormats: ['docx', 'pdf', 'html'],
    },
    stickies: {
        type: DRIVE_TYPE_STICKIES,
        mime: DRIVE_MIME_STICKIES,
        urlSlug: 'application-eigenstickies',
        extension: '.eigenstickies',
        label: 'Stickies',
        labelPlural: 'Stickies',
        noun: 'board',
        colorVar: '--app-stickies-color',
        softColorVar: '--app-stickies-color-soft',
        appName: 'stickies',
        yjsRoots: { columns: 'map', tasks: 'map', columnOrder: 'array' },
    },
    slides: {
        type: DRIVE_TYPE_SLIDES,
        mime: DRIVE_MIME_SLIDES,
        urlSlug: 'application-eigenslides',
        extension: '.eigenslides',
        label: 'Slide',
        labelPlural: 'Slides',
        colorVar: '--app-slides-color',
        softColorVar: '--app-slides-color-soft',
        appName: 'slides',
        yjsRoots: { elements: 'map', frames: 'map', meta: 'map' },
        exportFormats: ['pptx', 'pdf', 'html'],
    },
    sheets: {
        type: DRIVE_TYPE_SHEETS,
        mime: DRIVE_MIME_SHEETS,
        urlSlug: 'application-eigensheets',
        extension: '.eigensheets',
        label: 'Sheet',
        labelPlural: 'Sheets',
        colorVar: '--app-sheets-color',
        softColorVar: '--app-sheets-color-soft',
        appName: 'sheets',
        yjsRoots: { state: 'map', ops: 'array' },
        exportFormats: ['xlsx', 'pdf', 'html'],
    },
    chat: {
        type: DRIVE_TYPE_CHAT,
        mime: DRIVE_MIME_CHAT,
        urlSlug: 'application-eigenchat',
        extension: '.eigenchat',
        label: 'Chat',
        labelPlural: 'Chats',
        colorVar: '--app-chat-color',
        softColorVar: '--app-chat-color-soft',
        appName: 'chat',
    },
    vector: {
        type: DRIVE_TYPE_VECTOR,
        mime: DRIVE_MIME_VECTOR,
        urlSlug: 'application-eigenvector',
        extension: '.eigenvector',
        label: 'Vector',
        labelPlural: 'Vectors',
        colorVar: '--app-vector-color',
        softColorVar: '--app-vector-color-soft',
        appName: 'vector',
        yjsRoots: { elements: 'map', frames: 'map', meta: 'map' },
        exportFormats: ['pdf'],
    },
} as const satisfies Record<EigenDocType, EigenDocTypeInfo>;

export function exportFormatsFor(type: DrivePathType): readonly ExportFormat[] {
    return getEigenDocInfoByType(type)?.exportFormats ?? [];
}

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
    docx: 'Microsoft Word (.docx)',
    xlsx: 'Microsoft Excel (.xlsx)',
    pptx: 'Microsoft PowerPoint (.pptx)',
    pdf: 'PDF (.pdf)',
    html: 'Web page (.html)',
};

export function getEigenDocInfoByType(type: DrivePathType): EigenDocTypeInfo | undefined {
    return isDocumentType(type) ? EIGEN_DOC_TYPE_INFO[type] : undefined;
}

// Accepts both real mime (`application/eigendoc`) and route-safe url-slug
// (`application-eigendoc`), since both forms travel through the app.
export function getEigenDocInfoByMime(mimeOrSlug: string): EigenDocTypeInfo | undefined {
    for (const info of Object.values(EIGEN_DOC_TYPE_INFO)) {
        if (info.mime === mimeOrSlug || info.urlSlug === mimeOrSlug) return info;
    }
    return undefined;
}

// The stored name of an Eigen document. Every place that creates one, such as Drive.create or a create hook in the
// browser, builds the name here, so the stored name and the name a client reconciles against can't drift apart.
export function withEigenExtension(name: string, type: EigenDocType): string {
    return `${name}${EIGEN_DOC_TYPE_INFO[type].extension}`;
}

export function stripEigenExtension(name: string): string {
    for (const { extension: ext } of Object.values(EIGEN_DOC_TYPE_INFO)) {
        if (name.endsWith(ext)) return name.slice(0, -ext.length);
    }
    return name;
}

export type DriveCollabType = DriveTypeDoc | DriveTypeStickies | DriveTypeSlides | DriveTypeSheets | DriveTypeVector;
type DriveChatType = DriveTypeChat;
export type DriveContainerType = DriveTypeFolder | DriveCollabType | DriveChatType;

export function isFolderType(type: DrivePathType) {
    return type === DRIVE_TYPE_FOLDER;
}

export function isCollabType(type: DrivePathType): type is DriveCollabType {
    return (
        type === DRIVE_TYPE_DOC ||
        type === DRIVE_TYPE_STICKIES ||
        type === DRIVE_TYPE_SLIDES ||
        type === DRIVE_TYPE_SHEETS ||
        type === DRIVE_TYPE_VECTOR
    );
}

export function isChatType(type: DrivePathType): type is DriveChatType {
    return type === DRIVE_TYPE_CHAT;
}

export function isContainerType(type: DrivePathType): type is DriveContainerType {
    return isFolderType(type) || isCollabType(type) || isChatType(type);
}

// Every Eigen container type except plain folders: the EIGEN_DOC_TYPES set as a predicate.
export function isDocumentType(type: DrivePathType): type is EigenDocType {
    return EIGEN_DOC_TYPES.some((t) => t === type);
}

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

export type ImageDimensions = {
    width: number;
    height: number;
};

// With `xml`, value is the client's element content serialized as XML; without it, value is text.
export type WebdavDeadProp = { ns: string; name: string; value: string; xml?: true };

export type DrivePathDetails =
    | ({
          originalName?: string;
          duration?: number;
          pageCount?: number;
          // The WebDAV dead properties (RFC 4918 §3) a client attached, such as Finder's color tags or Office's
          // Win32 timestamps, kept as opaque XML. Live properties, such as the etag, are derived and can't be set.
          webdavProps?: WebdavDeadProp[];
          [key: string]: unknown;
      } & Partial<ImageDimensions>)
    | null;

export type DrivePath = {
    id: string;
    mountId: string;
    name: string;
    type: DrivePathType;
    parentId: string | null;
    ownerId: string;
    mimeType: string;
    size: number;
    hash: string | null;
    thumbnail: string | null;
    acl: DriveACL[] | null;
    visibility: DriveVisibility;
    sharingRestricted: boolean;
    details: DrivePathDetails;
    trashedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

// A path on the Recent page, with the last time its user opened it or was notified about it.
export type RecentPath = DrivePath & { lastActivityAt: Date };

// The server cuts another owner's chain at the first folder the viewer can't read, so a chain that doesn't start at
// a mount root starts where the viewer came in, through a share or a public link.
export function sharedChainHead(chain: readonly DrivePath[]): DrivePath | undefined {
    const head = chain.at(0);
    return head && head.parentId !== null ? head : undefined;
}

export type DriveViewMode = 'list' | 'grid';
export const DRIVE_SORT_KEYS = ['name', 'modified', 'size'] as const;
export type DriveSortKey = (typeof DRIVE_SORT_KEYS)[number];
export type DriveSortDir = 'asc' | 'desc';
export type DriveSort = { key: DriveSortKey; dir: DriveSortDir };
export type DriveViewPreferences = { mode: DriveViewMode; sortKey: DriveSortKey; sortDir: DriveSortDir };

// What a Drive view lets the user do. Each view declares its whole set as one value, such as a preset
// spread with overrides, and every Drive action reads its gate from it.
export type DriveCapabilities = {
    canCreateFolder: boolean;
    canUpload: boolean;
    // May write where the listed items sit: a convert saves the new document beside its source.
    canWrite: boolean;
    canDelete: boolean;
    canRename: boolean;
    canMove: boolean;
    canShare: boolean;
    // The fs browser shows the folder breadcrumb; filtered views show a title instead.
    showBreadcrumb: boolean;
    // Omit to allow creating every EigenDocType; an empty set disables create entirely.
    createTypes?: ReadonlySet<EigenDocType>;
};

// The Drive file an import-from-drive request names, and nothing about where it lands. Every format posts this one
// body, so the hooks and routes can't drift apart; importFromDriveSchema mirrors it.
export type DriveImportSource = { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };

// Where a copy of a Drive item goes, and under which name: the body of the copy route.
export type DriveCopyDestination = {
    targetOwnerId: string;
    targetMountId: string;
    targetParentId: string;
    name?: string;
};

// The part of a DrivePath that names an item, enough to build its URL or open it. DrivePath is assignable to it.
export type DriveItemRef = {
    id: string;
    ownerId: string;
    mountId: string;
    name: string;
    type: DrivePathType;
    mimeType: string;
};

export type DriveSearchParams = {
    pid?: string;
    uid?: string;
    mid?: string;
    sharePathId?: string;
    shareEmail?: string;
};

export type DriveContextType = {
    rootPath: DrivePath | null;
};

export type InviteResult = {
    alreadyHasAccess: boolean;
    targetPathId: string;
};

export type FileEditorContent = {
    editMode: BytesTextPreviewMode;
    content: string;
    frontmatter: string | null;
    mimeType: string;
    // The file's HTTP etag when it was read. A save sends it back, and conflicts when the file moved on.
    etag: string;
};

export type EditorSaveResult = { conflict: true; currentEtag: string } | { conflict: false; etag: string };

export type EffectiveMember = { email: string; read: boolean; write: boolean };

// One row of the share dialog's access list. A direct entry is the path's own ACL plus the owner
// row the dialog synthesizes; an inherited one comes from an ancestor folder and names it.
export type DirectAccessItem = DriveACL & { owner: boolean };
export type InheritedAccessItem = DriveACL & { sourceFolderName: string };
export type DriveAccessItem =
    | (DirectAccessItem & { inherited?: never; sourceFolderName?: never })
    | (InheritedAccessItem & { owner?: never; inherited: true });

export type DriveAccessRecipient = { email: string; hasReadAccess: boolean; needsGuestAdmission: boolean };
export type DriveAccessCheckResult = { canShare: boolean; recipients: DriveAccessRecipient[] };
