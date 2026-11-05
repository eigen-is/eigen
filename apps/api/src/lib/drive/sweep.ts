// Deletes the parts of a document that its current state does not name, such as an image deleted from a doc or the
// thread of a deleted comment. Nothing runs it on its own: Delete history runs it once the versions are gone, and a
// copy runs it on each document it copied. Inside each thread it keeps, a file no message names goes too. A part
// younger than the grace stays, a file by its upload and a thread by its last write, because an upload lands before
// the edit that names it. A failure is logged and deletes nothing more.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, DRIVE_TYPE_FOLDER, isCollabType } from '@workspace/lib/types/drive';
import { CHAT_ROOM_DB_CONFIG, withCommentIndex } from '../chat';
import * as chatSchema from '../chat/schema';
import { captureCollabSource } from '../document/transform/collab-source';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { CONTAINER_CHAT_FOLDER, CONTAINER_DATA_DB, CONTAINER_MEDIA_FOLDER } from '../mount/container-dbs';
import { foldName } from '../mount/names';
import { withSvgSiblings } from '../preview/svg-media-inline';
import type { DriveLike } from './get-drive';

// Runs on an open document as well as a closed one, as both read the same data.db. The grace is how old a part must
// be to go, which is none for a copy nobody has opened yet.
export async function sweepDocument(drive: DriveLike, document: DrivePath, graceMs: number): Promise<void> {
    try {
        await sweepParts(drive, document, Date.now() - graceMs);
    } catch (error) {
        console.warn(`[sweep] stopped in ${document.id}:`, error instanceof Error ? error.message : error);
    }
}

// Sweeps each document a copy made: the copy itself, or each one in a copied folder.
export async function sweepCopy(drive: DriveLike, copy: DrivePath): Promise<void> {
    if (copy.type === DRIVE_TYPE_FOLDER) {
        const { mount } = await drive.resolveFile(copy.mountId, copy.id);
        for (const child of await mount.listFolder(copy.id)) await sweepCopy(drive, child);
    } else if (copy.type !== DRIVE_TYPE_FILE) {
        await sweepDocument(drive, copy, 0);
    }
}

async function sweepParts(drive: DriveLike, document: DrivePath, cutoff: number): Promise<void> {
    const { mount } = await drive.resolveFile(document.mountId, document.id);
    const isOld = (file: DrivePath) => file.createdAt.getTime() <= cutoff;
    const media = await mount.getChildByName(document.id, CONTAINER_MEDIA_FOLDER);
    const files = media ? (await mount.listFolder(media.id)).filter((file) => file.type === DRIVE_TYPE_FILE) : [];
    const chat = isCollabType(document.type) ? await mount.getChildByName(document.id, CONTAINER_CHAT_FOLDER) : null;
    const threads = chat ? (await mount.listFolder(chat.id)).filter((thread) => thread.type === DRIVE_TYPE_CHAT) : [];
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
    if (!keptFiles) throw new Error('an SVG could not be read');
    const namedThreads = new Set(names.chat.map(foldName));
    const keptThreads: DrivePath[] = [];
    const idleThreads: DrivePath[] = [];
    for (const thread of threads) {
        const kept = namedThreads.has(foldName(thread.name)) || (await isActive(mount, thread, cutoff));
        (kept ? keptThreads : idleThreads).push(thread);
    }

    const unnamedFiles = files.filter((file) => isOld(file) && !keptFiles.has(foldName(file.name)));
    await Promise.all([...unnamedFiles, ...idleThreads].map((path) => mount.deletePath(path.id)));
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
    for (const thread of keptThreads) await sweepParts(drive, thread, cutoff);
}

// Whether someone wrote in a thread since the cutoff: its creation, or the last sync of its data.db, which stamps the
// row. A reply reaches the row only when the database syncs, so one in the last seconds before a sweep doesn't count.
async function isActive(mount: Mount, thread: DrivePath, cutoff: number): Promise<boolean> {
    const dataDb = await mount.getChildByName(thread.id, CONTAINER_DATA_DB);
    return Math.max(thread.createdAt.getTime(), dataDb?.updatedAt.getTime() ?? 0) > cutoff;
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
