import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DRIVE_TYPE_FOLDER, type DrivePath, isContainerType } from '@workspace/lib/types';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { createTestMountConfig } from '../mount-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-iic-${Date.now()}`);
const OWNER_ID = 'test-owner-iic';

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const fullPath = join(baseDir, relativePath);
        const db = new ManagedDatabase(config, fullPath);
        await db.open(0);
        return db;
    };
}

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

// Drive.isInsideContainer is a thin wrapper around Mount.getBreadcrumb + the same
// "non-folder container ancestor" predicate. Exercise that combination directly so the
// test stays unit-scoped (full Drive needs a Home + UserHome).
describe('Mount.getBreadcrumb (powers Drive.isInsideContainer)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createTestMountConfig('test-iic', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
    });

    function hasNonFolderContainerAncestor(ancestors: DrivePath[], leafId: string): boolean {
        return ancestors
            .slice(0, -1)
            .some((p) => p.id !== leafId && isContainerType(p.type) && p.type !== DRIVE_TYPE_FOLDER);
    }

    test('container ancestor: child of an .eigendoc-style folder is marked inside', async () => {
        const docId = await mount.createFolder(rootId, 'My.eigendoc', 'doc');
        const childId = await mount.createFile(docId, 'data.db', 'application/octet-stream', 0, Buffer.alloc(0));
        const ancestors = await mount.getBreadcrumb(childId);
        expect(hasNonFolderContainerAncestor(ancestors, childId)).toBe(true);
    });

    test('regular folder is NOT a container', async () => {
        const folderId = await mount.createFolder(rootId, 'plain-folder');
        const childId = await mount.createFile(folderId, 'note.txt', 'text/plain', 4, Buffer.from('test'));
        const ancestors = await mount.getBreadcrumb(childId);
        expect(hasNonFolderContainerAncestor(ancestors, childId)).toBe(false);
    });
});
