// The last steps of a new file, such as an upload or a copy from another drive. They turn a temp
// file into a file in the tree under a free name, tell open tabs and write the history row. A
// thumbnail is then made in the background, by a helper that an overwrite of a file uses too.

import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import { saveThumbnail } from '../shared/thumbnails';
import type { User } from '../user';
import type { Drive } from './drive';
import { folderIn, withFreeName } from './naming';

// The caller tells the watchers, so an upload of many files notifies them once. When this throws, the
// caller removes the temp file.
export async function finalizeUpload(
    drive: Drive,
    mount: Mount,
    args: {
        parentId: string;
        name: string;
        mimeType: string;
        size: number;
        hash: string;
        tempId: string;
        user: User;
    },
): Promise<DrivePath> {
    // The store keeps names in NFC, so the name is compared with its siblings in that form too.
    const originalName = args.name.replace(/[/\\]/g, '_').normalize('NFC');
    const pathId = await withFreeName(folderIn(mount, args.parentId), originalName, (name) =>
        mount.createFileFromTemp(args.parentId, name, args.mimeType, args.size, args.hash, args.tempId),
    );
    const uploadedFile = originalName
        ? await mount.updatePath(pathId, { details: { originalName } })
        : await mount.getActivePath(pathId);
    drive.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
    mount.history.record({ pathId, eventType: 'uploaded', actor: args.user, details: { size: uploadedFile.size } });

    if (uploadedFile.size === 0) {
        // An empty file has no thumbnail. Finder copies in two steps: an empty file first, and the
        // bytes later through writeFileContent.
        await mount.cleanupTemp(args.tempId);
    } else {
        regenerateThumbnailAsync(
            drive,
            mount,
            pathId,
            mount.getTempPath(args.tempId),
            args.mimeType,
            uploadedFile.name,
            () => mount.cleanupTemp(args.tempId),
        );
    }

    return uploadedFile;
}

export function regenerateThumbnailAsync(
    drive: Drive,
    mount: Mount,
    pathId: string,
    source: Buffer | string,
    mimeType: string,
    fileName: string,
    onCleanup?: () => Promise<void>,
): void {
    mount.runInBackground(`thumbnail of ${pathId}`, async () => {
        try {
            const thumbnail = await saveThumbnail(mount.thumbsDir, pathId, source, mimeType, fileName);
            if (!thumbnail) return;
            const current = await mount.getPath(pathId);
            if (!current) return;
            const updated = await mount.updatePath(pathId, {
                thumbnail: thumbnail.fileName,
                details: {
                    ...current.details,
                    width: thumbnail.width,
                    height: thumbnail.height,
                    ...(thumbnail.duration !== undefined && { duration: thumbnail.duration }),
                },
            });
            drive.emit(SSEventType.DRIVE_FILE_UPLOADED, updated);
        } finally {
            await onCleanup?.();
        }
    });
}
