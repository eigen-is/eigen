import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSenderAddress } from '@workspace/lib/constants/mail';
import { EMPTY_S3, type S3Config } from '@workspace/lib/types/mount';
import type { ServerSettings, ServerSettingsSaved } from '@workspace/lib/types/settings';
import { and, eq, inArray } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { member as memberSchema, organization as organizationSchema, team as teamSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getDataRoot } from '../../lib/config/paths';
import { getMailDomain, getOrgName, getServerConfig } from '../../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import type { ControlStatus } from '../../lib/config/server-status';
import * as mailer from '../../lib/core/mailer';
import { LocalStorage } from '../../lib/storage/local-storage';
import { restoreEnvAfterEach } from '../env-test-helpers';
import { FakeS3Server } from '../fake-s3-server';
import { assertJson, authedRequest, createTestUser, getTestContext, type TestUser } from '../setup';
import { TEST_DATA_DIR } from '../test-env';

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

    describe('the backup settings', () => {
        const destination = {
            endpoint: 'https://backups.example.com',
            bucket: 'eigen-backups',
            prefix: 'nightly',
            accessKeyId: 'backup-key-id',
            secretAccessKey: 'backup-secret',
        };

        function putBackups(sessionToken: string, backups: unknown): Promise<Response> {
            return authedRequest(sessionToken, '/settings/server', {
                method: 'PUT',
                headers: JSON_HEADERS,
                body: JSON.stringify({ backups }),
            });
        }

        afterAll(async () => {
            await updateServerSettings({
                backups: {
                    schedule: { enabled: false, hourUtc: 2, withS3: false, keep: 7 },
                    upload: { enabled: false, s3: { ...EMPTY_S3, region: undefined }, keep: 30 },
                },
            });
        });

        test('start with the schedule off at 02:00 UTC keeping seven, and no destination', async () => {
            const settings = await assertJson<ServerSettings>(
                await authedRequest(ctx.alice.user.sessionToken, '/settings/server'),
            );
            expect(settings.backups.schedule).toEqual({ enabled: false, hourUtc: 2, withS3: false, keep: 7 });
            expect(settings.backups.upload.enabled).toBe(false);
            expect(settings.backups.upload.keep).toBe(30);
        });

        test('the owner turns the schedule on, and a later save of one field keeps the rest', async () => {
            const on = await assertJson<ServerSettings>(
                await putBackups(ctx.alice.user.sessionToken, {
                    schedule: { enabled: true, hourUtc: 23, withS3: true, keep: 14 },
                }),
            );
            expect(on.backups.schedule).toEqual({ enabled: true, hourUtc: 23, withS3: true, keep: 14 });
            const later = await assertJson<ServerSettings>(
                await putBackups(ctx.alice.user.sessionToken, { schedule: { hourUtc: 0 } }),
            );
            expect(later.backups.schedule).toEqual({ enabled: true, hourUtc: 0, withS3: true, keep: 14 });
        });

        test('an hour that is not one of the day, and a keep under one, are refused', async () => {
            for (const schedule of [{ hourUtc: 24 }, { hourUtc: -1 }, { hourUtc: 1.5 }, { keep: 0 }, { keep: 2.5 }]) {
                const res = await putBackups(ctx.alice.user.sessionToken, { schedule });
                expect(res.status).toBe(422);
            }
        });

        test('a keep or hour out of range answers a message that names the field and its range', async () => {
            for (const backups of [{ schedule: { keep: 0 } }, { upload: { keep: 400 } }]) {
                const res = await putBackups(ctx.alice.user.sessionToken, backups);
                expect(res.status).toBe(422);
                expect(await res.text()).toBe('Backups to keep must be a whole number from 1 to 365');
            }
            const res = await putBackups(ctx.alice.user.sessionToken, { schedule: { hourUtc: 24 } });
            expect(res.status).toBe(422);
            expect(await res.text()).toBe('The backup hour must be a whole number from 0 to 23');
        });

        test('an admin cannot change them', async () => {
            const res = await putBackups(admin.sessionToken, { schedule: { enabled: true } });
            expect(res.status).toBe(403);
        });

        test('an admin reads neither the destination nor the schedule', async () => {
            await updateServerSettings({
                backups: { schedule: { enabled: true, hourUtc: 5 }, upload: { enabled: true, s3: destination } },
            });
            const settings = await assertJson<ServerSettings>(
                await authedRequest(admin.sessionToken, '/settings/server'),
            );
            expect(settings.backups).toEqual({
                schedule: { enabled: false, hourUtc: 2, withS3: false, keep: 7 },
                upload: { enabled: false, s3: EMPTY_S3, keep: 30 },
            });
            await updateServerSettings({
                backups: { schedule: { enabled: false, hourUtc: 2 }, upload: { enabled: false } },
            });
        });

        test("the destination's secret reaches nobody, the owner included, nor a save's answer", async () => {
            await updateServerSettings({ backups: { upload: { s3: destination } } });
            const settings = await assertJson<ServerSettings>(
                await authedRequest(ctx.alice.user.sessionToken, '/settings/server'),
            );
            expect(settings.backups.upload.s3).toEqual({ ...destination, secretAccessKey: '' });
            const saved = await assertJson<ServerSettingsSaved>(
                await putBackups(ctx.alice.user.sessionToken, { upload: { s3: destination } }),
            );
            expect(saved.backups.upload.s3.secretAccessKey).toBe('');
            expect(getServerSettings().backups.upload.s3).toEqual(destination);
        });

        test('a blank secret keeps the stored one while the key, endpoint and bucket stay', async () => {
            await updateServerSettings({ backups: { upload: { s3: destination } } });
            const saved = await assertJson<ServerSettingsSaved>(
                await putBackups(ctx.alice.user.sessionToken, {
                    upload: { s3: { ...destination, prefix: 'weekly', secretAccessKey: '' }, keep: 12 },
                }),
            );
            expect(saved.backups.upload.keep).toBe(12);
            expect(getServerSettings().backups.upload.s3).toEqual({ ...destination, prefix: 'weekly' });
        });

        test('a blank secret beside another key id, endpoint or bucket is refused, and nothing is saved', async () => {
            await updateServerSettings({ backups: { upload: { s3: destination } } });
            for (const changed of [
                { accessKeyId: 'another-key' },
                { endpoint: 'https://s3.elsewhere.example' },
                { bucket: 'another-bucket' },
            ]) {
                const res = await putBackups(ctx.alice.user.sessionToken, {
                    upload: { s3: { ...destination, ...changed, secretAccessKey: '' } },
                });
                expect(res.status).toBe(400);
            }
            expect(getServerSettings().backups.upload.s3).toEqual(destination);
        });

        test('a bucket name S3 does not allow is refused, even with uploads off', async () => {
            const res = await putBackups(ctx.alice.user.sessionToken, {
                upload: { s3: { ...destination, bucket: 'Eigen_Backups' } },
            });
            expect(res.status).toBe(400);
            expect(await res.text()).toContain('bucket name');
        });

        describe('turned on', () => {
            let fake: FakeS3Server;
            let bucket: S3Config;

            beforeAll(async () => {
                fake = new FakeS3Server(new LocalStorage(mkdtempSync(join(TEST_DATA_DIR, 'settings-bucket-'))));
                bucket = { ...(await fake.start()), bucket: 'eigen-backups', prefix: '', accessKeyId: 'backup-key-id' };
            });

            beforeEach(async () => {
                await updateServerSettings({
                    defaults: { mount: { s3Config: undefined } },
                    backups: { upload: { enabled: false, s3: { ...EMPTY_S3, region: undefined }, keep: 30 } },
                });
            });

            afterAll(async () => {
                await fake.stop();
            });

            test('a destination that checks out is saved, and the owner hears once that its keys belong off the box', async () => {
                const first = await assertJson<ServerSettingsSaved>(
                    await putBackups(ctx.alice.user.sessionToken, { upload: { enabled: true, s3: bucket } }),
                );
                expect(first.backups.upload).toEqual({
                    enabled: true,
                    s3: { ...bucket, secretAccessKey: '' },
                    keep: 30,
                });
                expect(getServerSettings().backups.upload.s3).toEqual(bucket);
                expect(first.notice).toContain('keep them somewhere other than this server');
                expect(first.warning).toContain('AbortIncompleteMultipartUpload');
                const again = await assertJson<ServerSettingsSaved>(
                    await putBackups(ctx.alice.user.sessionToken, { upload: { keep: 20 } }),
                );
                expect(again.backups.upload.keep).toBe(20);
                expect(again.notice).toBeUndefined();
            });

            test('a data bucket and a public one are refused, and nothing is saved', async () => {
                await updateServerSettings({
                    defaults: { mount: { s3Config: { ...bucket, prefix: 'drives', accessKeyId: 'data-key' } } },
                });
                const dataBucket = await putBackups(ctx.alice.user.sessionToken, {
                    upload: { enabled: true, s3: { ...bucket, prefix: 'backups' } },
                });
                expect(dataBucket.status).toBe(400);
                expect(await dataBucket.text()).toContain('holds Eigen data');
                await updateServerSettings({ defaults: { mount: { s3Config: undefined } } });

                fake.publicRead = true;
                const open = await putBackups(ctx.alice.user.sessionToken, { upload: { enabled: true, s3: bucket } });
                fake.publicRead = false;
                expect(open.status).toBe(400);
                expect(await open.text()).toContain('Anyone can read');

                const settings = await assertJson<ServerSettings>(
                    await authedRequest(ctx.alice.user.sessionToken, '/settings/server'),
                );
                expect(settings.backups.upload).toEqual({ enabled: false, s3: EMPTY_S3, keep: 30 });
            });

            test('turning it on without a destination is refused', async () => {
                const res = await putBackups(ctx.alice.user.sessionToken, { upload: { enabled: true } });
                expect(res.status).toBe(400);
            });
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
