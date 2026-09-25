import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSenderAddress } from '@workspace/lib/constants/mail';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { and, eq, inArray } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { member as memberSchema, organization as organizationSchema, team as teamSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getDataRoot } from '../../lib/config/paths';
import { getMailDomain, getOrgName, getServerConfig } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import type { ControlStatus } from '../../lib/config/server-status';
import * as mailer from '../../lib/core/mailer';
import { restoreEnvAfterEach } from '../env-test-helpers';
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

    describe('the saved S3 configuration in the server settings', () => {
        const s3Config = {
            endpoint: 'https://s3.example.com',
            bucket: 'eigen',
            prefix: '',
            accessKeyId: 'key-id',
            secretAccessKey: 'owner-secret',
        };

        beforeAll(async () => {
            await updateServerSettings({ defaults: { mount: { s3Config } } });
        });

        afterAll(async () => {
            await updateServerSettings({ defaults: { mount: { s3Config: undefined } } });
        });

        test('reaches an admin without its secret', async () => {
            const settings = await assertJson<ServerSettings>(
                await authedRequest(admin.sessionToken, '/settings/server'),
            );
            expect(settings.defaults.mount.s3Config).toEqual({ ...s3Config, secretAccessKey: '' });
        });

        test('reaches the owner whole', async () => {
            const settings = await assertJson<ServerSettings>(
                await authedRequest(ctx.alice.user.sessionToken, '/settings/server'),
            );
            expect(settings.defaults.mount.s3Config).toEqual(s3Config);
        });
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

    describe('the certificate row', () => {
        const certs = join(getDataRoot(), 'certs');
        restoreEnvAfterEach(['COMPOSE_PROFILES']);

        afterEach(() => {
            rmSync(certs, { recursive: true, force: true });
        });

        async function statusWith(profiles: string, fixture?: string): Promise<ControlStatus> {
            process.env['COMPOSE_PROFILES'] = profiles;
            if (fixture) {
                mkdirSync(certs, { recursive: true });
                copyFileSync(join(import.meta.dir, '../fixtures/control', fixture), join(certs, 'cert.pem'));
            }
            return assertJson<ControlStatus>(await authedRequest(ctx.alice.user.sessionToken, '/settings/status'));
        }

        test('reads an issued certificate in data/certs', async () => {
            const status = await statusWith('edge,mail', 'issued-2036.crt');
            expect(status.certExpiresAt).toBe('2036-12-31T23:59:59.000Z');
            expect(status.certSelfSigned).toBe(false);
        });

        test("marks the mail server's self-signed stand-in", async () => {
            const status = await statusWith('edge,mail', 'expires-2036.crt');
            expect(status.certExpiresAt).toBe('2036-12-31T23:59:59.000Z');
            expect(status.certSelfSigned).toBe(true);
        });

        test('without a certificate file, the edge profile means the bundled Caddy holds it', async () => {
            const status = await statusWith('edge');
            expect(status.certExpiresAt).toBeNull();
            expect(status.bundledCaddy).toBe(true);
        });

        test('without a certificate file or the edge profile, a web server in front holds it', async () => {
            const status = await statusWith('static,mail');
            expect(status.certExpiresAt).toBeNull();
            expect(status.bundledCaddy).toBe(false);
        });
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

        test('a sender equal to the default is stored empty, so it follows a later rename or domain', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    mail: { senderName: ` ${getOrgName()} `, senderAddress: defaultSenderAddress(getMailDomain()) },
                }),
            });
            const settings = await assertJson<ServerSettings>(res);
            expect(settings.mail).toMatchObject({ senderName: '', senderAddress: '' });
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

        test('the team setup named after the organization follows the rename, and a team named by hand keeps its name', async () => {
            const orgId = getServerConfig()?.orgId ?? '';
            const current = getAuthDrizzleDb()
                .select({ name: organizationSchema.name })
                .from(organizationSchema)
                .where(eq(organizationSchema.id, orgId))
                .get();
            const named = await auth.api.createTeam({ body: { name: current?.name ?? '', organizationId: orgId } });
            const design = await auth.api.createTeam({ body: { name: 'Design', organizationId: orgId } });
            try {
                const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/organization', {
                    method: 'PUT',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ name: 'Acme Teams' }),
                });
                expect(res.status).toBe(200);
                const nameOf = (id: string) =>
                    getAuthDrizzleDb()
                        .select({ name: teamSchema.name })
                        .from(teamSchema)
                        .where(eq(teamSchema.id, id))
                        .get()?.name;
                expect(nameOf(named.id)).toBe('Acme Teams');
                expect(nameOf(design.id)).toBe('Design');
            } finally {
                getAuthDrizzleDb()
                    .delete(teamSchema)
                    .where(inArray(teamSchema.id, [named.id, design.id]))
                    .run();
            }
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
        restoreEnvAfterEach(['MAIL_ENABLED', 'SMTP_RELAY_HOST']);

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

        test('without a relay it says so instead of failing on a missing sendmail', async () => {
            process.env['MAIL_ENABLED'] = '0';
            delete process.env['SMTP_RELAY_HOST'];
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/mail/test', { method: 'POST' });
            expect(res.status).toBe(502);
            expect(await res.text()).toContain('Run ./eigen setup and name a relay');
        });

        test('an admin cannot send it', async () => {
            const res = await authedRequest(admin.sessionToken, '/settings/mail/test', { method: 'POST' });
            expect(res.status).toBe(403);
        });
    });
});
