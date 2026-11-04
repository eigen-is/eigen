import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Sheet, SheetImage } from '@workspace/lib/sheets';
import { encodeSheetsSnapshot, sheetsOpLog, sheetsStateMap } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eigenMediaHref } from '@workspace/lib/vector';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { withCommentIndex } from '../../lib/chat';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';
import * as commentSchema from '../../lib/chat/comment-schema';
import { CHAT_ROOM_DB_CONFIG } from '../../lib/chat/db-config';
import * as chatSchema from '../../lib/chat/schema';
import { CLOSE_LINGER_MS } from '../../lib/collab/collab-document';
import { ApiError } from '../../lib/core/errors';
import { REFERENCE_READER_VERSION } from '../../lib/document/references';
import type { Drive } from '../../lib/drive/drive';
import { isSweepDue, sweepAfterClose, sweepDocument } from '../../lib/drive/sweep';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount/mount';
import { paths } from '../../lib/mount/schema';
import { getVersionReferences, putVersionReferences } from '../../lib/mount/version-references';
import { DAY_MS, HOUR_MS } from '../../lib/versioning/retention';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount, waitFor } from '../fault-storage-helpers';
import { buildGoldenDeckScene, seedEigendoc, seedVectorDoc } from '../fixtures/golden-documents';
import { createTestUserOnStorage } from '../setup';

const M = 'default';
// Older than the three days a fresh upload is spared.
const OLD_HOURS = 100;

let home: Home;
let drive: Drive;
let mount: Mount;
let rootId: string;

beforeAll(async () => {
    const user = await createTestUserOnStorage('local-fullnames', 'Sweep');
    home = await getHome(user.id);
    drive = home.drive;
    const root = await drive.getRootFolder(M);
    if (!root) throw new Error('no root folder');
    rootId = root.id;
    ({ mount } = await drive.resolveFile(M, rootId));
});

afterEach(() => {
    jest.useRealTimers();
});

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const figure = (mediaName: string) => ({ type: 'figure', attrs: { mediaName } });
const marked = (cardId: string) => ({ type: 'text', text: 'Marked', marks: [{ type: 'comment', attrs: { cardId } }] });

// A comment card as the comment hooks write it.
function addCard(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
    const card = new Y.Map<unknown>();
    card.set('id', id);
    card.set('title', id);
    card.set('description', '');
    for (const [field, value] of Object.entries(fields)) card.set(field, value);
    doc.getMap('comments').set(id, card);
}

// An open doc whose body is the given paragraphs, one block each.
async function openDoc(sweepMount: Mount, mountId: string, name: string, blocks: object[]) {
    const root = await sweepMount.getRootFolder();
    if (!root) throw new Error('no root folder');
    const path = await drive.create(mountId, root.id, `${name}-${crypto.randomUUID()}`, 'doc');
    const collab = await drive.getCollabDocument(mountId, path.id);
    seedEigendoc(collab.doc, { type: 'doc', content: blocks });
    return { path, collab };
}

// A file in the document's media folder, uploaded `ageHours` ago.
async function addMedia(
    sweepMount: Mount,
    containerId: string,
    name: string,
    opts: { ageHours?: number; mimeType?: string; body?: string } = {},
): Promise<string> {
    const media = await sweepMount.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    const body = Buffer.from(opts.body ?? `bytes of ${name}`);
    const id = await sweepMount.createFile(media.id, name, opts.mimeType ?? 'image/png', body.length, body);
    const createdAt = new Date(Date.now() - (opts.ageHours ?? OLD_HOURS) * HOUR_MS);
    sweepMount.db.update(paths).set({ createdAt }).where(eq(paths.id, id)).run();
    return id;
}

async function mediaNames(sweepMount: Mount, containerId: string): Promise<string[]> {
    const media = await sweepMount.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    return (await sweepMount.listFolder(media.id)).map((file) => file.name).sort();
}

// The close, with no version of its own.
async function close(mountId: string, path: DrivePath): Promise<void> {
    await drive.closeCollabDocument(mountId, path.id, { skipFinalSnapshot: true });
}

async function versionIds(sweepMount: Mount, containerId: string): Promise<string[]> {
    const versions = await sweepMount.getChildByName(containerId, 'versions');
    return versions ? (await sweepMount.listFolder(versions.id)).map((file) => file.id) : [];
}

