import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import type { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import { FakeS3Server } from '../fake-s3-server';
import {
    createGetLocalDatabase,
    createS3MountConfig,
    FaultMount,
    provisionDoc,
    settleContainer,
} from '../fault-storage-helpers';

// A version snapshot on an s3 mount whose only source is the stored object, and that object's GET fails.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-version-snapshot-failure-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = { items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }) };
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'version-snapshot-failure-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

let fake: FakeS3Server;
let mount: Mount;

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
beforeEach(async () => {
    const id = `vsf-${Math.random().toString(36).slice(2)}`;
    fake = new FakeS3Server(new LocalStorage(join(TEST_DIR, `bucket-${id}`)));
    const s3Config = await fake.start();
    mount = new FaultMount(
        OWNER_ID,
        TEST_DIR,
        { ...createS3MountConfig(id), s3Config },
        createGetLocalDatabase(TEST_DIR),
    );
    await mount.init();
});
afterEach(async () => {
    fake.heal();
    await mount.closeAllDatabases();
    await fake.stop();
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('A version snapshot whose read fails', () => {
    test.each(['fail-get', 'cut'] as const)('a %s GET leaves no version row and no staged copy', async (fault) => {
        const { containerId, dataDbId } = await provisionDoc(mount);
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db
            .insert(docSchema.items)
            .values({ id: 1, data: 'x'.repeat(4096) })
            .run();
        // Closed and acked: nothing live, nothing staged, so the copy has to GET the stored object.
        await settleContainer(mount, containerId);
        const staged = new Set(readdirSync(mount.stagingDir));
        fake.faults.set(await mount.getStorageKey(dataDbId), fault);

        await expect(mount.snapshotContainerDataDb(containerId, DEFAULT_RETENTION)).rejects.toMatchObject({
            status: 503,
        });

        const versions = await mount.getChildByName(containerId, VERSIONS_FOLDER_NAME);
        expect(versions ? await mount.listFolder(versions.id) : []).toEqual([]);
        expect(readdirSync(mount.stagingDir).filter((entry) => !staged.has(entry))).toEqual([]);
    });
});
