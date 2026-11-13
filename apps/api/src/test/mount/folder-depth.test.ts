import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Mount } from '../../lib/mount/mount';
import { createGetLocalDatabase } from '../fault-storage-helpers';
import { createTestMountConfig, seedFile, TEST_ACTOR } from '../mount-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-folder-depth-${Date.now()}`);
const TOO_DEEP = { status: 400, message: 'Folders can be nested at most 256 levels deep' };

beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('Folders nest at most 256 levels deep', () => {
    let mount: Mount;
    let rootId: string;
    // levels[d] is a folder at depth d, the root at 0.
    const levels: string[] = [];

    beforeAll(async () => {
        mount = new Mount(
            'test-owner-depth',
            TEST_DIR,
            createTestMountConfig('test-depth', 'local-key'),
            createGetLocalDatabase(TEST_DIR),
        );
        await mount.init();
        rootId = (await mount.getRootFolder())!.id;
        levels.push(rootId);
        for (let depth = 1; depth <= 255; depth++) {
            levels.push(await mount.createFolder(levels[depth - 1]!, `L${depth}`));
        }
    });

    // A folder A with B inside and C inside B: moved or copied, it adds three levels.
    async function threeDeep(name: string): Promise<string> {
        const a = await mount.createFolder(rootId, name);
        const b = await mount.createFolder(a, 'B');
        await mount.createFolder(b, 'C');
        return a;
    }

    test('a folder at depth 256 is created, and a folder or file at 257 is refused', async () => {
        const deepest = await mount.createFolder(levels[255]!, 'L256');
        await expect(mount.createFolder(deepest, 'L257')).rejects.toMatchObject(TOO_DEEP);
        await expect(seedFile(mount, deepest, 'f.txt', 'text/plain', 1, Buffer.from('x'))).rejects.toMatchObject(
            TOO_DEEP,
        );
        expect(await mount.listFolder(deepest)).toHaveLength(0);
    });

    test('a move whose subtree would end past 256 levels is refused, and one ending at 256 lands', async () => {
        const a = await threeDeep('MoveMe');
        await expect(mount.updatePath(a, { parentId: levels[254]! })).rejects.toMatchObject(TOO_DEEP);
        expect((await mount.getPath(a))!.parentId).toBe(rootId);

        await mount.updatePath(a, { parentId: levels[253]! });
        expect((await mount.getPath(a))!.parentId).toBe(levels[253]!);
    });

    test('a copy whose subtree would end past 256 levels is refused and leaves nothing behind', async () => {
        const a = await threeDeep('CopyMe');
        const discard = (pathId: string): Promise<void> => mount.deletePath(pathId);
        const before = await mount.listFolder(levels[254]!);
        await expect(
            mount.copyPath(mount, await mount.listCopy(a), levels[254]!, 'CopyMe', discard, TEST_ACTOR),
        ).rejects.toMatchObject(TOO_DEEP);
        expect(await mount.listFolder(levels[254]!)).toEqual(before);
    });
});
