import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
