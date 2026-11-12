// Deletes the parts of a document that its current state does not name, such as an image deleted from a doc or the
// thread of a deleted comment. It runs only when a change asks for it, such as Delete history or a copy. Inside each
// thread it keeps, a file no message names goes too. A part younger than the grace stays, because an upload lands
// before the edit that names it. A copy deletes only parts it wrote itself. A failure is logged and deletes no more.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, isCollabType } from '@workspace/lib/types/drive';
import { CHAT_ROOM_DB_CONFIG, withCommentIndex } from '../chat';
import * as chatSchema from '../chat/schema';
import { captureCollabSource } from '../document/transform/collab-source';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { CONTAINER_CHAT_FOLDER, CONTAINER_DATA_DB, CONTAINER_MEDIA_FOLDER } from '../mount/container-dbs';
import type { Copied } from '../mount/copy';
import { foldName } from '../mount/names';
import { withSvgSiblings } from '../preview/svg-media-inline';
import type { Drive } from './drive';

// Runs on an open document as well as a closed one, as both read the same data.db. The grace is how old a part must
// be to go.
export async function sweepDocument(drive: Drive, mount: Mount, document: DrivePath, graceMs: number): Promise<void> {
    try {
        await sweepParts(drive, mount, document, Date.now() - graceMs, null);
    } catch (error) {
        console.warn(`[sweep] stopped in ${document.id}:`, error instanceof Error ? error.message : error);
    }
}

// Sweeps each document a copy made, with no grace. Someone may add a part to the copy while it lands, so only the
// paths the copy made may go. The copy itself succeeded, so a failure only logs.
export async function sweepCopy(drive: Drive, mount: Mount, copy: Copied): Promise<void> {
    try {
        for (const id of copy.documentIds) {
            await sweepParts(drive, mount, await mount.getActivePath(id), Date.now(), copy.createdIds);
        }
    } catch (error) {
        console.warn(`[sweep] stopped in ${copy.path.id}:`, error instanceof Error ? error.message : error);
    }
}

// Only a part in `written` may go. With null any part may.
async function sweepParts(
    drive: Drive,
    mount: Mount,
    document: DrivePath,
    cutoff: number,
    written: ReadonlySet<string> | null,
): Promise<void> {
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
    const gone = [...unnamedFiles, ...idleThreads];
    // One at a time, so a failure deletes nothing more after it.
    for (const path of gone) await mount.deletePath(path.id);
    // A row goes once its thread is gone, as one still there would lose its status and its assignee.
    if (chat) {
        await withCommentIndex(drive, document.mountId, document.id, async (index) =>
            index.deleteRowsWithoutThread(new Set(mount.liveChildNames(chat.id).map(foldName))),
        );
    }
    const freed = gone.reduce((sum, path) => sum + path.size, 0);
    if (freed > 0) {
        console.log(
            `[sweep] ${document.id}: deleted ${unnamedFiles.length} files, ${idleThreads.length} threads, ${freed} bytes`,
        );
    }
    for (const thread of keptThreads) await sweepParts(drive, mount, thread, cutoff, written);
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
