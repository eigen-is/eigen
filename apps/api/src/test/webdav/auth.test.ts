import { beforeAll, describe, expect, test } from 'bun:test';
import { app, getTestContext } from '../setup';
import { basicAuth, getDefaultMountId } from './setup';

describe('WebDAV auth', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountUrl: string;
    beforeAll(async () => {
        ctx = await getTestContext();
        const mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        mountUrl = `http://localhost/webdav/${ctx.alice.user.id}/${mountId}/`;
    });

    test('missing Authorization → 401 with WWW-Authenticate Basic', async () => {
        const res = await app.handle(new Request(mountUrl, { method: 'PROPFIND' }));
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')?.toLowerCase()).toContain('basic');
    });

    test('wrong password → 401', async () => {
        const res = await app.handle(
            new Request(mountUrl, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email, 'wrong') },
            }),
        );
        expect(res.status).toBe(401);
    });

    test('valid primary password → 207', async () => {
        const res = await app.handle(
            new Request(mountUrl, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(res.status).toBe(207);
    });
});
