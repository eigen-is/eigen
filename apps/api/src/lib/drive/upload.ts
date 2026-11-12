// The last steps of a write of a file's bytes, such as an upload, an attachment saved from mail or an
// overwrite. The bytes wait in a temp file of the mount, which commitFromTemp owns: it runs the commit
// and makes the thumbnail in the background, and removes the temp file whichever way the write ends.
// finalizeUpload is the commit of a new file: a free name, a word to open tabs and the history row.

import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import { saveThumbnail } from '../shared/thumbnails';
import type { User } from '../user';
import type { Drive } from './drive';
import { folderIn, withFreeName } from './naming';

// `commit` writes the temp file when its caller has not yet, and puts the bytes in the tree. No caller
// removes the temp file: a failed commit does here, and after a commit the thumbnail job does.
export async function commitFromTemp(
    drive: Drive,
    mount: Mount,
    tempId: string,
    commit: () => Promise<DrivePath>,
): Promise<DrivePath> {
    const file = await commit().catch(async (e: unknown) => {
        await mount.cleanupTemp(tempId);
        throw e;
    });
    mount.runInBackground(`thumbnail of ${file.id}`, async () => {
        try {
            if (file.size === 0) return;
            const source = mount.getTempPath(tempId);
            const thumbnail = await saveThumbnail(mount.thumbsDir, file.id, source, file.mimeType, file.name);
            if (!thumbnail) return;
            const current = await mount.getPath(file.id);
            if (!current) return;
            const updated = await mount.updatePath(file.id, {
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
            await mount.cleanupTemp(tempId);
        }
    });
    return file;
}

// The caller tells the watchers, so an upload of many files notifies them once.
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
    const uploadedFile = await mount.updatePath(pathId, { details: { originalName } });
    drive.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
    mount.history.record({ pathId, eventType: 'uploaded', actor: args.user, details: { size: uploadedFile.size } });
    return uploadedFile;
}
