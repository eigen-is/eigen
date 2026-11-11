import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import type { Home } from '../../lib/home';
import { getHome } from '../../lib/home';
import { evictHome } from '../../lib/home/get-home';
import { getSyntheticTeamUser, TeamHome } from '../../lib/home/team-home';
import type { Mount } from '../../lib/mount/mount';
import {
    countBackingRows,
    countRowsInFile,
    createHomeFaultMount,
    holdUploadRetries,
    passPutDeadline,
    registerFaultMount,
    SETTLE_BOUND_MS,
    STALL_BOUND_MS,
    settlesWithin,
} from '../fault-storage-helpers';
import { createTestUser, getTestContext, TEST_DATA_DIR } from '../setup';

// An upload on its way is a user of its Home, so the upload queue holds the Home while a PUT is on the
// wire. An idle close then never meets a PUT and never waits for one. An eviction, such as for a
// restore, closes a held Home anyway, and it waits for the PUTs it meets, so none lands over what the
// Home reopens to. The hold never stretches the Home's life past its last request, so a bucket that
// keeps failing does not keep the Home open.

const USER_IDLE_MS = 5 * 60_000;
const BACKING = join(TEST_DATA_DIR, `upload-queue-home-hold-${Date.now()}`);

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'uq-home-hold-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

beforeAll(async () => {
    await getTestContext();
    mkdirSync(BACKING, { recursive: true });
});

afterEach(() => jest.useRealTimers());

