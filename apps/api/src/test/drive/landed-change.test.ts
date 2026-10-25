import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount';
import * as publicInfo from '../../lib/space/public';
import type { User } from '../../lib/user';
import { getUserById } from '../../lib/user';
import { getTestContext } from '../setup';

// A change that has landed in the tree stays a success when the work after it fails, such as
// telling the watchers. The caller sees the change, and no temp file stays behind.
describe('a change that has landed', () => {
    let home: Home;
    let mount: Mount;
    let rootId: string;
    let alice: User;
    let bobId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        home = await getHome(ctx.alice.user.id);
        [mount] = home.drive.getMounts();
        rootId = (await home.drive.getRootFolder(mount.id))!.id;
        alice = (await getUserById(ctx.alice.user.id))!;
        bobId = ctx.bob.user.id;
    });

    async function settledTempFiles(): Promise<string[]> {
        await Promise.allSettled(mount.thumbnailJobs);
        return readdirSync(mount.tmpDir).sort();
    }

    test('a copy from another drive stays created when its watchers cannot be told', async () => {
        mount.history.addWatcher(rootId, bobId);
        const before = await settledTempFiles();
        const lookup = spyOn(publicInfo, 'getBatchPublicInfo').mockRejectedValue(new Error('auth db down'));
        try {
            const created = await home.drive.createFileFromData(
                mount.id,
                rootId,
                'landed-copy.txt',
                'text/plain',
                Buffer.from('hello'),
                alice,
            );

            expect((await home.drive.getPath(mount.id, created.id))?.size).toBe(5);
            expect(await settledTempFiles()).toEqual(before);
        } finally {
            lookup.mockRestore();
            mount.history.removeWatcher(rootId, bobId);
        }
    });
});
