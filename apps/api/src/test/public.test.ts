import { beforeAll, describe, expect, test } from 'bun:test';
import type { PublicConfig, PublicUser } from '@workspace/lib/types/public';
import { assertJson, getTestContext } from './setup';

describe('Public Routes', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('/p/config', () => {
        test('returns public config without authentication', async () => {
            const response = await ctx.app.handle(new Request('http://localhost/p/config'));
            const data = await assertJson<PublicConfig>(response);
            expect(data.domain).toBe('test.eigen.is');
            expect(data.orgName).toBe('Test Organization');
            expect(data.orgId).toBeString();
        });

        test('does not expose storage configuration', async () => {
            const response = await ctx.app.handle(new Request('http://localhost/p/config'));
            const data = (await response.json()) as Record<string, unknown>;

            expect(data).not.toHaveProperty('storage');
            expect(data).not.toHaveProperty('setupCompleted');
            expect(data).not.toHaveProperty('setupCompletedAt');
        });
    });

    describe('/p/user/:emailOrId', () => {
        test('returns public user info by email', async () => {
            const response = await ctx.app.handle(new Request(`http://localhost/p/user/${ctx.alice.user.email}`));
            const data = await assertJson<PublicUser>(response);
            expect(data.name).toBe('Alice Test');
            expect(data.email).toBe('alice@test.eigen.is');
            expect(data.avatar).toContain('p/avatar/');
        });

        test('returns public user info by id', async () => {
            const response = await ctx.app.handle(new Request(`http://localhost/p/user/${ctx.alice.user.id}`));
            const data = await assertJson<PublicUser>(response);
            expect(data.name).toBe('Alice Test');
            expect(data.email).toBe('alice@test.eigen.is');
        });

        test('returns 404 for non-existent user', async () => {
            const response = await ctx.app.handle(new Request('http://localhost/p/user/nobody@test.eigen.is'));
            expect(response.status).toBe(404);
        });
    });

    describe('/p/avatar/:emailOrId', () => {
        test('returns fallback SVG avatar for user without image', async () => {
            const response = await ctx.app.handle(new Request(`http://localhost/p/avatar/${ctx.alice.user.email}`));
            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('image/svg+xml');

            const svg = await response.text();
            expect(svg).toContain('<svg');
        });

        test('returns fallback SVG for unknown email', async () => {
            const response = await ctx.app.handle(new Request('http://localhost/p/avatar/unknown@test.eigen.is'));
            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
        });
    });
});
