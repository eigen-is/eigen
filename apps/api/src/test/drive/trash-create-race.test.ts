import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DRIVE_TYPE_DOC } from '@workspace/lib/types/drive';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import { trashStorageKey } from '../../lib/mount/names';
import { createTestUserOnStorage } from '../setup';

// Everything under a trashed folder is trashed. A create, upload, copy or move that checked its folder
// before the trash marked it writes its row after, and that write refuses the folder, so nothing lands
// as a live row inside a trashed folder, and on `local` no bytes land in .trash/.
describe('a write into a folder that goes to the trash', () => {
    for (const storage of ['local-fullnames', 'local-id'] as const) {
        const setUp = async (name: string) => {
            const user = await createTestUserOnStorage(storage, `${name} ${storage}`);
            const home = await getHome(user.id);
            const [mount] = home.drive.getMounts();
            const root = await home.drive.getRootFolder(mount.id);
            if (!root) throw new Error('no root');
            const folder = await home.drive.createFolder(mount.id, root.id, 'race-folder', home.user);
            return { home, mount, root, folder };
        };

        test(`an upload that streams while its folder is trashed is refused (${storage})`, async () => {
            const { home, mount, folder } = await setUp('Upload race');
            const gate = Promise.withResolvers<void>();
            const body = new ReadableStream<Uint8Array>({
                async start(controller) {
                    controller.enqueue(new TextEncoder().encode('hello '));
                    await gate.promise;
                    controller.enqueue(new TextEncoder().encode('world'));
                    controller.close();
                },
            });
            const upload = home.drive
                .createFileFromData(mount.id, folder.id, 'late.txt', 'text/plain', body, home.user)
                .catch((e: unknown) => e);
            await Bun.sleep(20);
            await home.drive.deletePath(mount.id, folder.id, home.user);
            gate.resolve();
            const result = await upload;

            expect(result instanceof ApiError && result.status).toBe(404);
            expect(await mount.getChildByName(folder.id, 'late.txt')).toBeNull();
            expect((await home.drive.getMimeTypeContents('text/plain')).some((p) => p.name === 'late.txt')).toBe(false);
            if (mount.isPathBased) {
                const trashed = path.join(mount.dataDir, trashStorageKey(folder.id, folder.name), 'late.txt');
                expect(fs.existsSync(trashed)).toBe(false);
            }
        });

        test(`a create, a copy or a move that checked its folder before the trash is a 404 (${storage})`, async () => {
            const { home, mount, root, folder } = await setUp('Write race');
            const doc = await home.drive.create(mount.id, root.id, 'outside', DRIVE_TYPE_DOC, home.user);
            // Each write waits past its folder check until the trash is in.
            const trashed = Promise.withResolvers<void>();
            const reached = [
                Promise.withResolvers<void>(),
                Promise.withResolvers<void>(),
                Promise.withResolvers<void>(),
            ];
            const createFolder = mount.createFolder.bind(mount);
            const copyPath = mount.copyPath.bind(mount);
            const updatePath = mount.updatePath.bind(mount);
            const spies = [
                spyOn(mount, 'createFolder').mockImplementationOnce(async (...args) => {
                    reached[0].resolve();
                    await trashed.promise;
                    return createFolder(...args);
                }),
                spyOn(mount, 'copyPath').mockImplementationOnce(async (...args) => {
                    reached[1].resolve();
                    await trashed.promise;
                    return copyPath(...args);
                }),
                spyOn(mount, 'updatePath').mockImplementationOnce(async (...args) => {
                    reached[2].resolve();
                    await trashed.promise;
                    return updatePath(...args);
                }),
            ];
            const attempts = Promise.all([
                home.drive.create(mount.id, folder.id, 'inside', DRIVE_TYPE_DOC, home.user).catch((e: unknown) => e),
                home.drive
                    .copyPath(
                        mount.id,
                        doc.id,
                        { drive: home.drive, mountId: mount.id, parentId: folder.id },
                        'copy',
                        home.user,
                    )
                    .catch((e: unknown) => e),
                home.drive.movePath(mount.id, doc.id, folder.id, home.user).catch((e: unknown) => e),
            ]);
            try {
                await Promise.all(reached.map((r) => r.promise));
                await home.drive.deletePath(mount.id, folder.id, home.user);
                trashed.resolve();
                expect((await attempts).map((a) => a instanceof ApiError && a.status)).toEqual([404, 404, 404]);
            } finally {
                for (const spy of spies) spy.mockRestore();
            }
            expect((await mount.getPath(doc.id))?.parentId).toBe(root.id);
            expect(await mount.listFolderAll(folder.id)).toEqual([]);
        });
    }
});
