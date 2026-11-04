// A copy of a collab document takes only the parts its current state names: the files in its media folder that the
// state names, the comment threads whose card is in use, and inside each such thread the files its messages name.
// Drive.copyPath filters the listed tree here before it sizes and writes it, so a copy in one mount and one to another
// drive take the same parts. A copied comments.db then drops the rows of the threads the copy left behind.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, DRIVE_TYPE_FILE, isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { withCommentIndex } from '../chat';
import { readYjsStatePayloadFromFile } from '../collab/yjs-loader';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import {
    CONTAINER_CHAT_FOLDER,
    CONTAINER_COMMENTS_DB,
    CONTAINER_DATA_DB,
    CONTAINER_MEDIA_FOLDER,
} from '../mount/container-dbs';
import type { CopyTree } from '../mount/copy';
import { foldName } from '../mount/names';
import { hashFile } from '../storage';
import type { DriveLike } from './get-drive';
import { mediaKeptBy, threadAttachmentNames } from './named-parts';

// The tree with each collab document inside reduced to the parts its current state names. The listing flushed each
// document first, so its stored data.db holds its latest edits. Each data.db is read from a temp copy that goes before
// the next document is read. The filter keeps the hash of the bytes it read, so the copy can tell when the data.db it
// writes is another. The documents are read one at a time, so a folder of many runs one references job at a time. A
// document whose parts can't be read, such as one past the reader's size limit or one the strict reader refuses,
// copies whole. Such a copy keeps more than it needs, never less, and it never fails for it.
export async function withNamedPartsOnly(mount: Mount, tree: CopyTree): Promise<CopyTree> {
    const { path } = tree;
    if (!isContainerType(path.type)) return tree;
    if (!isCollabType(path.type)) {
        const children: CopyTree[] = [];
        for (const child of tree.children) children.push(await withNamedPartsOnly(mount, child));
        return { path, children };
    }
    const media = childNamed(tree, CONTAINER_MEDIA_FOLDER);
    const chat = childNamed(tree, CONTAINER_CHAT_FOLDER);
    // A document with no file in media/ and no thread has nothing to leave behind, so it costs no job.
    const hasFiles = media?.children.some((child) => child.path.type === DRIVE_TYPE_FILE);
    const hasThreads = chat?.children.some((child) => child.path.type === DRIVE_TYPE_CHAT);
    if (!hasFiles && !hasThreads) return tree;
    const tempId = crypto.randomUUID();
    try {
        const dataDb = childNamed(tree, CONTAINER_DATA_DB);
        if (!dataDb) throw new Error(`${path.id}: data.db missing`);
        const localPath = await mount.downloadToTemp(dataDb.path.id, tempId);
        const { hash } = await hashFile(localPath);
        const source = readYjsStatePayloadFromFile(localPath);
        const named = await runDocumentReferences({ documentType: path.type, source }, { priority: 'foreground' });
        const keptThreads = new Set(named.chat.map(foldName));
        let leftThreads = false;
        const children: CopyTree[] = [];
        for (const child of tree.children) {
            if (child === media) {
                const files = child.children.map((file) => file.path).filter((file) => file.type === DRIVE_TYPE_FILE);
                children.push(onlyFiles(child, await mediaKeptBy(mount, child.path.id, named.media, files)));
            } else if (child === chat) {
                const threads: CopyTree[] = [];
                for (const thread of child.children) {
                    if (thread.path.type !== DRIVE_TYPE_CHAT) threads.push(thread);
                    else if (keptThreads.has(foldName(thread.path.name)))
                        threads.push(await withNamedThreadMedia(mount, thread));
                    else leftThreads = true;
                }
                children.push({ path: child.path, children: threads });
            } else {
                children.push(child);
            }
        }
        return { path, children, filtered: { dataDb, hash, whole: tree }, leftThreads };
    } catch (error) {
        console.warn(`[copy] ${path.id} copies whole:`, error instanceof Error ? error.message : error);
        return tree;
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

// Runs once a copied document has landed. Its comments.db came over whole, with the rows of every thread the source
// has. A copy that left threads behind keeps only the rows of the threads it holds, as the sweep does after it
// deleted a thread. One that kept every thread, or had none, never opens it.
export async function keepRowsOfCopiedThreads(
    drive: DriveLike,
    mountId: string,
    copy: DrivePath,
    src: CopyTree,
): Promise<void> {
    if (!src.leftThreads || !childNamed(src, CONTAINER_COMMENTS_DB)) return;
    const threads = childNamed(src, CONTAINER_CHAT_FOLDER)?.children ?? [];
    const names = new Set(threads.map((thread) => foldName(thread.path.name)));
    await withCommentIndex(drive, mountId, copy.id, async (index) => index.deleteRowsWithoutThread(names));
}

// A kept thread takes the files in its media folder that its messages name, a deleted message included. A thread
// whose media folder holds no file has nothing to leave behind, so its messages are never read. One with no data.db
// names nothing it could be read for, so it copies whole.
async function withNamedThreadMedia(mount: Mount, thread: CopyTree): Promise<CopyTree> {
    const dataDb = childNamed(thread, CONTAINER_DATA_DB);
    const media = childNamed(thread, CONTAINER_MEDIA_FOLDER);
    if (!dataDb || !media?.children.some((child) => child.path.type === DRIVE_TYPE_FILE)) return thread;
    const names = await threadAttachmentNames(mount, dataDb.path);
    return {
        path: thread.path,
        children: thread.children.map((child) => (child === media ? onlyFiles(media, names) : child)),
    };
}

// A part is found the way getChildByName finds it, whatever its case or Unicode form.
function childNamed(tree: CopyTree, name: string): CopyTree | undefined {
    return tree.children.find((child) => foldName(child.path.name) === name);
}

// A folder that keeps only the files named, and every folder it holds.
function onlyFiles(folder: CopyTree, names: ReadonlySet<string>): CopyTree {
    const children = folder.children.filter(
        (child) => child.path.type !== DRIVE_TYPE_FILE || names.has(foldName(child.path.name)),
    );
    return { path: folder.path, children };
}
