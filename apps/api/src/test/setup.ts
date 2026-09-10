// test-env sets EIGEN_DATA_ROOT before the app/auth imports below open their SQLite files. Keep it first.
import './test-env';
import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { treaty } from '@elysiajs/eden';
import { type DrivePath, type MountInfo, type OrgTeam, teamOwnerId } from '@workspace/lib/types';
import type { SSEvent } from '@workspace/lib/types/sse';
import { app } from '../app';
import { auth } from '../lib/auth/auth';
import { drainACLFanOuts } from '../lib/drive/acl-propagation';
import { getHome } from '../lib/home';
import { TEST_DATA_DIR } from './test-env';

type App = typeof app;

// Runs the setup wizard exactly once per worker process. No top-level await: under `bun test --parallel`
// (which implies `--isolate`), a suspended setup module is observed mid-evaluation by the importing test
// file, so its exports must be defined synchronously and the server booted lazily behind this gate.
let serverReady: Promise<void> | null = null;
export function ensureServer(): Promise<void> {
    if (!serverReady) serverReady = bootServer();
    return serverReady;
}
async function bootServer(): Promise<void> {
    const setupResponse = await app.handle(
        new Request('http://localhost/setup/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                domain: 'test.eigen.is',
                orgName: 'Test Organization',
                storageType: 'local-id',
                adminEmail: 'alice@test.eigen.is',
                adminPassword: 'testpassword123',
                adminName: 'Alice Test',
            }),
        }),
    );
    if (!setupResponse.ok) {
        throw new Error(`Setup failed (${setupResponse.status}): ${await setupResponse.text()}`);
    }
}

// In-process SSE listener: subscribes to a user's Home broadcast stream and
// collects every event until stop() is called.
export function collectSSE(userId: string): { events: SSEvent[]; stop: () => void } {
    const events: SSEvent[] = [];
    let home: Awaited<ReturnType<typeof getHome>> | null = null;
    const listener = (event: SSEvent) => events.push(event);
    const setup = getHome(userId).then((h) => {
        home = h;
        h.subscribeSSE(listener);
    });
    return {
        events,
        stop: () => {
            setup.then(() => {
                if (home) home.unsubscribeSSE(listener);
            });
        },
    };
}

type TestUser = {
    id: string;
    email: string;
    name: string;
    sessionToken: string;
};

export type TestContext = {
    alice: { user: TestUser; api: ReturnType<typeof treaty<App>> };
    bob: { user: TestUser; api: ReturnType<typeof treaty<App>> };
    charlie: { user: TestUser; api: ReturnType<typeof treaty<App>> };
    app: App;
};

let context: TestContext | null = null;

function extractSessionToken(headers: Headers): string {
    const setCookie = headers.get('set-cookie') || '';
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (!match) {
        const allCookies = setCookie.split(',').map((c) => c.trim());
        for (const cookie of allCookies) {
            const tokenMatch = cookie.match(/better-auth\.session_token=([^;]+)/);
            if (tokenMatch) return tokenMatch[1];
        }
        throw new Error(`Session token not found in set-cookie header: ${setCookie}`);
    }
    return match[1];
}

function createAuthenticatedClient(sessionToken: string) {
    return treaty<App>(app, {
        headers: {
            cookie: `better-auth.session_token=${sessionToken}`,
        },
    });
}

export async function createTestUser(email: string, password: string, name: string): Promise<TestUser> {
    let userId: string;
    let userName: string;

    try {
        const signUp = await auth.api.signUpEmail({
            body: { email, password, name },
        });
        userId = signUp.user.id;
        userName = signUp.user.name;
    } catch {
        const existing = await auth.api.signInEmail({ body: { email, password } });
        userId = existing.user.id;
        userName = existing.user.name;
    }

    const signIn = await auth.api.signInEmail({
        returnHeaders: true,
        body: { email, password },
    });

    const sessionToken = extractSessionToken(signIn.headers);

    return {
        id: userId,
        email,
        name: userName,
        sessionToken,
    };
}

export async function getTestContext(): Promise<TestContext> {
    if (context) return context;
    await ensureServer();

    const alice = await createTestUser('alice@test.eigen.is', 'testpassword123', 'Alice Test');
    const bob = await createTestUser('bob@test.eigen.is', 'testpassword123', 'Bob Test');
    const charlie = await createTestUser('charlie@test.eigen.is', 'testpassword123', 'Charlie Test');

    // Auto-join non-admin users to default org (Alice is already owner from setup)
    // await authAddUserToDefaultOrg(bob.id);
    // await authAddUserToDefaultOrg(charlie.id);

    context = {
        alice: {
            user: alice,
            api: createAuthenticatedClient(alice.sessionToken),
        },
        bob: {
            user: bob,
            api: createAuthenticatedClient(bob.sessionToken),
        },
        charlie: {
            user: charlie,
            api: createAuthenticatedClient(charlie.sessionToken),
        },
        app,
    };

    return context;
}

export async function authedRequest(sessionToken: string, path: string, options?: RequestInit): Promise<Response> {
    await ensureServer();
    // ACL fan-out to recipient homes is async (fire-and-forget after the mutation returns).
    // Draining here gives every test read-your-fanout consistency: a cross-user assertion
    // that follows a share/revoke/rename/trash sees the delivered mirror state, matching
    // what a real client experiences after its SSE-triggered refetch. No-op when idle.
    await drainACLFanOuts();
    return app.handle(
        new Request(`http://localhost${path}`, {
            ...options,
            headers: {
                ...options?.headers,
                cookie: `better-auth.session_token=${sessionToken}`,
            },
        }),
    );
}