// A fresh user's Home with an s3 fault mount in its Drive, so the Home's close closes the mount too.
async function homeWithS3Mount(name: string) {
    const user = await createTestUser(`${name}-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', name);
    const home = await getHome(user.id);
    const s3 = await addS3Mount(home, name);
    return { user, home, ...s3 };
}

async function addS3Mount(home: Home, id: string) {
    const { mount, fault } = createHomeFaultMount(home, id, BACKING);
    await mount.init();
    registerFaultMount(home.drive, mount);
    return { mount, fault };
}

// A plain folder holds the database, not a document container: a server backup in a later test file
// verifies every container's data.db as a Yjs document, and this schema is none.
async function provisionDatabase(mount: Mount): Promise<{ dataDbId: string }> {
    const root = await mount.getRootFolder();
    if (!root) throw new Error('mount has no root');
    const folderId = await mount.createFolder(root.id, `db-${crypto.randomUUID()}`);
    return { dataDbId: await mount.touchFile(folderId, 'items.db', 'application/x-sqlite3') };
}

describe('an upload on its way holds its Home', () => {
    test('a PUT keeps the Home open past its idle time, and the idle close after it waits for nothing', async () => {
        const { home, mount, fault } = await homeWithS3Mount('uq-hold-idle');
        const parked = await provisionDatabase(mount);
        const parkedDb = await mount.createDatabase(docConfig, parked.dataDbId);
        // A second document stays open and dirty, so the idle close has a final sync to stage.
        const open = await provisionDatabase(mount);
        const openDb = await mount.createDatabase(docConfig, open.dataDbId);
        await mount.uploadQueue?.drain({ flushNow: true });
        openDb.db.insert(docSchema.items).values({ id: 1, data: 'staged by the close' }).run();

        fault.parkWrites = true;
        parkedDb.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(parked.dataDbId);
        const put = await fault.waitForParked(() => true);

        jest.useFakeTimers();
        home.touch();
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(false);

        await put.land();
        await mount.uploadQueue?.drain();
        const writesBefore = fault.writeCount;
        const parkedKey = await mount.getStorageKey(parked.dataDbId);
        const openKey = await mount.getStorageKey(open.dataDbId);
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();

        // The final sync of the open document only stages: a PUT started now would park and keep the close waiting.
        expect(await settlesWithin([home.close()], SETTLE_BOUND_MS)).toBe(true);
        expect(fault.writeCount).toBe(writesBefore);
        expect(await countRowsInFile(fault.read(parkedKey), BACKING)).toBe(1);
        expect(await countRowsInFile(fault.read(openKey), BACKING)).toBe(0);

        // The next open's queue sends the row the close left.
        const reopened = await addS3Mount(await getHome(home.user.id), 'uq-hold-idle');
        await reopened.mount.uploadQueue?.drain({ flushNow: true });
        expect(await countBackingRows(reopened.mount, open.dataDbId, BACKING)).toBe(1);
    });

    test('an upload that retries on a failing bucket lets the Home close its idle time after the last request', async () => {
        const idleMs = 600;
        const previousIdle = process.env['TEAM_HOME_IDLE_MS'];
        process.env['TEAM_HOME_IDLE_MS'] = String(idleMs);
        const home = new TeamHome(getSyntheticTeamUser(teamOwnerId(crypto.randomUUID().replace(/-/g, ''))));
        if (previousIdle === undefined) delete process.env['TEAM_HOME_IDLE_MS'];
        else process.env['TEAM_HOME_IDLE_MS'] = previousIdle;
        try {
            await home.init();
            // A Home built here has had no request, so the release of the first PUT would close it at once.
            home.touch();
            const { mount, fault } = await addS3Mount(home, 'uq-hold-failing');
            const { dataDbId } = await provisionDatabase(mount);
            const managed = await mount.createDatabase(docConfig, dataDbId);
            await mount.uploadQueue?.drain({ flushNow: true });

            holdUploadRetries(10);
            fault.failNextWrites = 1_000_000;
            managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
            await mount.closeDatabase(dataDbId);
            home.touch();
            const requestedAt = Date.now();
            const writesAtRequest = fault.writeCount;

            for (let waited = 0; waited < 5 * idleMs && !home.closing; waited += 10) await Bun.sleep(10);
            expect(home.closing).toBe(true);
            // It closed once its idle time after the request was up, with the queue retrying all along.
            expect(Date.now() - requestedAt).toBeGreaterThanOrEqual(idleMs - 20);
            expect(fault.writeCount - writesAtRequest).toBeGreaterThan(5);
        } finally {
            holdUploadRetries();
            await home.close();
            rmSync(home.homeDir, { recursive: true, force: true });
        }
    });

    test('an eviction during a stalled PUT waits for it, so the late PUT cannot land over newer bytes', async () => {
        const { user, mount, fault } = await homeWithS3Mount('uq-hold-evict');
        const { dataDbId } = await provisionDatabase(mount);
        const managed = await mount.createDatabase(docConfig, dataDbId);
        await mount.uploadQueue?.drain({ flushNow: true });

        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        const oldPut = await fault.waitForParked(() => true);

        const evicting = evictHome(user.id);
        expect(await settlesWithin([evicting], STALL_BOUND_MS)).toBe(false);
        await oldPut.land();
        await evicting;

        // The Home reopens and writes {1,2}, which acks after the old PUT landed.
        const reopened = await addS3Mount(await getHome(user.id), 'uq-hold-evict');
        await reopened.mount.withDatabase(docConfig, dataDbId, async (db) => {
            db.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        });
        await reopened.mount.closeDatabase(dataDbId);
        await reopened.mount.uploadQueue?.drain({ flushNow: true });
        expect(await countBackingRows(reopened.mount, dataDbId, BACKING)).toBe(2);
    });

    test('the wait of an eviction for a stalled PUT is bounded', async () => {
        const { user, mount, fault } = await homeWithS3Mount('uq-hold-bounded');
        const { dataDbId } = await provisionDatabase(mount);
        const managed = await mount.createDatabase(docConfig, dataDbId);
        await mount.uploadQueue?.drain({ flushNow: true });

        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        await fault.waitForParked(() => true);

        // The close waits one PUT timeout at most.
        try {
            const { started: evicting } = await passPutDeadline(
                () => evictHome(user.id),
                () => jest.getTimerCount() > 0,
            );
            expect(await settlesWithin([evicting], SETTLE_BOUND_MS)).toBe(true);
        } finally {
            await fault.landAllRemaining();
        }
    });
});