type Message = { content: string; attachments?: string[] };

// A comment thread in the document's chat folder, its messages posted, last active `ageHours` ago.
async function addThread(
    sweepMount: Mount,
    mountId: string,
    containerId: string,
    opts: { ageHours?: number; messages?: Message[] } = {},
): Promise<DrivePath> {
    const chat = await sweepMount.getChildByName(containerId, 'chat');
    if (!chat) throw new Error('no chat folder');
    const thread = await drive.create(mountId, chat.id, `thread-${crypto.randomUUID()}`, 'chat', home.user);
    const room = await drive.getChat(mountId, thread.id);
    for (const { content, attachments } of opts.messages ?? []) {
        await room.postMessage(home.user, content, 'message', undefined, undefined, attachments);
    }
    await closeThreadDb(sweepMount, thread.id);
    const at = new Date(Date.now() - (opts.ageHours ?? OLD_HOURS) * HOUR_MS);
    const dataDb = await threadDataDb(sweepMount, thread.id);
    sweepMount.db.update(paths).set({ createdAt: at }).where(eq(paths.id, thread.id)).run();
    sweepMount.db.update(paths).set({ updatedAt: at }).where(eq(paths.id, dataDb.id)).run();
    return thread;
}

async function threadDataDb(sweepMount: Mount, threadId: string): Promise<DrivePath> {
    const dataDb = await sweepMount.getChildByName(threadId, 'data.db');
    if (!dataDb) throw new Error('no data.db');
    return dataDb;
}

// A write reaches the data.db row when the database syncs, which its close does at once.
async function closeThreadDb(sweepMount: Mount, threadId: string): Promise<void> {
    await sweepMount.closeDatabase((await threadDataDb(sweepMount, threadId)).id, { skipFinalSnapshot: true });
}

async function threadNames(sweepMount: Mount, containerId: string): Promise<string[]> {
    const chat = await sweepMount.getChildByName(containerId, 'chat');
    if (!chat) throw new Error('no chat folder');
    return (await sweepMount.listFolder(chat.id)).map((thread) => thread.name).sort();
}

async function commentRows(mountId: string, containerId: string): Promise<string[]> {
    return withCommentIndex(drive, mountId, containerId, async (index) =>
        (await index.list()).map((entry) => entry.chatName).sort(),
    );
}

