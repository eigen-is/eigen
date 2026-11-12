import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SWEEP_GRACE_MS } from '@workspace/lib/constants/sweep';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eigenMediaHref } from '@workspace/lib/vector';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { withCommentIndex } from '../../lib/chat';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';
import * as commentSchema from '../../lib/chat/comment-schema';
import type { Drive } from '../../lib/drive/drive';
import { sweepDocument } from '../../lib/drive/sweep';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount/mount';
import { paths } from '../../lib/mount/schema';
import { HOUR_MS } from '../../lib/versioning/retention';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount } from '../fault-storage-helpers';
import { buildGoldenDeckScene, seedEigendoc, seedVectorDoc } from '../fixtures/golden-documents';
import { flushContentReindex, seedFile } from '../mount-test-helpers';
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

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const figure = (mediaName: string) => ({ type: 'figure', attrs: { mediaName } });
const marked = (cardId: string) => ({ type: 'text', text: 'Marked', marks: [{ type: 'comment', attrs: { cardId } }] });
const svgDrawing = (...names: string[]) =>
    `<svg xmlns="http://www.w3.org/2000/svg">${names.map((name) => `<image href="${eigenMediaHref(name)}"/>`).join('')}</svg>`;

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
    const path = await drive.create(mountId, root.id, `${name}-${crypto.randomUUID()}`, 'doc', home.user);
    const collab = await drive.getCollabDocument(mountId, path.id);
    seedEigendoc(collab.doc, { type: 'doc', content: blocks });
    return { path, collab };
}

