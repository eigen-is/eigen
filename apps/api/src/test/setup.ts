import {mkdirSync, rmSync} from 'fs';
import {join} from 'path';

const TEST_DATA_ROOT = join(import.meta.dir, '../../../../data-test'); 
// clear TEST_DATA_ROOT - remove all files and directories from previous test runs
rmSync(TEST_DATA_ROOT, {recursive: true, force: true});

const TEST_DATA_DIR = join(TEST_DATA_ROOT, 'test-' + Date.now());
process.env['EIGEN_DATA_ROOT'] = TEST_DATA_DIR;

mkdirSync(join(TEST_DATA_DIR, 'server'), {recursive: true});
mkdirSync(join(TEST_DATA_DIR, 'home'), {recursive: true});

const {app} = await import('../app');

const setupResponse = await app.handle(new Request('http://localhost/setup/complete', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
        domain: 'test.eigen.is',
        orgName: 'Test Organization',
        storageType: 'local-id',
        adminEmail: 'alice@test.eigen.is',
        adminPassword: 'testpassword123',
        adminName: 'Alice Test',
    }),
}));
const setupResult = await setupResponse.json() as { success: boolean; error?: string };
if (!setupResult.success) {
    throw new Error(`Setup failed: ${setupResult.error}`);
}

const {auth} = await import('../lib/auth/auth');
const {treaty} = await import('@elysiajs/eden');

type App = typeof app;

type TestUser = {
    id: string;
    email: string;
    name: string;
    sessionToken: string;
};

type TestContext = {
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
        const allCookies = setCookie.split(',').map(c => c.trim());
        for (const cookie of allCookies) {
            const tokenMatch = cookie.match(/better-auth\.session_token=([^;]+)/);
            if (tokenMatch) return tokenMatch[1];
        }
        throw new Error('Session token not found in set-cookie header: ' + setCookie);
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

async function createTestUser(email: string, password: string, name: string): Promise<TestUser> {
    let userId: string;
    let userName: string;

    try {
        const signUp = await auth.api.signUpEmail({
            body: {email, password, name},
        });
        userId = signUp.user.id;
        userName = signUp.user.name;
    } catch {
        const existing = await auth.api.signInEmail({body: {email, password}});
        userId = existing.user.id;
        userName = existing.user.name;
    }

    const signIn = await auth.api.signInEmail({
        returnHeaders: true,
        body: {email, password},
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

export function authedRequest(sessionToken: string, path: string, options?: RequestInit): Promise<Response> {
    return app.handle(new Request(`http://localhost${path}`, {
        ...options,
        headers: {
            ...options?.headers,
            cookie: `better-auth.session_token=${sessionToken}`,
        },
    }));
}

export function cleanup() {
    // if (existsSync(TEST_DATA_DIR)) {
    //     rmSync(TEST_DATA_DIR, {recursive: true, force: true});
    // }
}

export function driveUrl(ownerId: string, mountId: string, ...parts: string[]) {
    return `/drive/${ownerId}/${mountId}/${parts.join('/')}`;
}

export async function driveGet(token: string, ownerId: string, mountId: string, ...parts: string[]): Promise<any> {
    const res = await authedRequest(token, driveUrl(ownerId, mountId, ...parts));
    return res.status !== 200 ? [] : await res.json();
}

export async function drivePost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    return res.json();
}

export async function drivePut(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    return res.json();
}

export async function driveDelete(token: string, ownerId: string, mountId: string, path: string): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {method: 'DELETE'});
    return res.json();
}

export async function driveUpload(token: string, ownerId: string, mountId: string, parentId: string, file: File): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${parentId}`, {
        method: 'POST',
        body: formData,
    });
    return res.json();
}

export function chatPost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).then(r => r.json());
}

export function chatGet(token: string, ownerId: string, mountId: string, path: string): Promise<any> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`).then(r => r.json());
}

export {TEST_DATA_DIR};
