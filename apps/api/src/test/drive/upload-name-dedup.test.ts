import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { NameFolder } from '../../lib/drive/naming';
import { withFreeName } from '../../lib/drive/naming';
import { authedRequest, createTestUserOnStorage, driveGet, drivePost, TEST_PNG_BYTES } from '../setup';

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

describe('withFreeName', () => {
    // A folder whose rows never change, so only the names that creates picked can make a name taken. Each
    // call gets its own folder id.
    function emptyFolder(): NameFolder {
        return {
            ownerId: 'owner',
            mountId: MOUNT,
            parentId: crypto.randomUUID(),
            isTaken: async () => false,
            childNames: async () => [],
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
        expect(failed).rejects.toThrow('create failed');
        await failed.catch(() => {});
        expect(await withFreeName(folder, 'a.txt', async (name) => name)).toBe('a.txt');
        held.resolve();
        await busy;
    });

    // The second create reads the folder before the first one's row lands, and picks after the first one
    // ended. It must still see the first one's name.
    test('a create whose read was older than a finished create still skips its name', async () => {
        const folder = emptyFolder();
        const read = Promise.withResolvers<boolean>();
        const late = withFreeName({ ...folder, isTaken: () => read.promise }, 'a.txt', async (name) => name);
        expect(await withFreeName(folder, 'a.txt', async (name) => name)).toBe('a.txt');
        read.resolve(false);
        expect(await late).toBe('a (2).txt');
    });
});
