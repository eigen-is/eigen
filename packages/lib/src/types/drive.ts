export type DriveACL = {
    email: string;
    read: boolean;
    write: boolean;
    public: boolean;
}

export type DrivePath = {
    id: string;
    name: string;
    type: "folder" | "file" | "doc" | "stickies";
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
}