describe('the media sweep', () => {
    test('a file no state names goes, one the current state names stays', async () => {
        const { path } = await openDoc(mount, M, 'Plain', [paragraph(figure('kept.png'))]);
        await addMedia(mount, path.id, 'kept.png');
        await addMedia(mount, path.id, 'loose.png');

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['kept.png']);
    });

    test('an image deleted before every retained version goes', async () => {
        const { path, collab } = await openDoc(mount, M, 'Deleted', [paragraph(figure('a.png')), paragraph()]);
        await addMedia(mount, path.id, 'a.png');
        collab.doc.getXmlFragment('default').delete(0, 1);
        await drive.saveVersion(M, path.id);

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });

    test('an image a retained version names stays until that version is deleted', async () => {
        const { path, collab } = await openDoc(mount, M, 'Versioned', [paragraph(figure('a.png')), paragraph()]);
        await addMedia(mount, path.id, 'a.png');
        await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);
        await close(M, path);

        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['a.png']);

        for (const id of await versionIds(mount, path.id)) await mount.deletePath(id);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });

    test('a file under three days old stays', async () => {
        const { path } = await openDoc(mount, M, 'Young', [paragraph()]);
        await addMedia(mount, path.id, 'young.png', { ageHours: 71 });
        await addMedia(mount, path.id, 'old.png', { ageHours: 73 });

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['young.png']);
    });

    test("a card's attachment stays while the card is in use", async () => {
        const { path, collab } = await openDoc(mount, M, 'Card', [paragraph(marked('c1'))]);
        addCard(collab.doc, 'c1', { attachments: ['card.pdf'] });
        addCard(collab.doc, 'c-loose', { attachments: ['loose.pdf'] });
        await addMedia(mount, path.id, 'card.pdf', { mimeType: 'application/pdf' });
        await addMedia(mount, path.id, 'loose.pdf', { mimeType: 'application/pdf' });

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['card.pdf']);
    });

    test("an SVG figure's sibling media stay, to the inline depth", async () => {
        const { path } = await openDoc(mount, M, 'Svg', [paragraph(figure('outer.svg'))]);
        const svg = (...names: string[]) =>
            `<svg xmlns="http://www.w3.org/2000/svg">${names.map((name) => `<image href="${eigenMediaHref(name)}"/>`).join('')}</svg>`;
        const asSvg = (body: string) => ({ mimeType: 'image/svg+xml', body });
        await addMedia(mount, path.id, 'outer.svg', asSvg(svg('inner.svg', 'leaf.png')));
        await addMedia(mount, path.id, 'inner.svg', asSvg(svg('deep.png')));
        await addMedia(mount, path.id, 'leaf.png');
        await addMedia(mount, path.id, 'deep.png');
        await addMedia(mount, path.id, 'loose.png');

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['deep.png', 'inner.svg', 'leaf.png', 'outer.svg']);
    });

    test('an open document is never swept', async () => {
        const { path } = await openDoc(mount, M, 'Open', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');

        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });

    // The delete phase takes the container's lock, so a change that lands right before it stands in for one made
    // while the sweep read. The change may take the lock itself, so it runs on the first take only.
    async function changeBeforeDelete(containerId: string, change: () => Promise<void>): Promise<() => void> {
        const original = mount.withPathLock.bind(mount);
        let pending = true;
        const spy = spyOn(mount, 'withPathLock').mockImplementation(async (pathId, fn) => {
            if (pending && pathId === containerId) {
                pending = false;
                await change();
            }
            return original(pathId, fn);
        });
        return () => spy.mockRestore();
    }

    test('a reopen between the read and the delete aborts the delete', async () => {
        const { path } = await openDoc(mount, M, 'Reopened', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path);
        const restore = await changeBeforeDelete(path.id, async () => {
            await drive.getCollabDocument(M, path.id);
        });
        try {
            await sweepDocument(drive, path);
        } finally {
            restore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(isSweepDue(path)).toBe(true);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });

    test('a version saved between the read and the delete aborts the delete', async () => {
        const { path } = await openDoc(mount, M, 'Saved', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path);
        const restore = await changeBeforeDelete(path.id, async () => {
            await drive.saveVersion(M, path.id);
        });
        try {
            await sweepDocument(drive, path);
        } finally {
            restore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
    });

    test('a version that fails to load sweeps nothing, and the next sweep tries again', async () => {
        const { path } = await openDoc(mount, M, 'Corrupt', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        await drive.saveVersion(M, path.id);
        const [versionId] = await versionIds(mount, path.id);
        if (!versionId) throw new Error('no version');
        await mount.writeFile(versionId, Buffer.from('not a database'));
        await close(M, path);

        await expect(sweepDocument(drive, path)).rejects.toThrow();
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        // A failure waits a day, so a version that never reads costs one try a day.
        expect(isSweepDue(path)).toBe(false);

        await mount.deletePath(versionId);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });

    test('a reader that throws sweeps nothing', async () => {
        const { path, collab } = await openDoc(mount, M, 'Unreadable', [paragraph()]);
        addCard(collab.doc, 'c-odd', { chatName: 42 });
        await addMedia(mount, path.id, 'loose.png');

        await close(M, path);
        await expect(sweepDocument(drive, path)).rejects.toThrow();
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(isSweepDue(path)).toBe(false);
    });

    test("the drive's size drops by the deleted bytes", async () => {
        const { path } = await openDoc(mount, M, 'Size', [paragraph()]);
        const body = 'x'.repeat(5_000);
        await addMedia(mount, path.id, 'loose.png', { body });
        await close(M, path);
        const before = { drive: await drive.size(M), container: (await mount.getPath(path.id))?.size ?? 0 };

        await sweepDocument(drive, path);
        expect(await drive.size(M)).toBe(before.drive - body.length);
        expect((await mount.getPath(path.id))?.size).toBe(before.container - body.length);
    });

    test('a version is read once, and again when its row is from an older reader', async () => {
        const { path } = await openDoc(mount, M, 'Scanned', [paragraph()]);
        await drive.saveVersion(M, path.id);
        const [versionId] = await versionIds(mount, path.id);
        if (!versionId) throw new Error('no version');
        await close(M, path);
        const downloads = spyOn(mount, 'downloadToTemp');
        const versionReads = () => downloads.mock.calls.filter(([id]) => id === versionId).length;
        try {
            await sweepDocument(drive, path);
            expect(getVersionReferences(mount, [versionId])).toEqual([
                { versionPathId: versionId, readerVersion: REFERENCE_READER_VERSION, names: { media: [], chat: [] } },
            ]);
            await sweepDocument(drive, path);
            expect(versionReads()).toBe(1);

            // A row an older reader wrote is no record: its names keep nothing, and the version is read again.
            putVersionReferences(mount, [
                {
                    versionPathId: versionId,
                    readerVersion: REFERENCE_READER_VERSION - 1,
                    names: { media: ['stale.png'], chat: [] },
                },
            ]);
            await addMedia(mount, path.id, 'stale.png');
            await sweepDocument(drive, path);
            expect(versionReads()).toBe(2);
            expect(await mediaNames(mount, path.id)).toEqual([]);
            expect(getVersionReferences(mount, [versionId])[0]?.readerVersion).toBe(REFERENCE_READER_VERSION);
        } finally {
            downloads.mockRestore();
        }
    });

    test('a version that fails to load keeps the rows of the versions read before it', async () => {
        const { path, collab } = await openDoc(mount, M, 'Partial', [paragraph()]);
        const older = await drive.saveVersion(M, path.id);
        await mount.writeFile(older.id, Buffer.from('not a database'));
        collab.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
        // Versions are read newest first, so the newer one is read before the older one fails.
        const newer = await drive.saveVersion(M, path.id);

        await close(M, path);
        await expect(sweepDocument(drive, path)).rejects.toThrow();
        expect(getVersionReferences(mount, [older.id, newer.id]).map((row) => row.versionPathId)).toEqual([newer.id]);
    });

    test('a name that differs from its file only in case or in Unicode form keeps the file', async () => {
        const decomposed = 'Café.png'.normalize('NFD');
        const { path } = await openDoc(mount, M, 'Case', [
            paragraph(figure('Photo.PNG')),
            paragraph(figure(decomposed)),
        ]);
        await addMedia(mount, path.id, 'photo.png');
        await addMedia(mount, path.id, decomposed);

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['Café.png'.normalize('NFC'), 'photo.png']);
    });

    test('a trash under way when the delete starts aborts the delete', async () => {
        const { path } = await openDoc(mount, M, 'Trashed', [paragraph()]);
        const loose = await addMedia(mount, path.id, 'loose.png');
        await close(M, path);
        // The trash waits before it marks the rows, until the sweep is done.
        const started = Promise.withResolvers<void>();
        const swept = Promise.withResolvers<void>();
        const original = mount.trashPath.bind(mount);
        const trashPath = spyOn(mount, 'trashPath').mockImplementation(async (pathId) => {
            started.resolve();
            await swept.promise;
            return original(pathId);
        });
        let trashing: Promise<void> | null = null;
        const restore = await changeBeforeDelete(path.id, async () => {
            trashing = drive.deletePath(M, path.id);
            await started.promise;
        });
        try {
            await sweepDocument(drive, path);
        } finally {
            swept.resolve();
            restore();
            await trashing;
            trashPath.mockRestore();
        }
        expect(await mount.getPath(loose)).not.toBeNull();
    });

    test('a data.db replaced between the read and the delete aborts the delete', async () => {
        const other = await openDoc(mount, M, 'Other', [
            paragraph({ type: 'text', text: Array.from({ length: 2_000 }, () => crypto.randomUUID()).join(' ') }),
        ]);
        await close(M, other.path);
        const otherDataDb = await mount.getChildByName(other.path.id, 'data.db');
        if (!otherDataDb) throw new Error('no data.db');
        const { path } = await openDoc(mount, M, 'Replaced', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path);
        const tempId = crypto.randomUUID();
        const source = await mount.downloadToTemp(otherDataDb.id, tempId);
        const restore = await changeBeforeDelete(path.id, () => mount.replaceContainerDataDb(path.id, source));
        try {
            await sweepDocument(drive, path);
        } finally {
            restore();
            await mount.cleanupTemp(tempId);
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(isSweepDue(path)).toBe(true);
    });

    test('a restore under way when the delete starts aborts the delete', async () => {
        const { path } = await openDoc(mount, M, 'Restoring', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        const version = await drive.saveVersion(M, path.id);
        await close(M, path);
        // The restore waits at its first step, the download of the version, until the sweep is done. Nothing it does
        // before that step moves the fence.
        const started = Promise.withResolvers<void>();
        const swept = Promise.withResolvers<void>();
        let restoring: Promise<void> | null = null;
        const original = mount.downloadToTemp.bind(mount);
        const download = spyOn(mount, 'downloadToTemp').mockImplementation(async (pathId, tempId) => {
            if (restoring && pathId === version.id) {
                started.resolve();
                await swept.promise;
            }
            return original(pathId, tempId);
        });
        const restore = await changeBeforeDelete(path.id, async () => {
            restoring = Promise.resolve().then(() => drive.restoreContainer(M, path.id, version.name));
            await started.promise;
        });
        try {
            await sweepDocument(drive, path);
        } finally {
            swept.resolve();
            restore();
            await restoring;
            download.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
    });

    // The restore's own save can prune the version it restores, so only data.db may name what it put back.
    test('a restore between the close and the sweep keeps the media the restored state names', async () => {
        const { path, collab } = await openDoc(mount, M, 'RestoredAfterClose', [
            paragraph(figure('a.png')),
            paragraph(),
        ]);
        await addMedia(mount, path.id, 'a.png');
        const version = await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);
        await close(M, path);
        await drive.restoreContainer(M, path.id, version.name);
        await mount.deletePath(version.id);

        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['a.png']);
    });

    test('a delete that fails lets the other deletes end before the lock is let go', async () => {
        const { path } = await openDoc(mount, M, 'FailedDelete', [paragraph()]);
        const failing = await addMedia(mount, path.id, 'failing.png');
        await addMedia(mount, path.id, 'slow.png');
        await close(M, path);
        const ended: string[] = [];
        const deletePath = mount.deletePath.bind(mount);
        const deletes = spyOn(mount, 'deletePath').mockImplementation(async (pathId) => {
            if (pathId === failing) throw new Error('disk full');
            await Bun.sleep(20);
            await deletePath(pathId);
            ended.push('delete');
        });
        const withPathLock = mount.withPathLock.bind(mount);
        const locks = spyOn(mount, 'withPathLock').mockImplementation(async (pathId, fn) => {
            try {
                return await withPathLock(pathId, fn);
            } finally {
                if (pathId === path.id) ended.push('lock');
            }
        });
        try {
            await expect(sweepDocument(drive, path)).rejects.toThrow('disk full');
        } finally {
            deletes.mockRestore();
            locks.mockRestore();
        }
        await Bun.sleep(40);
        expect(ended).toEqual(['delete', 'lock']);
        expect(await mediaNames(mount, path.id)).toEqual(['failing.png']);
    });

    test('a sweep of a document already being swept leaves it to that sweep', async () => {
        const { path } = await openDoc(mount, M, 'Twice', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path);
        const gate = Promise.withResolvers<void>();
        const resolveFile = drive.resolveFile.bind(drive);
        const resolves = spyOn(drive, 'resolveFile').mockImplementation(async (mountId, pathId) => {
            if (pathId === path.id && resolves.mock.calls.length === 1) await gate.promise;
            return resolveFile(mountId, pathId);
        });
        try {
            const first = sweepDocument(drive, path);
            await sweepDocument(drive, path);
            expect(resolves.mock.calls.filter(([, pathId]) => pathId === path.id).length).toBe(1);
            gate.resolve();
            await first;
        } finally {
            gate.resolve();
            resolves.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });
});

describe('the thread sweep', () => {
    async function commentsDbId(containerId: string): Promise<string> {
        const commentsDb = await mount.getChildByName(containerId, 'comments.db');
        if (!commentsDb) throw new Error('no comments.db');
        return commentsDb.id;
    }

    test('a thread no state names goes with its row, its mentions and its search hit', async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadGone', [paragraph(marked('c-kept'))]);
        const kept = await addThread(mount, M, path.id, { messages: [{ content: 'needle kept' }] });
        const gone = await addThread(mount, M, path.id, {
            messages: [{ content: `needle gone, ask ${home.user.email}` }],
        });
        addCard(collab.doc, 'c-kept', { chatName: kept.name });
        addCard(collab.doc, 'c-gone', { chatName: gone.name });

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await threadNames(mount, path.id)).toEqual([kept.name]);
        expect(await commentRows(M, path.id)).toEqual([kept.name]);
        const hits = await withCommentIndex(drive, M, path.id, (index) => index.searchComments('needle'));
        expect(hits.map((hit) => hit.id)).toEqual([kept.name]);
        const mentions = await drive.withDatabase(M, COMMENT_INDEX_DB_CONFIG, await commentsDbId(path.id), async (db) =>
            db.db.select().from(commentSchema.commentMentions).all(),
        );
        expect(mentions.map((mention) => mention.chatName)).not.toContain(gone.name);
    });

    test('a thread a retained version anchors stays until that version is deleted', async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadVersioned', [paragraph(marked('c1')), paragraph()]);
        const thread = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);
        await close(M, path);

        await sweepDocument(drive, path);
        expect(await threadNames(mount, path.id)).toEqual([thread.name]);

        for (const id of await versionIds(mount, path.id)) await mount.deletePath(id);
        await sweepDocument(drive, path);
        expect(await threadNames(mount, path.id)).toEqual([]);
        expect(await commentRows(M, path.id)).toEqual([]);
    });

    test('a thread under three days old stays, and so does an old one with a recent reply', async () => {
        const { path } = await openDoc(mount, M, 'ThreadYoung', [paragraph()]);
        const young = await addThread(mount, M, path.id, { ageHours: 71 });
        const replied = await addThread(mount, M, path.id);
        await addThread(mount, M, path.id);
        // A reply through a notification, while the document is closed.
        await (await drive.getChat(M, replied.id)).postMessage(home.user, 'still here');
        await closeThreadDb(mount, replied.id);

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await threadNames(mount, path.id)).toEqual([replied.name, young.name].sort());
    });

    test('a canvas keeps the thread of a document-level card and drops that of a deleted one', async () => {
        const created = await drive.create(M, rootId, `ThreadCanvas-${crypto.randomUUID()}`, 'vector');
        const { path } = await drive.resolveFile(M, created.id);
        const collab = await drive.getCollabDocument(M, path.id);
        seedVectorDoc(collab.doc, buildGoldenDeckScene());
        const documentLevel = await addThread(mount, M, path.id);
        const deleted = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c-document', { chatName: documentLevel.name });
        addCard(collab.doc, 'c-deleted', { chatName: deleted.name, deletedAt: Date.now() });

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await threadNames(mount, path.id)).toEqual([documentLevel.name]);
    });

    test('comments.db is not opened when no thread goes', async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadNone', [paragraph(marked('c1'))]);
        const thread = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await close(M, path);
        const commentsDb = await commentsDbId(path.id);
        await mount.closeDatabase(commentsDb);
        const opens = spyOn(mount, 'withDatabase');
        try {
            await sweepDocument(drive, path);
            expect(opens.mock.calls.filter(([, pathId]) => pathId === commentsDb)).toEqual([]);
        } finally {
            opens.mockRestore();
        }
        expect(await threadNames(mount, path.id)).toEqual([thread.name]);
    });

    test('a row whose thread went before is dropped with the next swept thread', async () => {
        const { path } = await openDoc(mount, M, 'ThreadOrphan', [paragraph()]);
        await withCommentIndex(drive, M, path.id, async (index) => {
            await index.ensureComment('ghost.eigenchat');
            await index.addMention('ghost.eigenchat', home.user.email);
        });
        await addThread(mount, M, path.id);

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await commentRows(M, path.id)).toEqual([]);
    });

    test("a thread's media nobody names goes, and a file a message names stays, a deleted message too", async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadMedia', [paragraph(marked('c1'))]);
        const thread = await addThread(mount, M, path.id, {
            messages: [
                { content: 'named', attachments: ['named.png'] },
                { content: 'deleted', attachments: ['deleted.png'] },
            ],
        });
        addCard(collab.doc, 'c1', { chatName: thread.name });
        // The row as a delete leaves it. The delete itself trashes the file, so only an older delete leaves it live.
        await drive.withDatabase(M, CHAT_ROOM_DB_CONFIG, (await threadDataDb(mount, thread.id)).id, async (db) => {
            db.db
                .update(chatSchema.messages)
                .set({ deletedAt: new Date(), content: '' })
                .where(eq(chatSchema.messages.content, 'deleted'))
                .run();
        });
        await closeThreadDb(mount, thread.id);
        for (const name of ['named.png', 'deleted.png', 'loose.png']) await addMedia(mount, thread.id, name);
        await addMedia(mount, thread.id, 'young.png', { ageHours: 71 });

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, thread.id)).toEqual(['deleted.png', 'named.png', 'young.png']);
    });

    test('a thread with no old media is never opened', async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadUnopened', [paragraph(marked('c1'))]);
        const thread = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await addMedia(mount, thread.id, 'young.png', { ageHours: 71 });
        const dataDb = await threadDataDb(mount, thread.id);
        await close(M, path);
        const downloads = spyOn(mount, 'downloadToTemp');
        try {
            await sweepDocument(drive, path);
            expect(downloads.mock.calls.filter(([id]) => id === dataDb.id)).toEqual([]);
        } finally {
            downloads.mockRestore();
        }
        expect(await mediaNames(mount, thread.id)).toEqual(['young.png']);
    });
});

