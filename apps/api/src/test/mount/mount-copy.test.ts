import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseConfig, SchemaType } from '../../lib/core';
import { ManagedDatabase } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import { createTestMountConfig, seedFile, TEST_ACTOR } from '../mount-test-helpers';

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
    // Drive passes the cleanup that trashes what others put in a failed copy. These copies hold only their own paths.
    const discard = (pathId: string): Promise<void> => mount.deletePath(pathId);

    beforeAll(async () => {
        const config = createTestMountConfig('test-copy', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const root = await mount.getRootFolder();
        rootId = root!.id;
    });

    test('copies a file with a new name', async () => {
        const data = Buffer.from('hello copy');
        const fileId = await seedFile(mount, rootId, 'orig.txt', 'text/plain', data.length, data);
        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(fileId),
            rootId,
            'orig-copy.txt',
            discard,
            TEST_ACTOR,
        );
        expect(copied.id).not.toBe(fileId);
        expect(copied.name).toBe('orig-copy.txt');
        expect(copied.size).toBe(data.length);
        expect(copied.hash).toBe((await mount.getPath(fileId))!.hash);
        const bytes = await (await mount.readFile(copied.id))!.text();
        expect(bytes).toBe('hello copy');
    });

    test('copies a folder with children', async () => {
        const folderId = await mount.createFolder(rootId, 'src-folder');
        const childId = await seedFile(mount, folderId, 'a.txt', 'text/plain', 3, Buffer.from('abc'));
        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(folderId),
            rootId,
            'dst-folder',
            discard,
            TEST_ACTOR,
        );
        const children = await mount.listFolder(copied.id);
        expect(children).toHaveLength(1);
        expect(children[0]!.name).toBe('a.txt');
        expect(children[0]!.id).not.toBe(childId);
        const bytes = await (await mount.readFile(children[0]!.id))!.text();
        expect(bytes).toBe('abc');
    });

    test('copies the source thumbnail and its dimensions', async () => {
        const data = Buffer.from('png-bytes');
        const fileId = await seedFile(mount, rootId, 'photo.png', 'image/png', data.length, data);
        await Bun.write(join(mount.thumbsDir, `${fileId}.webp`), 'thumb-bytes');
        await mount.updatePath(fileId, { thumbnail: `${fileId}.webp`, details: { width: 12, height: 8 } });

        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(fileId),
            rootId,
            'photo-copy.png',
            discard,
            TEST_ACTOR,
        );
        expect(copied.thumbnail).toBe(`${copied.id}.webp`);
        expect(await Bun.file(join(mount.thumbsDir, `${copied.id}.webp`)).text()).toBe('thumb-bytes');
        expect(copied.details?.width).toBe(12);
        expect(copied.details?.height).toBe(8);
    });

    // A copy into another mount reads through the source mount and writes into this one. The history row names the
    // source's owner and mount, not the target's.
    test('copies a thumbnailed file from another mount, and names that mount as its source', async () => {
        const otherDir = `${TEST_DIR}-other`;
        mkdirSync(otherDir, { recursive: true });
        const source = new Mount(
            'test-owner-copy-source',
            otherDir,
            createTestMountConfig('test-copy-source', 'local-key'),
            createGetLocalDatabase(otherDir),
        );
        await source.init();
        try {
            const sourceRoot = await source.getRootFolder();
            const data = Buffer.from('png-bytes');
            const fileId = await seedFile(source, sourceRoot!.id, 'far.png', 'image/png', data.length, data);
            await Bun.write(join(source.thumbsDir, `${fileId}.webp`), 'far-thumb');
            await source.updatePath(fileId, { thumbnail: `${fileId}.webp`, details: { width: 7, height: 9 } });

            const { path: copied } = await mount.copyPath(
                source,
                await source.listCopy(fileId),
                rootId,
                'far-copy.png',
                discard,
                TEST_ACTOR,
            );
            expect(await (await mount.readFile(copied.id))!.text()).toBe('png-bytes');
            expect(copied.thumbnail).toBe(`${copied.id}.webp`);
            expect(await Bun.file(join(mount.thumbsDir, `${copied.id}.webp`)).text()).toBe('far-thumb');
            expect(copied.details).toEqual({ width: 7, height: 9 });
            expect(mount.history.list(copied.id).map((event) => [event.eventType, event.details])).toEqual([
                [
                    'copied',
                    {
                        sourceOwnerId: 'test-owner-copy-source',
                        sourceMountId: 'test-copy-source',
                        sourcePathId: fileId,
                    },
                ],
            ]);
        } finally {
            await source.closeAllDatabases();
            rmSync(otherDir, { recursive: true, force: true });
        }
    });

    test('copies a file whose thumbnail file is gone, details and all', async () => {
        const data = Buffer.from('png-bytes');
        const fileId = await seedFile(mount, rootId, 'stale.png', 'image/png', data.length, data);
        await mount.updatePath(fileId, { thumbnail: `${fileId}.webp`, details: { width: 4, height: 2 } });

        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(fileId),
            rootId,
            'stale-copy.png',
            discard,
            TEST_ACTOR,
        );
        expect(copied.thumbnail).toBeNull();
        expect(existsSync(join(mount.thumbsDir, `${copied.id}.webp`))).toBe(false);
        expect(copied.details?.width).toBe(4);
        expect(copied.details?.height).toBe(2);
    });

    test('copies the details of a file that never had a thumbnail', async () => {
        const data = Buffer.from('mp3-bytes');
        const fileId = await seedFile(mount, rootId, 'song.mp3', 'audio/mpeg', data.length, data);
        await mount.updatePath(fileId, { details: { duration: 42 } });

        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(fileId),
            rootId,
            'song-copy.mp3',
            discard,
            TEST_ACTOR,
        );
        expect(copied.details?.duration).toBe(42);
    });

    test('leaves the details that belong to the source row behind', async () => {
        const data = Buffer.from('png-bytes');
        const fileId = await seedFile(mount, rootId, 'upload.png', 'image/png', data.length, data);
        await mount.updatePath(fileId, { details: { originalName: 'holiday.png', width: 3 } });

        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(fileId),
            rootId,
            'upload-copy.png',
            discard,
            TEST_ACTOR,
        );
        expect(copied.details?.width).toBe(3);
        expect(copied.details?.originalName).toBeUndefined();
    });

    // The listing can be a while ago. The copy reads the source row again, so a thumbnail made since comes along.
    test('copies the thumbnail and details the source got after the listing', async () => {
        const data = Buffer.from('png-bytes');
        const fileId = await seedFile(mount, rootId, 'late.png', 'image/png', data.length, data);
        const tree = await mount.listCopy(fileId);
        await Bun.write(join(mount.thumbsDir, `${fileId}.webp`), 'late-thumb');
        await mount.updatePath(fileId, { thumbnail: `${fileId}.webp`, details: { width: 5, height: 6 } });

        const { path: copied } = await mount.copyPath(mount, tree, rootId, 'late-copy.png', discard, TEST_ACTOR);
        expect(copied.thumbnail).toBe(`${copied.id}.webp`);
        expect(await Bun.file(join(mount.thumbsDir, `${copied.id}.webp`)).text()).toBe('late-thumb');
        expect(copied.details?.width).toBe(5);
        expect(copied.details?.height).toBe(6);
    });

    test('stops at a source trashed after the listing', async () => {
        const data = Buffer.from('gone-soon');
        const fileId = await seedFile(mount, rootId, 'trashed.txt', 'text/plain', data.length, data);
        const tree = await mount.listCopy(fileId);
        await mount.trashPath(fileId);

        await expect(
            mount.copyPath(mount, tree, rootId, 'trashed-copy.txt', discard, TEST_ACTOR),
        ).rejects.toMatchObject({
            status: 404,
        });
        expect(await mount.getChildByName(rootId, 'trashed-copy.txt')).toBeNull();
    });

    test('copies a folder with a thumbnailed child', async () => {
        const folderId = await mount.createFolder(rootId, 'album');
        const data = Buffer.from('png-bytes');
        const childId = await seedFile(mount, folderId, 'inside.png', 'image/png', data.length, data);
        await Bun.write(join(mount.thumbsDir, `${childId}.webp`), 'child-thumb');
        await mount.updatePath(childId, { thumbnail: `${childId}.webp` });

        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(folderId),
            rootId,
            'album-copy',
            discard,
            TEST_ACTOR,
        );
        const child = (await mount.listFolder(copied.id))[0]!;
        expect(child.thumbnail).toBe(`${child.id}.webp`);
        expect(await Bun.file(join(mount.thumbsDir, `${child.id}.webp`)).text()).toBe('child-thumb');
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
        await seedFile(mount, docId, 'data.db', 'application/octet-stream', 4, Buffer.from('YJS!'));
        const versionsId = await mount.createFolder(docId, VERSIONS_FOLDER_NAME);
        await seedFile(mount, versionsId, '2020.db', 'application/octet-stream', 3, Buffer.from('old'));

        const { path: copied } = await mount.copyPath(
            mount,
            await mount.listCopy(docId),
            rootId,
            'My Doc copy.eigendoc',
            discard,
            TEST_ACTOR,
        );
        expect(copied.type).toBe('doc');
        const children = await mount.listFolder(copied.id);
        const names = children.map((c) => c.name).sort();
        expect(names).toEqual(['data.db']);
    });
});
