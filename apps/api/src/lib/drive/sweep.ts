// Deletes the parts of a collab document that nothing names any more, such as an image deleted before every saved
// version, or the thread of a deleted comment. A part stays while the current state or a saved version names it, or
// while it is younger than the grace period. Each version's names are read when it is taken. A linger close starts a
// sweep, once a day per document or sooner after a Delete history. A change or a busy transform process while it
// reads waits for the next close, and a failure for the next day, so a sweep can keep a part too long but never
// deletes one in use.

import { SWEEP_GRACE_MS } from '@workspace/lib/constants/sweep';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, isCollabType } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { withCommentIndex } from '../chat';
import { ApiError } from '../core/errors';
import { REFERENCE_READER_VERSION } from '../document/references';
import type { Mount } from '../mount';
import { CONTAINER_CHAT_FOLDER, CONTAINER_DATA_DB, CONTAINER_MEDIA_FOLDER } from '../mount/container-dbs';
import { pathKey } from '../mount/helpers';
import { foldName } from '../mount/names';
import { getVersionReferences, putVersionReferences } from '../mount/version-references';
import { listVersions } from '../versioning/list';
import { DAY_MS } from '../versioning/retention';
import type { Drive } from './drive';
import { mediaKeptBy, storedReferences, threadAttachmentNames } from './named-parts';

// The most unread versions one sweep reads, so a document with a long history costs a few downloads and jobs per
// close. A sweep that left some unread deletes nothing, and the next close reads on.
export const MAX_VERSIONS_PER_SWEEP = 8;

// When each document's last sweep ended, by owner, mount and path. It lives in memory, so a restart forgets it, which
// costs one extra sweep.
const sweptAt = new Map<string, number>();
// The documents a sweep works on. A reopen and a second close during a long read find the document still due, and
// that second sweep leaves it to the first.
const sweeping = new Set<string>();
// The documents marked due while their sweep ran, such as by a Delete history. That sweep may have read what was
// there before, so the document stays due.
const markedWhileSwept = new Set<string>();

export function isSweepDue(path: DrivePath): boolean {
    const at = sweptAt.get(pathKey(path.ownerId, path.mountId, path.id));
    return at === undefined || Date.now() - at >= DAY_MS;
}

