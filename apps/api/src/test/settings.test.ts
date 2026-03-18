import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';
import {getServerConfig} from '../lib/config/server-config';

describe('Server Settings', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('admin can read server settings', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.quotas).toBeDefined();
        expect(data.quotas.mailAndContactsMaxMB).toBeGreaterThan(0);
        expect(data.quotas.defaultMountMaxSizeMB).toBeGreaterThan(0);
        expect(data.quotas.maxUploadSizeMB).toBeGreaterThan(0);
        expect(data.quotas.maxBatchUploadSizeMB).toBeGreaterThan(0);
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
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({quotas: {maxUploadSizeMB: 50}}),
        });
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.quotas.maxUploadSizeMB).toBe(50);
        expect(data.quotas.mailAndContactsMaxMB).toBeGreaterThan(0);
    });

    test('admin can update default storage type', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({defaults: {mount: {storageType: 'local-fullnames'}}}),
        });
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.defaults.mount.storageType).toBe('local-fullnames');
    });

    test('non-admin cannot update server settings', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({quotas: {maxUploadSizeMB: 99}}),
        });
        expect(res.status).toBe(403);
    });

    test('restore default upload size', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                quotas: {maxUploadSizeMB: 35},
                defaults: {mount: {storageType: 'local-id'}},
            }),
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
        const mountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const mountList = await mountsRes.json() as {id: string}[];
        aliceMountId = mountList[0]?.id || 'default';
        const rootRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/root`);
        const root = await rootRes.json() as any;
        aliceRootId = root.id;
    });

    test('upload within quota succeeds', async () => {
        const file = new File(['small content'], 'quota-test.txt', {type: 'text/plain'});
        const formData = new FormData();
        formData.append('file', file);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`,
            {method: 'POST', body: formData},
        );
        expect(res.status).toBe(200);
    });

    test('upload exceeding max upload size returns 413', async () => {
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({quotas: {maxUploadSizeMB: 1}}),
        });

        const bigContent = 'x'.repeat(2 * 1024 * 1024);
        const file = new File([bigContent], 'big.txt', {type: 'text/plain'});
        const formData = new FormData();
        formData.append('file', file);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`,
            {method: 'POST', body: formData},
        );
        expect(res.status).toBe(413);

        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({quotas: {maxUploadSizeMB: 35}}),
        });
    });
});

describe('Team Mount Management', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: config!.orgId}),
            });

        const res = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Settings Test Team', organizationId: config!.orgId}),
            });
        const team = await res.json() as any;
        teamId = team.id;
    });

    test('team starts with no mounts', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        expect(res.status).toBe(200);
        const mounts = await res.json() as Record<string, unknown>;
        expect(Object.keys(mounts).length).toBe(0);
    });

    test('admin can add a mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mount`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: 'Shared Files', maxSizeMB: 200}),
        });
        expect(res.status).toBe(200);
        const mount = await res.json() as any;
        expect(mount.id).toBeTruthy();
        expect(mount.name).toBe('Shared Files');
        expect(mount.maxSizeMB).toBe(200);
        expect(mount.enabled).toBe(true);
    });

    test('mounts list shows the new mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        const mounts = await res.json() as Record<string, unknown>;
        expect(Object.keys(mounts).length).toBe(1);
    });

    test('admin can disable a mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        const mounts = await res.json() as Record<string, any>;
        const mountId = Object.keys(mounts)[0];

        const updateRes = await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/mount/${mountId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({enabled: false}),
            });
        expect(updateRes.status).toBe(200);
        const updated = await updateRes.json() as any;
        expect(updated.enabled).toBe(false);
    });

    test('admin can update memberOverrides', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {mailAndContactsMaxMB: 200}}),
            });
        expect(res.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/settings`);
        const settings = await getRes.json() as any;
        expect(settings.memberOverrides.mailAndContactsMaxMB).toBe(200);
    });

    test('clearing memberOverride sets to null', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {mailAndContactsMaxMB: null}}),
            });
        expect(res.status).toBe(200);

        const getRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/settings`);
        const settings = await getRes.json() as any;
        expect(settings.memberOverrides.mailAndContactsMaxMB).toBeUndefined();
    });

    test('admin can add a second mount', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mount`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: 'Archives', storageType: 'local-key', maxSizeMB: 100}),
        });
        expect(res.status).toBe(200);
        const mount = await res.json() as any;
        expect(mount.name).toBe('Archives');
        expect(mount.storageType).toBe('local-key');
        expect(mount.maxSizeMB).toBe(100);
    });

    test('mounts list shows both mounts', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        const mounts = await res.json() as Record<string, any>;
        expect(Object.keys(mounts).length).toBe(2);
        const names = Object.values(mounts).map((m: any) => m.name);
        expect(names).toContain('Shared Files');
        expect(names).toContain('Archives');
    });

    test('disabling one mount does not affect the other', async () => {
        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        const mounts = await listRes.json() as Record<string, any>;
        const [id1, id2] = Object.keys(mounts);

        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mount/${id1}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({enabled: false}),
        });

        const afterRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        const after = await afterRes.json() as Record<string, any>;
        expect(after[id1].enabled).toBe(false);
        expect(after[id2].enabled).toBe(true);
    });

    test('admin can update specific mount among multiple', async () => {
        const listRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mounts`);
        const mounts = await listRes.json() as Record<string, any>;
        const archiveId = Object.entries(mounts).find(([, m]: [string, any]) => m.name === 'Archives')![0];

        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mount/${archiveId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({maxSizeMB: 250, name: 'Archives (Expanded)'}),
        });
        expect(res.status).toBe(200);
        const updated = await res.json() as any;
        expect(updated.maxSizeMB).toBe(250);
        expect(updated.name).toBe('Archives (Expanded)');
        expect(updated.storageType).toBe('local-key');
    });

    test('updating nonexistent mount returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/mount/nonexistent`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({enabled: false}),
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

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: config!.orgId}),
            });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Quota Test Team', organizationId: config!.orgId}),
            });
        const team = await teamRes.json() as any;
        teamId = team.id;

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.alice.user.id}),
            });
    });

    test('team override elevates user quota via home/size', async () => {
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: 1000}}),
            });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken,
            `/home/${ctx.alice.user.id}/size`);
        const size = await sizeRes.json() as any;
        expect(size.drive.default.max).toBe(1000 * 1024 * 1024);
    });

    test('server default applies when team override is cleared', async () => {
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: null}}),
            });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken,
            `/home/${ctx.alice.user.id}/size`);
        const size = await sizeRes.json() as any;
        expect(size.drive.default.max).toBe(500 * 1024 * 1024);
    });

    test('most permissive team override wins', async () => {
        const team2Res = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Quota Test Team 2', organizationId: getServerConfig()!.orgId}),
            });
        const team2 = await team2Res.json() as any;

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team2.id, userId: ctx.alice.user.id}),
            });

        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: 200}}),
            });
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${team2.id}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: 800}}),
            });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken,
            `/home/${ctx.alice.user.id}/size`);
        const size = await sizeRes.json() as any;
        expect(size.drive.default.max).toBe(800 * 1024 * 1024);

        // Clean up
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: null}}),
            });
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${team2.id}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: null}}),
            });
    });

    test('team override below server default still uses server default (most permissive)', async () => {
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: 50}}),
            });

        const sizeRes = await authedRequest(ctx.alice.user.sessionToken,
            `/home/${ctx.alice.user.id}/size`);
        const size = await sizeRes.json() as any;
        // Server default is 500 MB, team says 50 MB — max(500, 50) = 500
        expect(size.drive.default.max).toBe(500 * 1024 * 1024);

        // Clean up
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({memberOverrides: {defaultMountMaxSizeMB: null}}),
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
        const data = await res.json() as any;
        expect(data.quotas.mailAndContactsMaxMB).toBe(100);
        expect(data.quotas.defaultMountMaxSizeMB).toBe(500);
        expect(data.quotas.maxUploadSizeMB).toBe(35);
        expect(data.quotas.maxBatchUploadSizeMB).toBe(10);
    });
});
