import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Mount } from '../../lib/mount/mount';
import { MARKER_DB_CONFIG, MARKER_SCHEMA, readMarkers } from '../backup/backup-test-helpers';
import { createFaultMount, provisionDoc } from '../fault-storage-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-versioning-snapshot-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

// Closed after each test so no mount's upload-queue retry timer outlives it.
const mounts: Mount[] = [];

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(async () => {
    for (const mount of mounts) await mount.closeAllDatabases();
    mounts.length = 0;
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('replaceContainerDataDb on an s3 mount', () => {
    test('keeps the row, and its bytes win over an earlier upload that lands after them', async () => {
        const { mount, fault } = createFaultMount(OWNER_ID, TEST_DIR, 'replace-s3');
        mounts.push(mount);
        await mount.init();
        const { containerId, dataDbId } = await provisionDoc(mount);
        const managed = await mount.createDatabase(MARKER_DB_CONFIG, dataDbId);
        managed.db.insert(MARKER_SCHEMA.items).values({ id: 1, data: 'live' }).run();
        const sourcePath = join(TEST_DIR, 'restored.db');
        const source = new Database(sourcePath, { create: true });
        source.run('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)');
        source.run("INSERT INTO items (id, data) VALUES (1, 'restored')");
        source.close();

        // An upload of 'live' is still on the wire when the restore writes, and lands after it.
        await mount.drainPendingUploads({ flushNow: true });
        fault.parkWrites = true;
        await managed.flush();
        const storageKey = await mount.getStorageKey(dataDbId);
        await fault.waitForParked((parked) => parked.key === storageKey);
        fault.parkWrites = false;
        await mount.replaceContainerDataDb(containerId, sourcePath);
        await fault.landAllRemaining();
        await mount.drainPendingUploads({ flushNow: true });

        expect((await mount.getChildByName(containerId, 'data.db'))?.id).toBe(dataDbId);
        const stored = join(TEST_DIR, 'stored.db');
        await Bun.write(stored, mount.storage.read(storageKey));
        expect(readMarkers(stored)).toEqual(['restored']);
    });
});