// A file in the media folder of a document or a thread, uploaded `ageHours` ago.
async function addMedia(
    sweepMount: Mount,
    containerId: string,
    name: string,
    opts: { ageHours?: number; mimeType?: string; body?: string } = {},
): Promise<string> {
    const media = await sweepMount.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    const body = Buffer.from(opts.body ?? `bytes of ${name}`);
    const id = await seedFile(sweepMount, media.id, name, opts.mimeType ?? 'image/png', body.length, body);
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

type Message = { content: string; attachments?: string[] };

// A comment thread in the document's chat folder, its messages posted, last written `ageHours` ago.
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
    // open data.db counts as a write, so it is closed once more after the index read it.
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

describe('the sweep', () => {
    test('an old file the current state does not name goes, a named one and a young one stay', async () => {
        const { path } = await openDoc(mount, M, 'Plain', [paragraph(figure('kept.png'))]);
        await addMedia(mount, path.id, 'kept.png');
        await addMedia(mount, path.id, 'loose.png');
        await addMedia(mount, path.id, 'young.png', { ageHours: 71 });

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(mount, path.id)).toEqual(['kept.png', 'young.png']);
    });

    test("a card's attachment stays while the card is in use", async () => {
        const { path, collab } = await openDoc(mount, M, 'Card', [paragraph(marked('c1'))]);
        addCard(collab.doc, 'c1', { attachments: ['card.pdf'] });
        addCard(collab.doc, 'c-loose', { attachments: ['loose.pdf'] });
        await addMedia(mount, path.id, 'card.pdf', { mimeType: 'application/pdf' });
        await addMedia(mount, path.id, 'loose.pdf', { mimeType: 'application/pdf' });

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(mount, path.id)).toEqual(['card.pdf']);
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
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(mount, path.id)).toEqual(['Café.png'.normalize('NFC'), 'photo.png']);
    });

    test("a kept SVG's siblings stay, to the inline depth, and so do those of a young SVG", async () => {
        const { path } = await openDoc(mount, M, 'Svg', [paragraph(figure('outer.svg'))]);
        const asSvg = (body: string, ageHours = OLD_HOURS) => ({ mimeType: 'image/svg+xml', body, ageHours });
        await addMedia(mount, path.id, 'outer.svg', asSvg(svgDrawing('inner.svg', 'leaf.png')));
        await addMedia(mount, path.id, 'inner.svg', asSvg(svgDrawing('deep.png')));
        await addMedia(mount, path.id, 'leaf.png');
        await addMedia(mount, path.id, 'deep.png');
        // Such as an SVG pasted a moment ago, whose edit has not reached the server yet.
        await addMedia(mount, path.id, 'young.svg', asSvg(svgDrawing('pasted.png'), 1));
        await addMedia(mount, path.id, 'pasted.png');
        await addMedia(mount, path.id, 'loose.png');

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(mount, path.id)).toEqual([
            'deep.png',
            'inner.svg',
            'leaf.png',
            'outer.svg',
            'pasted.png',
            'young.svg',
        ]);
    });

    test('an unnamed idle thread goes with its row, its mentions and its search hit', async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadGone', [paragraph(marked('c-kept'))]);
        const kept = await addThread(mount, M, path.id, { messages: [{ content: 'needle kept' }] });
        const gone = await addThread(mount, M, path.id, {
            messages: [{ content: `needle gone, ask ${home.user.email}` }],
        });
        addCard(collab.doc, 'c-kept', { chatName: kept.name });
        addCard(collab.doc, 'c-gone', { chatName: gone.name });

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await threadNames(mount, path.id)).toEqual([kept.name]);
        expect(await commentRows(M, path.id)).toEqual([kept.name]);
        const hits = await withCommentIndex(drive, M, path.id, (index) => index.searchComments('needle'));
        expect(hits.map((hit) => hit.id)).toEqual([kept.name]);
        const commentsDb = await mount.getChildByName(path.id, 'comments.db');
        if (!commentsDb) throw new Error('no comments.db');
        const mentions = await drive.withDatabase(M, COMMENT_INDEX_DB_CONFIG, commentsDb.id, async (db) =>
            db.db.select().from(commentSchema.commentMentions).all(),
        );
        expect(mentions.map((mention) => mention.chatName)).not.toContain(gone.name);
    });

    test('a thread written in during the grace stays, by its creation or its last reply', async () => {
        const { path } = await openDoc(mount, M, 'ThreadYoung', [paragraph()]);
        const young = await addThread(mount, M, path.id, { ageHours: 71 });
        const replied = await addThread(mount, M, path.id);
        await addThread(mount, M, path.id);
        // A reply through a notification, while the document is closed.
        await (await drive.getChat(M, replied.id)).postMessage(home.user, 'still here');
        await closeThreadDb(mount, replied.id);

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await threadNames(mount, path.id)).toEqual([replied.name, young.name].sort());
    });

    test('a canvas keeps the thread of a document-level card and drops that of a deleted one', async () => {
        const created = await drive.create(M, rootId, `ThreadCanvas-${crypto.randomUUID()}`, 'vector', home.user);
        const collab = await drive.getCollabDocument(M, created.id);
        seedVectorDoc(collab.doc, buildGoldenDeckScene());
        const documentLevel = await addThread(mount, M, created.id);
        const deleted = await addThread(mount, M, created.id);
        addCard(collab.doc, 'c-document', { chatName: documentLevel.name });
        addCard(collab.doc, 'c-deleted', { chatName: deleted.name, deletedAt: Date.now() });

        await close(M, created);
        await sweepDocument(drive, mount, created, SWEEP_GRACE_MS);
        expect(await threadNames(mount, created.id)).toEqual([documentLevel.name]);
    });

    test('a row without its thread goes', async () => {
        const { path } = await openDoc(mount, M, 'ThreadOrphan', [paragraph()]);
        await withCommentIndex(drive, M, path.id, async (index) => {
            await index.ensureComment('ghost.eigenchat', home.user.email);
            await index.addMention('ghost.eigenchat', home.user.email);
        });
        await addThread(mount, M, path.id, { ageHours: 1 });

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await commentRows(M, path.id)).not.toContain('ghost.eigenchat');
    });

    test('inside a kept thread, an old file no message names goes', async () => {
        const { path, collab } = await openDoc(mount, M, 'ThreadMedia', [paragraph(marked('c1'))]);
        const thread = await addThread(mount, M, path.id, {
            messages: [{ content: 'see', attachments: ['named.png'] }],
        });
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await addMedia(mount, thread.id, 'named.png');
        await addMedia(mount, thread.id, 'loose.png');
        await addMedia(mount, thread.id, 'young.png', { ageHours: 1 });

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(mount, thread.id)).toEqual(['named.png', 'young.png']);
    });

    test('a reader that throws deletes nothing', async () => {
        const { path, collab } = await openDoc(mount, M, 'Unreadable', [paragraph()]);
        addCard(collab.doc, 'c-odd', { chatName: 42 });
        await addMedia(mount, path.id, 'loose.png');
        await addThread(mount, M, path.id);

        await close(M, path);
        await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(await threadNames(mount, path.id)).toHaveLength(1);
    });

    test('an SVG that cannot be read deletes nothing', async () => {
        const { path } = await openDoc(mount, M, 'SvgUnreadable', [paragraph(figure('outer.svg'))]);
        const outer = await addMedia(mount, path.id, 'outer.svg', {
            mimeType: 'image/svg+xml',
            body: svgDrawing('leaf.png'),
        });
        await addMedia(mount, path.id, 'leaf.png');
        await addMedia(mount, path.id, 'loose.png');
        await addThread(mount, M, path.id);

        await close(M, path);
        const readBytes = mount.readBytes.bind(mount);
        const reads = spyOn(mount, 'readBytes').mockImplementation(async (id) => (id === outer ? null : readBytes(id)));
        try {
            await sweepDocument(drive, mount, path, SWEEP_GRACE_MS);
        } finally {
            reads.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['leaf.png', 'loose.png', 'outer.svg']);
        expect(await threadNames(mount, path.id)).toHaveLength(1);
    });
});

