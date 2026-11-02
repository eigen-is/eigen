import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, createTestUserOnStorage, driveGet, drivePost, TEST_PNG_BYTES } from '../setup';

const MOUNT = 'default';

// Two screenshots pasted into one chat message are both called screenshot.png, and the chat uploads them at
// once. Both read the media folder before either one creates, so both pick the same free name. The loser has
// to pick again instead of answering 409. On `local-id` both creates write their bytes and the row write
// refuses the second; on `local-fullnames` the create lock makes the second fail before its write.
describe('upload route name dedup', () => {
    test.each(['local-id', 'local-fullnames'] as const)(
        'two same-named files uploaded into one folder at once both land, with distinct names (%s)',
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

            for (let round = 0; round < 3; round++) {
                const responses = await Promise.all([1, 2].map((n) => upload(round * 2 + n)));
                expect(responses.map((res) => res.status)).toEqual([200, 200]);
            }
            const names = (await driveGet<DrivePath[]>(token, user.id, MOUNT, `folder/${target.id}`)).map(
                (p) => p.name,
            );
            expect(names).toHaveLength(6);
            expect(new Set(names).size).toBe(6);
        },
    );
});
