export type DriveACL = {
    userId: string;
    read: boolean;
    write: boolean;
    public: boolean;
}

export type DrivePath = {
    id: string;
    name: string;
    type: "folder" | "file" | "eigendocs";
    parentId?: string;
    ownerId: string;
    labels: string[];
    mimeType: string;
    acl: DriveACL[] | null;
    createdAt: Date;
    updatedAt: Date;
}