// The last steps of a write of a file's bytes, such as an upload, an attachment saved from mail or an
// overwrite. The bytes wait in a temp file of the mount, which commitFromTemp owns: it runs the commit
// and makes the thumbnail in the background, and removes the temp file whichever way the write ends.
// finalizeNamedUpload is the commit of a new file: its row, a word to open tabs and the history row.
// finalizeUpload is that commit under a free name, for a create that may not refuse a taken one.

import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import { cleanName } from '../mount/names';
import { saveThumbnail } from '../shared/thumbnails';
import type { User } from '../user';
import type { Drive } from './drive';
import { folderIn, withFreeName } from './naming';

// `commit` writes the temp file when its caller has not yet and puts the bytes in the tree, or only fetches them for
// a file whose type changed. No caller removes the temp file: a failed commit does here, then the thumbnail job.
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

type StagedFile = {
    parentId: string;
    name: string;
    mimeType: string;
    size: number;
    hash: string;
    tempId: string;
    user: User;
};

// The file keeps the name it came with beside the free one: inside a document nobody sees the stored name, so
// an attachment shows and downloads under this one.
export async function finalizeUpload(drive: Drive, mount: Mount, file: StagedFile): Promise<DrivePath> {
    const originalName = cleanName(file.name);
    return withFreeName(folderIn(mount, file.parentId), originalName, (name) =>
        finalizeNamedUpload(drive, mount, { ...file, name }, originalName),
    );
}

// A WebDAV URL names one file, so its create never picks another name: on a taken one the mount's 409 stands.
// It tells no watcher, so an upload of many files can notify them once.
export async function finalizeNamedUpload(
    drive: Drive,
    mount: Mount,
    file: StagedFile,
    originalName?: string,
): Promise<DrivePath> {
    const { parentId, name, mimeType, size, hash, tempId, user } = file;
    const pathId = await mount.createFileFromTemp(parentId, name, mimeType, size, hash, tempId);
    const uploaded = originalName
        ? await mount.updatePath(pathId, { details: { originalName } })
        : await mount.getActivePath(pathId);
    drive.emit(SSEventType.DRIVE_FILE_UPLOADED, uploaded);
    mount.history.record({ pathId, eventType: 'uploaded', actor: user, details: { size: uploaded.size } });
    return uploaded;
}
