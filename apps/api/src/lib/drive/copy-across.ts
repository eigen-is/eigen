// Writes a listed copy to another mount or to another owner's drive, through the Drive methods the target
// offers, so the target checks each write and tells its own tabs. Each file is downloaded and uploaded
// again, and each folder or Eigen document is created again with its type. A document's insides refer to
// each other by name, not by path id, so the byte copy is a valid document. Drive.copyPath calls it for
// every copy that leaves its mount, once the shared walk has listed and sized the source.

import type { DrivePath } from '@workspace/lib/types/drive';
import { storageGone } from '../core';
import type { CopyTree } from '../mount/copy';
import { writeCopy } from '../mount/copy';
import type { User } from '../user';
import type { Drive } from './drive';
import type { DriveLike } from './get-drive';

// Where a copy that leaves its mount lands. The owner and the mount are the ones whose limits it meets.
export type CopyTarget = { drive: DriveLike; ownerId: string; mountId: string };

export function copyPathAcross(
    source: Drive,
    tree: CopyTree,
    to: CopyTarget,
    destParentId: string,
    name: string,
    user?: User,
): Promise<DrivePath> {
    return writeCopy(tree, destParentId, name, {
        createFolder: (parentId, folderName, type) =>
            to.drive.createFolder(to.mountId, parentId, folderName, user, type),
        copyFile: async (parentId, fileName, src) => {
            const file = await source.downloadFile(src.mountId, src.id);
            if (!file) throw storageGone();
            return to.drive.createFileFromData(to.mountId, parentId, fileName, src.mimeType, file, user);
        },
        // Deleted for good and not trashed: in the trash its bytes would still count against the target's
        // space, and a writer from another drive can't empty that trash before a retry.
        discard: (pathId) => to.drive.deleteFailedCopy(to.mountId, pathId),
    });
}
