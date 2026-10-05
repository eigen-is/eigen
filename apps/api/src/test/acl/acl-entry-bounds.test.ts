import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MAX_SEND_RECIPIENTS } from '@workspace/lib/constants/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { authedRequest, driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const MOUNT = 'default';

// An ACL id is an email or a team id; the chat invite route bounds the same field by MAX_EMAIL_LENGTH,
// and an unbounded one would flow into the share registry, notifications and invite mail as-is.
describe('ACL entry bounds', () => {
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
                folderName: `acl-bounds-${randomUUID()}`,
            },
        );
        folderId = folder.id;
    });

    async function putAcl(...ids: string[]): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/${MOUNT}/path/${folderId}/acl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ add: ids.map((id) => ({ id, read: true, write: false })) }),
        });
    }

    async function storedAcl(): Promise<DrivePath['acl']> {
        const path = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `path/${folderId}`,
        );
        return path.acl;
    }

    test('an id over MAX_EMAIL_LENGTH is refused at the schema, nothing is stored', async () => {
        const res = await putAcl(`${'x'.repeat(MAX_EMAIL_LENGTH)}@example.com`);
        expect(res.status).toBe(422);
        expect(await storedAcl()).toBeNull();
    });

    // The access-check route caps its email list the same way: one share request reaches 100 people at most.
    test('more than MAX_SEND_RECIPIENTS entries are refused at the schema, nothing is stored', async () => {
        const ids = Array.from({ length: MAX_SEND_RECIPIENTS + 1 }, (_, i) => `acl-many-${i}@example.com`);
        const res = await putAcl(...ids);
        expect(res.status).toBe(422);
        expect(await storedAcl()).toBeNull();
    });

    test('an id at the limit is accepted', async () => {
        const domain = '@example.com';
        const res = await putAcl(`${'a'.repeat(MAX_EMAIL_LENGTH - domain.length)}${domain}`);
        expect(res.status).toBe(200);
    });
});
