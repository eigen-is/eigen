import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { type S3Config, teamOwnerId } from '@workspace/lib/types';
import type { AdminUserRow } from '@workspace/lib/types/admin';
import type { DrivePath } from '@workspace/lib/types/drive';
import type {
    HomeSizeResponse,
    MountResponse,
    S3HardenResult,
    ServerSettings,
    TeamSettings,
    UserSettings,
} from '@workspace/lib/types/settings';
import { eq, inArray } from 'drizzle-orm';
import { user } from '../../../auth-schema';
import { ensureAuthSchemaColumns, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig } from '../../lib/config/server-config';
import { assertJson, authedRequest, getTestContext } from '../setup';

describe('Server Settings', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('admin can read server settings', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        const data = await assertJson<ServerSettings>(res);
        expect(data.quotas).toBeDefined();
        expect(data.quotas.mailAndContactsMaxMB).toBeGreaterThan(0);
        expect(data.quotas.defaultMountMaxSizeMB).toBeGreaterThan(0);
        expect(data.quotas.maxUploadSizeMB).toBeGreaterThan(0);
        expect(data.defaults).toBeDefined();
        expect(data.defaults.mount.storageType).toBeDefined();
    });

    test('non-admin cannot read server settings', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, '/settings/server');
        expect(res.status).toBe(403);
    });

    test('admin can update quotas', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotas: { maxUploadSizeMB: 50 } }),
        });
        const data = await assertJson<ServerSettings>(res);
        expect(data.quotas.maxUploadSizeMB).toBe(50);
        expect(data.quotas.mailAndContactsMaxMB).toBeGreaterThan(0);
    });

    test('admin can update default storage type', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ defaults: { mount: { storageType: 'local-fullnames' } } }),
        });
        const data = await assertJson<ServerSettings>(res);
        expect(data.defaults.mount.storageType).toBe('local-fullnames');
    });

    test('non-admin cannot update server settings', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotas: { maxUploadSizeMB: 99 } }),
        });
        expect(res.status).toBe(403);
    });

    test('restore default upload size', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quotas: { maxUploadSizeMB: 35 },
                defaults: { mount: { storageType: 'local-id' } },
            }),
        });
        expect(res.status).toBe(200);
    });
});

describe('landing links', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('admin can set and read back landing links', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ landing: { links: [{ title: 'Docs', url: 'https://docs.eigen.is' }] } }),
        });
        expect(res.status).toBe(200);
        const settings = await assertJson<ServerSettings>(
            await authedRequest(ctx.alice.user.sessionToken, '/settings/server'),
        );
        expect(settings.landing.links).toEqual([{ title: 'Docs', url: 'https://docs.eigen.is' }]);
    });

    test('rejects non-http(s) urls', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ landing: { links: [{ title: 'Evil', url: 'javascript:alert(1)' }] } }),
        });
        expect(res.status).toBe(422);
    });

    test('rejects empty title', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ landing: { links: [{ title: '', url: 'https://ok.example' }] } }),
        });
        expect(res.status).toBe(422);
    });

    // Reset to defaults — JsonStore is shared across the whole suite.
    test('reset landing links', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ landing: { links: [] } }),
        });
        expect(res.status).toBe(200);
    });
});

