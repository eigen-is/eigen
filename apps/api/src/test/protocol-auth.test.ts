import { beforeAll, describe, expect, test } from 'bun:test';
import { app, getTestContext } from './setup';

describe('Protocol Auth', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let verifyProtocolAuth: typeof import('../lib/auth/protocol-auth').verifyProtocolAuth;
    let auth: typeof import('../lib/auth/auth').auth;

    beforeAll(async () => {
        ctx = await getTestContext();
        verifyProtocolAuth = (await import('../lib/auth/protocol-auth')).verifyProtocolAuth;
        auth = (await import('../lib/auth/auth')).auth;
    });

    test('rejects unknown email', async () => {
        expect(verifyProtocolAuth('nobody@test.eigen.is', 'anything')).rejects.toThrow();
    });

    test('rejects wrong password', async () => {
        expect(verifyProtocolAuth(ctx.alice.user.email, 'wrongpassword')).rejects.toThrow();
    });

    test('accepts correct primary password', async () => {
        const user = await verifyProtocolAuth(ctx.alice.user.email, 'testpassword123');
        expect(user.id).toBe(ctx.alice.user.id);
        expect(user.email).toBe(ctx.alice.user.email);
    });

    test('accepts valid app password', async () => {
        const created = await auth.api.createApiKey({
            body: { name: 'test-app-password' },
            headers: {
                cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}`,
            },
        });
        expect(created?.key).toBeDefined();

        const user = await verifyProtocolAuth(ctx.alice.user.email, created!.key!);
        expect(user.id).toBe(ctx.alice.user.id);
    });

    test('rejects app password for wrong user', async () => {
        const created = await auth.api.createApiKey({
            body: { name: 'test-wrong-user' },
            headers: {
                cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}`,
            },
        });

        expect(verifyProtocolAuth(ctx.bob.user.email, created!.key!)).rejects.toThrow();
    });

    test('internal auth endpoint accepts correct password', async () => {
        const res = await app.handle(
            new Request('http://localhost/internal/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: ctx.alice.user.email,
                    password: 'testpassword123',
                }),
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.userId).toBe(ctx.alice.user.id);
    });

    test('internal auth endpoint rejects wrong password', async () => {
        const res = await app.handle(
            new Request('http://localhost/internal/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: ctx.alice.user.email,
                    password: 'wrongpassword',
                }),
            }),
        );
        expect(res.status).toBe(401);
    });

    test('CalDAV basic auth accepts correct password', async () => {
        const res = await app.handle(
            new Request('http://localhost/dav/', {
                method: 'PROPFIND',
                headers: {
                    Authorization: `Basic ${btoa(`${ctx.alice.user.email}:testpassword123`)}`,
                    Depth: '0',
                },
            }),
        );
        expect(res.status).toBe(207);
    });

    test('CalDAV basic auth rejects wrong password', async () => {
        const res = await app.handle(
            new Request('http://localhost/dav/', {
                method: 'PROPFIND',
                headers: {
                    Authorization: `Basic ${btoa(`${ctx.alice.user.email}:wrongpassword`)}`,
                    Depth: '0',
                },
            }),
        );
        expect(res.status).toBe(401);
    });
});
