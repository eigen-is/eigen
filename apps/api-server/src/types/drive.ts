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
    parentId?: string;
    ownerId: string;
    labels: string[];
    mimeType: string;
    size: number;
    thumbnail: string;
    acl: DriveACL[] | null;
    createdAt: Date;
    updatedAt: Date;
}