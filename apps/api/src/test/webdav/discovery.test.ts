import { beforeAll, describe, expect, test } from 'bun:test';
import { getTestContext } from '../setup';
import { webdavRequest } from './setup';

describe('WebDAV discovery', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('PROPFIND /webdav/ lists self', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', '/webdav/');
        expect(res.status).toBe(207);
        const body = await res.text();
        expect(body).toContain(ctx.alice.user.id);
        expect(body).toContain('<D:multistatus');
    });

    test('PROPFIND /webdav/:uid/ lists at least the default mount', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        expect(res.status).toBe(207);
        const body = await res.text();
        expect(body).toMatch(/<D:href>\/webdav\/[^<]+\/[^<]+\/<\/D:href>/);
    });

    test("PROPFIND on bob's owner from alice → 403", async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.bob.user.id}/`);
        expect(res.status).toBe(403);
    });

    test('PROPFIND on a team the user does not belong to → 403', async () => {
        const res = await webdavRequest(
            ctx.alice.user.email,
            'PROPFIND',
            '/webdav/team_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
        );
        expect(res.status).toBe(403);
    });
});