describe('the sweep after a linger close', () => {
    // The open arms the linger on fake timers, and the clock moves past it. A sweep takes a hold on the Home before the
    // close starts, so the holds taken once the linger ran out count the sweeps, and the last release ends one.
    async function lingerClose(path: DrivePath): Promise<{ sweeps: number; swept: Promise<void> }> {
        jest.useFakeTimers();
        await drive.getCollabDocument(M, path.id);
        const original = drive.holdHome.bind(drive);
        const swept = Promise.withResolvers<void>();
        const holds = spyOn(drive, 'holdHome').mockImplementation((onClosing) => {
            const release = original(onClosing);
            return () => {
                release();
                swept.resolve();
            };
        });
        try {
            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            jest.useRealTimers();
            await waitFor(() => !drive.hasCollabDocument(M, path.id), 20_000);
            const sweeps = holds.mock.calls.length;
            return { sweeps, swept: sweeps > 0 ? swept.promise : Promise.resolve() };
        } finally {
            holds.mockRestore();
        }
    }

    test('sweeps once, and a second close the same day does not', async () => {
        const { path } = await openDoc(mount, M, 'Lingered', [paragraph()]);
        await addMedia(mount, path.id, 'first.png');
        await close(M, path);

        const first = await lingerClose(path);
        expect(first.sweeps).toBe(1);
        await first.swept;
        expect(await mediaNames(mount, path.id)).toEqual([]);
        expect(isSweepDue(path)).toBe(false);

        await addMedia(mount, path.id, 'second.png');
        expect((await lingerClose(path)).sweeps).toBe(0);
        expect(await mediaNames(mount, path.id)).toEqual(['second.png']);
    });

    test('a sweep that fails is not tried again that day, but is the next day', async () => {
        const { path, collab } = await openDoc(mount, M, 'Failing', [paragraph()]);
        addCard(collab.doc, 'c-odd', { chatName: 42 });
        await close(M, path);
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const first = await lingerClose(path);
            expect(first.sweeps).toBe(1);
            await first.swept;
            expect(warn).toHaveBeenCalled();
            expect((await lingerClose(path)).sweeps).toBe(0);
        } finally {
            warn.mockRestore();
        }
        const tomorrow = Date.now() + DAY_MS;
        const clock = spyOn(Date, 'now').mockReturnValue(tomorrow);
        try {
            expect(isSweepDue(path)).toBe(true);
        } finally {
            clock.mockRestore();
        }
    });

    test('a Home that is closing still closes the document, without a sweep', async () => {
        const { path } = await openDoc(mount, M, 'HomeClosing', [paragraph()]);
        const holds = spyOn(drive, 'holdHome').mockImplementation(() => {
            throw new ApiError(503, 'Home is closing');
        });
        const closeDocument = jest.fn(() => close(M, path));
        try {
            await sweepAfterClose(drive, path, closeDocument);
        } finally {
            holds.mockRestore();
        }
        expect(closeDocument).toHaveBeenCalledTimes(1);
        expect(drive.hasCollabDocument(M, path.id)).toBe(false);
    });

    test('a workbook whose close folded its op log is swept after it', async () => {
        const created = await drive.create(M, rootId, `Folded-${crypto.randomUUID()}`, 'sheets');
        const { path } = await drive.resolveFile(M, created.id);
        const collab = await drive.getCollabDocument(M, path.id);
        const sheet: Sheet = { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], images: {} };
        const image: SheetImage = { id: 'i1', index: 'a0', x: 0, y: 0, width: 10, height: 10, mediaName: 'op.png' };
        collab.doc.transact(() => {
            sheetsStateMap(collab.doc).set('snapshot', encodeSheetsSnapshot([sheet], { computed: true }));
            sheetsOpLog(collab.doc).push([[{ op: 'add', id: 'sheet-1', path: ['images', 'i1'], value: image }]]);
        });
        await addMedia(mount, path.id, 'op.png');
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path);

        const closed = await lingerClose(path);
        expect(closed.sweeps).toBe(1);
        await closed.swept;
        expect(await mediaNames(mount, path.id)).toEqual(['op.png']);
        const reopened = await drive.getCollabDocument(M, path.id);
        expect(sheetsOpLog(reopened.doc).length).toBe(0);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });
});