// The server-wide upload bound every 413 test drives. Server settings are global, so
// a test that lowers it must restore 35 (the seeded default) in a finally block.
export async function setMaxUploadSizeMB(sessionToken: string, mb: number): Promise<void> {
    const res = await authedRequest(sessionToken, '/settings/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quotas: { maxUploadSizeMB: mb } }),
    });
    expect(res.status).toBe(200);
}

export function cleanup() {
    // if (existsSync(TEST_DATA_DIR)) {
    //     rmSync(TEST_DATA_DIR, {recursive: true, force: true});
    // }
}

export async function assertJson<T>(res: Response, expectedStatus = 200): Promise<T> {
    expect(res.status).toBe(expectedStatus);
    return (await res.json()) as T;
}

export function findOrFail<T>(arr: T[], pred: (t: T) => boolean, msg?: string): T {
    const result = arr.find(pred);
    if (result === undefined) throw new Error(msg ?? 'Item not found in array');
    return result;
}

export function driveUrl(ownerId: string, mountId: string, ...parts: string[]) {
    return `/drive/${ownerId}/${mountId}/${parts.join('/')}`;
}

export async function driveGet<T = DrivePath>(
    token: string,
    ownerId: string,
    mountId: string,
    ...parts: string[]
): Promise<T> {
    const res = await authedRequest(token, driveUrl(ownerId, mountId, ...parts));
    return res.status !== 200 ? ([] as T) : ((await res.json()) as T);
}

export type PermissionResult = { canRead: boolean; canWrite: boolean };

export function driveGetList(
    token: string,
    ownerId: string,
    mountId: string,
    ...parts: string[]
): Promise<DrivePath[]> {
    return driveGet<DrivePath[]>(token, ownerId, mountId, ...parts);
}

export function driveGetPermission(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
): Promise<PermissionResult> {
    return driveGet<PermissionResult>(token, ownerId, mountId, `path/${pathId}/permissions`);
}

export async function drivePost<T = DrivePath>(
    token: string,
    ownerId: string,
    mountId: string,
    path: string,
    body: Record<string, unknown>,
): Promise<T> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
}

export async function drivePut<T = { success: boolean }>(
    token: string,
    ownerId: string,
    mountId: string,
    path: string,
    body: Record<string, unknown>,
): Promise<T> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
}

export async function driveDelete<T = { success: boolean }>(
    token: string,
    ownerId: string,
    mountId: string,
    path: string,
): Promise<T> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, { method: 'DELETE' });
    return res.json() as Promise<T>;
}

export async function driveUpload<T = DrivePath>(
    token: string,
    ownerId: string,
    mountId: string,
    parentId: string,
    file: File,
): Promise<T> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${parentId}`, {
        method: 'POST',
        body: formData,
    });
    const data = await res.json();
    return (Array.isArray(data) ? data[0] : data) as T;
}

export async function driveUploadMultiple<T = DrivePath>(
    token: string,
    ownerId: string,
    mountId: string,
    parentId: string,
    files: File[],
): Promise<T[]> {
    const formData = new FormData();
    for (const file of files) formData.append('file', file);
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${parentId}`, {
        method: 'POST',
        body: formData,
    });
    return res.json() as Promise<T[]>;
}

// --- Team setup helpers (shared by the *-fanout integration tests). Team admin actions run as alice. ---

export async function createTeam(ctx: TestContext, orgId: string, name: string): Promise<string> {
    const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, organizationId: orgId }),
    });
    return (await assertJson<OrgTeam>(res)).id;
}

export async function addMember(ctx: TestContext, teamId: string, userId: string): Promise<void> {
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, userId }),
    });
}

export async function addTeamMount(ctx: TestContext, teamId: string, name: string): Promise<void> {
    await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/mount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, storageType: 'local', maxSizeMB: 500 }),
    });
}

export async function firstMountId(token: string, ownerId: string): Promise<string> {
    const res = await authedRequest(token, `/drive/${ownerId}/mounts`);
    const mounts = await assertJson<MountInfo[]>(res);
    return mounts[0].id;
}

export function chatPost<T = unknown>(
    token: string,
    ownerId: string,
    mountId: string,
    path: string,
    body: Record<string, unknown>,
): Promise<T> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<T>);
}

export function chatGet<T = unknown>(token: string, ownerId: string, mountId: string, path: string): Promise<T> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`).then((r) => r.json() as Promise<T>);
}

// A mount's metadata.db, for a test that reads storage keys straight out of the table. Read-write
// on purpose: a WAL database whose owner is not holding it open has no -shm beside it, and a
// read-only open of one fails outright (SQLITE_CANTOPEN) — the shape of every home folder a restore
// leaves behind. Only ever used for SELECTs.
export function openMountMetadata(metadataPath: string): Database {
    return new Database(metadataPath, { readwrite: true, create: false });
}

// Smallest valid 4x4 PNG — the shared image fixture for upload/thumbnail/avatar tests.
export const TEST_PNG_BYTES = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0, 38, 147, 9, 41,
    0, 0, 0, 9, 112, 72, 89, 115, 0, 0, 3, 232, 0, 0, 3, 232, 1, 181, 123, 82, 107, 0, 0, 0, 17, 73, 68, 65, 84, 120,
    156, 99, 248, 207, 192, 0, 71, 8, 22, 94, 14, 0, 174, 147, 15, 241, 166, 148, 72, 35, 0, 0, 0, 0, 73, 69, 78, 68,
    174, 66, 96, 130,
]);

export { app, TEST_DATA_DIR };
