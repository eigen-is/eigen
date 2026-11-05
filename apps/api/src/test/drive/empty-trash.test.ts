import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount';
import { createTestUserOnStorage } from '../setup';

// Emptying the trash deletes item after item, and an item can be gone or restored by the time its
// turn comes. That item is skipped, and the rest still goes.
describe('emptyTrash', () => {
    let home: Home;
    let mount: Mount;
    let rootId: string;

    beforeEach(async () => {
        const user = await createTestUserOnStorage('local-id', 'Empty Trash');
        home = await getHome(user.id);
        [mount] = home.drive.getMounts();
        rootId = (await home.drive.getRootFolder(mount.id))!.id;
    });

    const createFile = async (parentId: string, name: string) =>
        (await home.drive.createFileFromData(mount.id, parentId, name, 'text/plain', Buffer.from(name))).id;

    test('a child the folder delete took with it is skipped', async () => {
        const folder = await home.drive.createFolder(mount.id, rootId, 'Folder');
        const child = await createFile(folder.id, 'child.txt');
        const other = await createFile(rootId, 'other.txt');
        await home.drive.deletePath(mount.id, other);
        await home.drive.deletePath(mount.id, child);
        await home.drive.deletePath(mount.id, folder.id);
        // The trash lists the newest first, so the folder comes before its child and the other file.
        const earlier = new Date(Date.now() - 60 * 1000);
        await mount.updatePath(child, { trashedAt: earlier });
        await mount.updatePath(other, { trashedAt: earlier });

        // The child is gone by its turn, which is no failure, so nothing is logged.
        const errors = spyOn(console, 'error');
        try {
            await home.drive.emptyTrash(mount.id);
            expect(errors).not.toHaveBeenCalled();
        } finally {
            errors.mockRestore();
        }

        expect(await mount.listTrash()).toEqual([]);
        expect(await mount.getPath(other)).toBeNull();
    });

    // The query asks the tree for the folders under it, so its size can't reach SQLite's variable cap.
    test('a folder delete takes an item trashed on its own from a folder deep inside it', async () => {
        const folder = await home.drive.createFolder(mount.id, rootId, 'Outer');
        const middle = await home.drive.createFolder(mount.id, folder.id, 'Middle');
        const inner = await home.drive.createFolder(mount.id, middle.id, 'Inner');
        const loner = await createFile(inner.id, 'loner.txt');
        const outside = await createFile(rootId, 'outside.txt');
        await home.drive.deletePath(mount.id, loner);
        await home.drive.deletePath(mount.id, outside);
        await home.drive.deletePath(mount.id, folder.id);

        expect(await mount.permanentlyDeleteFromTrash(folder.id)).toBe(true);

        expect(await mount.getPath(inner.id)).toBeNull();
        expect(await mount.getPath(loner)).toBeNull();
        expect((await mount.getPath(outside))?.trashedAt).toBeInstanceOf(Date);
    });

    // Nested trash roots take each other's locks in nesting order only, so deletes that meet on them all end.
    test('two deletes of nested trash roots beside emptyTrash and the purge at open all end, leaving nothing', async () => {
        const user = await createTestUserOnStorage('local-fullnames', 'Nested Trash');
        const drive = (await getHome(user.id)).drive;
        const [local] = drive.getMounts();
        const root = (await drive.getRootFolder(local.id))!.id;
        const outer = (await drive.createFolder(local.id, root, 'Outer')).id;
        const mid = (await drive.createFolder(local.id, outer, 'Mid')).id;
        const sub = (await drive.createFolder(local.id, mid, 'Sub')).id;
        const inSub = (await drive.createFileFromData(local.id, sub, 'in-sub.txt', 'text/plain', Buffer.from('s'))).id;
        const inOuter = (
            await drive.createFileFromData(local.id, outer, 'in-outer.txt', 'text/plain', Buffer.from('o'))
        ).id;
        const earlier = new Date(Date.now() - 60 * 1000);
        for (const id of [inSub, mid, inOuter, outer]) {
            await drive.deletePath(local.id, id);
            await local.updatePath(id, { trashedAt: earlier });
        }

        const all = Promise.all([
            local.permanentlyDeleteFromTrash(outer),
            local.permanentlyDeleteFromTrash(mid),
            drive.emptyTrash(local.id),
            local.purgeTrash(0),
        ]);
        expect(await Promise.race([all.then(() => 'ended'), Bun.sleep(5000).then(() => 'timed out')])).toBe('ended');

        expect(await local.listTrash()).toEqual([]);
        for (const id of [outer, mid, sub, inSub, inOuter]) expect(await local.getPath(id)).toBeNull();
        expect(readdirSync(join(local.dataDir, '.trash'))).toEqual([]);
        expect(existsSync(join(local.dataDir, 'Outer'))).toBe(false);
    });

    test('an item restored before its turn is kept', async () => {
        const restored = await createFile(rootId, 'restored.txt');
        const deleted = await createFile(rootId, 'deleted.txt');
        await home.drive.deletePath(mount.id, deleted);
        await home.drive.deletePath(mount.id, restored);

        const permanentlyDelete = mount.permanentlyDeleteFromTrash.bind(mount);
        const spy = spyOn(mount, 'permanentlyDeleteFromTrash').mockImplementation(async (pathId) => {
            if (pathId === restored) await mount.restorePath(pathId);
            return permanentlyDelete(pathId);
        });
        try {
            await home.drive.emptyTrash(mount.id);
        } finally {
            spy.mockRestore();
        }

        expect((await mount.getPath(restored))?.trashedAt).toBeNull();
        expect(await mount.getPath(deleted)).toBeNull();
    });

    // An item a folder delete took has no members to read, and that is expected. Any other failed read
    // costs only the event, so the delete still goes, but it is logged.
    test('a failed members read other than a gone item is logged, and the delete still goes', async () => {
        const file = await createFile(rootId, 'logged.txt');
        await home.drive.deletePath(mount.id, file);
        const members = spyOn(home.drive, 'getEffectiveMembers').mockRejectedValue(new Error('auth db unavailable'));
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await home.drive.permanentlyDelete(mount.id, file);
            expect(errors.mock.calls.flat().some((arg) => String(arg).includes('auth db unavailable'))).toBe(true);
        } finally {
            members.mockRestore();
            errors.mockRestore();
        }

        expect(await mount.getPath(file)).toBeNull();
    });
});
