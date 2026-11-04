// The sweep. Once a document's last tab has closed, it deletes the parts of the document that nothing names any more,
// such as an image deleted before every version that is still kept, or the thread of a deleted comment. A part stays
// while the current state or a saved version names it, or while it is younger than three days. A linger close starts
// it, at most once a day per document. A change while it reads waits for the next close, and a failure for the next
// day, so a sweep can keep a part too long but never deletes one in use.

import { Database as BunDatabase } from 'bun:sqlite';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, isCollabType } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { withCommentIndex } from '../chat';
import * as chatSchema from '../chat/schema';
import { readYjsStatePayloadFromFile } from '../collab/yjs-loader';
import { REFERENCE_READER_VERSION } from '../document/references';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { foldName } from '../mount/names';
import { getVersionReferences, putVersionReferences } from '../mount/version-references';
import { withSvgSiblings } from '../preview/svg-media-inline';
import { listVersions } from '../versioning/list';
import { DAY_MS, HOUR_MS } from '../versioning/retention';
import type { Drive } from './drive';

// A part this young stays, whatever names it: a file by its upload, a thread by its last message. An upload lands in
// media/ before the edit that names it reaches the server, and a tab that was offline may still hold such an edit.
const GRACE_MS = 72 * HOUR_MS;

// When each document's last sweep ended, by owner, mount and path. It lives in memory, so a restart forgets it, which
// costs one extra sweep.
const sweptAt = new Map<string, number>();
// The documents a sweep is reading or deleting now. A reopen and a second close during a long read find the document
// still due, and that second sweep leaves it to the first.
const sweeping = new Set<string>();

export function isSweepDue(path: DrivePath): boolean {
    const at = sweptAt.get(sweepKey(path));
    return at === undefined || Date.now() - at >= DAY_MS;
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

// Reads everything first, outside any lock: the names in the current state and in every saved version, and the files
// the messages of each thread name. Then, under the document's lock, it deletes only if nothing changed while it read.
export async function sweepDocument(drive: Drive, container: DrivePath): Promise<void> {
    const key = sweepKey(container);
    if (!isCollabType(container.type) || sweeping.has(key)) return;
    sweeping.add(key);
    // A change while it read leaves the document due, so its next close tries again. Every other end marks the
    // document swept for the day, a failure included.
    let changed = false;
    try {
        const documentType = container.type;
        const cutoff = Date.now() - GRACE_MS;
        const isOld = (file: DrivePath) => file.type === DRIVE_TYPE_FILE && file.createdAt.getTime() <= cutoff;
        const { mount } = await drive.resolveFile(container.mountId, container.id);
        if (isBusy(drive, mount, container.id)) {
            changed = true;
            return;
        }
        // The current state is read from data.db after the fence. A change before the fence, such as a restore, is
        // in what it reads, and a change after it moves the fence the delete checks.
        const read = await readFence(mount, container.id);
        if (!read.dataDb) throw new Error(`${container.id}: data.db missing`);

        // Each read is a job of its own, and a version is read again only when the reader changed. A version's row is
        // written as soon as its job returns. So memory and the child's time stay bounded to one state, and a failure
        // keeps the work done.
        const current = await readStoredCopy(mount, read.dataDb.id, readYjsStatePayloadFromFile);
        const named = [await runDocumentReferences({ documentType, source: current }, { priority: 'background' })];
        const rows = getVersionReferences(
            mount,
            read.versions.map((version) => version.id),
        ).filter((row) => row.readerVersion >= REFERENCE_READER_VERSION);
        named.push(...rows.map((row) => row.names));
        const known = new Set(rows.map((row) => row.versionPathId));
        for (const version of read.versions) {
            if (known.has(version.id)) continue;
            const source = await readStoredCopy(mount, version.id, readYjsStatePayloadFromFile);
            const names = await runDocumentReferences({ documentType, source }, { priority: 'background' });
            named.push(names);
            putVersionReferences(mount, [
                { versionPathId: version.id, readerVersion: REFERENCE_READER_VERSION, names },
            ]);
        }

        // A name matches its file as getChildByName finds it, whatever its case or Unicode form.
        const media = await mount.getChildByName(container.id, 'media');
        const kept = media
            ? await withSvgSiblings(
                  mount,
                  media.id,
                  named.flatMap((names) => names.media),
              )
            : [];
        const keptNames = new Set([...kept].map(foldName));

        // A thread goes when no state names it and nobody wrote in it for three days. The media of a thread that
        // stays go when no message names them, a deleted message included. On a bucket a thread's data.db is read as
        // a whole download, so it is read only when an old file could go.
        const keptThreads = new Set(named.flatMap((names) => names.chat).map(foldName));
        const chat = await mount.getChildByName(container.id, 'chat');
        const idleThreads: DrivePath[] = [];
        const threadMedia = new Map<string, ReadonlySet<string>>();
        for (const thread of chat ? await mount.listFolder(chat.id) : []) {
            if (thread.type !== DRIVE_TYPE_CHAT) continue;
            if (!keptThreads.has(foldName(thread.name)) && (await lastActivity(mount, thread)) <= cutoff) {
                idleThreads.push(thread);
                continue;
            }
            const threadMediaFolder = await mount.getChildByName(thread.id, 'media');
            const threadDataDb = await mount.getChildByName(thread.id, 'data.db');
            if (!threadMediaFolder || !threadDataDb) continue;
            if (!(await mount.listFolder(threadMediaFolder.id)).some(isOld)) continue;
            threadMedia.set(threadMediaFolder.id, await readStoredCopy(mount, threadDataDb.id, readAttachmentNames));
        }

        const deleted = await mount.withPathLock(container.id, async () => {
            const row = await mount.getPath(container.id);
            if (!row || row.trashedAt || isBusy(drive, mount, container.id)) return null;
            if ((await readFence(mount, container.id)).fence !== read.fence) return null;
            const unnamedIn = async (folderId: string, names: ReadonlySet<string>) =>
                (await mount.listFolder(folderId)).filter((file) => isOld(file) && !names.has(foldName(file.name)));
            const files = media ? await unnamedIn(media.id, keptNames) : [];
            for (const [folderId, names] of threadMedia) files.push(...(await unnamedIn(folderId, names)));
            // A reply since the read keeps its thread.
            const threads: DrivePath[] = [];
            for (const thread of idleThreads) if ((await lastActivity(mount, thread)) <= cutoff) threads.push(thread);

            // Every delete ends before the lock is let go, so a failed one doesn't leave the others running outside it.
            const results = await Promise.allSettled([...files, ...threads].map((path) => mount.deletePath(path.id)));
            const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failed) throw failed.reason;
            // The rows go only once their threads went, because a thread that stays without its row loses its status
            // and its assignee. A thread in the trash keeps its row too, so a restore brings it back as it was. A row
            // whose thread went is harmless, and the next sweep that deletes a thread drops it.
            if (chat && threads.length > 0) {
                await withCommentIndex(drive, mount.id, container.id, async (index) => {
                    const present = new Set(mount.childNamesWithTrash(chat.id).map(foldName));
                    return index.deleteRowsWithoutThread((chatName) => present.has(foldName(chatName)));
                });
            }
            return { files, threads };
        });
        if (!deleted) {
            changed = true;
            return;
        }
        const { files, threads } = deleted;
        if (files.length === 0 && threads.length === 0) return;
        const freed = [...files, ...threads].reduce((sum, path) => sum + path.size, 0);
        console.log(
            `[sweep] ${container.id}: deleted ${files.length} files and ${threads.length} threads, freed ${freed} bytes`,
        );
    } finally {
        sweeping.delete(key);
        if (!changed) {
            const now = Date.now();
            for (const [swept, at] of sweptAt) if (now - at >= DAY_MS) sweptAt.delete(swept);
            sweptAt.set(key, now);
        }
    }
}

