// The Drive types the API serves and every app reads: a path, the kinds of path and their MIME types, and
// the Eigen document types with their extensions, export formats and Y.Doc roots. The API and the apps
// import them alike, so a new kind of path or document is added here once. It also re-exports its siblings,
// such as access and file kinds, so Drive code imports every Drive name from this one module.

import { BAND_ROOTS } from '../docs/eigendoc/bands';
import { STYLE_ROOT } from '../docs/eigendoc/normal-style';
import { PAGE_ROOT } from '../docs/eigendoc/page';
import type { DriveACL, DriveVisibility } from './drive-access';

export * from './drive-access';
export * from './drive-convert';
export * from './drive-view';
export * from './file-kinds';

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

export const EIGEN_DOC_TYPES = ['doc', 'stickies', 'slides', 'sheets', 'chat', 'vector'] as const;
export type EigenDocType = (typeof EIGEN_DOC_TYPES)[number];

export type YjsRootKind = 'map' | 'array' | 'text' | 'xmlfragment';

// Every download format the export route can produce. A type's own list is below and keeps this order,
// so ⌘K's per-format rows read like that type's Download menu.
const EXPORT_FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

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

// The part of a DrivePath that names an item, enough to build its URL or open it. DrivePath is assignable to it.
export type DriveItemRef = {
    id: string;
    ownerId: string;
    mountId: string;
    name: string;
    type: DrivePathType;
    mimeType: string;
};
