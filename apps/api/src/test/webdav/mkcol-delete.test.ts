import { beforeAll, describe, expect, test } from 'bun:test';
import { getTestContext } from '../setup';
import { webdavRequest } from './setup';

describe('WebDAV MKCOL/DELETE', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const dRes = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        const m = (await dRes.text()).match(new RegExp(`/webdav/${ctx.alice.user.id}/([^/<]+)/`));
        if (!m) throw new Error('mount id not found');
        mountId = m[1];
    });

    test('MKCOL creates a folder', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/Reports/`;
        const res = await webdavRequest(ctx.alice.user.email, 'MKCOL', url);
        expect(res.status).toBe(201);
        const propfind = await webdavRequest(ctx.alice.user.email, 'PROPFIND', url, {
            headers: { Depth: '0' },
        });
        expect(propfind.status).toBe(207);
        expect(await propfind.text()).toContain('<D:collection/>');
    });

    test('MKCOL with body → 415', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/BodyMkcol/`;
        const res = await webdavRequest(ctx.alice.user.email, 'MKCOL', url, {
            body: '<x/>',
            headers: { 'Content-Length': '4' },
        });
        expect(res.status).toBe(415);
    });

    test('MKCOL on existing collection → 405', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/Reports/`;
        const res = await webdavRequest(ctx.alice.user.email, 'MKCOL', url);
        expect(res.status).toBe(405);
    });

    test('MKCOL with no parent → 409', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/Missing/Sub/`;
        const res = await webdavRequest(ctx.alice.user.email, 'MKCOL', url);
        expect(res.status).toBe(409);
    });

    test('DELETE soft-deletes (subsequent GET → 404)', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/to-delete.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'bye' });
        const del = await webdavRequest(ctx.alice.user.email, 'DELETE', url);
        expect(del.status).toBe(204);
        const get = await webdavRequest(ctx.alice.user.email, 'GET', url);
        expect(get.status).toBe(404);
    });

    test('DELETE on a folder cascades children', async () => {
        const folder = `/webdav/${ctx.alice.user.id}/${mountId}/Cascade/`;
        await webdavRequest(ctx.alice.user.email, 'MKCOL', folder);
        await webdavRequest(ctx.alice.user.email, 'PUT', `${folder}child.txt`, { body: 'x' });
        const del = await webdavRequest(ctx.alice.user.email, 'DELETE', folder);
        expect(del.status).toBe(204);
        const child = await webdavRequest(ctx.alice.user.email, 'GET', `${folder}child.txt`);
        expect(child.status).toBe(404);
    });

    test('DELETE on missing path → 404', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/no-such-thing.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'DELETE', url);
        expect(res.status).toBe(404);
    });
});
