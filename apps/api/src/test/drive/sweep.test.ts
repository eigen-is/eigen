import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { SWEEP_GRACE_MS } from '@workspace/lib/constants/sweep';
import { commentCardIdsIn } from '@workspace/lib/docs/eigendoc';
import type { Sheet, SheetImage } from '@workspace/lib/sheets';
import { encodeSheetsSnapshot, sheetsOpLog, sheetsStateMap } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eigenMediaHref } from '@workspace/lib/vector';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { withCommentIndex } from '../../lib/chat';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';
import * as commentSchema from '../../lib/chat/comment-schema';
import { CLOSE_LINGER_MS } from '../../lib/collab/collab-document';
import { ApiError } from '../../lib/core/errors';
import { REFERENCE_READER_VERSION } from '../../lib/document/references';
import type { Drive } from '../../lib/drive/drive';
import { sweepAfterClose, sweepDocument } from '../../lib/drive/sweep';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount/mount';
import { paths } from '../../lib/mount/schema';
import { getVersionReferences, putVersionReferences } from '../../lib/mount/version-references';
import { HOUR_MS } from '../../lib/versioning/retention';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount, waitFor } from '../fault-storage-helpers';
import { buildGoldenDeckScene, seedEigendoc, seedVectorDoc } from '../fixtures/golden-documents';
import { flushContentReindex } from '../mount-test-helpers';
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
    // The close syncs the messages, which sends the thread to the content index, and that read opens it again. An
    // open data.db counts as activity, so it is closed once more after the index read it.
    await closeThreadDb(sweepMount, thread.id);
    await flushContentReindex(drive);
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

