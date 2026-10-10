import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PublicConfig, PublicUser } from '@workspace/lib/types/public';
import type { LandingLink } from '@workspace/lib/types/settings';
import { assertJson, authedRequest, getTestContext, TEST_PNG_BYTES } from '../setup';

// All /p/* routes are intentionally PUBLIC (unauthenticated) — that is what the /p/ prefix means.
// Do not gate them (see routes/public.ts).
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

        test('exposes admin-configured landing links', async () => {
            const empty = await assertJson<{ landingLinks: LandingLink[] }>(
                await ctx.app.handle(new Request('http://localhost/p/config')),
            );
            expect(empty.landingLinks).toEqual([]);

            const link = { title: 'Docs', url: 'https://docs.eigen.is' };
            await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ landing: { links: [link] } }),
            });

            const withLink = await assertJson<{ landingLinks: LandingLink[] }>(
                await ctx.app.handle(new Request('http://localhost/p/config')),
            );
            expect(withLink.landingLinks).toEqual([link]);
        });

        test('reports hosted mail as on by default and off with MAIL_ENABLED=0', async () => {
            const on = await assertJson<{ mailEnabled: boolean }>(
                await ctx.app.handle(new Request('http://localhost/p/config')),
            );
            expect(on.mailEnabled).toBe(true);

            process.env['MAIL_ENABLED'] = '0';
            try {
                const off = await assertJson<{ mailEnabled: boolean }>(
                    await ctx.app.handle(new Request('http://localhost/p/config')),
                );
                expect(off.mailEnabled).toBe(false);
            } finally {
                delete process.env['MAIL_ENABLED'];
            }
        });

        // Reset to defaults even on failure — JsonStore is shared across the whole suite.
        afterAll(async () => {
            await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ landing: { links: [] } }),
            });
        });
    });

    describe('/p/users', () => {
        test('resolves a user by email and by id, and omits an id without an account', async () => {
            const ids = [ctx.alice.user.email, ctx.alice.user.id, 'nobody@test.eigen.is'];
            const response = await ctx.app.handle(
                new Request('http://localhost/p/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids }),
                }),
            );
            const users = await assertJson<Record<string, PublicUser>>(response);
            const alice = { name: 'Alice Test', email: 'alice@test.eigen.is', avatar: `p/avatar/${ctx.alice.user.id}` };
            expect(users).toEqual({ [ctx.alice.user.email]: alice, [ctx.alice.user.id]: alice });
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

        // A contact without an email renders src="/p/avatar/" — the empty id must serve the fallback, not 404.
        test('returns fallback SVG for empty emailOrId', async () => {
            const response = await ctx.app.handle(new Request('http://localhost/p/avatar/'));
            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
            expect(await response.text()).toContain('<svg');
        });

        test('returns uploaded avatar as WebP after profile update', async () => {
            // Create a small test image (4x4 PNG — same bytes used in preview.test.ts)
            const file = new File([TEST_PNG_BYTES], 'test-avatar.png', { type: 'image/png' });

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