describe('Delete history', () => {
    test('deletes the versions, then at once what only they named, and keeps what is under three days old', async () => {
        const { path, collab } = await openDoc(mount, M, 'History', [
            paragraph(figure('versioned.png'), marked('c1')),
            paragraph(figure('kept.png')),
        ]);
        await addMedia(mount, path.id, 'versioned.png');
        await addMedia(mount, path.id, 'kept.png');
        await addMedia(mount, path.id, 'young.png', { ageHours: 71 });
        const thread = await addThread(mount, M, path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);

        // The document stays open, as when its owner deletes its history from the File menu.
        await drive.deleteVersions(M, path.id, home.user);
        expect(await drive.listVersions(M, path.id)).toEqual([]);
        expect(await mediaNames(mount, path.id)).toEqual(['kept.png', 'young.png']);
        expect(await threadNames(mount, path.id)).toEqual([]);
        expect(await commentRows(M, path.id)).toEqual([]);
        await close(M, path);
    });
});

describe('a copy', () => {
    const intoRoot = () => ({ drive, mountId: M, parentId: rootId });

    // A source with a named image, a loose one from a moment ago, a kept thread with a named and a loose file, and a
    // thread nothing names that was written in a moment ago.
    async function sourceDoc(name: string) {
        const { path, collab } = await openDoc(mount, M, name, [paragraph(figure('kept.png'), marked('c1'))]);
        await addMedia(mount, path.id, 'kept.png');
        await addMedia(mount, path.id, 'loose.png', { ageHours: 0 });
        const kept = await addThread(mount, M, path.id, { messages: [{ content: 'see', attachments: ['named.png'] }] });
        await addMedia(mount, kept.id, 'named.png');
        await addMedia(mount, kept.id, 'stray.png', { ageHours: 0 });
        const left = await addThread(mount, M, path.id, { ageHours: 0 });
        addCard(collab.doc, 'c1', { chatName: kept.name });
        return { path, kept, left };
    }

    async function expectOnlyNamed(copied: DrivePath, kept: DrivePath): Promise<void> {
        expect(await mediaNames(mount, copied.id)).toEqual(['kept.png']);
        expect(await threadNames(mount, copied.id)).toEqual([kept.name]);
        expect(await commentRows(M, copied.id)).toEqual([kept.name]);
        const chat = await mount.getChildByName(copied.id, 'chat');
        const copiedThread = chat ? await mount.getChildByName(chat.id, kept.name) : null;
        if (!copiedThread) throw new Error('no copied thread');
        expect(await mediaNames(mount, copiedThread.id)).toEqual(['named.png']);
    }

    test('holds what the source state names and nothing else, and the source keeps everything', async () => {
        const { path, kept, left } = await sourceDoc('Copy');

        const copied = await drive.copyPath(M, path.id, intoRoot(), `${path.name} copy`, home.user);
        await expectOnlyNamed(copied, kept);
        expect(await mediaNames(mount, path.id)).toEqual(['kept.png', 'loose.png']);
        expect(await threadNames(mount, path.id)).toEqual([kept.name, left.name].sort());
        expect(await mediaNames(mount, kept.id)).toEqual(['named.png', 'stray.png']);
        await close(M, path);
    });

    test('inside a copied folder holds only what each state names', async () => {
        const folder = await drive.createFolder(M, rootId, `CopyFolder-${crypto.randomUUID()}`, home.user);
        const { path, kept } = await sourceDoc('CopyAcross');
        await drive.movePath(M, path.id, folder.id, home.user);

        const copied = await drive.copyPath(M, folder.id, intoRoot(), `${folder.name} copy`, home.user);
        const copiedDoc = await mount.getChildByName(copied.id, path.name);
        if (!copiedDoc) throw new Error('no copied document');
        await expectOnlyNamed(copiedDoc, kept);
        await close(M, path);
    });

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

        const copied = await drive.copyPath(M, path.id, intoRoot(), `${path.name} copy`, home.user);
        expect(await commentRows(M, copied.id)).toEqual([thread.name]);
        expect(await mediaNames(mount, copied.id)).toEqual(['new.png']);
        await close(M, path);
    });

    // A listing of the target folder shows the copy while it lands, so its owner may add to it before the cleanup runs.
    test('keeps an image and a thread added to it before its cleanup runs', async () => {
        const { path, kept } = await sourceDoc('CopyAdded');
        let added: DrivePath | undefined;
        const copyPath = mount.copyPath.bind(mount);
        const copies = spyOn(mount, 'copyPath').mockImplementation(async (...args) => {
            const copy = await copyPath(...args);
            await addMedia(mount, copy.path.id, 'added.png');
            added = await addThread(mount, M, copy.path.id);
            return copy;
        });
        try {
            const copied = await drive.copyPath(M, path.id, intoRoot(), `${path.name} copy`, home.user);
            if (!added) throw new Error('nothing added');
            expect(await mediaNames(mount, copied.id)).toEqual(['added.png', 'kept.png']);
            expect(await threadNames(mount, copied.id)).toEqual([added.name, kept.name].sort());
        } finally {
            copies.mockRestore();
        }
        await close(M, path);
    });

    test('succeeds and stays whole when its cleanup fails', async () => {
        const { path } = await sourceDoc('CopyCleanupFails');
        let landed = false;
        const copyPath = mount.copyPath.bind(mount);
        const copies = spyOn(mount, 'copyPath').mockImplementation(async (...args) => {
            const copy = await copyPath(...args);
            landed = true;
            return copy;
        });
        const listFolder = mount.listFolder.bind(mount);
        const lists = spyOn(mount, 'listFolder').mockImplementation(async (id) => {
            if (landed) throw new Error('listing failed');
            return listFolder(id);
        });
        let copied: DrivePath;
        try {
            copied = await drive.copyPath(M, path.id, intoRoot(), `${path.name} copy`, home.user);
        } finally {
            copies.mockRestore();
            lists.mockRestore();
        }
        expect(await mediaNames(mount, copied.id)).toEqual(['kept.png', 'loose.png']);
        await close(M, path);
    });
});

