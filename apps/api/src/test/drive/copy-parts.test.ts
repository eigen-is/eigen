import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eigenMediaHref } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { withCommentIndex } from '../../lib/chat';
import * as enforcement from '../../lib/config/enforcement';
import type { Drive } from '../../lib/drive/drive';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount/mount';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount } from '../fault-storage-helpers';
import { seedEigendoc } from '../fixtures/golden-documents';
import { createTestUserOnStorage } from '../setup';

const M = 'default';

let home: Home;
let drive: Drive;
let mount: Mount;
let rootId: string;

beforeAll(async () => {
    const user = await createTestUserOnStorage('local-fullnames', 'Copy parts');
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

// A comment card as the comment hooks write it.
function addCard(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
    const card = new Y.Map<unknown>();
    card.set('id', id);
    card.set('title', id);
    card.set('description', '');
    for (const [field, value] of Object.entries(fields)) card.set(field, value);
    doc.getMap('comments').set(id, card);
}

// An open doc in the folder whose body is the given paragraphs, one block each.
async function openDoc(name: string, blocks: object[], at: { mountId: string; folderId: string } = defaultFolder()) {
    const path = await drive.create(at.mountId, at.folderId, `${name}-${crypto.randomUUID()}`, 'doc');
    const collab = await drive.getCollabDocument(at.mountId, path.id);
    seedEigendoc(collab.doc, { type: 'doc', content: blocks });
    return { path, collab };
}

function defaultFolder(): { mountId: string; folderId: string } {
    return { mountId: M, folderId: rootId };
}

// A file in the media folder of a document or a thread.
async function addMedia(
    containerId: string,
    name: string,
    opts: { mimeType?: string; body?: string; on?: Mount } = {},
): Promise<void> {
    const on = opts.on ?? mount;
    const media = await on.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    const body = Buffer.from(opts.body ?? `bytes of ${name}`);
    await on.createFile(media.id, name, opts.mimeType ?? 'image/png', body.length, body);
}

async function mediaNames(containerId: string, on: Mount = mount): Promise<string[]> {
    const media = await on.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    return (await on.listFolder(media.id)).map((file) => file.name).sort();
}

// A comment thread in the document's chat folder, with the messages posted.
async function addThread(
    containerId: string,
    messages: { content: string; attachments?: string[] }[] = [],
    at: { mountId: string; on: Mount } = { mountId: M, on: mount },
): Promise<DrivePath> {
    const chat = await at.on.getChildByName(containerId, 'chat');
    if (!chat) throw new Error('no chat folder');
    const thread = await drive.create(at.mountId, chat.id, `thread-${crypto.randomUUID()}`, 'chat', home.user);
    const room = await drive.getChat(at.mountId, thread.id);
    for (const { content, attachments } of messages) {
        await room.postMessage(home.user, content, 'message', undefined, undefined, attachments);
    }
    return thread;
}

async function threadNames(containerId: string, on: Mount = mount): Promise<string[]> {
    const chat = await on.getChildByName(containerId, 'chat');
    if (!chat) throw new Error('no chat folder');
    return (await on.listFolder(chat.id)).map((thread) => thread.name).sort();
}

async function commentRows(containerId: string, mountId = M): Promise<string[]> {
    return withCommentIndex(drive, mountId, containerId, async (index) =>
        (await index.list()).map((entry) => entry.chatName).sort(),
    );
}

async function copyOf(path: DrivePath, mountId = M, folderId = rootId): Promise<DrivePath> {
    return drive.copyPath(mountId, path.id, folderId, `${path.name} copy`, home.user);
}

// A doc with one of each part its state names, and one of each it does not.
async function docWithEveryPart(name: string) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref('sibling.png')}"/></svg>`;
    const { path, collab } = await openDoc(name, [
        paragraph(figure('figure.png')),
        paragraph(figure('drawing.svg')),
        paragraph(marked('c-kept')),
    ]);
    for (const file of ['figure.png', 'sibling.png', 'card.pdf', 'loose.png']) await addMedia(path.id, file);
    await addMedia(path.id, 'drawing.svg', { mimeType: 'image/svg+xml', body: svg });
    const kept = await addThread(path.id, [{ content: 'named', attachments: ['named.png'] }]);
    for (const file of ['named.png', 'unnamed.png']) await addMedia(kept.id, file);
    const left = await addThread(path.id, [{ content: 'left behind' }]);
    addCard(collab.doc, 'c-kept', { chatName: kept.name, attachments: ['card.pdf'] });
    addCard(collab.doc, 'c-left', { chatName: left.name });
    return { path, kept, left };
}

