import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { encodeSheetsSnapshot } from '@workspace/lib/sheets';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { Snapshot } from '@workspace/lib/types/versioning';
import {
    activeCommentCardIds,
    readVectorFromDoc,
    VECTOR_STYLE_DEFAULTS,
    writeElementInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import type { Drive } from '../../lib/drive/drive';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import type { User } from '../../lib/user';
import type { TestUser } from '../setup';
import { authedRequest, chatGet, chatPost, createTestUserOnStorage, driveGet, drivePost, findOrFail } from '../setup';

const M = 'default';

let user: TestUser;
let owner: User;
let drive: Drive;
let rootId: string;

// A `local` mount, which keeps an open document's working copy in tmp/, as `s3` does.
beforeAll(async () => {
    user = await createTestUserOnStorage('local-fullnames', 'Restore');
    const home = await getHome(user.id);
    owner = home.user;
    drive = home.drive;
    rootId = (await drive.getRootFolder(M))!.id;
});

// The version besides `saved`: the pre-restore snapshot.
async function preRestoreVersion(containerId: string, saved: string): Promise<string> {
    const versions = await driveGet<Snapshot[]>(user.sessionToken, user.id, M, `file/${containerId}/versions`);
    return findOrFail(versions, (version) => version.name !== saved).name;
}

// What an unclean shutdown leaves: the working copy in tmp/ holds the closed data.db's last edits, which its
// stored object lacks.
async function leaveCrashTemp(mount: Mount, dataDbId: string, stored: ArrayBuffer | null): Promise<void> {
    await Bun.write(mount.getTempPath(dataDbId), (await mount.readFile(dataDbId))!);
    const key = await mount.getStorageKey(dataDbId);
    if (stored) await mount.storage.write(key, stored);
    else await mount.storage.delete(key);
}

describe('a container restored after an unclean shutdown', () => {
    test('a chat keeps the edits only its crash temp holds in the pre-restore version', async () => {
        const t = user.sessionToken;
        const chat = await drivePost(t, user.id, M, `folder/${rootId}/create/chat`, { fileName: 'Talk' });
        await chatPost(t, user.id, M, `${chat.id}/messages`, { content: 'v1' });
        const saved = await drive.saveVersion(M, chat.id);
        await chatPost(t, user.id, M, `${chat.id}/messages`, { content: 'v2' });
        const { mount } = await drive.resolveFile(M, chat.id);
        const dataDb = (await mount.getChildByName(chat.id, 'data.db'))!;
        await mount.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
        const versionsId = (await mount.getChildByName(chat.id, 'versions'))!.id;
        const savedFile = (await mount.getChildByName(versionsId, saved.name))!;
        await leaveCrashTemp(mount, dataDb.id, await mount.readBytes(savedFile.id));

        await drive.restoreContainer(M, chat.id, saved.name, owner);
        const messages = () => chatGet<{ content: string }[]>(t, user.id, M, `${chat.id}/messages`);
        expect((await messages()).map((message) => message.content)).toEqual(['v1']);

        await drive.restoreContainer(M, chat.id, await preRestoreVersion(chat.id, saved.name), owner);
        expect((await messages()).map((message) => message.content)).toEqual(['v1', 'v2']);
    });

    test('a document whose stored object is gone is restored over its crash temp, which the pre-restore version keeps', async () => {
        const doc = await drive.create(M, rootId, 'Plan', 'sheets', owner);
        const collab = await drive.getCollabDocument(M, doc.id);
        collab.doc.getMap('state').set('marker', 'v1');
        const saved = await drive.saveVersion(M, doc.id);
        collab.doc.getMap('state').set('marker', 'v2');
        await drive.closeCollabDocument(M, doc.id, { skipFinalSnapshot: true });
        const { mount } = await drive.resolveFile(M, doc.id);
        const dataDb = (await mount.getChildByName(doc.id, 'data.db'))!;
        await leaveCrashTemp(mount, dataDb.id, null);

        await drive.restoreContainer(M, doc.id, saved.name, owner);
        const marker = async () => {
            const reopened = await drive.getCollabDocument(M, doc.id);
            const value = reopened.doc.getMap('state').get('marker');
            await drive.closeCollabDocument(M, doc.id, { skipFinalSnapshot: true });
            return value;
        };
        expect(await marker()).toBe('v1');

        await drive.restoreContainer(M, doc.id, await preRestoreVersion(doc.id, saved.name), owner);
        expect(await marker()).toBe('v2');
    });
});

// On local-key the stored object is the live database, so a kill leaves it with its -wal beside it.
describe('a local-key chat restored after an unclean shutdown', () => {
    type Message = { content: string };

    async function chatWithTailInWal() {
        const owner = await createTestUserOnStorage('local-id', 'Stray wal');
        const t = owner.sessionToken;
        const home = (await getHome(owner.id)).drive;
        const root = (await home.getRootFolder(M))!.id;
        const chat = await drivePost(t, owner.id, M, `folder/${root}/create/chat`, { fileName: 'Talk' });
        await chatPost(t, owner.id, M, `${chat.id}/messages`, { content: 'saved' });
        const saved = await home.saveVersion(M, chat.id);
        await chatPost(t, owner.id, M, `${chat.id}/messages`, { content: 'tail' });
        const { mount } = await home.resolveFile(M, chat.id);
        const dataDb = (await mount.getChildByName(chat.id, 'data.db'))!;
        const key = await mount.getStorageKey(dataDb.id);
        const file = mount.storage.getPath!(key);
        const main = fs.readFileSync(file);
        const wal = fs.readFileSync(`${file}-wal`);
        await mount.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
        // The close's own search reindex would open the database again and fold the -wal in.
        mount.clearContentDirty(chat.id);
        fs.writeFileSync(file, main);
        fs.writeFileSync(`${file}-wal`, wal);
        const restore = (name: string) =>
            authedRequest(t, `/drive/${owner.id}/${M}/file/${chat.id}/versions/${name}/restore`, { method: 'POST' });
        const messages = async () =>
            (await chatGet<Message[]>(t, owner.id, M, `${chat.id}/messages`)).map((m) => m.content);
        return { owner, chat, saved, mount, key, file, restore, messages };
    }

    test('the pre-restore version keeps the -wal tail and the restored bytes stay intact', async () => {
        const { owner, chat, saved, file, restore, messages } = await chatWithTailInWal();

        expect((await restore(saved.name)).status).toBe(200);
        expect(await messages()).toEqual(['saved']);
        const db = new Database(file, { readwrite: true, create: false });
        expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        db.close();

        const versions = await driveGet<Snapshot[]>(owner.sessionToken, owner.id, M, `file/${chat.id}/versions`);
        const preRestore = findOrFail(versions, (version) => version.name !== saved.name);
        expect((await restore(preRestore.name)).status).toBe(200);
        expect(await messages()).toEqual(['saved', 'tail']);
    });

    test('a restore over a lost main file does not replay the -wal left beside it', async () => {
        const { saved, file, restore, messages } = await chatWithTailInWal();
        fs.rmSync(file);

        expect((await restore(saved.name)).status).toBe(200);
        expect(fs.existsSync(`${file}-wal`)).toBe(false);
        expect(await messages()).toEqual(['saved']);
    });

    test('a restore whose write fails leaves the previous data.db at its key', async () => {
        const { saved, mount, key: dataDbKey, file, restore, messages } = await chatWithTailInWal();
        const write = mount.storage.write.bind(mount.storage);
        const spy = spyOn(mount.storage, 'write').mockImplementation(async (key, data) => {
            if (key === dataDbKey) throw new Error('disk full');
            return write(key, data);
        });
        try {
            expect((await restore(saved.name)).status).toBe(500);
        } finally {
            spy.mockRestore();
        }
        expect(fs.existsSync(file)).toBe(true);
        expect(await messages()).toEqual(['saved', 'tail']);
    });
});

describe('a sheet version in an encoding the editor cannot read', () => {
    test('is refused with 409, and the open sheet keeps its content', async () => {
        const sheets = await drive.create(M, rootId, 'Budget', 'sheets', owner);
        const collab = await drive.getCollabDocument(M, sheets.id);
        const state = collab.doc.getMap<string>('state');
        // The first encoding: the bare Sheet[] array, which decodeSheetsSnapshot refuses.
        state.set('snapshot', JSON.stringify([{ name: 'Sheet1', celldata: [] }]));
        const old = await drive.saveVersion(M, sheets.id);
        const current = encodeSheetsSnapshot([{ id: 'fixture-1', name: 'Sheet1', celldata: [] }], { computed: true });
        state.set('snapshot', current);

        await expect(drive.restoreContainer(M, sheets.id, old.name, owner)).rejects.toMatchObject({ status: 409 });
        expect(state.get('snapshot')).toBe(current);
        await drive.closeCollabDocument(M, sheets.id);
    });
});

describe('a canvas comment deleted after a version', () => {
    // The canvas card as the comments pane reads it, with only the fields the active set looks at.
    function cardsOf(doc: Y.Doc): Record<string, CommentCard> {
        const cards: Record<string, CommentCard> = {};
        for (const [id, card] of doc.getMap('comments')) {
            if (!(card instanceof Y.Map)) continue;
            const deletedAt = card.get('deletedAt');
            cards[id] = {
                id,
                title: '',
                description: '',
                deletedAt: typeof deletedAt === 'number' ? deletedAt : undefined,
            };
        }
        return cards;
    }

    test('comes back with its element when the version is restored', async () => {
        const board = await drive.create(M, rootId, 'Board', 'vector', owner);
        const { doc } = await drive.getCollabDocument(M, board.id);
        const card = new Y.Map<unknown>();
        doc.transact(() => {
            card.set('id', 'c1');
            card.set('title', 'Fix the logo');
            doc.getMap('comments').set('c1', card);
            writeElementInDoc(doc, { type: 'rectangle', commentCardIds: '["c1"]' }, 'a0', VECTOR_STYLE_DEFAULTS, 'r1');
        });
        const saved = await drive.saveVersion(M, board.id);

        // The canvas delete: the card stays, marked, and the element loses its anchor.
        doc.transact(() => {
            card.set('deletedAt', Date.now());
            const element = doc.getMap('elements').get('r1');
            if (element instanceof Y.Map) element.set('commentCardIds', '');
        });
        const active = () => activeCommentCardIds(readVectorFromDoc(doc).elements, cardsOf(doc));
        expect(active().has('c1')).toBe(false);

        await drive.restoreContainer(M, board.id, saved.name, owner);
        expect(readVectorFromDoc(doc).elements.map((el) => el.commentCardIds)).toEqual(['["c1"]']);
        expect(active().has('c1')).toBe(true);
        await drive.closeCollabDocument(M, board.id, { skipFinalSnapshot: true });
    });
});
