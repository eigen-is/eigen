export type DriveACL = {
    id: string;
    read: boolean;
    write: boolean;
};

// Wire shape of the ACL route: callers send what changed, the server merges onto the
// current ACL. Full-array replace is not accepted — it loses concurrent sharers' entries.
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

export type DriveTypeDoc = typeof DRIVE_TYPE_DOC;
export type DriveTypeStickies = typeof DRIVE_TYPE_STICKIES;
export type DriveTypeSlides = typeof DRIVE_TYPE_SLIDES;
export type DriveTypeSheets = typeof DRIVE_TYPE_SHEETS;
export type DriveTypeChat = typeof DRIVE_TYPE_CHAT;
export type DriveTypeVector = typeof DRIVE_TYPE_VECTOR;
export type DriveTypeFolder = typeof DRIVE_TYPE_FOLDER;
export type DriveTypeFile = typeof DRIVE_TYPE_FILE;

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

// `mime` is the real mime (`application/eigendoc`); `urlSlug` is the route-safe
// form (`application-eigendoc`) used by `/drive/.../mime/:slug` — the server
// route reverses dash→slash at handler time.
//
// `yjsRoots` declares the Y.Doc root-type schema for collab containers. Used by
// the version-restore walker to force-type both the live doc and the snapshot
// doc before pair-walking them — needed because Y.applyUpdate hydrates as
// AbstractType, so `instanceof` checks would otherwise fail. Omitted for chat.
export type YjsRootKind = 'map' | 'array' | 'text' | 'xmlfragment';
export type EigenDocTypeInfo = {
    type: EigenDocType;
    mime: string;
    urlSlug: string;
    extension: string;
    label: string;
    labelPlural: string;
    // Share-notification noun when label.toLowerCase() reads wrong (stickies → "shared a board").
    noun?: string;
    colorVar: string;
    softColorVar: string;
    appName: string;
    yjsRoots?: Record<string, YjsRootKind>;
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
        yjsRoots: { default: 'xmlfragment' },
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
        yjsRoots: { slides: 'map', objects: 'map', slideOrder: 'array' },
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
    },
} as const satisfies Record<EigenDocType, EigenDocTypeInfo>;

export const DRIVE_EXTENSIONS = {
    doc: EIGEN_DOC_TYPE_INFO.doc.extension,
    stickies: EIGEN_DOC_TYPE_INFO.stickies.extension,
    slides: EIGEN_DOC_TYPE_INFO.slides.extension,
    sheets: EIGEN_DOC_TYPE_INFO.sheets.extension,
    chat: EIGEN_DOC_TYPE_INFO.chat.extension,
    vector: EIGEN_DOC_TYPE_INFO.vector.extension,
} as const satisfies Record<EigenDocType, string>;

export function getEigenDocInfoByType(type: DrivePathType): EigenDocTypeInfo | undefined {
    return EIGEN_DOC_TYPES.includes(type as EigenDocType) ? EIGEN_DOC_TYPE_INFO[type as EigenDocType] : undefined;
}

// Accepts both real mime (`application/eigendoc`) and route-safe url-slug
// (`application-eigendoc`), since both forms travel through the app.
export function getEigenDocInfoByMime(mimeOrSlug: string): EigenDocTypeInfo | undefined {
    for (const info of Object.values(EIGEN_DOC_TYPE_INFO)) {
        if (info.mime === mimeOrSlug || info.urlSlug === mimeOrSlug) return info;
    }
    return undefined;
}

// The on-disk name of an eigen document: every create path (FE hooks, Drive.create, the chat route's
// dedupe) builds it here so the stored name and the name a client reconciles against can't drift.
export function withEigenExtension(name: string, type: EigenDocType): string {
    return `${name}${DRIVE_EXTENSIONS[type]}`;
}

export function stripEigenExtension(name: string): string {
    for (const ext of Object.values(DRIVE_EXTENSIONS)) {
        if (name.endsWith(ext)) return name.slice(0, -ext.length);
    }
    return name;
}

export type DriveCollabType = DriveTypeDoc | DriveTypeStickies | DriveTypeSlides | DriveTypeSheets | DriveTypeVector;
export type DriveChatType = DriveTypeChat;
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

export function isDocumentType(type: DrivePathType) {
    return isCollabType(type) || isChatType(type);
}

// Every Eigen container type except plain folders. Single source of truth for
// "is this an Eigen-managed document/chat" — used by WebDAV write-protect
// (mount internals are read-only) and by the docContainerDescendantIds CTE in
// mount/helpers.ts. Same set as isDocumentType; an alias of EIGEN_DOC_TYPES (kept under
// this name for the SQL-IN call sites) so the two lists can't drift.
export const EIGEN_DOCUMENT_TYPES = EIGEN_DOC_TYPES;

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

// Single source for "this extension is a code file" — shared by isInlineEditable
// (below) and the 'code' preview mode (constants/preview.ts).
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

export function isInlineEditable(mimeType: string, name: string): boolean {
    if (INLINE_EDITABLE_MIMES.has(mimeType)) return true;
    const dot = name.lastIndexOf('.');
    if (dot === -1) return false;
    return INLINE_EDITABLE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// True when the item has a meaningful "Open" action: folders, eigen documents
// (their own app), chats, and inline-editable text files. Regular binary files
// (images, PDFs, archives) use the preview lightbox instead, not Open.
export function isOpenable(path: { type: DrivePathType; mimeType: string; name: string }): boolean {
    return path.type !== 'file' || isInlineEditable(path.mimeType, path.name);
}

export type ImageDimensions = {
    width: number;
    height: number;
};

export type WebdavDeadProp = { ns: string; name: string; value: string };

export type DrivePathDetails =
    | ({
          originalName?: string;
          duration?: number;
          pageCount?: number;
          // RFC 4918 §3 dead properties — opaque key/value XML attached by clients
          // (Finder color tags, Office Win32* timestamps). Live properties (etag,
          // displayname, etc.) are derived; PROPPATCH on those returns 403.
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

export type DriveViewMode = 'list' | 'grid';
export type DriveSortKey = 'name' | 'modified' | 'size';
export type DriveSortDir = 'asc' | 'desc';
export type DriveViewPreferences = { mode: DriveViewMode; sortKey: DriveSortKey; sortDir: DriveSortDir };

// The identity subset of DrivePath needed to resolve a URL or open an item
// (getDriveItemUrl, openDocument). DrivePath is assignable to it.
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
    showHistory?: boolean;
};

export type DriveContextType = {
    rootPath: DrivePath | null;
};

export type InviteResult = {
    alreadyHasAccess: boolean;
    targetPathId: string;
};

export type FileEditorContent = {
    editMode: string;
    content: string;
    frontmatter: string | null;
    mimeType: string;
    updatedAt: Date;
};

export type EditorSaveResult = {
    conflict: boolean;
    updatedAt?: Date;
    currentUpdatedAt?: Date;
};

export type EffectiveMember = { email: string; read: boolean; write: boolean };

export type DriveAccessRecipient = { email: string; hasReadAccess: boolean; needsGuestAdmission: boolean };
export type DriveAccessCheckResult = { canShare: boolean; recipients: DriveAccessRecipient[] };