describe('Quota Enforcement', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const mountList = await assertJson<{ id: string }[]>(mountsRes);
        aliceMountId = mountList[0]?.id || 'default';
        const rootRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/root`,
        );
        const root = await assertJson<DrivePath>(rootRes);
        aliceRootId = root.id;
    });

    test('upload within quota succeeds', async () => {
        const file = new File(['small content'], 'quota-test.txt', { type: 'text/plain' });
        const formData = new FormData();
        formData.append('file', file);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`,
            { method: 'POST', body: formData },
        );
        expect(res.status).toBe(200);
    });

    test('upload exceeding max upload size returns 413', async () => {
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotas: { maxUploadSizeMB: 1 } }),
        });

        const bigContent = 'x'.repeat(2 * 1024 * 1024);
        const file = new File([bigContent], 'big.txt', { type: 'text/plain' });
        const formData = new FormData();
        formData.append('file', file);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`,
            { method: 'POST', body: formData },
        );
        expect(res.status).toBe(413);

        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quotas: { maxUploadSizeMB: 35 } }),
        });
    });
});

describe('Team Mount Management', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: config!.orgId }),
        });

        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Settings Test Team', organizationId: config!.orgId }),
        });
        const team = (await res.json()) as { id: string; name: string };
        teamId = team.id;
    });

    test('team starts with no mounts', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const mounts = await assertJson<Record<string, unknown>>(res);
        expect(Object.keys(mounts).length).toBe(0);
    });

    test('admin can add a mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mount`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Shared Files', maxSizeMB: 200 }),
        });
        const mount = await assertJson<MountResponse>(res);
        expect(mount.id).toBeTruthy();
        expect(mount.name).toBe('Shared Files');
        expect(mount.maxSizeMB).toBe(200);
        expect(mount.enabled).toBe(true);
    });

    test('mounts list shows the new mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const mounts = await assertJson<Record<string, unknown>>(res);
        expect(Object.keys(mounts).length).toBe(1);
    });

    test('admin can disable a mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const mounts = await assertJson<Record<string, MountResponse>>(res);
        const mountId = Object.keys(mounts)[0];

        const updateRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/team/${teamOwnerId(teamId)}/mount/${mountId}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false }),
            },
        );
        const updated = await assertJson<MountResponse>(updateRes);
        expect(updated.enabled).toBe(false);
    });

    test('admin can update memberOverrides', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { mailAndContactsMaxMB: 200 } }),
        });
        expect(res.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`);
        const settings = await assertJson<TeamSettings>(getRes);
        expect(settings.memberOverrides!.mailAndContactsMaxMB).toBe(200);
    });

    test('clearing memberOverride sets to null', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { mailAndContactsMaxMB: null } }),
        });
        expect(res.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`);
        const settings = await assertJson<TeamSettings>(getRes);
        expect(settings.memberOverrides?.mailAndContactsMaxMB).toBeUndefined();
    });

    test('admin can add a second mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mount`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Archives', storageType: 'local-key', maxSizeMB: 100 }),
        });
        const mount = await assertJson<MountResponse>(res);
        expect(mount.name).toBe('Archives');
        expect(mount.storageType).toBe('local-key');
        expect(mount.maxSizeMB).toBe(100);
    });

    test('mounts list shows both mounts', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const mounts = await assertJson<Record<string, MountResponse>>(res);
        expect(Object.keys(mounts).length).toBe(2);
        const names = Object.values(mounts).map((m) => m.name);
        expect(names).toContain('Shared Files');
        expect(names).toContain('Archives');
    });

    test('disabling one mount does not affect the other', async () => {
        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const mounts = await assertJson<Record<string, MountResponse>>(listRes);
        // Select by name, not Object.keys order — all-digit mount ids reorder the keys
        // numerically, which used to surface a residual-disabled mount from an earlier test.
        const sharedId = Object.entries(mounts).find(([, m]) => m.name === 'Shared Files')![0];
        const archiveId = Object.entries(mounts).find(([, m]) => m.name === 'Archives')![0];

        // Normalize both to enabled so the assertion doesn't depend on earlier tests' state.
        for (const id of [sharedId, archiveId]) {
            await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mount/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true }),
            });
        }

        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mount/${archiveId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        });

        const afterRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const after = await assertJson<Record<string, MountResponse>>(afterRes);
        expect(after[archiveId].enabled).toBe(false);
        expect(after[sharedId].enabled).toBe(true);
    });

    test('admin can update specific mount among multiple', async () => {
        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mounts`);
        const mounts = await assertJson<Record<string, MountResponse>>(listRes);
        const archiveId = Object.entries(mounts).find(([, m]) => m.name === 'Archives')![0];

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/team/${teamOwnerId(teamId)}/mount/${archiveId}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ maxSizeMB: 250, name: 'Archives (Expanded)' }),
            },
        );
        const updated = await assertJson<MountResponse>(res);
        expect(updated.maxSizeMB).toBe(250);
        expect(updated.name).toBe('Archives (Expanded)');
        expect(updated.storageType).toBe('local-key');
    });

    test('updating nonexistent mount returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mount/nonexistent`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        });
        expect(res.status).toBe(404);
    });
});

