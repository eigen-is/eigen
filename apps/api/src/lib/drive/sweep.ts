// Deletes the parts of a collab document that nothing names any more, such as an image deleted before every saved
// version, or the thread of a deleted comment. A part stays while the current state or a saved version names it, or
// while it is younger than the grace period. Each version's names are read when it is taken, and every linger close
// starts a sweep that uses them. A sweep that fails, or finds the document changed, deletes nothing, and the next
// close tries again, so a sweep can keep a part too long but never deletes one in use.

import { SWEEP_GRACE_MS } from '@workspace/lib/constants/sweep';
import type { DriveCollabType, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, isCollabType } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { withCommentIndex } from '../chat';
import { readYjsStatePayloadFromFile } from '../collab/yjs-loader';
import { REFERENCE_READER_VERSION } from '../document/references';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { CONTAINER_CHAT_FOLDER, CONTAINER_DATA_DB, CONTAINER_MEDIA_FOLDER } from '../mount/container-dbs';
import { foldName } from '../mount/names';
import type { DocumentReferences } from '../mount/schema';
import { getVersionReferences, putVersionReferences } from '../mount/version-references';
import { withSvgSiblings } from '../preview/svg-media-inline';
import { listVersions } from '../versioning/list';
import type { Drive } from './drive';

// Reads what a version names and keeps it as the version's row, so a sweep finds it without a download. Mount calls it
// for each version it takes, while the version's bytes are still on local disk. It runs in the background, and a
// failure, such as a busy transform process, only leaves the version for a sweep to read.
export function nameVersion(mount: Mount, containerId: string, versionId: string): void {
    const read = async () => {
        const container = await mount.getPath(containerId);
        if (container && isCollabType(container.type)) await readVersionNames(mount, container.type, versionId);
    };
    read().catch((error: unknown) => {
        console.warn(`[sweep] names of version ${versionId}:`, error instanceof Error ? error.message : error);
    });
}

// Closes a lingering document and then sweeps it. The hold on the Home comes first, because the close lets go of the
// hold the lingering document kept, and an idle Home would close before the sweep began. It resolves with the close,
// and the sweep goes on in the background.
export function sweepAfterClose(drive: Drive, path: DrivePath, close: () => Promise<void>): Promise<void> {
    // A Home that is closing refuses the hold. The document still closes, and the sweep waits for a later close.
    let releaseHome: () => void;
    try {
        releaseHome = drive.holdHome();
    } catch {
        return close();
    }
    const closed = close();
    closed
        .then(() => sweepDocument(drive, path))
        .catch((error: unknown) => {
            console.warn(`[sweep] skipped ${path.id}:`, error instanceof Error ? error.message : error);
        })
        .finally(releaseHome);
    return closed;
}

