import { beforeAll, describe, expect, test } from 'bun:test';
import { encodeSheetsSnapshot } from '@workspace/lib/sheets';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home/get-home';
import { createTestUser, ensureServer, type TestUser } from '../setup';

const M = 'default';

let user: TestUser;
let drive: Drive;
let rootId: string;

beforeAll(async () => {
    await ensureServer();
    user = await createTestUser(`restore-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Restore');
    drive = (await getHome(user.id)).drive;
    rootId = (await drive.getRootFolder(M))!.id;
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