describe('a copy of a document', () => {
    test('of an open document holds a comment row added just before', async () => {
        const { path, collab } = await openDoc('OpenRow', [paragraph(marked('c1'))]);
        const thread = await addThread(path.id);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        // A post writes the thread's row into comments.db, which stays open and unsynced for a while.
        const room = await drive.getChat(M, thread.id);
        await room.postMessage(home.user, 'just before the copy', 'message');

        const copied = await copyOf(path);
        expect(await commentRows(copied.id)).toEqual([thread.name]);
    });

    test('holds every part the current state names, and nothing else', async () => {
        const { path, kept } = await docWithEveryPart('Every');

        const copied = await copyOf(path);
        expect(await mediaNames(copied.id)).toEqual(['card.pdf', 'drawing.svg', 'figure.png', 'sibling.png']);
        expect(await threadNames(copied.id)).toEqual([kept.name]);
        const chat = await mount.getChildByName(copied.id, 'chat');
        const thread = chat && (await mount.getChildByName(chat.id, kept.name));
        if (!thread) throw new Error('no copied thread');
        expect(await mediaNames(thread.id)).toEqual(['named.png']);
        // The source keeps every part.
        expect(await mediaNames(path.id)).toEqual([
            'card.pdf',
            'drawing.svg',
            'figure.png',
            'loose.png',
            'sibling.png',
        ]);
    });

    test('holds no part that only a version names', async () => {
        const { path, collab } = await openDoc('VersionOnly', [paragraph(figure('a.png')), paragraph(marked('c1'))]);
        await addMedia(path.id, 'a.png');
        const thread = await addThread(path.id, [{ content: 'once anchored' }]);
        addCard(collab.doc, 'c1', { chatName: thread.name });
        await drive.saveVersion(M, path.id);
        // The image and the comment's anchor go, so only the version names them.
        collab.doc.getXmlFragment('default').delete(0, 2);

        const copied = await copyOf(path);
        expect(await mediaNames(copied.id)).toEqual([]);
        expect(await threadNames(copied.id)).toEqual([]);
    });

    test('has no comment row for a thread it left behind', async () => {
        const { path, kept, left } = await docWithEveryPart('Rows');
        expect(await commentRows(path.id)).toEqual([kept.name, left.name].sort());

        const copied = await copyOf(path);
        expect(await commentRows(copied.id)).toEqual([kept.name]);
        expect(await commentRows(path.id)).toEqual([kept.name, left.name].sort());
    });

    test('of an open document holds an image added just before', async () => {
        const { path, collab } = await openDoc('OpenImage', [paragraph()]);
        await addMedia(path.id, 'new.png');
        const added = new Y.XmlElement('figure');
        added.setAttribute('mediaName', 'new.png');
        collab.doc.getXmlFragment('default').insert(0, [added]);

        const copied = await copyOf(path);
        expect(await mediaNames(copied.id)).toEqual(['new.png']);
    });

    test('in a folder copy, each document inside takes only its named parts', async () => {
        const folderId = await mount.createFolder(rootId, `Folder-${crypto.randomUUID()}`);
        const first = await openDoc('First', [paragraph(figure('one.png'))], { mountId: M, folderId });
        const sub = await mount.createFolder(folderId, 'sub');
        const second = await openDoc('Second', [paragraph(figure('two.png'))], { mountId: M, folderId: sub });
        for (const [doc, named] of [
            [first.path, 'one.png'],
            [second.path, 'two.png'],
        ] as const) {
            await addMedia(doc.id, named);
            await addMedia(doc.id, 'loose.png');
        }
        const folder = await mount.getActivePath(folderId);

        const copied = await copyOf(folder);
        const firstCopy = await mount.getChildByName(copied.id, first.path.name);
        const subCopy = await mount.getChildByName(copied.id, 'sub');
        const secondCopy = subCopy && (await mount.getChildByName(subCopy.id, second.path.name));
        if (!firstCopy || !secondCopy) throw new Error('a document did not copy');
        expect(await mediaNames(firstCopy.id)).toEqual(['one.png']);
        expect(await mediaNames(secondCopy.id)).toEqual(['two.png']);
    });

    test('meets the quota with only the bytes it copies', async () => {
        const { path } = await openDoc('Quota', [paragraph(figure('kept.png'))]);
        await addMedia(path.id, 'kept.png');
        await addMedia(path.id, 'loose.png', { body: 'x'.repeat(100_000) });
        const quota = spyOn(enforcement, 'enforceMountQuota');
        try {
            const copied = await copyOf(path);
            const [, , bytes] = quota.mock.calls[0] ?? [];
            expect(bytes).toBe(copied.size);
            expect(copied.size).toBeLessThan(100_000);
        } finally {
            quota.mockRestore();
        }
    });

    test('to another drive takes the same parts', async () => {
        const { path, kept } = await docWithEveryPart('Across');

        const copied = await drive.copyPath(M, path.id, rootId, `${path.name} across`, home.user, {
            drive,
            ownerId: home.user.id,
            mountId: M,
        });
        expect(await mediaNames(copied.id)).toEqual(['card.pdf', 'drawing.svg', 'figure.png', 'sibling.png']);
        expect(await threadNames(copied.id)).toEqual([kept.name]);
        expect(await commentRows(copied.id)).toEqual([kept.name]);
    });

    test('whose state does not read fails and writes nothing', async () => {
        const { path, collab } = await openDoc('Unreadable', [paragraph()]);
        addCard(collab.doc, 'c-odd', { chatName: 42 });
        await addMedia(path.id, 'loose.png');
        const name = `${path.name} copy`;

        await expect(copyOf(path)).rejects.toThrow();
        expect(await mount.getChildByName(rootId, name)).toBeNull();
    });
});

