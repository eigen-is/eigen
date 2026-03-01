export type DriveACL = {
    id: string;
    read: boolean;
    write: boolean;
}

export type DriveVisibility = 'private' | 'public-read' | 'public-write';

export type DriveCollabType = "doc" | "stickies";
export type DriveChatType = "chat";
export type DriveContainerType = "folder" | DriveCollabType | DriveChatType;
export type DrivePathType = "file" | DriveContainerType;

export function isContainerType(type: DrivePathType): type is DriveContainerType {
    return type === 'folder' || type === 'doc' || type === 'stickies' || type === 'chat';
}

export function isCollabType(type: DrivePathType): type is DriveCollabType {
    return type === 'doc' || type === 'stickies';
}

export function isChatType(type: DrivePathType): type is DriveChatType {
    return type === 'chat';
}

export type DrivePathDetails = {
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