function sweepKey(path: DrivePath): string {
    return `${path.ownerId}.${path.mountId}.${path.id}`;
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
        mount.getChildByName(containerId, 'data.db'),
        listVersions(mount, containerId),
    ]);
    const fence = JSON.stringify([dataDb?.size, dataDb?.updatedAt.getTime(), versions.map((version) => version.id)]);
    return { dataDb, versions, fence };
}

// When someone last wrote in a thread: its creation, or the last sync of its data.db, which stamps the row.
async function lastActivity(mount: Mount, thread: DrivePath): Promise<number> {
    const dataDb = await mount.getChildByName(thread.id, 'data.db');
    return Math.max(thread.createdAt.getTime(), dataDb?.updatedAt.getTime() ?? 0);
}

// A database nobody serves, such as the document's own data.db after its close, a version or a thread's data.db, is
// read from a temp copy of its own. On a bucket the copy is the staged one while its upload is pending, so it is the
// newest. The copy is never opened through the mount, so the read stamps no row.
async function readStoredCopy<T>(mount: Mount, pathId: string, read: (localPath: string) => T): Promise<T> {
    const tempId = crypto.randomUUID();
    try {
        return read(await mount.downloadToTemp(pathId, tempId));
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

// The files a thread's messages name, folded the way a name finds its file. A message's attachment is a file in the
// thread's media folder when it is a string, and a Drive reference otherwise.
function readAttachmentNames(localPath: string): Set<string> {
    const rawDb = new BunDatabase(localPath);
    try {
        const rows = drizzle(rawDb, { schema: chatSchema })
            .select({ attachments: chatSchema.messages.attachments })
            .from(chatSchema.messages)
            .all();
        const names = rows
            .flatMap((row) => row.attachments ?? [])
            .filter((attachment) => typeof attachment === 'string');
        return new Set(names.map(foldName));
    } finally {
        rawDb.close();
    }
}