// A change that leaves parts only the next sweep can free, such as Delete history, makes the document due at once.
export function markSweepDue(path: DrivePath): void {
    const key = pathKey(path.ownerId, path.mountId, path.id);
    sweptAt.delete(key);
    if (sweeping.has(key)) markedWhileSwept.add(key);
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

// Reads what a version names and keeps it as the version's row, so a sweep finds it without a download. Mount calls it
// for each version it takes, while the version's bytes are still on local disk. It runs in the background, and a
// failure, such as a busy transform process, only leaves the version for a sweep to read.
export function nameVersion(mount: Mount, containerId: string, versionId: string): void {
    readVersionNames(mount, containerId, versionId).catch((error: unknown) => {
        console.warn(`[sweep] names of version ${versionId}:`, error instanceof Error ? error.message : error);
    });
}

async function readVersionNames(mount: Mount, containerId: string, versionId: string): Promise<void> {
    const container = await mount.getPath(containerId);
    if (!container || !isCollabType(container.type)) return;
    const names = await storedReferences(mount, container.type, versionId, 'background');
    putVersionReferences(mount, { versionPathId: versionId, readerVersion: REFERENCE_READER_VERSION, names });
}

// Lists first what could go: the old files in media/, the idle threads and the threads that hold an old file. Only
// then, outside any lock, it reads the names in the saved versions and in the current state, and the files the
// messages of each thread name. Under the document's lock it deletes only if nothing changed while it read.
export async function sweepDocument(drive: Drive, container: DrivePath): Promise<void> {
    const key = pathKey(container.ownerId, container.mountId, container.id);
    const documentType = container.type;
    if (!isCollabType(documentType) || sweeping.has(key)) return;
    sweeping.add(key);
    // A change while it read, a busy transform process or a Delete history meanwhile leave the document due, so its
    // next close tries again. Every other end marks the document swept for the day, a failure included.
    let due = false;
    try {
        const cutoff = Date.now() - SWEEP_GRACE_MS;
        const isOld = (file: DrivePath) => file.type === DRIVE_TYPE_FILE && file.createdAt.getTime() <= cutoff;
        const { mount } = await drive.resolveFile(container.mountId, container.id);
        if (isBusy(drive, mount, container.id)) {
            due = true;
            return;
        }

        // A listing is cheap, so a document where nothing could go costs no download and no job. On a bucket a
        // thread's data.db is read as a whole download, so it is read only for a thread that holds an old file.
        const media = await mount.getChildByName(container.id, CONTAINER_MEDIA_FOLDER);
        const oldMedia = media ? (await mount.listFolder(media.id)).filter(isOld) : [];
        const chat = await mount.getChildByName(container.id, CONTAINER_CHAT_FOLDER);
        const candidateThreads: { thread: DrivePath; idle: boolean; oldMediaIn: DrivePath | null }[] = [];
        for (const thread of chat ? await mount.listFolder(chat.id) : []) {
            if (thread.type !== DRIVE_TYPE_CHAT) continue;
            const idle = !(await isActive(mount, thread, cutoff));
            const threadMedia = await mount.getChildByName(thread.id, CONTAINER_MEDIA_FOLDER);
            const holdsOld = threadMedia !== null && (await mount.listFolder(threadMedia.id)).some(isOld);
            if (idle || holdsOld) candidateThreads.push({ thread, idle, oldMediaIn: holdsOld ? threadMedia : null });
        }
        if (oldMedia.length === 0 && candidateThreads.length === 0) return;

        // The current state is read from data.db after the fence. A change before the fence, such as a restore, is
        // in what it reads, and a change after it moves the fence the delete checks.
        const read = await readFence(mount, container.id);
        if (!read.dataDb) throw new Error(`${container.id}: data.db missing`);

        // A version is read again only when the reader changed. A version's row is written as soon as its read
        // returns, so a failure keeps the work done.
        const rows = getVersionReferences(
            mount,
            read.versions.map((version) => version.id),
        ).filter((row) => row.readerVersion >= REFERENCE_READER_VERSION);
        const named = rows.map((row) => row.names);
        const known = new Set(rows.map((row) => row.versionPathId));
        const unread = read.versions.filter((version) => !known.has(version.id));
        for (const version of unread.slice(0, MAX_VERSIONS_PER_SWEEP)) {
            const names = await storedReferences(mount, documentType, version.id, 'background');
            named.push(names);
            putVersionReferences(mount, { versionPathId: version.id, readerVersion: REFERENCE_READER_VERSION, names });
        }
        if (unread.length > MAX_VERSIONS_PER_SWEEP) {
            due = true;
            return;
        }
        // A restore brings back a version's anchors but keeps today's cards, so the current state also names what
        // today's card holds for every card a version has in use.
        const versionCards = [...new Set(named.flatMap((names) => names.cards))];
        named.push(await storedReferences(mount, documentType, read.dataDb.id, 'background', versionCards));

        const keptNames = media
            ? await mediaKeptBy(
                  mount,
                  media.id,
                  named.flatMap((names) => names.media),
                  oldMedia,
              )
            : new Set<string>();

        // A thread goes when no state names it and nobody wrote in it for the grace period. The media of a thread
        // that stays go when no message names them, a deleted message included.
        const keptThreads = new Set(named.flatMap((names) => names.chat).map(foldName));
        const idleThreads: DrivePath[] = [];
        const threadMedia: { thread: DrivePath; folderId: string; names: ReadonlySet<string> }[] = [];
        for (const { thread, idle, oldMediaIn } of candidateThreads) {
            if (idle && !keptThreads.has(foldName(thread.name))) {
                idleThreads.push(thread);
                continue;
            }
            if (!oldMediaIn) continue;
            const threadDataDb = await mount.getChildByName(thread.id, CONTAINER_DATA_DB);
            if (!threadDataDb) continue;
            const names = await threadAttachmentNames(mount, threadDataDb);
            threadMedia.push({ thread, folderId: oldMediaIn.id, names });
        }

        const deleted = await mount.withPathLock(container.id, async () => {
            const row = await mount.getPath(container.id);
            if (!row || row.trashedAt || isBusy(drive, mount, container.id)) return null;
            if ((await readFence(mount, container.id)).fence !== read.fence) return null;
            const unnamedIn = async (folderId: string, names: ReadonlySet<string>) =>
                (await mount.listFolder(folderId)).filter((file) => isOld(file) && !names.has(foldName(file.name)));
            // A thread is read again, because since the read someone may have moved or trashed it, and then it and
            // its media stay where they went. An idle thread also stays when someone replied in it since.
            const stillInChat = async (id: string) => {
                const thread = await mount.getPath(id);
                if (!thread || thread.trashedAt || thread.parentId !== chat?.id) return null;
                return drive.isTrashing(mount.id, thread.id) ? null : thread;
            };
            const files = media ? await unnamedIn(media.id, keptNames) : [];
            for (const { thread, folderId, names } of threadMedia) {
                if (await stillInChat(thread.id)) files.push(...(await unnamedIn(folderId, names)));
            }
            const threads: DrivePath[] = [];
            for (const idle of idleThreads) {
                const thread = await stillInChat(idle.id);
                if (thread && !(await isActive(mount, thread, cutoff))) threads.push(thread);
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
        if (!deleted) {
            due = true;
            return;
        }
        const { files, threads } = deleted;
        if (files.length === 0 && threads.length === 0) return;
        const freed = [...files, ...threads].reduce((sum, path) => sum + path.size, 0);
        console.log(
            `[sweep] ${container.id}: deleted ${files.length} files and ${threads.length} threads, freed ${freed} bytes`,
        );
    } catch (error) {
        // A busy transform process says nothing about the document.
        if (!(error instanceof ApiError && error.status === 503)) throw error;
        due = true;
    } finally {
        sweeping.delete(key);
        if (markedWhileSwept.delete(key)) due = true;
        if (!due) {
            const now = Date.now();
            for (const [swept, at] of sweptAt) if (now - at >= DAY_MS) sweptAt.delete(swept);
            sweptAt.set(key, now);
        }
    }
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

// Whether someone wrote in a thread since the cutoff: its creation, or the last sync of its data.db, which stamps the
// row. A write reaches the row only when the database syncs, so a data.db open on the server counts as a write, such
// as a reply through the Chat app while the document is closed.
async function isActive(mount: Mount, thread: DrivePath, cutoff: number): Promise<boolean> {
    const dataDb = await mount.getChildByName(thread.id, CONTAINER_DATA_DB);
    if (dataDb && mount.documentDbs.has(dataDb.id)) return true;
    return Math.max(thread.createdAt.getTime(), dataDb?.updatedAt.getTime() ?? 0) > cutoff;
}
