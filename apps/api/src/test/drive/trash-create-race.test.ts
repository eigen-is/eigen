import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_DOC } from '@workspace/lib/types/drive';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import { trashStorageKey } from '../../lib/mount/names';
import { createTestUserOnStorage } from '../setup';

// Everything under a trashed folder is trashed. A create, copy or move that targets a folder on its
// way to the trash, or one that went there while the create waited, is refused, so nothing lands as
// a live row inside a trashed folder.
describe('a create into a folder that goes to the trash', () => {
    for (const storage of ['local-fullnames', 'local-id'] as const) {
        test(`an upload that streams while its folder is trashed is refused (${storage})`, async () => {
            const user = await createTestUserOnStorage(storage, `Create race ${storage}`);
            const home = await getHome(user.id);
            const [mount] = home.drive.getMounts();
            const root = await home.drive.getRootFolder(mount.id);
            if (!root) throw new Error('no root');
            const folder = await home.drive.createFolder(mount.id, root.id, 'race-folder');

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const body = new ReadableStream<Uint8Array>({
                async start(controller) {
                    controller.enqueue(new TextEncoder().encode('hello '));
                    await gate;
                    controller.enqueue(new TextEncoder().encode('world'));
                    controller.close();
                },
            });
            const upload = home.drive
                .createFileFromData(mount.id, folder.id, 'late.txt', 'text/plain', body)
                .catch((e: unknown) => e);
            await Bun.sleep(20);
            await home.drive.deletePath(mount.id, folder.id);
            release();
            const result = await upload;

            expect(result instanceof ApiError && result.status).toBe(404);
            expect(await mount.getChildByName(folder.id, 'late.txt')).toBeNull();
            expect((await home.drive.getMimeTypeContents('text/plain')).some((p) => p.name === 'late.txt')).toBe(false);
            if (mount.isPathBased) {
                const trashed = path.join(mount.dataDir, trashStorageKey(folder.id, folder.name), 'late.txt');
                expect(fs.existsSync(trashed)).toBe(false);
            }
        });
    }

    test('a move or a create into a folder that is being trashed is a 404', async () => {
        const user = await createTestUserOnStorage('local-fullnames', 'Move race');
        const home = await getHome(user.id);
        const [mount] = home.drive.getMounts();
        const root = await home.drive.getRootFolder(mount.id);
        if (!root) throw new Error('no root');
        const folder = await home.drive.createFolder(mount.id, root.id, 'trashing');
        const doc: DrivePath = await home.drive.create(mount.id, root.id, 'outside', DRIVE_TYPE_DOC);

        const trashPath = mount.trashPath.bind(mount);
        const attempts: unknown[] = [];
        const spy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
            attempts.push(await home.drive.movePath(mount.id, doc.id, folder.id).catch((e: unknown) => e));
            attempts.push(
                await home.drive.create(mount.id, folder.id, 'inside', DRIVE_TYPE_DOC).catch((e: unknown) => e),
            );
            attempts.push(await home.drive.copyPath(mount.id, doc.id, folder.id, 'copy').catch((e: unknown) => e));
            return trashPath(pathId);
        });
        try {
            await home.drive.deletePath(mount.id, folder.id);
        } finally {
            spy.mockRestore();
        }

        expect(attempts.map((a) => a instanceof ApiError && a.status)).toEqual([404, 404, 404]);
        expect((await mount.getPath(doc.id))?.parentId).toBe(root.id);
    });
});
