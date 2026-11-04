import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Mount } from '../../lib/mount/mount';
import { getVersionReferences, putVersionReferences } from '../../lib/mount/version-references';
import { createGetLocalDatabase } from '../fault-storage-helpers';
import { createTestMountConfig } from '../mount-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-version-references-${Date.now()}`);

let mount: Mount;
let rootId: string;

beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mount = new Mount(
        'test-owner-id',
        TEST_DIR,
        createTestMountConfig('version-references'),
        createGetLocalDatabase(TEST_DIR),
    );
    await mount.init();
    const root = await mount.getRootFolder();
    if (!root) throw new Error('no root folder');
    rootId = root.id;
});

afterAll(async () => {
    await mount.closeAllDatabases();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

const version = (name: string) => mount.createFile(rootId, name, 'application/x-sqlite3', 0, undefined);

describe('version_references', () => {
    test("a version's names come back as stored, and a second write replaces them", async () => {
        const id = await version('2026-11-01T10-00-00-000Z.db');
        putVersionReferences(mount, [{ versionPathId: id, readerVersion: 1, names: { media: ['a.png'], chat: [] } }]);
        putVersionReferences(mount, [{ versionPathId: id, readerVersion: 2, names: { media: [], chat: ['t1'] } }]);
        expect(getVersionReferences(mount, [id])).toEqual([
            { versionPathId: id, readerVersion: 2, names: { media: [], chat: ['t1'] } },
        ]);
    });

    test('a version with no row reads as none', async () => {
        const id = await version('2026-11-01T11-00-00-000Z.db');
        expect(getVersionReferences(mount, [id])).toEqual([]);
    });

    test('deleting the version file deletes its row', async () => {
        const id = await version('2026-11-01T12-00-00-000Z.db');
        putVersionReferences(mount, [{ versionPathId: id, readerVersion: 1, names: { media: ['b.png'], chat: [] } }]);
        await mount.deletePath(id);
        expect(getVersionReferences(mount, [id])).toEqual([]);
    });
});