describe('Quota Resolution with Team Overrides', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: config!.orgId }),
        });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Quota Test Team', organizationId: config!.orgId }),
        });
        const team = (await teamRes.json()) as { id: string; name: string };
        teamId = team.id;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.alice.user.id }),
        });
    });

    test('team override elevates user quota via home/size', async () => {
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: 1000 } }),
        });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/size`);
        const size = await assertJson<HomeSizeResponse>(sizeRes);
        expect(size.drive.default.max).toBe(1000 * 1024 * 1024);
    });

    test('server default applies when team override is cleared', async () => {
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: null } }),
        });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/size`);
        const size = await assertJson<HomeSizeResponse>(sizeRes);
        expect(size.drive.default.max).toBe(500 * 1024 * 1024);
    });

    test('most permissive team override wins', async () => {
        const team2Res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Quota Test Team 2', organizationId: getServerConfig()!.orgId }),
        });
        const team2 = (await team2Res.json()) as { id: string; name: string };

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team2.id, userId: ctx.alice.user.id }),
        });

        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: 200 } }),
        });
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(team2.id)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: 800 } }),
        });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/size`);
        const size = await assertJson<HomeSizeResponse>(sizeRes);
        expect(size.drive.default.max).toBe(800 * 1024 * 1024);

        // Clean up
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: null } }),
        });
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(team2.id)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: null } }),
        });
    });

    test('team override below server default still uses server default (most permissive)', async () => {
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: 50 } }),
        });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/size`);
        const size = await assertJson<HomeSizeResponse>(sizeRes);
        // Server default is 500 MB, team says 50 MB — max(500, 50) = 500
        expect(size.drive.default.max).toBe(500 * 1024 * 1024);

        // Clean up
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB: null } }),
        });
    });
});

describe('Setup Flow', () => {
    test('setup generates auth secret in config', async () => {
        await getTestContext();
        const config = getServerConfig();
        expect(config).not.toBeNull();
        expect(config!.secret).toBeTruthy();
        expect(config!.secret.length).toBeGreaterThan(20);
    });

    test('server settings have sensible defaults', async () => {
        const ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        const data = await assertJson<ServerSettings>(res);
        expect(data.quotas.mailAndContactsMaxMB).toBe(100);
        expect(data.quotas.defaultMountMaxSizeMB).toBe(500);
        expect(data.quotas.maxUploadSizeMB).toBe(35);
    });
});

describe('Email notification toggles', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('GET exposes notifications.email with defaults', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        const data = await assertJson<ServerSettings>(res);
        expect(data.notifications.email.guestOnAclAdd).toBe(true);
        expect(data.notifications.email.userOnAclAdd).toBe(false);
        expect(data.notifications.email.userOnCalendarInvite).toBe(true);
        expect(data.notifications.email.ownerOnAccessRequest).toBe(true);
    });

    test('PUT round-trips notifications.email', async () => {
        const putRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                notifications: { email: { userOnAclAdd: true, userOnCalendarInvite: false } },
            }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        const data = await assertJson<ServerSettings>(getRes);
        expect(data.notifications.email.userOnAclAdd).toBe(true);
        expect(data.notifications.email.userOnCalendarInvite).toBe(false);
        expect(data.notifications.email.guestOnAclAdd).toBe(true); // deep-merge preserves untouched fields

        // Reset to defaults — JsonStore is shared across the whole suite.
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                notifications: { email: { userOnAclAdd: false, userOnCalendarInvite: true } },
            }),
        });
    });
});

describe('User Settings', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('PUT and GET round-trips email signatures', async () => {
        const sig = { id: 'sig-roundtrip', name: 'Default', html: '<p>Cheers, Alice</p>' };
        const putRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { signatures: [sig] } }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`);
        const data = await assertJson<UserSettings>(getRes);
        expect(data.email?.signatures).toEqual([sig]);
    });

    test('updating theme does not clobber email.signatures (cross-namespace deep merge)', async () => {
        const sig = { id: 'sig-merge', name: 'Default', html: '<p>Hi</p>' };
        await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { signatures: [sig] } }),
        });

        await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: 'dark' }),
        });

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`);
        const data = await assertJson<UserSettings>(getRes);
        expect(data.theme).toBe('dark');
        expect(data.email?.signatures).toEqual([sig]);
    });

    test('PUT and GET round-trips driveView', async () => {
        const driveView = { mode: 'grid', sortKey: 'modified', sortDir: 'desc' } as const;
        const putRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driveView }),
        });
        expect(putRes.status).toBe(200);
        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`);
        const data = await assertJson<UserSettings>(getRes);
        expect(data.driveView).toEqual(driveView);
    });

    test('updating driveView does not clobber theme', async () => {
        await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: 'dark' }),
        });
        await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driveView: { mode: 'grid', sortKey: 'name', sortDir: 'asc' } }),
        });
        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`);
        const data = await assertJson<UserSettings>(getRes);
        expect(data.theme).toBe('dark');
        expect(data.driveView?.mode).toBe('grid');
    });

    test('PUT with invalid driveView.mode returns 422', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driveView: { mode: 'tiles' } }),
        });
        expect(res.status).toBe(422);
    });

    test('PUT with malformed signature returns 422', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { signatures: [{ id: 'x', name: 'y' }] } }),
        });
        expect(res.status).toBe(422);
    });

    test('PUT and GET round-trips email keyboardShortcuts and autoAdvance', async () => {
        const putRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { keyboardShortcuts: true, autoAdvance: 'newer' } }),
        });
        expect(putRes.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`);
        const data = await assertJson<UserSettings>(getRes);
        expect(data.email?.keyboardShortcuts).toBe(true);
        expect(data.email?.autoAdvance).toBe('newer');
    });

    test('PUT with invalid autoAdvance returns 422', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { autoAdvance: 'bogus' } }),
        });
        expect(res.status).toBe(422);
    });

    test('updating autoAdvance does not clobber email.signatures (deep merge)', async () => {
        const sig = { id: 'sig-autoadvance', name: 'Default', html: '<p>Regards</p>' };
        await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { signatures: [sig] } }),
        });

        await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: { autoAdvance: 'list' } }),
        });

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/space/${ctx.alice.user.id}/settings`);
        const data = await assertJson<UserSettings>(getRes);
        expect(data.email?.autoAdvance).toBe('list');
        expect(data.email?.signatures).toEqual([sig]);
    });
});

