import { beforeAll, describe, expect, test } from 'bun:test';
import { driveGet, drivePost, getTestContext } from '../setup';
import { webdavRequest } from './setup';

describe('WebDAV resource PROPFIND', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        const body = await res.text();
        const m = body.match(new RegExp(`/webdav/${ctx.alice.user.id}/([^/<]+)/`));
        if (!m) throw new Error('could not find mount id');
        mountId = m[1];
    });

    test('Depth 0 on the root collection returns the collection only', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/${mountId}/`, {
            headers: { Depth: '0' },
        });
        expect(res.status).toBe(207);
        const body = await res.text();
        expect(body).toContain('<D:collection/>');
        const hrefs = [...body.matchAll(/<D:href>/g)];
        expect(hrefs.length).toBe(1);
    });

    test('Depth infinity → 403 with finite-depth precondition', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/${mountId}/`, {
            headers: { Depth: 'infinity' },
        });
        expect(res.status).toBe(403);
        const body = await res.text();
        expect(body).toContain('propfind-finite-depth');
    });

    test('PROPFIND on a missing path → 404', async () => {
        const res = await webdavRequest(
            ctx.alice.user.email,
            'PROPFIND',
            `/webdav/${ctx.alice.user.id}/${mountId}/does-not-exist`,
            { headers: { Depth: '0' } },
        );
        expect(res.status).toBe(404);
    });

    test('Last-Modified is RFC 1123 UTC', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/${mountId}/`, {
            headers: { Depth: '0' },
        });
        const body = await res.text();
        const m = body.match(/<D:getlastmodified>(.+?)<\/D:getlastmodified>/);
        expect(m).toBeTruthy();
        expect(m![1]).toMatch(/GMT$/);
    });

    test('quota-* properties present on collections', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/${mountId}/`, {
            headers: { Depth: '0' },
        });
        const body = await res.text();
        expect(body).toContain('<D:quota-used-bytes>');
        expect(body).toContain('<D:quota-available-bytes>');
    });

    test('Depth 1 lists children', async () => {
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${root.id}`, {
            folderName: 'PropfindFixture',
        });

        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/${mountId}/`, {
            headers: { Depth: '1' },
        });
        expect(res.status).toBe(207);
        const body = await res.text();
        expect(body).toContain('PropfindFixture');
    });
});
