import type { DriveItemRef, DrivePathType } from './drive';

export type AttachmentReference = {
    type: 'reference';
    ownerId: string;
    mountId: string;
    id: string;
    name: string;
    driveType: DrivePathType;
    mimeType: string;
};

export function toAttachmentReference(path: DriveItemRef): AttachmentReference {
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
