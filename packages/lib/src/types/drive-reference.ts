import type { DrivePathType } from './drive';

export type AttachmentReference = {
    type: 'reference';
    ownerId: string;
    mountId: string;
    id: string;
    name: string;
    driveType: DrivePathType;
    mimeType: string;
};

export function toAttachmentReference(path: {
    ownerId: string;
    mountId: string;
    id: string;
    name: string;
    type: DrivePathType;
    mimeType: string;
}): AttachmentReference {
    return {
        type: 'reference',
        ownerId: path.ownerId,
        mountId: path.mountId,
        id: path.id,
        name: path.name,
        driveType: path.type,
        mimeType: path.mimeType,
    };
}
