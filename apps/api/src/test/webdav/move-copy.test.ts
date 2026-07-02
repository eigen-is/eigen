import { beforeAll, describe, expect, test } from 'bun:test';
import { getTestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

describe('WebDAV MOVE/COPY', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let baseHref: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
    });

    test('MOVE renames in place', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/move-rename.txt`, { body: 'a' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/move-rename.txt`, {
            headers: { Destination: `http://localhost${baseHref}/renamed.txt` },
        });
        expect([201, 204]).toContain(res.status);
        const oldGet = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/move-rename.txt`);
        expect(oldGet.status).toBe(404);
        const newGet = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/renamed.txt`);
        expect(newGet.status).toBe(200);
        expect(await newGet.text()).toBe('a');
    });

    test('MOVE into a different folder', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/MoveTarget/`);
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/move-into.txt`, { body: 'b' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/move-into.txt`, {
            headers: { Destination: `http://localhost${baseHref}/MoveTarget/move-into.txt` },
        });
        expect([201, 204]).toContain(res.status);
        const target = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/MoveTarget/move-into.txt`);
        expect(await target.text()).toBe('b');
    });

    test('MOVE with Overwrite: F over existing → 412', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/source.txt`, { body: 'src' });
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/conflict.txt`, { body: 'dest' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/source.txt`, {
            headers: {
                Destination: `http://localhost${baseHref}/conflict.txt`,
                Overwrite: 'F',
            },
        });
        expect(res.status).toBe(412);
    });

    test('COPY in-mount preserves source', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/copy-src.txt`, { body: 'orig' });
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/copy-src.txt`, {
            headers: { Destination: `http://localhost${baseHref}/copy-dst.txt` },
        });
        expect([201, 204]).toContain(res.status);
        const src = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/copy-src.txt`);
        const dst = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/copy-dst.txt`);
        expect(await src.text()).toBe('orig');
        expect(await dst.text()).toBe('orig');
    });

    test('COPY a folder into its own subtree → 409 (no infinite recursion)', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyCycle/`);
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyCycle/Inner/`);
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/CopyCycle`, {
            headers: { Destination: `http://localhost${baseHref}/CopyCycle/Inner/CopyCycle` },
        });
        expect(res.status).toBe(409);
    });

    test('COPY a folder into an unrelated folder succeeds', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyFrom/`);
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/CopyFrom/note.txt`, { body: 'hi' });
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyInto/`);
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/CopyFrom`, {
            headers: { Destination: `http://localhost${baseHref}/CopyInto/CopyFrom` },
        });
        expect([201, 204]).toContain(res.status);
        const copied = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/CopyInto/CopyFrom/note.txt`);
        expect(await copied.text()).toBe('hi');
    });

    test('MOVE with no Destination → 400', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/no-dest.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/no-dest.txt`);
        expect(res.status).toBe(400);
    });

    test('MOVE missing parent → 409', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/orphan.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/orphan.txt`, {
            headers: { Destination: `http://localhost${baseHref}/no-such-folder/x.txt` },
        });
        expect(res.status).toBe(409);
    });

    test('MOVE Destination outside /webdav → 400', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/elsewhere.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/elsewhere.txt`, {
            headers: { Destination: `http://localhost/somewhere-else/x.txt` },
        });
        expect(res.status).toBe(400);
    });
});
