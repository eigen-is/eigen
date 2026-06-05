import { beforeAll, describe, expect, test } from 'bun:test';
import type { PublicConfig, PublicUser } from '@workspace/lib/types/public';
import { assertJson, authedRequest, getTestContext } from './setup';

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
            const response = await authedRequest(ctx.alice.user.sessionToken, `/p/user/${ctx.alice.user.email}`);
            const data = await assertJson<PublicUser>(response);
            expect(data.name).toBe('Alice Test');
            expect(data.email).toBe('alice@test.eigen.is');
            expect(data.avatar).toContain('p/avatar/');
        });

        test('returns public user info by id', async () => {
            const response = await authedRequest(ctx.alice.user.sessionToken, `/p/user/${ctx.alice.user.id}`);
            const data = await assertJson<PublicUser>(response);
            expect(data.name).toBe('Alice Test');
            expect(data.email).toBe('alice@test.eigen.is');
        });

        test('returns 404 for non-existent user', async () => {
            const response = await authedRequest(ctx.alice.user.sessionToken, '/p/user/nobody@test.eigen.is');
            expect(response.status).toBe(404);
        });

        test('requires authentication — no anonymous account enumeration', async () => {
            const response = await ctx.app.handle(new Request(`http://localhost/p/user/${ctx.alice.user.email}`));
            expect(response.status).toBe(401);
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

        test('returns uploaded avatar as WebP after profile update', async () => {
            // Create a small test image (4x4 PNG — same bytes used in preview.test.ts)
            const pngBytes = new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0, 38,
                147, 9, 41, 0, 0, 0, 9, 112, 72, 89, 115, 0, 0, 3, 232, 0, 0, 3, 232, 1, 181, 123, 82, 107, 0, 0, 0, 17,
                73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 71, 8, 22, 94, 14, 0, 174, 147, 15, 241, 166, 148, 72,
                35, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
            ]);
            const file = new File([pngBytes], 'test-avatar.png', { type: 'image/png' });

            // Upload avatar via contacts route
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/avatar`, {
                method: 'POST',
                body: formData,
            });
            expect(uploadRes.status).toBe(200);
            const avatarPath = await uploadRes.text();

            // Get bob's "me" contact to update it with the avatar
            const meRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/me`);
            const meContact = (await meRes.json()) as {
                id: string;
                firstName: string;
                lastName: string;
                email: string[];
            };

            // Update contact with avatar (triggers pushUserProfile)
            await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/contacts/${meContact.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...meContact,
                    avatar: avatarPath,
                    labels: [],
                }),
            });

            // Public avatar endpoint should now return WebP
            const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${ctx.bob.user.id}`));
            expect(avatarRes.status).toBe(200);
            expect(avatarRes.headers.get('Content-Type')).toBe('image/webp');
        });

        test('returns fallback SVG after avatar removal', async () => {
            // Get bob's "me" contact
            const meRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/me`);
            const meContact = (await meRes.json()) as {
                id: string;
                firstName: string;
                lastName: string;
                email: string[];
            };

            // Update contact with empty avatar (triggers deletion)
            await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/contacts/${meContact.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...meContact,
                    avatar: '',
                    labels: [],
                }),
            });

            // Public avatar endpoint should return fallback SVG
            const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${ctx.bob.user.id}`));
            expect(avatarRes.status).toBe(200);
            expect(avatarRes.headers.get('Content-Type')).toBe('image/svg+xml');
        });
    });
});
