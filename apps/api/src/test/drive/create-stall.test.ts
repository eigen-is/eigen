import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import type { User } from '../../lib/user';
import {
    createFaultMount,
    type FaultStorage,
    registerFaultMount,
    unregisterFaultMount,
    waitFor,
} from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// What the create hooks' reconcile poll sees in the listing while Drive.create's storage probe is stalled.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-create-stall-${Date.now()}`);
const MOUNT_ID = 'fault-create-stall';

let drive: Drive;
let mount: Mount;
let fault: FaultStorage;
let user: User;
let rootId: string;

beforeAll(async () => {
    const ctx = await getTestContext();
    mkdirSync(TEST_DIR, { recursive: true });
    const home = await getHome(ctx.alice.user.id);
    drive = home.drive;
    user = home.user;
    ({ mount, fault } = createFaultMount(ctx.alice.user.id, TEST_DIR, MOUNT_ID));
    await mount.init();
    registerFaultMount(drive, mount);
    rootId = (await mount.getRootFolder())!.id;
});

afterAll(async () => {
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Drive.create with a stalled storage probe', () => {
    // Gap UP-6: the reconcile poll can match a container that provisioning later rolls back.
    test.failing('a listing taken while the create is still provisioning does not show the container', async () => {
        let failProbe!: () => void;
        const probeHeld = new Promise<void>((resolve) => {
            failProbe = resolve;
        });
        const probe = spyOn(fault, 'exists').mockImplementationOnce(async () => {
            await probeHeld;
            throw new Error('injected exists failure (503)');
        });
        const creating = drive.create(MOUNT_ID, rootId, 'Pending', 'doc', user).catch((e: unknown) => e);
        try {
            await waitFor(() => probe.mock.calls.length > 0);
            const listing = await drive.getFolderContents(MOUNT_ID, rootId);
            failProbe();
            expect(await creating).toBeInstanceOf(Error);
            expect(await mount.getChildByName(rootId, 'Pending.eigendoc')).toBeNull();
            expect(listing.find((p) => p.name === 'Pending.eigendoc')).toBeUndefined();
        } finally {
            failProbe();
            await creating;
            probe.mockRestore();
        }
    });
});
