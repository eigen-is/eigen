import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, driveGet, drivePost, drivePut, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

// A move takes an item out of one folder and into another, so it needs write on the item and on both
// folders. Rename already needs write on the folder, and a move must not be looser.
describe('Moving a shared item', () => {
    let ctx: TestCtx;
    let rootId: string;

    async function folder(name: string, bobWrites: boolean): Promise<DrivePath> {
        const created = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${rootId}`,
            {
                folderName: `${name}-${randomUUID()}`,
            },
        );
        if (bobWrites) await shareWithBob(created.id);
        return created;
    }

    async function doc(parentId: string): Promise<DrivePath> {
        return drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${parentId}/create/doc`,
            {
                fileName: `moved-${randomUUID()}`,
            },
        );
    }

    async function shareWithBob(pathId: string): Promise<void> {
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, `path/${pathId}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
    }

    function bobMoves(pathId: string, targetParentId: string): Promise<Response> {
        return authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.alice.user.id}/${MOUNT}/path/${pathId}/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetParentId }),
        });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
    });

    test('an editor of one file can not move it out of a folder he can not write', async () => {
        const source = await folder('private', false);
        const target = await folder('target', true);
        const file = await doc(source.id);
        await shareWithBob(file.id);

        const res = await bobMoves(file.id, target.id);
        expect(res.status).toBe(403);
        const after = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `path/${file.id}`,
        );
        expect(after.parentId).toBe(source.id);
    });

    test('an editor of both folders can move it', async () => {
        const source = await folder('source', true);
        const target = await folder('target', true);
        const file = await doc(source.id);

        expect((await bobMoves(file.id, target.id)).status).toBe(200);
        const after = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `path/${file.id}`,
        );
        expect(after.parentId).toBe(target.id);
    });
});