describe('lastLoginAt', () => {
    test('is stamped on sign-in', async () => {
        const ctx = await getTestContext();
        const row = await getAuthDrizzleDb()
            .select({ lastLoginAt: user.lastLoginAt })
            .from(user)
            .where(eq(user.id, ctx.alice.user.id))
            .get();
        expect(row?.lastLoginAt).toBeInstanceOf(Date);
    });

    test('ensureAuthSchemaColumns adds the column to a pre-migration db', () => {
        const db = new Database(':memory:');
        db.run(`CREATE TABLE "user" ("id" text PRIMARY KEY NOT NULL, "name" text NOT NULL)`);
        ensureAuthSchemaColumns(db);
        ensureAuthSchemaColumns(db); // idempotent
        const cols = db.query<{ name: string }, []>(`PRAGMA table_info(user)`).all();
        expect(cols.some((c) => c.name === 'last_login_at')).toBe(true);
    });
});

describe('S3 Config Persistence', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('GET /settings/s3config returns null when not configured', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3config');
        expect(res.status).toBe(200);
        const text = await res.text();
        // Elysia serializes a `null` return as either empty body or the string "null"
        expect(text === '' || text === 'null').toBe(true);
    });

    test('PUT /settings/s3config persists into ServerSettings and round-trips through GETs', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'checkS3Connection').mockResolvedValueOnce({
            ok: true,
            message: 'Connection successful',
            versioning: 'enabled',
        });

        const config: S3Config = {
            endpoint: 'https://s3.example.com',
            bucket: 'eigen-test',
            prefix: 'data',
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'secret-example',
            region: 'eu-west-1',
        };

        try {
            const putRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });
            const persisted = await assertJson<S3Config>(putRes);
            expect(persisted).toEqual(config);

            const getRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3config');
            const fromGet = await assertJson<S3Config>(getRes);
            expect(fromGet).toEqual(config);

            const serverRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
            const server = await assertJson<ServerSettings>(serverRes);
            expect(server.defaults.mount.s3Config).toEqual(config);
        } finally {
            spy.mockRestore();
        }
    });

    test('PUT /settings/s3config returns 400 and does not persist when connection check fails', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'checkS3Connection').mockResolvedValueOnce({
            ok: false,
            message: 'invalid credentials',
        });

        const before = await assertJson<S3Config>(
            await authedRequest(ctx.alice.user.sessionToken, '/settings/s3config'),
        );

        try {
            const putRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    endpoint: 'https://bad.example',
                    bucket: 'bad',
                    prefix: '',
                    accessKeyId: 'bad',
                    secretAccessKey: 'bad',
                }),
            });
            expect(putRes.status).toBe(400);
        } finally {
            spy.mockRestore();
        }

        const after = await assertJson<S3Config>(
            await authedRequest(ctx.alice.user.sessionToken, '/settings/s3config'),
        );
        expect(after).toEqual(before);
    });

    test('non-admin cannot read or update S3 config', async () => {
        const getRes = await authedRequest(ctx.bob.user.sessionToken, '/settings/s3config');
        expect(getRes.status).toBe(403);

        const putRes = await authedRequest(ctx.bob.user.sessionToken, '/settings/s3config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: 'https://x',
                bucket: 'x',
                prefix: '',
                accessKeyId: 'x',
                secretAccessKey: 'x',
            }),
        });
        expect(putRes.status).toBe(403);
    });
});