describe('the media sweep on s3', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-sweep-s3-${Date.now()}`);
    const S3_MOUNT = 'sweep-s3';
    let s3: FakeS3Mount;

    beforeAll(async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        s3 = await createFakeS3Mount(home, TEST_DIR, S3_MOUNT);
    });

    afterAll(async () => {
        await removeFakeS3Mount(s3);
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test('reads a version still staged and deletes what nothing names', async () => {
        const { path, collab } = await openDoc(s3.mount, S3_MOUNT, 'Bucket', [
            paragraph(figure('versioned.png')),
            paragraph(figure('kept.png')),
        ]);
        for (const name of ['versioned.png', 'kept.png', 'loose.png']) await addMedia(s3.mount, path.id, name);
        const { uploadQueue } = s3.mount;
        if (!uploadQueue) throw new Error('no upload queue');
        // The version's upload never starts, so it is read from its staged copy.
        const held = spyOn(uploadQueue, 'drain').mockResolvedValue();
        try {
            await drive.saveVersion(S3_MOUNT, path.id);
            const [versionId] = await versionIds(s3.mount, path.id);
            if (!versionId) throw new Error('no version');
            expect(s3.mount.pendingStagedCopy(await s3.mount.getStorageKey(versionId))).not.toBeNull();
            collab.doc.getXmlFragment('default').delete(0, 1);

            await close(S3_MOUNT, path);
            await sweepDocument(drive, path);
            expect(await mediaNames(s3.mount, path.id)).toEqual(['kept.png', 'versioned.png']);
        } finally {
            held.mockRestore();
            await uploadQueue.drain({ flushNow: true });
        }
    });
    test('deletes a thread nothing names, with its row', async () => {
        const { path, collab } = await openDoc(s3.mount, S3_MOUNT, 'BucketThread', [paragraph(marked('c1'))]);
        const kept = await addThread(s3.mount, S3_MOUNT, path.id, {
            messages: [{ content: 'kept', attachments: ['named.png'] }],
        });
        await addThread(s3.mount, S3_MOUNT, path.id, { messages: [{ content: 'gone' }] });
        addCard(collab.doc, 'c1', { chatName: kept.name });
        for (const name of ['named.png', 'loose.png']) await addMedia(s3.mount, kept.id, name);

        await close(S3_MOUNT, path);
        await sweepDocument(drive, path);
        expect(await threadNames(s3.mount, path.id)).toEqual([kept.name]);
        expect(await mediaNames(s3.mount, kept.id)).toEqual(['named.png']);
        expect(await commentRows(S3_MOUNT, path.id)).toEqual([kept.name]);
    });
});