// Lists first what could go: the old files in media/ and the idle threads in chat/. It drops those a version names, and
// stops when none is left. Only then, outside any lock, it reads the current state. Under the document's lock it
// deletes only if nothing changed while it read.
export async function sweepDocument(drive: Drive, container: DrivePath): Promise<void> {
    const documentType = container.type;
    if (!isCollabType(documentType)) return;
    const cutoff = Date.now() - SWEEP_GRACE_MS;
    const isOld = (file: DrivePath) => file.type === DRIVE_TYPE_FILE && file.createdAt.getTime() <= cutoff;
    const { mount } = await drive.resolveFile(container.mountId, container.id);
    if (isBusy(drive, mount, container.id)) return;

    const media = await mount.getChildByName(container.id, CONTAINER_MEDIA_FOLDER);
    const chat = await mount.getChildByName(container.id, CONTAINER_CHAT_FOLDER);
    const oldMedia = media ? (await mount.listFolder(media.id)).filter(isOld) : [];
    const idleThreads: DrivePath[] = [];
    for (const thread of chat ? await mount.listFolder(chat.id) : []) {
        if (thread.type === DRIVE_TYPE_CHAT && !(await isActive(mount, thread, cutoff))) idleThreads.push(thread);
    }
    if (oldMedia.length === 0 && idleThreads.length === 0) return;

    // The states are read after the fence. A change before it, such as a restore, is in what they read, and a change
    // after it moves the fence the delete checks.
    const read = await readFence(mount, container.id);
    if (!read.dataDb) throw new Error(`${container.id}: data.db missing`);

    // A version without a row from the current reader, such as one whose read failed when it was taken, is read now.
    const rows = getVersionReferences(
        mount,
        read.versions.map((version) => version.id),
    ).filter((row) => row.readerVersion >= REFERENCE_READER_VERSION);
    const named = rows.map((row) => row.names);
    const known = new Set(rows.map((row) => row.versionPathId));
    for (const version of read.versions) {
        if (!known.has(version.id)) named.push(await readVersionNames(mount, documentType, version.id));
    }
    const namedBy = (field: 'media' | 'chat') => new Set(named.flatMap((names) => names[field]).map(foldName));
    const versionMedia = namedBy('media');
    const versionChat = namedBy('chat');
    if (
        oldMedia.every((file) => versionMedia.has(foldName(file.name))) &&
        idleThreads.every((thread) => versionChat.has(foldName(thread.name)))
    ) {
        return;
    }

    // A restore brings back a version's anchors but keeps today's cards, so the current state also names what today's
    // card holds for every card a version has in use.
    const versionCards = [...new Set(named.flatMap((names) => names.cards))];
    named.push(await storedReferences(mount, documentType, read.dataDb.id, versionCards));
    const namedMedia = namedBy('media');
    // A kept SVG keeps the files it draws. The SVGs are read only when an old file is not among the names, and one
    // that can't be read keeps every file this time.
    const keptMedia =
        media && oldMedia.some((file) => !namedMedia.has(foldName(file.name)))
            ? await withSvgSiblings(mount, media.id, [...namedMedia])
            : namedMedia;
    const keptThreads = namedBy('chat');
    const unnamedThreads = idleThreads.filter((thread) => !keptThreads.has(foldName(thread.name)));

    const deleted = await mount.withPathLock(container.id, async () => {
        const row = await mount.getPath(container.id);
        if (!row || row.trashedAt || isBusy(drive, mount, container.id)) return null;
        if ((await readFence(mount, container.id)).fence !== read.fence) return null;
        const files =
            media && keptMedia
                ? (await mount.listFolder(media.id)).filter(
                      (file) => isOld(file) && !keptMedia.has(foldName(file.name)),
                  )
                : [];
        // A thread is read again, because since the read someone may have trashed it, moved it or written in it, and
        // then it stays.
        const threads: DrivePath[] = [];
        for (const unnamed of unnamedThreads) {
            const thread = await mount.getPath(unnamed.id);
            if (!thread || thread.trashedAt || thread.parentId !== chat?.id) continue;
            if (drive.isTrashing(mount.id, thread.id) || (await isActive(mount, thread, cutoff))) continue;
            threads.push(thread);
        }

        // Every delete ends before the lock is let go, so a failed one doesn't leave the others running outside it.
        const results = await Promise.allSettled([...files, ...threads].map((path) => mount.deletePath(path.id)));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        // The rows go only once their threads went, because a thread that stays without its row loses its status
        // and its assignee. A thread in the trash keeps its row too, so a restore brings it back as it was. A row
        // whose thread went is harmless, and the next sweep that deletes a thread drops it.
        if (chat && threads.length > 0) {
            // The names are read in the same step as the delete, so a thread made meanwhile is either among them
            // or has no row yet.
            await withCommentIndex(drive, mount.id, container.id, async (index) =>
                index.deleteRowsWithoutThread(new Set(mount.childNamesWithTrash(chat.id).map(foldName))),
            );
        }
        return { files, threads };
    });
    if (!deleted || deleted.files.length + deleted.threads.length === 0) return;
    const { files, threads } = deleted;
    const freed = [...files, ...threads].reduce((sum, path) => sum + path.size, 0);
    console.log(
        `[sweep] ${container.id}: deleted ${files.length} files and ${threads.length} threads, freed ${freed} bytes`,
    );
}

// A document someone opened again, one on its way to the trash, one a restore puts back and a mount that closes are
// left alone.
function isBusy(drive: Drive, mount: Mount, containerId: string): boolean {
    return (
        mount.closing ||
        drive.hasCollabDocument(mount.id, containerId) ||
        drive.isTrashing(mount.id, containerId) ||
        drive.isRestoring(mount.id, containerId)
    );
}

// Whether someone wrote in a thread since the cutoff: its creation, or the last sync of its data.db, which stamps the
// row. A write reaches the row only when the database syncs, so a data.db open on the server counts as a write, such
// as a reply through the Chat app while the document is closed.
async function isActive(mount: Mount, thread: DrivePath, cutoff: number): Promise<boolean> {
    const dataDb = await mount.getChildByName(thread.id, CONTAINER_DATA_DB);
    if (dataDb && mount.documentDbs.has(dataDb.id)) return true;
    return Math.max(thread.createdAt.getTime(), dataDb?.updatedAt.getTime() ?? 0) > cutoff;
}

// What a change to the document while the sweep read would move: the data.db row, which every save stamps, and the
// list of versions, which a save, a prune or a restore changes.
async function readFence(
    mount: Mount,
    containerId: string,
): Promise<{ dataDb: DrivePath | null; versions: Snapshot[]; fence: string }> {
    const [dataDb, versions] = await Promise.all([
        mount.getChildByName(containerId, CONTAINER_DATA_DB),
        listVersions(mount, containerId),
    ]);
    const fence = JSON.stringify([dataDb?.size, dataDb?.updatedAt.getTime(), versions.map((version) => version.id)]);
    return { dataDb, versions, fence };
}

async function readVersionNames(
    mount: Mount,
    documentType: DriveCollabType,
    versionId: string,
): Promise<DocumentReferences> {
    const names = await storedReferences(mount, documentType, versionId);
    putVersionReferences(mount, { versionPathId: versionId, readerVersion: REFERENCE_READER_VERSION, names });
    return names;
}

// The parts one stored state names, such as a version or a closed document's data.db. It is read from a temp copy of
// its own, so the read opens nothing through the mount and stamps no row. On a bucket that copy is the staged one
// while its upload is pending, so it is the newest.
async function storedReferences(
    mount: Mount,
    documentType: DriveCollabType,
    pathId: string,
    versionCards?: readonly string[],
): Promise<DocumentReferences> {
    const tempId = crypto.randomUUID();
    try {
        const source = readYjsStatePayloadFromFile(await mount.downloadToTemp(pathId, tempId));
        return await runDocumentReferences({ documentType, source, versionCards }, { priority: 'background' });
    } finally {
        await mount.cleanupTemp(tempId);
    }
}
