import {mkdirSync, existsSync, rmSync} from 'fs';
import {join} from 'path';

const TEST_DATA_DIR = join(import.meta.dir, '../../../../data/test-' + Date.now());
process.env['EIGEN_DATA_ROOT'] = TEST_DATA_DIR;

mkdirSync(join(TEST_DATA_DIR, 'server'), {recursive: true});
mkdirSync(join(TEST_DATA_DIR, 'home'), {recursive: true});

Bun.write(join(TEST_DATA_DIR, 'server', 'config.json'), JSON.stringify({
    domain: 'test.eigen.is',
    storage: {type: 'local-id'},
    setupCompleted: true,
    setupCompletedAt: new Date().toISOString(),
}));

import {Database} from 'bun:sqlite';
const authDb = new Database(join(TEST_DATA_DIR, 'server', 'users3.db'));
authDb.exec(`
    CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, two_factor_enabled INTEGER, role TEXT, banned INTEGER, ban_reason TEXT, ban_expires INTEGER);
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, impersonated_by TEXT, active_organization_id TEXT);
    CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS two_factor (id TEXT PRIMARY KEY, secret TEXT NOT NULL, backup_codes TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, created_at INTEGER NOT NULL, metadata TEXT);
    CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, role TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitation (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL, expires_at INTEGER NOT NULL, inviter_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE);
`);
authDb.close();

const {app} = await import('../app');
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
    alice: {user: TestUser; api: ReturnType<typeof treaty<App>>};
    bob: {user: TestUser; api: ReturnType<typeof treaty<App>>};
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

    context = {
        alice: {
            user: alice,
            api: createAuthenticatedClient(alice.sessionToken),
        },
        bob: {
            user: bob,
            api: createAuthenticatedClient(bob.sessionToken),
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
    if (existsSync(TEST_DATA_DIR)) {
        rmSync(TEST_DATA_DIR, {recursive: true, force: true});
    }
}

export {TEST_DATA_DIR};
