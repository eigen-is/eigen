import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import { saveThumbnail } from '../shared/thumbnails';
import type { User } from '../user';
import type Drive from './drive';
import { getUniqueFileName } from './naming';

// Shared tail of both upload paths (uploadFiles, createFileFromData): sanitize + dedupe
// the name against the parent, promote the temp file into the tree, emit + record, kick
// the thumbnail worker. Fan-out stays with the caller so a multi-file upload notifies
// watchers once per batch; on throw the caller owns cleanupTemp.
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
    // NFC so dedup + getUniqueFileName compare against NFC siblings in the same form the store will use.
    let safeName = args.name.replace(/[/\\]/g, '_').normalize('NFC');
    const originalName = safeName;

    const existing = await mount.getChildByName(args.parentId, safeName);
    if (existing) {
        const siblings = await mount.listFolder(args.parentId);
        const usedNames = new Set(siblings.map((s) => s.name.toLowerCase()));
        safeName = getUniqueFileName(safeName, usedNames);
    }

    const pathId = await mount.createFileFromTemp(
        args.parentId,
        safeName,
        args.mimeType,
        args.size,
        args.hash,
        args.tempId,
    );
    const uploadedFile = originalName
        ? await mount.updatePath(pathId, { details: { originalName } })
        : await mount.getActivePath(pathId);
    drive.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
    // History row only — fan-out is the caller's job, so a multi-file upload
    // notifies watchers once per batch instead of once per file.
    if (args.user) {
        mount.history.record({
            pathId,
            eventType: 'uploaded',
            actor: args.user,
            details: { size: uploadedFile.size },
        });
    }

    if (uploadedFile.size === 0) {
        // 0-byte placeholders (Finder's two-step copy) can't yield a thumbnail.
        // Skip the worker spawn; the real bytes will arrive via writeFileContent.
        await mount.cleanupTemp(args.tempId);
    } else {
        regenerateThumbnailAsync(drive, mount, pathId, mount.getTempPath(args.tempId), args.mimeType, safeName, () =>
            mount.cleanupTemp(args.tempId),
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
    (async () => {
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
}
