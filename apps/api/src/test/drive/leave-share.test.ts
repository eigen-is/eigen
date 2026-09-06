import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types/drive';
import { assertJson, authedRequest, driveGet, drivePost, drivePut, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';
const BOB_EMAIL = 'bob@test.eigen.is';

describe('Delete of a direct share leaves it', () => {
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
            {
                folderName: `leave-share-${randomUUID()}`,
            },
        );
        folderId = folder.id;
        // Bob read-only + sharing restricted (the strictest share a recipient can be given), Charlie write.
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, `path/${folderId}/acl`, {
            add: [
                { id: BOB_EMAIL.toUpperCase(), read: true, write: false },
                { id: ctx.charlie.user.email, read: true, write: true },
            ],
            sharingRestricted: true,
        });
    });

    function del(token: string): Promise<Response> {
        return authedRequest(token, `/drive/${ctx.alice.user.id}/${MOUNT}/path/${folderId}`, { method: 'DELETE' });
    }

    test('a write recipient deleting a direct share leaves it instead of trashing it', async () => {
        await assertJson(await del(ctx.charlie.user.sessionToken));

        const folder = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `path/${folderId}`,
        );
        expect(folder.trashedAt).toBeNull();
        expect(folder.acl?.map((entry) => entry.id)).toEqual([BOB_EMAIL]);
    });

    test('a read-only recipient deleting a direct share leaves it, even when sharing is restricted', async () => {
        await assertJson(await del(ctx.bob.user.sessionToken));

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT}/folder/${folderId}`,
        );
        expect(res.status).toBe(403);

        const shared = await assertJson<DrivePath[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`),
        );
        expect(shared.some((item) => item.id === folderId)).toBe(false);
    });

    test("the owner's copy stays in place with an empty ACL", async () => {
        const folder = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `path/${folderId}`,
        );
        expect(folder.trashedAt).toBeNull();
        expect(folder.acl ?? []).toEqual([]);
    });

    test('deleting after leaving is a 403, like any stranger', async () => {
        expect((await del(ctx.bob.user.sessionToken)).status).toBe(403);
    });
});
