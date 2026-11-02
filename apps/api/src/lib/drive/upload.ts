// The last steps of a new file, such as an upload or a copy from another drive. They turn a temp
// file into a file in the tree under a free name, tell open tabs and write the history row. A
// thumbnail is then made in the background, by a helper that an overwrite of a file uses too.

import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import { isNameTakenError } from '../mount/helpers';
import { foldName } from '../mount/names';
import { saveThumbnail } from '../shared/thumbnails';
import type { User } from '../user';
import type { Drive } from './drive';
import { FREE_NAME_ATTEMPTS, getUniqueFileName } from './naming';

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
        user?: User;
    },
): Promise<DrivePath> {
    // The store keeps names in NFC, so the name is compared with its siblings in that form too.
    const originalName = args.name.replace(/[/\\]/g, '_').normalize('NFC');
    const { pathId, name: safeName } = await createUnderFreeName(mount, args.parentId, originalName, (name) =>
        mount.createFileFromTemp(args.parentId, name, args.mimeType, args.size, args.hash, args.tempId),
    );
    const uploadedFile = originalName
        ? await mount.updatePath(pathId, { details: { originalName } })
        : await mount.getActivePath(pathId);
    drive.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
    // Only the history row. The caller tells the watchers.
    if (args.user) {
        mount.history.record({
            pathId,
            eventType: 'uploaded',
            actor: args.user,
            details: { size: uploadedFile.size },
        });
    }

    if (uploadedFile.size === 0) {
        // An empty file has no thumbnail. Finder copies in two steps: an empty file first, and the
        // bytes later through writeFileContent.
        await mount.cleanupTemp(args.tempId);
    } else {
        regenerateThumbnailAsync(drive, mount, pathId, mount.getTempPath(args.tempId), args.mimeType, safeName, () =>
            mount.cleanupTemp(args.tempId),
        );
    }

    return uploadedFile;
}

// Two uploads of one name into one folder at once, such as two pasted screenshots, both read the name as
// free, and the one that creates second gets a 409. That one reads the folder again and picks the next free
// name, as the copy route does. The temp file is only read by a create, so a lost one can try again.
async function createUnderFreeName(
    mount: Mount,
    parentId: string,
    desired: string,
    create: (name: string) => Promise<string>,
): Promise<{ pathId: string; name: string }> {
    for (let attempt = 1; ; attempt++) {
        let name = desired;
        if (await mount.getChildByName(parentId, desired)) {
            const siblings = await mount.listFolder(parentId);
            name = getUniqueFileName(desired, new Set(siblings.map((s) => foldName(s.name))));
        }
        try {
            return { pathId: await create(name), name };
        } catch (e) {
            if (attempt === FREE_NAME_ATTEMPTS || !isNameTakenError(e, name)) throw e;
        }
    }
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
    const job = (async () => {
        try {
            const thumbnail = await saveThumbnail(mount.thumbsDir, pathId, source, mimeType, fileName);
            if (!thumbnail) return;
            const current = await mount.getPath(pathId);
            if (!current) return;
            const updated = await mount.updatePath(pathId, {
                thumbnail: thumbnail.fileName,
                details: {
                    ...(current.details ?? {}),
                    width: thumbnail.width,
                    height: thumbnail.height,
                    ...(thumbnail.duration !== undefined && { duration: thumbnail.duration }),
                },
            });
            drive.emit(SSEventType.DRIVE_FILE_UPLOADED, updated);
        } finally {
            await onCleanup?.();
        }
    })().catch((e) => console.error(`Thumbnail generation failed for ${pathId}:`, e));
    mount.thumbnailJobs.add(job);
    job.finally(() => mount.thumbnailJobs.delete(job));
}
