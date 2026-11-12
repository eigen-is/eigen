// Deletes the parts of a document that its current state does not name, such as an image deleted from a doc or the
// thread of a deleted comment. Nothing runs it on its own: Delete history runs it once the versions are gone, and a
// copy runs it on each document it copied. Inside each thread it keeps, a file no message names goes too. A part
// younger than the grace stays, a file by its upload and a thread by its last write, because an upload lands before
// the edit that names it. A copy deletes only parts it wrote itself. A failure is logged and deletes nothing more.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, DRIVE_TYPE_FOLDER, isCollabType } from '@workspace/lib/types/drive';
import { CHAT_ROOM_DB_CONFIG, withCommentIndex } from '../chat';
import * as chatSchema from '../chat/schema';
import { captureCollabSource } from '../document/transform/collab-source';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { CONTAINER_CHAT_FOLDER, CONTAINER_DATA_DB, CONTAINER_MEDIA_FOLDER } from '../mount/container-dbs';
import type { CopyTree } from '../mount/copy';
import { foldName } from '../mount/names';
import { withSvgSiblings } from '../preview/svg-media-inline';
import type { DriveLike } from './get-drive';

// Runs on an open document as well as a closed one, as both read the same data.db. The grace is how old a part must
// be to go.
export async function sweepDocument(drive: DriveLike, document: DrivePath, graceMs: number): Promise<void> {
    try {
        await sweepParts(drive, document, Date.now() - graceMs, null);
    } catch (error) {
        console.warn(`[sweep] stopped in ${document.id}:`, error instanceof Error ? error.message : error);
    }
}

// Sweeps each document a copy made, the copy itself or each one in a copied folder, with no grace. A listing of the
// target folder shows the copy while it lands, so someone may add an image, a comment or a document to it before this
// runs: only what `tree`, the listing the copy wrote from, names is swept. The copy itself succeeded, so a failure only logs.
export async function sweepCopy(drive: DriveLike, copy: DrivePath, tree: CopyTree): Promise<void> {
    try {
        const { mount } = await drive.resolveFile(copy.mountId, copy.id);
        if (copy.type === DRIVE_TYPE_FOLDER) {
            for (const [child, written] of await listWritten(mount, copy, tree)) await sweepCopy(drive, child, written);
        } else if (copy.type !== DRIVE_TYPE_FILE) {
            await sweepParts(drive, copy, Date.now(), await writtenIds(mount, copy, tree));
        }
    } catch (error) {
        console.warn(`[sweep] stopped in ${copy.id}:`, error instanceof Error ? error.message : error);
    }
}

// The paths in `folder` that a copy wrote, each with the part of `tree` it was written from, matched by name. A path
// added since is left out.
async function listWritten(mount: Mount, folder: DrivePath, tree: CopyTree): Promise<[DrivePath, CopyTree][]> {
    const written = new Map(tree.children.map((child) => [foldName(child.path.name), child]));
    return (await mount.listFolder(folder.id)).flatMap((path): [DrivePath, CopyTree][] => {
        const child = written.get(foldName(path.name));
        return child ? [[path, child]] : [];
    });
}

// The ids of every path below `container` that a copy wrote.
async function writtenIds(mount: Mount, container: DrivePath, tree: CopyTree): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const [path, written] of await listWritten(mount, container, tree)) {
        ids.add(path.id);
        if (written.children.length > 0) for (const id of await writtenIds(mount, path, written)) ids.add(id);
    }
    return ids;
}

// A copy passes `written`, the ids of the parts it wrote, and only those may go. Delete history passes null, as any
// part may go.
async function sweepParts(
    drive: DriveLike,
    document: DrivePath,
    cutoff: number,
    written: ReadonlySet<string> | null,
): Promise<void> {
    const { mount } = await drive.resolveFile(document.mountId, document.id);
    const isCandidate = (part: DrivePath) => !written || written.has(part.id);
    const isOld = (file: DrivePath) => file.createdAt.getTime() <= cutoff;
    const media = await mount.getChildByName(document.id, CONTAINER_MEDIA_FOLDER);
    const files = media
        ? (await mount.listFolder(media.id)).filter((file) => file.type === DRIVE_TYPE_FILE && isCandidate(file))
        : [];
    const chat = await mount.getChildByName(document.id, CONTAINER_CHAT_FOLDER);
    const threads = chat
        ? (await mount.listFolder(chat.id)).filter((thread) => thread.type === DRIVE_TYPE_CHAT && isCandidate(thread))
        : [];
    if (!files.some(isOld) && threads.length === 0) return;

    const names = isCollabType(document.type)
        ? await runDocumentReferences(
              { documentType: document.type, source: await captureCollabSource(mount, document) },
              { priority: 'background' },
          )
        : { media: await attachmentNames(mount, document), chat: [] };
    // A kept SVG keeps the files it draws, such as one the grace keeps because its edit has not landed yet.
    const youngFiles = files.filter((file) => !isOld(file)).map((file) => file.name);
    const keptFiles = await withSvgSiblings(mount, files, [...names.media, ...youngFiles]);
    const namedThreads = new Set(names.chat.map(foldName));
    const keptThreads: DrivePath[] = [];
    const idleThreads: DrivePath[] = [];
    for (const thread of threads) {
        // A thread nobody names stays while someone wrote in it since the cutoff: its creation, or the last sync of its
        // data.db, which stamps the row. A reply reaches the row only when the database syncs, so one in the last
        // seconds before a sweep doesn't count.
        const dataDb = await mount.getChildByName(thread.id, CONTAINER_DATA_DB);
        const lastWrite = Math.max(thread.createdAt.getTime(), dataDb?.updatedAt.getTime() ?? 0);
        const kept = namedThreads.has(foldName(thread.name)) || lastWrite > cutoff;
        (kept ? keptThreads : idleThreads).push(thread);
    }

    const unnamedFiles = files.filter((file) => isOld(file) && !keptFiles.has(foldName(file.name)));
    // One at a time, so a failure deletes nothing more after it.
    for (const path of [...unnamedFiles, ...idleThreads]) await mount.deletePath(path.id);
    // A row goes once its thread is gone, as one still there would lose its status and its assignee.
    if (chat) {
        await withCommentIndex(drive, document.mountId, document.id, async (index) =>
            index.deleteRowsWithoutThread(new Set(mount.liveChildNames(chat.id).map(foldName))),
        );
    }
    const freed = [...unnamedFiles, ...idleThreads].reduce((sum, path) => sum + path.size, 0);
    if (freed > 0) {
        console.log(
            `[sweep] ${document.id}: deleted ${unnamedFiles.length} files, ${idleThreads.length} threads, ${freed} bytes`,
        );
    }
    for (const thread of keptThreads) await sweepParts(drive, thread, cutoff, written);
}

// The files a thread's messages name, a deleted message's included. An attachment is a file in the thread's media
// folder when it is a string, and a Drive reference otherwise.
async function attachmentNames(mount: Mount, thread: DrivePath): Promise<string[]> {
    const dataDb = await mount.getChildByName(thread.id, CONTAINER_DATA_DB);
    if (!dataDb) throw new Error(`${thread.id}: data.db missing`);
    const rows = await mount.withDatabase(CHAT_ROOM_DB_CONFIG, dataDb.id, async ({ db }) =>
        db.select({ attachments: chatSchema.messages.attachments }).from(chatSchema.messages).all(),
    );
    return rows.flatMap((row) => row.attachments ?? []).filter((attachment) => typeof attachment === 'string');
}
