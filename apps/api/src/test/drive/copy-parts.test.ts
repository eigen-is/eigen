import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { withCommentIndex } from '../../lib/chat';
import type { Drive } from '../../lib/drive/drive';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount/mount';
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
async function openDoc(name: string, blocks: object[]) {
    const path = await drive.create(M, rootId, `${name}-${crypto.randomUUID()}`, 'doc');
    const collab = await drive.getCollabDocument(M, path.id);
    seedEigendoc(collab.doc, { type: 'doc', content: blocks });
    return { path, collab };
}

// A comment thread in the document's chat folder, with nothing posted yet.
async function addThread(containerId: string): Promise<DrivePath> {
    const chat = await mount.getChildByName(containerId, 'chat');
    if (!chat) throw new Error('no chat folder');
    return drive.create(M, chat.id, `thread-${crypto.randomUUID()}`, 'chat', home.user);
}

async function commentRows(containerId: string): Promise<string[]> {
    return withCommentIndex(drive, M, containerId, async (index) =>
        (await index.list()).map((entry) => entry.chatName).sort(),
    );
}

async function copyOf(path: DrivePath): Promise<DrivePath> {
    return drive.copyPath(M, path.id, rootId, `${path.name} copy`, home.user);
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
});
