import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { SSEventType } from '@workspace/lib/types/sse';
import { ApiError, StaleWriteError } from '../../lib/core/errors';
import * as aclPropagation from '../../lib/drive/acl-propagation';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount';
import * as thumbnails from '../../lib/shared/thumbnails';
import * as publicInfo from '../../lib/space/public';
import type { User } from '../../lib/user';
import { getUserById } from '../../lib/user';
import { getTestContext, TEST_PNG_BYTES } from '../setup';

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
        await mount.backgroundDone();
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

    test('an overwrite of a file that is deleted as the write lands is a 404, and leaves no temp file', async () => {
        const file = await home.drive.createFileFromData(
            mount.id,
            rootId,
            'landed-overwrite.txt',
            'text/plain',
            Buffer.from('one'),
            home.user,
        );
        const before = await settledTempFiles();
        const writeFileFromTemp = mount.writeFileFromTemp.bind(mount);
        const write = spyOn(mount, 'writeFileFromTemp').mockImplementationOnce(async (...args) => {
            const committed = await writeFileFromTemp(...args);
            await mount.deletePath(file.id);
            return committed;
        });
        try {
            const result = await home.drive
                .writeFileContent(mount.id, file.id, new Blob(['two']).stream(), { user: alice })
                .catch((e: unknown) => e);

            expect(result).toBeInstanceOf(ApiError);
            expect(result instanceof ApiError && result.status).toBe(404);
            expect(await settledTempFiles()).toEqual(before);
        } finally {
            write.mockRestore();
        }
    });

    // Every write of a file's bytes goes through a temp file of the mount. However the write ends, that
    // temp file is gone once the thumbnail job is done.
    async function bytesOf(pathId: string): Promise<Uint8Array> {
        return new Uint8Array((await mount.readBytes(pathId)) ?? []);
    }

    const PNG = TEST_PNG_BYTES;
    const sources = [
        ['a stream', () => new Blob([PNG]).stream()],
        ['a Buffer', () => Buffer.from(PNG)],
    ] as const;

    test('an upload leaves no temp file, of a picture or an empty file, and the picture gets its thumbnail', async () => {
        const before = await settledTempFiles();
        const form = new FormData();
        form.append('file', new File([PNG], 'temp-owner.png', { type: 'image/png' }));
        form.append('file', new File([], 'temp-owner-empty.txt', { type: 'text/plain' }));
        const request = new Request('http://localhost/upload', { method: 'POST', body: form });

        const [picture, empty] = await home.drive.uploadFiles(mount.id, rootId, request, 1024 * 1024, alice);

        expect(await settledTempFiles()).toEqual(before);
        expect(await bytesOf(picture.id)).toEqual(PNG);
        expect((await mount.getPath(picture.id))?.thumbnail).toBe(`${picture.id}.webp`);
        expect(await mount.getPath(empty.id)).toMatchObject({ size: 0, thumbnail: null });
    });

    test.each(sources)('an overwrite from %s leaves no temp file and makes the thumbnail', async (_name, from) => {
        const file = await home.drive.createFileFromData(
            mount.id,
            rootId,
            'temp-owner-overwrite.png',
            'image/png',
            Buffer.from('no picture yet'),
            alice,
        );
        const before = await settledTempFiles();
        expect((await mount.getPath(file.id))?.thumbnail).toBeNull();

        await home.drive.writeFileContent(mount.id, file.id, from(), { user: alice });

        expect(await settledTempFiles()).toEqual(before);
        expect(await bytesOf(file.id)).toEqual(PNG);
        expect((await mount.getPath(file.id))?.thumbnail).toBe(`${file.id}.webp`);
    });

    test.each(sources)('a refused overwrite from %s leaves no temp file and the old bytes', async (_name, from) => {
        const file = await home.drive.createFileFromData(
            mount.id,
            rootId,
            'temp-owner-refused.txt',
            'text/plain',
            Buffer.from('kept'),
            alice,
        );
        const before = await settledTempFiles();

        const write = home.drive.writeFileContent(mount.id, file.id, from(), { user: alice, ifMatch: '"stale"' });

        await expect(write).rejects.toBeInstanceOf(StaleWriteError);
        expect(await settledTempFiles()).toEqual(before);
        expect(await bytesOf(file.id)).toEqual(new TextEncoder().encode('kept'));
    });

    test('an empty overwrite, such as an empty WebDAV PUT, leaves no temp file', async () => {
        const file = await home.drive.createFileFromData(
            mount.id,
            rootId,
            'temp-owner-emptied.txt',
            'text/plain',
            Buffer.from('full'),
            alice,
        );
        const before = await settledTempFiles();

        const { path } = await home.drive.writeFileContent(mount.id, file.id, Buffer.alloc(0), { user: alice });

        expect(path.size).toBe(0);
        expect(await settledTempFiles()).toEqual(before);
        expect(await bytesOf(file.id)).toEqual(new Uint8Array());
    });

    // A shared path keeps a copy in the homes of the people it is shared with. Updating those copies
    // is the last step, so a failure there leaves the owner's tabs and the history up to date.
    async function sharedFile(name: string) {
        const file = await home.drive.createFileFromData(
            mount.id,
            rootId,
            name,
            'text/plain',
            Buffer.from('x'),
            home.user,
        );
        await home.drive.updateACLDelta(mount.id, file.id, {
            add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
        });
        return file;
    }

    async function failingPropagation<T>(change: () => Promise<T>): Promise<{ events: string[]; error: unknown }> {
        const events: string[] = [];
        const broadcast = spyOn(home, 'broadcast').mockImplementation((event) => {
            events.push(event.type);
        });
        const propagate = spyOn(aclPropagation, 'propagateSharedPathChange').mockRejectedValue(
            new Error('auth db down'),
        );
        try {
            const error = await change().then(
                () => null,
                (e: unknown) => e,
            );
            return { events, error };
        } finally {
            propagate.mockRestore();
            broadcast.mockRestore();
        }
    }

    async function historyOf(pathId: string): Promise<string[]> {
        return (await home.drive.getFileHistory(mount.id, pathId)).map((event) => event.eventType);
    }

    test('a rename of a shared path reaches the open tabs and the history when the share copies fail', async () => {
        const file = await sharedFile('landed-rename.txt');

        const { events, error } = await failingPropagation(() =>
            home.drive.renamePath(mount.id, file.id, 'landed-renamed.txt', alice),
        );

        expect(error).toBeInstanceOf(Error);
        expect(events).toContain(SSEventType.DRIVE_PATH_RENAMED);
        expect(await historyOf(file.id)).toContain('renamed');
    });

    test('a sharing change reaches the open tabs and the history when the share copies fail', async () => {
        const file = await sharedFile('landed-share.txt');

        const { events, error } = await failingPropagation(() =>
            home.drive.updateACLDelta(
                mount.id,
                file.id,
                { add: [{ id: 'charlie@test.eigen.is', read: true, write: false }] },
                undefined,
                undefined,
                alice,
            ),
        );

        expect(error).toBeInstanceOf(Error);
        expect(events).toContain(SSEventType.DRIVE_ACL_UPDATED);
        expect(await historyOf(file.id)).toContain('acl-changed');
    });

    test('a restore of a shared path reaches the open tabs and the history when the share copies fail', async () => {
        const file = await sharedFile('landed-restore.txt');
        await home.drive.deletePath(mount.id, file.id, alice);

        const { events, error } = await failingPropagation(() => home.drive.restorePath(mount.id, file.id, alice));

        expect(error).toBeInstanceOf(Error);
        expect(events).toContain(SSEventType.DRIVE_PATH_RESTORED);
        expect(await historyOf(file.id)).toContain('restored');
    });

    test('a failed fan-out leaves the new file its temp file until the thumbnail job is done', async () => {
        const { promise: fannedOut, resolve: afterFanOut } = Promise.withResolvers<void>();
        let sourceThere: boolean | undefined;
        const thumbnail = spyOn(thumbnails, 'saveThumbnail').mockImplementationOnce(async (_dir, _id, source) => {
            await fannedOut;
            sourceThere = typeof source === 'string' && existsSync(source);
            return null;
        });
        const fanOut = spyOn(mount.history, 'fanOut').mockRejectedValueOnce(new Error('watchers down'));
        try {
            const copy = home.drive.createFileFromData(
                mount.id,
                rootId,
                'fan-out-fails.txt',
                'text/plain',
                Buffer.from('hello'),
                alice,
            );
            await expect(copy).rejects.toThrow('watchers down');
            afterFanOut();
            await settledTempFiles();

            expect(sourceThere).toBe(true);
        } finally {
            fanOut.mockRestore();
            thumbnail.mockRestore();
        }
    });
});