describe('the sweep on s3', () => {
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

    test('deletes the file and the thread nothing names, with its row', async () => {
        const { path, collab } = await openDoc(s3.mount, S3_MOUNT, 'Bucket', [
            paragraph(figure('kept.png'), marked('c1')),
        ]);
        for (const name of ['kept.png', 'loose.png']) await addMedia(s3.mount, path.id, name);
        const kept = await addThread(s3.mount, S3_MOUNT, path.id, { messages: [{ content: 'kept' }] });
        await addThread(s3.mount, S3_MOUNT, path.id, { messages: [{ content: 'gone' }] });
        addCard(collab.doc, 'c1', { chatName: kept.name });

        await drive.deleteVersions(S3_MOUNT, path.id, home.user);
        expect(await mediaNames(s3.mount, path.id)).toEqual(['kept.png']);
        expect(await threadNames(s3.mount, path.id)).toEqual([kept.name]);
        expect(await commentRows(S3_MOUNT, path.id)).toEqual([kept.name]);
        await close(S3_MOUNT, path);
    });

    // A bucket's lookup by name folds only ASCII case, which misses École.svg for école.svg.
    test('keeps what a kept SVG named with a non-ASCII letter draws, through an SVG it draws', async () => {
        const { path } = await openDoc(s3.mount, S3_MOUNT, 'BucketSvg', [paragraph(figure('École.svg'))]);
        await addMedia(s3.mount, path.id, 'École.svg', { mimeType: 'image/svg+xml', body: svgDrawing('Über.svg') });
        await addMedia(s3.mount, path.id, 'Über.svg', { mimeType: 'image/svg+xml', body: svgDrawing('leaf.png') });
        await addMedia(s3.mount, path.id, 'leaf.png');
        await addMedia(s3.mount, path.id, 'loose.png');

        await close(S3_MOUNT, path);
        await sweepDocument(drive, s3.mount, path, SWEEP_GRACE_MS);
        expect(await mediaNames(s3.mount, path.id)).toEqual(['leaf.png', 'École.svg', 'Über.svg']);
    });
});
