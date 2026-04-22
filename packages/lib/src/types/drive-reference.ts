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
