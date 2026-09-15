import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const MOUNT = 'default';

// Drive.create appends the type's extension before the mount validates the name, so the stem needs its
// own gate: an empty stem would otherwise land as a bare `.eigendoc` dotfile that renders nameless and
// that the rename route refuses to produce. Same rule the chat rooms route already enforces by hand.
describe('Drive.create stem validation', () => {
    let ctx: TestCtx;
    let folderId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${rootId}`,
            { folderName: `create-name-${randomUUID()}` },
        );
        folderId = folder.id;
    });

    async function create(fileName: string): Promise<Response> {
        return authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT}/folder/${folderId}/create/doc`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName }),
            },
        );
    }

    test('rejects the stems the rename route rejects, before any row is written', async () => {
        for (const stem of ['', '.', '..', 'a/b', `x${String.fromCharCode(0)}y`, '.Trash']) {
            const res = await create(stem);
            expect(res.status).toBe(400);
        }
        const children = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${folderId}`,
        );
        expect(children).toEqual([]);
    });

    test('stores the stem NFC-normalized, matching the rename route', async () => {
        const res = await create('café'.normalize('NFD'));
        expect(res.status).toBe(200);
        const created = (await res.json()) as DrivePath;
        expect(created.name).toBe('café.eigendoc');
    });
});