describe('a copy of a document on s3', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-copy-parts-s3-${Date.now()}`);
    const S3_MOUNT = 'copy-parts-s3';
    let s3: FakeS3Mount;
    // A document left open would hold its database through the mount's close.
    const openDocIds: string[] = [];

    beforeAll(async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        s3 = await createFakeS3Mount(home, TEST_DIR, S3_MOUNT);
    });

    afterAll(async () => {
        await removeFakeS3Mount(s3, openDocIds);
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test('takes only the parts the current state names', async () => {
        const root = await s3.mount.getRootFolder();
        if (!root) throw new Error('no root folder');
        const at = { mountId: S3_MOUNT, folderId: root.id };
        const { path, collab } = await openDoc('Bucket', [paragraph(figure('kept.png')), paragraph(marked('c1'))], at);
        openDocIds.push(path.id);
        for (const file of ['kept.png', 'loose.png']) await addMedia(path.id, file, { on: s3.mount });
        const kept = await addThread(path.id, [{ content: 'kept' }], { mountId: S3_MOUNT, on: s3.mount });
        await addThread(path.id, [{ content: 'left' }], { mountId: S3_MOUNT, on: s3.mount });
        addCard(collab.doc, 'c1', { chatName: kept.name });

        const copied = await copyOf(path, S3_MOUNT, root.id);
        expect(await mediaNames(copied.id, s3.mount)).toEqual(['kept.png']);
        expect(await threadNames(copied.id, s3.mount)).toEqual([kept.name]);
        expect(await commentRows(copied.id, S3_MOUNT)).toEqual([kept.name]);
    });
});
