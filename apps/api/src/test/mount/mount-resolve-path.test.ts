import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { createTestMountConfig } from '../mount-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-resolve-${Date.now()}`);
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
        const config = createTestMountConfig('test-resolve', 'local-key');
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

    test('resolves an NFD-stored name by its NFC query form', async () => {
        // The actual bug (reverse of the test above): a name written DECOMPOSED (NFD, as macOS
        // emits) is normalized to NFC on write, so an NFC lookup finds it. A different word from
        // café — both café forms normalize alike and would collide with the folder created above.
        const nfdName = 're\u0301sume\u0301'; // "resume" decomposed: e + U+0301
        const nfcName = 'r\u00e9sum\u00e9'; // "resume" composed: U+00E9
        await mount.createFolder(rootId, nfdName);
        const viaNfc = await mount.resolvePath(`/${nfcName}`);
        expect(viaNfc).not.toBeNull();
        expect(viaNfc!.name).toBe(nfcName); // stored NFC, not the raw NFD input
    });

    test('rejects path traversal', async () => {
        await expect(mount.resolvePath('/../etc/passwd')).rejects.toThrow();
        await expect(mount.resolvePath('/./foo')).rejects.toThrow();
    });

    test('rejects control characters', async () => {
        await expect(mount.resolvePath('/foo\x00bar')).rejects.toThrow();
    });
});
