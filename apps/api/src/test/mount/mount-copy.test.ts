import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import { createTestMountConfig } from '../mount-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-mount-copy-${Date.now()}`);
const OWNER_ID = 'test-owner-copy';

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

describe('Mount.copyPath', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createTestMountConfig('test-copy', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('copies a file with a new name', async () => {
        const data = Buffer.from('hello copy');
        const fileId = await mount.createFile(rootId, 'orig.txt', 'text/plain', data.length, data);
        const copied = await mount.copyPath(fileId, rootId, 'orig-copy.txt');
        expect(copied.id).not.toBe(fileId);
        expect(copied.name).toBe('orig-copy.txt');
        expect(copied.size).toBe(data.length);
        expect(copied.hash).toBe((await mount.getPath(fileId))!.hash);
        const bytes = await (await mount.readFile(copied.id))!.text();
        expect(bytes).toBe('hello copy');
    });

    test('copies a folder with children', async () => {
        const folderId = await mount.createFolder(rootId, 'src-folder');
        const childId = await mount.createFile(folderId, 'a.txt', 'text/plain', 3, Buffer.from('abc'));
        const copied = await mount.copyPath(folderId, rootId, 'dst-folder');
        const children = await mount.listFolder(copied.id);
        expect(children).toHaveLength(1);
        expect(children[0]!.name).toBe('a.txt');
        expect(children[0]!.id).not.toBe(childId);
        const bytes = await (await mount.readFile(children[0]!.id))!.text();
        expect(bytes).toBe('abc');
    });

    test('isSelfOrDescendant detects self, descendants, and unrelated', async () => {
        const parent = await mount.createFolder(rootId, 'g-parent');
        const child = await mount.createFolder(parent, 'g-child');
        const grandchild = await mount.createFolder(child, 'g-grandchild');
        const sibling = await mount.createFolder(rootId, 'g-sibling');

        expect(await mount.isSelfOrDescendant(parent, parent)).toBe(true);
        expect(await mount.isSelfOrDescendant(parent, child)).toBe(true);
        expect(await mount.isSelfOrDescendant(parent, grandchild)).toBe(true);
        expect(await mount.isSelfOrDescendant(parent, sibling)).toBe(false);
        expect(await mount.isSelfOrDescendant(child, parent)).toBe(false);
    });

    test('copying a doc container skips the versions/ folder', async () => {
        // Build a container-shaped dir: type 'doc' with data.db + versions/
        const docId = await mount.createFolder(rootId, 'My Doc.eigendoc', 'doc');
        await mount.createFile(docId, 'data.db', 'application/octet-stream', 4, Buffer.from('YJS!'));
        const versionsId = await mount.createFolder(docId, VERSIONS_FOLDER_NAME);
        await mount.createFile(versionsId, '2020.db', 'application/octet-stream', 3, Buffer.from('old'));

        const copied = await mount.copyPath(docId, rootId, 'My Doc copy.eigendoc');
        expect(copied.type).toBe('doc');
        const children = await mount.listFolder(copied.id);
        const names = children.map((c) => c.name).sort();
        expect(names).toEqual(['data.db']);
    });
});
