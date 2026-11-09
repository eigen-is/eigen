// A link to a Drive document that some other thing carries, such as a chat message, a comment card or a mail draft. It
// names the document by owner, mount and id, and keeps enough, such as the name, to draw the link without a lookup.

import { isRecord } from '../core/guards';
import type { DriveItemRef, DrivePathType } from './drive';
import { DRIVE_TYPE_FILE, DRIVE_TYPE_FOLDER, EIGEN_DOC_TYPES } from './drive';

export type AttachmentReference = {
    type: 'reference';
    ownerId: string;
    mountId: string;
    id: string;
    name: string;
    driveType: DrivePathType;
    mimeType: string;
};

// For a reference another program wrote, read where no route's schema runs: a collaborator's comment card or a block in
// a draft. Every field is checked, because a later link or Drive lookup uses them all.
export function isAttachmentReferenceShape(value: unknown): value is AttachmentReference {
    return (
        isRecord(value) &&
        value['type'] === 'reference' &&
        typeof value['ownerId'] === 'string' &&
        typeof value['mountId'] === 'string' &&
        typeof value['id'] === 'string' &&
        typeof value['name'] === 'string' &&
        typeof value['mimeType'] === 'string' &&
        (value['driveType'] === DRIVE_TYPE_FOLDER ||
            value['driveType'] === DRIVE_TYPE_FILE ||
            EIGEN_DOC_TYPES.some((type) => type === value['driveType']))
    );
}

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
