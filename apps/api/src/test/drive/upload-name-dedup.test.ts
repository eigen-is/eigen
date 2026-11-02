import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { NameFolder } from '../../lib/drive/naming';
import { withFreeName } from '../../lib/drive/naming';
import type { TestUser } from '../setup';
import {
    authedRequest,
    createTestUserOnStorage,
    driveDelete,
    driveGet,
    drivePost,
    driveUpload,
    TEST_PNG_BYTES,
} from '../setup';

const MOUNT = 'default';

// The names one burst of n same-named creates lands under, after `start - 1` of them already exist.
function freeNames(stem: string, ext: string, start: number, n: number): string[] {
    return Array.from({ length: n }, (_, i) => (start + i === 1 ? `${stem}${ext}` : `${stem} (${start + i})${ext}`));
}

// Screenshots pasted into one chat message are all called screenshot.png, and the chat uploads them at once.
// They all read the media folder before any one of them creates, so each must still get its own name. On
// `local-id` every create writes its bytes and the row write would refuse a clash; on `local-fullnames` the
// create lock would refuse it before the write.
describe('upload route name dedup', () => {
    test.each(['local-id', 'local-fullnames'] as const)(
        'eight same-named files uploaded into one folder at once all land, with distinct names (%s)',
        async (storageType) => {
            const user = await createTestUserOnStorage(storageType, 'Upload Race');
            const token = user.sessionToken;
            const root = await driveGet<DrivePath>(token, user.id, MOUNT, 'root');
            const target = await drivePost<DrivePath>(token, user.id, MOUNT, `folder/${root.id}`, {
                folderName: 'upload-race',
            });
            const upload = (n: number) => {
                const formData = new FormData();
                formData.append(
                    'file',
                    new File([TEST_PNG_BYTES, new Uint8Array([n])], 'screenshot.png', { type: 'image/png' }),
                );
                return authedRequest(token, `/drive/${user.id}/${MOUNT}/file/${target.id}`, {
                    method: 'POST',
                    body: formData,
                });
            };

            // The second burst lands beside the first one's files, so it reads the folder too.
            for (let round = 0; round < 2; round++) {
                const responses = await Promise.all(Array.from({ length: 8 }, (_, n) => upload(round * 8 + n)));
                expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));
            }
            const names = (await driveGet<DrivePath[]>(token, user.id, MOUNT, `folder/${target.id}`)).map(
                (p) => p.name,
            );
            expect(names.toSorted()).toEqual(freeNames('screenshot', '.png', 1, 16).toSorted());
        },
    );
});

// A create that never ends, such as a copy the client stopped reading, keeps its own name only. A name
// another create took, then gave up, is free again while it runs.
describe('a name freed while another create runs in the folder', () => {
    let user: TestUser;
    let rootId: string;

    beforeAll(async () => {
        user = await createTestUserOnStorage('local-id', 'Freed Name');
        rootId = (await driveGet<DrivePath>(user.sessionToken, user.id, MOUNT, 'root')).id;
    });

    // A new folder with a create held in flight in it. The returned function lets that create end.
    async function busyFolder(): Promise<{ id: string; release: () => Promise<void> }> {
        const folder = await drivePost<DrivePath>(user.sessionToken, user.id, MOUNT, `folder/${rootId}`, {
            folderName: `busy-${crypto.randomUUID()}`,
        });
        const held = Promise.withResolvers<void>();
        const nameFolder = {
            ownerId: user.id,
            mountId: MOUNT,
            parentId: folder.id,
            isTaken: () => false,
            childNames: () => [],
        };
        const running = withFreeName(nameFolder, 'held.bin', () => held.promise);
        return {
            id: folder.id,
            release: () => {
                held.resolve();
                return running;
            },
        };
    }

    test('an upload, trashed and uploaded again, keeps its name', async () => {
        const folder = await busyFolder();
        const first = await driveUpload(user.sessionToken, user.id, MOUNT, folder.id, new File(['1'], 'x.txt'));
        await driveDelete(user.sessionToken, user.id, MOUNT, `path/${first.id}`);
        const second = await driveUpload(user.sessionToken, user.id, MOUNT, folder.id, new File(['2'], 'x.txt'));
        expect(second.name).toBe('x.txt');
        await folder.release();
    });

    test('an upload, trashed and restored, keeps its name', async () => {
        const folder = await busyFolder();
        const uploaded = await driveUpload(user.sessionToken, user.id, MOUNT, folder.id, new File(['1'], 'x.txt'));
        await driveDelete(user.sessionToken, user.id, MOUNT, `path/${uploaded.id}`);
        const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${MOUNT}/trash/${uploaded.id}/restore`, {
            method: 'POST',
        });
        expect(res.status).toBe(200);
        expect((await driveGet<DrivePath>(user.sessionToken, user.id, MOUNT, `path/${uploaded.id}`)).name).toBe(
            'x.txt',
        );
        await folder.release();
    });
});

describe('withFreeName', () => {
    // A folder whose rows never change, so only the names that creates picked can make a name taken. Each
    // call gets its own folder id.
    function emptyFolder(): NameFolder {
        return {
            ownerId: 'owner',
            mountId: MOUNT,
            parentId: crypto.randomUUID(),
            isTaken: () => false,
            childNames: () => [],
        };
    }

    test('a name a running create picked counts as taken until that create ends', async () => {
        const folder = emptyFolder();
        const held = Promise.withResolvers<void>();
        const first = withFreeName(folder, 'a.txt', async (name) => {
            await held.promise;
            return name;
        });
        expect(await withFreeName(folder, 'a.txt', async (name) => name)).toBe('a (2).txt');
        held.resolve();
        expect(await first).toBe('a.txt');
        expect(await withFreeName(folder, 'a.txt', async (name) => name)).toBe('a.txt');
    });

    test('a failed create gives its name back while the folder is still busy', async () => {
        const folder = emptyFolder();
        const held = Promise.withResolvers<void>();
        const busy = withFreeName(folder, 'other.txt', () => held.promise);
        const failed = withFreeName(folder, 'a.txt', async () => {
            throw new Error('create failed');
        });
        await expect(failed).rejects.toThrow('create failed');
        expect(await withFreeName(folder, 'a.txt', async (name) => name)).toBe('a.txt');
        held.resolve();
        await busy;
    });
});
