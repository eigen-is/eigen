import { beforeAll, describe, expect, test } from 'bun:test';
import { encodeSheetsSnapshot } from '@workspace/lib/sheets';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { getStorageType, updateServerSettings } from '../../lib/config/server-settings';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import {
    chatGet,
    chatPost,
    createTestUser,
    driveGet,
    drivePost,
    ensureServer,
    findOrFail,
    type TestUser,
} from '../setup';

const M = 'default';

let user: TestUser;
let drive: Drive;
let rootId: string;

// A `local` mount, which keeps an open document's working copy in tmp/, as `s3` does.
beforeAll(async () => {
    await ensureServer();
    const before = getStorageType();
    await updateServerSettings({ defaults: { mount: { storageType: 'local-fullnames' } } });
    try {
        user = await createTestUser(`restore-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Restore');
        drive = (await getHome(user.id)).drive;
    } finally {
        await updateServerSettings({ defaults: { mount: { storageType: before } } });
    }
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

        await drive.restoreContainer(M, chat.id, saved.name);
        const messages = () => chatGet<{ content: string }[]>(t, user.id, M, `${chat.id}/messages`);
        expect((await messages()).map((message) => message.content)).toEqual(['v1']);

        await drive.restoreContainer(M, chat.id, await preRestoreVersion(chat.id, saved.name));
        expect((await messages()).map((message) => message.content)).toEqual(['v1', 'v2']);
    });

    test('a document whose stored object is gone is restored over its crash temp, which the pre-restore version keeps', async () => {
        const doc = await drive.create(M, rootId, 'Plan', 'sheets');
        const collab = await drive.getCollabDocument(M, doc.id);
        collab.doc.getMap('state').set('marker', 'v1');
        const saved = await drive.saveVersion(M, doc.id);
        collab.doc.getMap('state').set('marker', 'v2');
        await drive.closeCollabDocument(M, doc.id, { skipFinalSnapshot: true });
        const { mount } = await drive.resolveFile(M, doc.id);
        const dataDb = (await mount.getChildByName(doc.id, 'data.db'))!;
        await leaveCrashTemp(mount, dataDb.id, null);

        await drive.restoreContainer(M, doc.id, saved.name);
        const marker = async () => {
            const reopened = await drive.getCollabDocument(M, doc.id);
            const value = reopened.doc.getMap('state').get('marker');
            await drive.closeCollabDocument(M, doc.id, { skipFinalSnapshot: true });
            return value;
        };
        expect(await marker()).toBe('v1');

        await drive.restoreContainer(M, doc.id, await preRestoreVersion(doc.id, saved.name));
        expect(await marker()).toBe('v2');
    });
});

describe('a sheet version in an encoding the editor cannot read', () => {
    test('is refused with 409, and the open sheet keeps its content', async () => {
        const sheets = await drive.create(M, rootId, 'Budget', 'sheets');
        const collab = await drive.getCollabDocument(M, sheets.id);
        const state = collab.doc.getMap<string>('state');
        // The first encoding: the bare Sheet[] array, which decodeSheetsSnapshot refuses.
        state.set('snapshot', JSON.stringify([{ name: 'Sheet1', celldata: [] }]));
        const old = await drive.saveVersion(M, sheets.id);
        const current = encodeSheetsSnapshot([{ name: 'Sheet1', celldata: [] }], { computed: true });
        state.set('snapshot', current);

        await expect(drive.restoreContainer(M, sheets.id, old.name)).rejects.toMatchObject({ status: 409 });
        expect(state.get('snapshot')).toBe(current);
        await drive.closeCollabDocument(M, sheets.id);
    });
});
