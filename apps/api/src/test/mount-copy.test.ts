import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { createDefaultMountConfig, Mount } from '../lib/mount/mount';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-mount-copy-${Date.now()}`);
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
        const config = createDefaultMountConfig('test-copy', 'local-key');
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
});
