import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { and, eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { member as memberSchema, organization as organizationSchema } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { getOrgName, getServerConfig } from '../../lib/config/server-config';
import type { ControlStatus } from '../../lib/config/server-status';
import * as mailer from '../../lib/core/mailer';
import { assertJson, authedRequest, createTestUser, getTestContext, type TestUser } from '../setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Settings, its PUT, the waitlist and the server's own facts are the owner's; an admin keeps users, teams and team mounts.
describe('owner-only settings', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let admin: TestUser;

    function membership(userId: string) {
        const orgId = getServerConfig()?.orgId ?? '';
        return and(eq(memberSchema.userId, userId), eq(memberSchema.organizationId, orgId));
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        admin = await createTestUser('ada-owner-settings@test.eigen.is', 'testpassword123', 'Ada Admin');
        await getAuthDrizzleDb().update(memberSchema).set({ role: 'admin' }).where(membership(admin.id));
    });

    // The auth database is the whole suite's.
    afterAll(async () => {
        await getAuthDrizzleDb().update(memberSchema).set({ role: 'member' }).where(membership(admin.id));
    });

    test('an admin still reads the server settings, which a team mount needs', async () => {
        const res = await authedRequest(admin.sessionToken, '/settings/server');
        expect(res.status).toBe(200);
    });

    test('an admin cannot change the server settings', async () => {
        const res = await authedRequest(admin.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ quotas: { maxUploadSizeMB: 99 } }),
        });
        expect(res.status).toBe(403);
    });

    test("an admin cannot read the server's saved S3 configuration", async () => {
        const res = await authedRequest(admin.sessionToken, '/settings/s3config');
        expect(res.status).toBe(403);
    });

    test('the owner reads the server status', async () => {
        const status = await assertJson<ControlStatus>(
            await authedRequest(ctx.alice.user.sessionToken, '/settings/status'),
        );
        expect(status.version).toBeString();
        expect(status.diskTotal).toBeGreaterThan(0);
        expect(status.domain).toBeString();
    });

    test('an admin does not read the server status', async () => {
        const res = await authedRequest(admin.sessionToken, '/settings/status');
        expect(res.status).toBe(403);
    });

    test('an admin does not read the waitlist', async () => {
        const res = await authedRequest(admin.sessionToken, '/waitlist/entries');
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('server owner');
    });

    test('the org owner cannot be deleted', async () => {
        const res = await authedRequest(admin.sessionToken, `/settings/user/${ctx.alice.user.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('owner');
    });

    describe('system sender', () => {
        afterAll(async () => {
            await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ mail: { senderName: '', senderAddress: '', relaySendsAsUsers: false } }),
            });
        });

        test('the owner sets the sender, and an empty address means the default', async () => {
            for (const senderAddress of ['hello@example.com', '']) {
                const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                    method: 'PUT',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ mail: { senderName: 'Acme', senderAddress } }),
                });
                const settings = await assertJson<ServerSettings>(res);
                expect(settings.mail).toEqual({ senderName: 'Acme', senderAddress, relaySendsAsUsers: false });
            }
        });

        test('the sender name is stored trimmed', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ mail: { senderName: '  Acme  ' } }),
            });
            const settings = await assertJson<ServerSettings>(res);
            expect(settings.mail.senderName).toBe('Acme');
        });

        test('an address that is none is refused', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ mail: { senderAddress: 'not-an-address' } }),
            });
            expect(res.status).toBe(400);
            expect(await res.text()).toContain('not a valid sender address');
        });

        test('a name that would break the From header is refused', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ mail: { senderName: 'Acme\r\nBcc: x@example.com' } }),
            });
            expect(res.status).toBe(422);
        });
    });

    describe('organization name', () => {
        let before: string;

        beforeAll(() => {
            before = getOrgName();
        });

        afterAll(async () => {
            await authedRequest(ctx.alice.user.sessionToken, '/settings/organization', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ name: before }),
            });
        });

        test('the owner renames the organization, and mail signs with the new name', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/organization', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ name: 'Acme Renamed' }),
            });
            expect(res.status).toBe(200);
            expect(getOrgName()).toBe('Acme Renamed');
            const org = getAuthDrizzleDb()
                .select({ name: organizationSchema.name })
                .from(organizationSchema)
                .where(eq(organizationSchema.id, getServerConfig()?.orgId ?? ''))
                .get();
            expect(org?.name).toBe('Acme Renamed');
        });

        test('an empty name is refused', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/organization', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ name: '' }),
            });
            expect(res.status).toBe(422);
        });

        test('an admin cannot rename the organization', async () => {
            const res = await authedRequest(admin.sessionToken, '/settings/organization', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ name: 'Admin Renamed' }),
            });
            expect(res.status).toBe(403);
        });
    });

    describe('test mail', () => {
        afterEach(() => {
            spyOn(mailer, 'createTransport').mockRestore();
        });

        test('goes to the owner through the transport', async () => {
            const transport = nodemailer.createTransport({ jsonTransport: true });
            const send = spyOn(transport, 'sendMail');
            spyOn(mailer, 'createTransport').mockReturnValue(transport);
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/mail/test', { method: 'POST' });
            const body = await assertJson<{ to: string }>(res);
            expect(body.to).toBe(ctx.alice.user.email);
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0]?.[0].from).toEqual({ name: ctx.alice.user.name, address: ctx.alice.user.email });
        });

        test("returns the transport's error instead of swallowing it", async () => {
            // A relay that refuses the connection: port 1 on loopback has no listener.
            spyOn(mailer, 'createTransport').mockReturnValue(
                nodemailer.createTransport({ host: '127.0.0.1', port: 1 }),
            );
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/mail/test', { method: 'POST' });
            expect(res.status).toBe(502);
            expect(await res.text()).toContain('ECONNREFUSED');
        });

        test('an admin cannot send it', async () => {
            const res = await authedRequest(admin.sessionToken, '/settings/mail/test', { method: 'POST' });
            expect(res.status).toBe(403);
        });
    });
});
