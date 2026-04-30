import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { createDefaultMountConfig, Mount } from '../lib/mount/mount';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-resolve-${Date.now()}`);
const OWNER_ID = 'test-owner-resolve';

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

describe('Mount.resolvePath', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config = createDefaultMountConfig('test-resolve', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('returns root for "/"', async () => {
        const root = await mount.resolvePath('/');
        expect(root).not.toBeNull();
        expect(root!.parentId).toBeNull();
        expect(root!.id).toBe(rootId);
    });

    test('returns root for empty string', async () => {
        const root = await mount.resolvePath('');
        expect(root!.id).toBe(rootId);
    });

    test('resolves nested folder', async () => {
        const aId = await mount.createFolder(rootId, 'A');
        const bId = await mount.createFolder(aId, 'B');
        const resolved = await mount.resolvePath('/A/B');
        expect(resolved!.id).toBe(bId);
    });

    test('returns null for missing path', async () => {
        const resolved = await mount.resolvePath('/does-not-exist');
        expect(resolved).toBeNull();
    });

    test('skips trashed entries', async () => {
        const trashedId = await mount.createFolder(rootId, 'Trashed');
        await mount.trashPath(trashedId);
        const resolved = await mount.resolvePath('/Trashed');
        expect(resolved).toBeNull();
    });

    test('NFC vs NFD names match', async () => {
        // Stored NFC ("é" composed = U+00E9); lookup NFD ("e" + U+0301 combining acute)
        const nfcName = 'café';
        const nfdName = 'café';
        await mount.createFolder(rootId, nfcName);
        const viaNfd = await mount.resolvePath(`/${nfdName}`);
        expect(viaNfd).not.toBeNull();
        expect(viaNfd!.name).toBe(nfcName);
    });

    test('rejects path traversal', async () => {
        await expect(mount.resolvePath('/../etc/passwd')).rejects.toThrow();
        await expect(mount.resolvePath('/./foo')).rejects.toThrow();
    });

    test('rejects control characters', async () => {
        await expect(mount.resolvePath('/foo\x00bar')).rejects.toThrow();
    });
});
