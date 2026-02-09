export type DriveACL = {
    email: string;
    read: boolean;
    write: boolean;
    public: boolean;
}

export type DrivePathType = "folder" | "file" | "doc" | "stickies";
export type DriveContainerType = "folder" | "doc" | "stickies";

export const CONTAINER_TYPES: DriveContainerType[] = ['folder', 'doc', 'stickies'];

export function isContainerType(type: DrivePathType): type is DriveContainerType {
    return type === 'folder' || type === 'doc' || type === 'stickies';
}

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
