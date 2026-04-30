import { beforeAll, describe, expect, test } from 'bun:test';
import { app, getTestContext } from '../setup';
import { basicAuth } from './setup';

describe('WebDAV auth', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('missing Authorization → 401 with WWW-Authenticate Basic', async () => {
        const res = await app.handle(
            new Request(`http://localhost/webdav/${ctx.alice.user.id}/`, { method: 'PROPFIND' }),
        );
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')?.toLowerCase()).toContain('basic');
    });

    test('wrong password → 401', async () => {
        const res = await app.handle(
            new Request(`http://localhost/webdav/${ctx.alice.user.id}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email, 'wrong') },
            }),
        );
        expect(res.status).toBe(401);
    });

    test('valid primary password → 207 (handler exists)', async () => {
        const res = await app.handle(
            new Request(`http://localhost/webdav/${ctx.alice.user.id}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        // After Task 5 lands, this returns 207. For now the router doesn't exist; the test
        // is added here so the next task can light it up.
        expect([207, 404]).toContain(res.status);
    });
});
