import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_STORAGE_UNAVAILABLE_CLOSE } from '@workspace/lib/constants/collab';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import type { User } from '../../lib/user';
import { createFaultMount, registerFaultMount, settleContainer, unregisterFaultMount } from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// Unreachable storage closes the collab WS with 1013 'storage-unavailable', every other failed open
// with 1008. Needs a real listening server: app.handle() never completes the upgrade.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-collab-unavailable-${Date.now()}`);
const MOUNT_ID = 'fault-collab';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let drive: Drive;
let mount: Mount;
let user: User;
let ownerId: string;
let token: string;
let port: number;
let docId: string;

// Resolve on close, whatever happens first — the route closes right after the upgrade, so onopen
// may or may not have fired by then.
function closeOfCollabWs(pathId: string): Promise<{ code: number; reason: string }> {
    const ws = new WebSocket(`ws://localhost:${port}/ws/collab/${ownerId}/${MOUNT_ID}/${pathId}`, {
        headers: { cookie: `better-auth.session_token=${token}` },
    } as unknown as string[]);
    return new Promise((resolve, reject) => {
        ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
        ws.onerror = (e) => reject(e);
    });
}

beforeAll(async () => {
    ctx = await getTestContext();
    ownerId = ctx.alice.user.id;
    token = ctx.alice.user.sessionToken;
    mkdirSync(TEST_DIR, { recursive: true });

    const home = await getHome(ownerId);
    drive = home.drive;
    user = home.user;
    ({ mount } = createFaultMount(ownerId, TEST_DIR, MOUNT_ID));
    await mount.init();
    registerFaultMount(drive, mount);
    const rootId = (await mount.getRootFolder())!.id;

    const doc = await drive.create(MOUNT_ID, rootId, 'Unreachable', 'doc', user);
    docId = doc.id;
    await settleContainer(mount, docId);

    const dataDb = (await mount.getChildByName(docId, 'data.db'))!;
    await mount.storage.delete(await mount.getStorageKey(dataDb.id));

    const listenPort = ctx.app.listen(0).server?.port;
    expect(listenPort).toBeDefined();
    port = listenPort!;
});

afterAll(async () => {
    ctx.app.stop();
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Collab WS open under unreachable storage', () => {
    test('a document whose storage object is gone closes 1013 storage-unavailable', async () => {
        expect(await closeOfCollabWs(docId)).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: 'storage-unavailable',
        });
    });

    test('an ordinary failed open still closes 1008', async () => {
        expect((await closeOfCollabWs('no-such-path')).code).toBe(1008);
    });
});