describe('S3 Bucket Hardening', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    const hardenBody = {
        endpoint: 'https://s3.example.com',
        bucket: 'eigen-test',
        prefix: 'data',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret-example',
        region: 'eu-west-1',
        noncurrentDays: 30,
    };

    test('POST /settings/s3harden returns the harden result and threads the retention days', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'hardenS3Bucket').mockResolvedValueOnce({
            ok: true,
            message: 'Versioning enabled. Old-version cleanup rule applied.',
            versioning: 'enabled',
            lifecycle: { noncurrentDays: 30 },
            applied: { versioning: true, lifecycle: true },
        });

        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3harden', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(hardenBody),
            });
            const data = await assertJson<S3HardenResult>(res);
            expect(data.applied).toEqual({ versioning: true, lifecycle: true });
            expect(data.versioning).toBe('enabled');
            expect(data.lifecycle).toEqual({ noncurrentDays: 30 });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0]?.[0].bucket).toBe('eigen-test');
            expect(spy.mock.calls[0]?.[0].prefix).toBe('data');
            expect(spy.mock.calls[0]?.[1]).toBe(30);
        } finally {
            spy.mockRestore();
        }
    });

    test('POST /settings/s3harden reports a partial application without failing the request', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'hardenS3Bucket').mockResolvedValueOnce({
            ok: false,
            message: 'Versioning enabled. An existing lifecycle configuration was found.',
            versioning: 'enabled',
            lifecycle: 'foreign',
            applied: { versioning: true, lifecycle: false },
            reason: 'foreign-lifecycle',
        });

        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3harden', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(hardenBody),
            });
            const data = await assertJson<S3HardenResult>(res);
            expect(data.reason).toBe('foreign-lifecycle');
            expect(data.applied).toEqual({ versioning: true, lifecycle: false });
        } finally {
            spy.mockRestore();
        }
    });

    test('non-admin cannot harden a bucket and the bucket is never touched', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'hardenS3Bucket');

        try {
            const res = await authedRequest(ctx.bob.user.sessionToken, '/settings/s3harden', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(hardenBody),
            });
            expect(res.status).toBe(403);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test('POST /settings/s3harden rejects a retention below one day', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'hardenS3Bucket');

        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/s3harden', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...hardenBody, noncurrentDays: 0 }),
            });
            expect(res.status).toBe(422);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test('POST /setup/s3harden is refused once setup is completed', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'hardenS3Bucket');

        try {
            const res = await ctx.app.handle(
                new Request('http://localhost/setup/s3harden', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(hardenBody),
                }),
            );
            expect(res.status).toBe(403);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('GET /settings/users', () => {
    test('403 for non-admin', async () => {
        const ctx = await getTestContext();
        const res = await authedRequest(ctx.bob.user.sessionToken, '/settings/users');
        expect(res.status).toBe(403);
    });

    test('lists members and orphans, excludes guests', async () => {
        const ctx = await getTestContext();
        const db = getAuthDrizzleDb();
        const now = new Date();
        await db.insert(user).values({
            id: 'orphan-test-id',
            name: 'Orphan',
            email: 'orphan@test.eigen.is',
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
        });
        await db.insert(user).values({
            id: 'guest-test-id',
            name: 'Guest',
            email: 'guest-row@test.eigen.is',
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
            role: 'guest',
        });
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/users');
        expect(res.status).toBe(200);
        const rows: AdminUserRow[] = await res.json();
        const orphan = rows.find((r) => r.id === 'orphan-test-id');
        expect(orphan?.role).toBeNull();
        expect(orphan?.memberId).toBeNull();
        expect(rows.find((r) => r.id === 'guest-test-id')).toBeUndefined();
        const aliceRow = rows.find((r) => r.email === 'alice@test.eigen.is');
        expect(aliceRow?.role).toBe('owner');
        expect(aliceRow?.lastActiveAt).not.toBeNull();
        expect(Array.isArray(aliceRow?.teams)).toBe(true);
        // cleanup so other tests' user counts stay stable
        await db.delete(user).where(inArray(user.id, ['orphan-test-id', 'guest-test-id']));
    });
});

describe('GET /settings/users/usage', () => {
    test('403 for non-admin', async () => {
        const ctx = await getTestContext();
        const res = await authedRequest(ctx.bob.user.sessionToken, '/settings/users/usage');
        expect(res.status).toBe(403);
    });

    test('returns HomeSizeResponse per user', async () => {
        const ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/users/usage');
        expect(res.status).toBe(200);
        const usage: Record<string, HomeSizeResponse> = await res.json();
        const mine = usage[ctx.alice.user.id];
        expect(mine?.total.max).toBeGreaterThan(0);
        expect(mine?.drive.default).toBeDefined();
        expect(mine?.mailAndContacts).toBeDefined();
    });
});
