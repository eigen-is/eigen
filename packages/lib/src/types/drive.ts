export type DriveACL = {
    id: string;
    read: boolean;
    write: boolean;
}

export const DRIVE_TYPE_DOC = "doc" as const;
export const DRIVE_TYPE_STICKIES = "stickies" as const;
export const DRIVE_TYPE_SLIDES = "slides" as const;
export const DRIVE_TYPE_SHEETS = "sheets" as const;
export const DRIVE_TYPE_CHAT = "chat" as const;
export const DRIVE_TYPE_FOLDER = "folder" as const;
export const DRIVE_TYPE_FILE = "file" as const;

export const DRIVE_MIME_DOC = "application/eigendoc" as const;
export const DRIVE_MIME_STICKIES = "application/eigenstickies" as const;
export const DRIVE_MIME_SLIDES = "application/eigenslides" as const;
export const DRIVE_MIME_SHEETS = "application/eigensheets" as const;
export const DRIVE_MIME_CHAT = "application/eigenchat" as const;

export type DriveTypeDoc = typeof DRIVE_TYPE_DOC;
export type DriveTypeStickies = typeof DRIVE_TYPE_STICKIES;
export type DriveTypeSlides = typeof DRIVE_TYPE_SLIDES;
export type DriveTypeSheets = typeof DRIVE_TYPE_SHEETS;
export type DriveTypeChat = typeof DRIVE_TYPE_CHAT;
export type DriveTypeFolder = typeof DRIVE_TYPE_FOLDER;
export type DriveTypeFile = typeof DRIVE_TYPE_FILE;

export type DrivePathType =
    DriveTypeDoc
    | DriveTypeStickies
    | DriveTypeSlides
    | DriveTypeSheets
    | DriveTypeChat
    | DriveTypeFolder
    | DriveTypeFile;
export type DriveVisibility = 'private' | 'public-read' | 'public-write';

export type DriveCollabType = DriveTypeDoc | DriveTypeStickies | DriveTypeSlides | DriveTypeSheets;
export type DriveChatType = DriveTypeChat;
export type DriveContainerType = DriveTypeFolder | DriveCollabType | DriveChatType;

export function isFolderType(type: DrivePathType) {
    return type === DRIVE_TYPE_FOLDER;
}

export function isCollabType(type: DrivePathType): type is DriveCollabType {
    return type === DRIVE_TYPE_DOC || type === DRIVE_TYPE_STICKIES || type === DRIVE_TYPE_SLIDES || type === DRIVE_TYPE_SHEETS;
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


export type DrivePathDetails = {
    originalName?: string;
    width?: number;
    height?: number;
    duration?: number;
    pageCount?: number;
    [key: string]: unknown;
} | null;

export type DrivePath = {
    id: string;
    mountId: string;
    name: string;
    type: DrivePathType;
    parentId: string | null;
    ownerId: string;
    labels?: string[];
    mimeType: string;
    size: number;
    thumbnail: string | null;
    acl: DriveACL[] | null;
    visibility: DriveVisibility;
    details: DrivePathDetails;
    createdAt: Date;
    updatedAt: Date;
}

export type DriveSearchParams = {
    pid?: string;
    uid?: string;
}

export type DriveContextType = {
    rootPath: DrivePath | null;
    mountId: string;
}