describe("a version's names", () => {
    test('let a sweep whose old parts the version rows all name stop before it reads data.db', async () => {
        const { path, collab } = await openDoc(mount, M, 'AllNamed', [paragraph(figure('a.png'), marked('c1'))]);
        await addMedia(mount, path.id, 'a.png');
        const thread = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);
        await close(M, path);
        const dataDb = await mount.getChildByName(path.id, 'data.db');
        const downloads = spyOn(mount, 'downloadToTemp');
        try {
            await sweepDocument(drive, path);
            expect(downloads.mock.calls.filter(([id]) => id === dataDb?.id)).toEqual([]);
        } finally {
            downloads.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['a.png']);
        expect(await threadNames(mount, path.id)).toEqual([thread.name]);
    });
});

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

    test('Delete history and then a close frees what only the versions named', async () => {
        const { path, collab } = await openDoc(mount, M, 'History', [paragraph(figure('a.png')), paragraph()]);
        await addMedia(mount, path.id, 'a.png');
        await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);
        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['a.png']);

        await drive.getCollabDocument(M, path.id);
        await drive.deleteVersions(M, path.id);
        expect(await mediaNames(mount, path.id)).toEqual(['a.png']);
        await close(M, path);
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

    // A restore brings back the version's anchors but keeps today's cards, so a card a version anchors keeps
    // the attachment and the thread its card has today, such as ones added after the version was saved.
    test("a card a version anchors keeps today's attachment and thread", async () => {
        const { path, collab } = await openDoc(mount, M, 'CardLater', [paragraph(marked('c1')), paragraph()]);
        addCard(collab.doc, 'c1', {});
        const version = await drive.saveVersion(M, path.id);
        const thread = await addThread(mount, M, path.id);
        await addMedia(mount, path.id, 'later.pdf', { mimeType: 'application/pdf' });
        const card = collab.doc.getMap('comments').get('c1');
        if (!(card instanceof Y.Map)) throw new Error('no card');
        card.set('attachments', ['later.pdf']);
        card.set('chatName', thread.name);
        collab.doc.getXmlFragment('default').delete(0, 1);
        await close(M, path);

        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['later.pdf']);
        expect(await threadNames(mount, path.id)).toEqual([thread.name]);

        await drive.restoreContainer(M, path.id, version.name);
        const restored = await drive.getCollabDocument(M, path.id);
        const anchors = commentCardIdsIn([yXmlFragmentToProsemirrorJSON(restored.doc.getXmlFragment('default'))]);
        expect([...anchors]).toEqual(['c1']);
        const restoredCard = restored.doc.getMap('comments').get('c1');
        if (!(restoredCard instanceof Y.Map)) throw new Error('no card');
        expect(restoredCard.get('attachments')).toEqual(['later.pdf']);
        await close(M, path);
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

    // Such as an SVG pasted a moment ago, whose edit has not reached the server yet.
    test('an SVG the grace period keeps keeps the old files it draws', async () => {
        const { path } = await openDoc(mount, M, 'SvgYoung', [paragraph()]);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref('leaf.png')}"/></svg>`;
        await addMedia(mount, path.id, 'young.svg', { mimeType: 'image/svg+xml', body: svg, ageHours: 1 });
        await addMedia(mount, path.id, 'leaf.png');
        await addMedia(mount, path.id, 'loose.png');

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['leaf.png', 'young.svg']);
    });

    test('a document with no old file and no idle thread is never read', async () => {
        const { path, collab } = await openDoc(mount, M, 'NothingOld', [paragraph(marked('c1'))]);
        await addMedia(mount, path.id, 'young.png', { ageHours: 71 });
        const thread = await addThread(mount, M, path.id, { ageHours: 71 });
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await drive.saveVersion(M, path.id);
        await close(M, path);
        const downloads = spyOn(mount, 'downloadToTemp');
        try {
            await sweepDocument(drive, path);
            expect(downloads).not.toHaveBeenCalled();
        } finally {
            downloads.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['young.png']);
    });

    test('an SVG that cannot be read keeps every old file this time', async () => {
        const { path } = await openDoc(mount, M, 'SvgUnreadable', [paragraph(figure('outer.svg'))]);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref('leaf.png')}"/></svg>`;
        const outer = await addMedia(mount, path.id, 'outer.svg', { mimeType: 'image/svg+xml', body: svg });
        await addMedia(mount, path.id, 'leaf.png');
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path);
        const readBytes = mount.readBytes.bind(mount);
        const reads = spyOn(mount, 'readBytes').mockImplementation(async (id) => (id === outer ? null : readBytes(id)));
        try {
            await sweepDocument(drive, path);
        } finally {
            reads.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['leaf.png', 'loose.png', 'outer.svg']);
    });

    test('an SVG is read only when an old file is not one the states name', async () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref('leaf.png')}"/></svg>`;
        const { path } = await openDoc(mount, M, 'SvgUnread', [
            paragraph(figure('outer.svg')),
            paragraph(figure('leaf.png')),
        ]);
        const outer = await addMedia(mount, path.id, 'outer.svg', { mimeType: 'image/svg+xml', body: svg });
        await addMedia(mount, path.id, 'leaf.png');
        await close(M, path);
        const reads = spyOn(mount, 'readBytes');
        try {
            await sweepDocument(drive, path);
            expect(reads.mock.calls.filter(([id]) => id === outer)).toEqual([]);
        } finally {
            reads.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['leaf.png', 'outer.svg']);
    });

    test('an open document is never swept', async () => {
        const { path } = await openDoc(mount, M, 'Open', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');

        await sweepDocument(drive, path);
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });

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

    test('a version with no row that fails to load sweeps nothing, and the next sweep tries again', async () => {
        const { path } = await openDoc(mount, M, 'Corrupt', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        const { id: versionId } = await drive.saveVersion(M, path.id);
        // A row an older reader wrote counts as none, as for a version from before the rows.
        putVersionReferences(mount, {
            versionPathId: versionId,
            readerVersion: REFERENCE_READER_VERSION - 1,
            names: { media: [], chat: [], cards: [] },
        });
        await mount.writeFile(versionId, Buffer.from('not a database'));
        await close(M, path);

        await expect(sweepDocument(drive, path)).rejects.toThrow();
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);

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

    test('a version is read by the first sweep that needs it, then again only for a row from an older reader', async () => {
        // A file the state names stays old, so every sweep has something to read for.
        const { path } = await openDoc(mount, M, 'Scanned', [paragraph(figure('kept.png'))]);
        await addMedia(mount, path.id, 'kept.png');
        const { id: versionId } = await drive.saveVersion(M, path.id);
        await close(M, path);
        expect(getVersionReferences(mount, [versionId])).toEqual([]);
        const downloads = spyOn(mount, 'downloadToTemp');
        const versionReads = () => downloads.mock.calls.filter(([id]) => id === versionId).length;
        try {
            await sweepDocument(drive, path);
            expect(versionReads()).toBe(1);
            expect(getVersionReferences(mount, [versionId])[0]?.names.media).toEqual(['kept.png']);
            await sweepDocument(drive, path);
            expect(versionReads()).toBe(1);

            // A row an older reader wrote is no record: its names keep nothing, and the version is read again.
            putVersionReferences(mount, {
                versionPathId: versionId,
                readerVersion: REFERENCE_READER_VERSION - 1,
                names: { media: ['stale.png'], chat: [], cards: [] },
            });
            await addMedia(mount, path.id, 'stale.png');
            await sweepDocument(drive, path);
            expect(versionReads()).toBe(2);
            expect(await mediaNames(mount, path.id)).toEqual(['kept.png']);
            expect(getVersionReferences(mount, [versionId])[0]?.readerVersion).toBe(REFERENCE_READER_VERSION);
        } finally {
            downloads.mockRestore();
        }
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

    test('a thread in the trash keeps its row and its status when another thread goes', async () => {
        const { path } = await openDoc(mount, M, 'ThreadTrashed', [paragraph()]);
        const trashed = await addThread(mount, M, path.id);
        await drive.setCommentStatus(M, path.id, trashed.name, 'resolved', home.user);
        await drive.deletePath(M, trashed.id);
        const gone = await addThread(mount, M, path.id);

        await close(M, path);
        await sweepDocument(drive, path);
        expect(await threadNames(mount, path.id)).toEqual([]);
        expect(await commentRows(M, path.id)).toEqual([trashed.name]);
        expect(await commentRows(M, path.id)).not.toContain(gone.name);
        const row = await withCommentIndex(drive, M, path.id, (index) => index.get(trashed.name));
        expect(row?.status).toBe('resolved');
    });

    test('a thread whose data.db is open on the server stays, such as for a reply through the Chat app', async () => {
        const { path } = await openDoc(mount, M, 'ThreadOpen', [paragraph()]);
        const thread = await addThread(mount, M, path.id);
        await close(M, path);
        // The reply reaches the data.db row only when the database syncs, so the row still reads as idle.
        const restore = await changeBeforeDelete(path.id, async () => {
            await (await drive.getChat(M, thread.id)).postMessage(home.user, 'a reply');
        });
        try {
            await sweepDocument(drive, path);
        } finally {
            restore();
            await closeThreadDb(mount, thread.id);
        }
        expect(await threadNames(mount, path.id)).toEqual([thread.name]);
    });

    test('a thread trashed or moved while the sweep read stays where it went', async () => {
        const { path } = await openDoc(mount, M, 'ThreadLeft', [paragraph()]);
        const trashed = await addThread(mount, M, path.id);
        const moved = await addThread(mount, M, path.id);
        const folder = await drive.createFolder(M, rootId, `ThreadLeft-${crypto.randomUUID()}`);
        await close(M, path);
        const restore = await changeBeforeDelete(path.id, async () => {
            await drive.deletePath(M, trashed.id);
            await drive.movePath(M, moved.id, folder.id);
        });
        try {
            await sweepDocument(drive, path);
        } finally {
            restore();
        }
        expect((await mount.getPath(trashed.id))?.trashedAt).not.toBeNull();
        expect((await mount.getPath(moved.id))?.parentId).toBe(folder.id);
    });

    test('a thread on its way to the trash when the delete starts stays for the trash', async () => {
        const { path } = await openDoc(mount, M, 'ThreadTrashing', [paragraph()]);
        const thread = await addThread(mount, M, path.id);
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
            trashing = drive.deletePath(M, thread.id);
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
        expect((await mount.getPath(thread.id))?.trashedAt).not.toBeNull();
    });
});

describe('a copy', () => {
    test('of an open document holds a comment row and an image added just before', async () => {
        const { path, collab } = await openDoc(mount, M, 'CopyOpen', [paragraph(marked('c1'))]);
        const thread = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        // A post writes the thread's row into comments.db, which stays open and unsynced for a while.
        await (await drive.getChat(M, thread.id)).postMessage(home.user, 'just before the copy', 'message');
        await addMedia(mount, path.id, 'new.png', { ageHours: 0 });
        const added = new Y.XmlElement('figure');
        added.setAttribute('mediaName', 'new.png');
        collab.doc.getXmlFragment('default').insert(0, [added]);

        const copied = await drive.copyPath(M, path.id, rootId, `${path.name} copy`, home.user);
        expect(await commentRows(M, copied.id)).toEqual([thread.name]);
        const copy = await drive.getCollabDocument(M, copied.id);
        expect(copy.doc.getXmlFragment('default').toString()).toContain('new.png');
        await close(M, copied);
        await close(M, path);
    });

    test('carries every part, and its first sweep after the grace frees what its state does not name', async () => {
        const { path, collab } = await openDoc(mount, M, 'CopyAll', [paragraph(figure('kept.png'), marked('c1'))]);
        await addMedia(mount, path.id, 'kept.png');
        await addMedia(mount, path.id, 'loose.png');
        const kept = await addThread(mount, M, path.id);
        const left = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: kept.name });
        await close(M, path);

        const copied = await drive.copyPath(M, path.id, rootId, `${path.name} copy`, home.user);
        const threads = [kept.name, left.name].sort();
        expect(await mediaNames(mount, copied.id)).toEqual(['kept.png', 'loose.png']);
        expect(await threadNames(mount, copied.id)).toEqual(threads);
        expect(await commentRows(M, copied.id)).toEqual(threads);
        // A copied part is new, so the grace spares it.
        await sweepDocument(drive, copied);
        expect(await mediaNames(mount, copied.id)).toEqual(['kept.png', 'loose.png']);

        // The content index reads the copy's threads, and a thread open on the server counts as active.
        await flushContentReindex(drive);
        const chat = await mount.getChildByName(copied.id, 'chat');
        for (const thread of chat ? await mount.listFolder(chat.id) : []) await closeThreadDb(mount, thread.id);
        const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + SWEEP_GRACE_MS + HOUR_MS);
        try {
            await sweepDocument(drive, copied);
        } finally {
            clock.mockRestore();
        }
        expect(await mediaNames(mount, copied.id)).toEqual(['kept.png']);
        expect(await threadNames(mount, copied.id)).toEqual([kept.name]);
        expect(await commentRows(M, copied.id)).toEqual([kept.name]);
        expect(await mediaNames(mount, path.id)).toEqual(['kept.png', 'loose.png']);
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

    test('sweeps after every close', async () => {
        const { path } = await openDoc(mount, M, 'Lingered', [paragraph()]);
        await addMedia(mount, path.id, 'first.png');
        await close(M, path);

        for (const name of ['first.png', 'second.png']) {
            if (name === 'second.png') await addMedia(mount, path.id, name);
            const closed = await lingerClose(path);
            expect(closed.sweeps).toBe(1);
            await closed.swept;
            expect(await mediaNames(mount, path.id)).toEqual([]);
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
            const version = await drive.saveVersion(S3_MOUNT, path.id);
            expect(s3.mount.pendingStagedCopy(await s3.mount.getStorageKey(version.id))).not.toBeNull();
            collab.doc.getXmlFragment('default').delete(0, 1);

            await close(S3_MOUNT, path);
            await sweepDocument(drive, path);
            expect(await mediaNames(s3.mount, path.id)).toEqual(['kept.png', 'versioned.png']);
        } finally {
            held.mockRestore();
            await uploadQueue.drain({ flushNow: true });
        }
    });

    // A bucket's lookup by name folds only ASCII case, which misses École.svg for école.svg.
    test('keeps what a kept SVG named with a non-ASCII letter draws, through an SVG it draws', async () => {
        const { path } = await openDoc(s3.mount, S3_MOUNT, 'BucketSvg', [paragraph(figure('École.svg'))]);
        const svg = (name: string) =>
            `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref(name)}"/></svg>`;
        await addMedia(s3.mount, path.id, 'École.svg', { mimeType: 'image/svg+xml', body: svg('Über.svg') });
        await addMedia(s3.mount, path.id, 'Über.svg', { mimeType: 'image/svg+xml', body: svg('leaf.png') });
        await addMedia(s3.mount, path.id, 'leaf.png');
        await addMedia(s3.mount, path.id, 'loose.png');

        await close(S3_MOUNT, path);
        await sweepDocument(drive, path);
        expect(await mediaNames(s3.mount, path.id)).toEqual(['leaf.png', 'École.svg', 'Über.svg']);
    });

    test('deletes a thread nothing names, with its row', async () => {
        const { path, collab } = await openDoc(s3.mount, S3_MOUNT, 'BucketThread', [paragraph(marked('c1'))]);
        const kept = await addThread(s3.mount, S3_MOUNT, path.id, { messages: [{ content: 'kept' }] });
        await addThread(s3.mount, S3_MOUNT, path.id, { messages: [{ content: 'gone' }] });
        addCard(collab.doc, 'c1', { chatName: kept.name });

        await close(S3_MOUNT, path);
        await sweepDocument(drive, path);
        expect(await threadNames(s3.mount, path.id)).toEqual([kept.name]);
        expect(await commentRows(S3_MOUNT, path.id)).toEqual([kept.name]);
    });
});
