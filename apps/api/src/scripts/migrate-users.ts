// One-time migration script: copies users from users_current.db to users3.db.
//
// For each user in users_current.db:
//   - If the user (by email) doesn't exist in users3.db, inserts the user row
//   - Copies the matching account row (preserving the hashed password)
//   - Adds the user as a member of the default organization
//
// Usage:  bun run apps/api/src/scripts/migrate-users.ts
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

function getDataRoot(): string {
    return process.env['EIGEN_DATA_ROOT'] || './../../data';
}

function getServerDataPath(filename: string): string {
    const serverData = path.join(getDataRoot(), 'server');
    if (!fs.existsSync(serverData)) {
        fs.mkdirSync(serverData, { recursive: true });
    }
    return path.join(serverData, filename);
}

const oldDbPath = getServerDataPath('users_current.db');
const newDbPath = getServerDataPath('users3.db');

if (!fs.existsSync(oldDbPath)) {
    console.error(`Source database not found: ${oldDbPath}`);
    process.exit(1);
}
if (!fs.existsSync(newDbPath)) {
    console.error(`Target database not found: ${newDbPath}`);
    process.exit(1);
}

const oldDb = new Database(oldDbPath, { readonly: true });
const newDb = new Database(newDbPath);

type UserRow = {
    id: string;
    name: string;
    email: string;
    email_verified: number;
    image: string | null;
    created_at: number;
    updated_at: number;
    two_factor_enabled: number | null;
    role: string | null;
    banned: number | null;
    ban_reason: string | null;
    ban_expires: number | null;
};

type AccountRow = {
    id: string;
    account_id: string;
    provider_id: string;
    user_id: string;
    access_token: string | null;
    refresh_token: string | null;
    id_token: string | null;
    access_token_expires_at: number | null;
    refresh_token_expires_at: number | null;
    scope: string | null;
    password: string | null;
    created_at: number;
    updated_at: number;
};

const oldUsers = oldDb.query('SELECT * FROM user').all() as UserRow[];
console.log(`Found ${oldUsers.length} user(s) in users_current.db`);

const defaultOrg = newDb.query('SELECT id FROM organization LIMIT 1').get() as { id: string } | null;
if (!defaultOrg) {
    console.error('No organization found in users3.db — run setup first.');
    process.exit(1);
}
console.log(`Default organization: ${defaultOrg.id}`);

const existingEmails = new Set(
    (newDb.query('SELECT email FROM user').all() as { email: string }[]).map((r) => r.email.toLowerCase()),
);

let migrated = 0;
let skipped = 0;

const insertUser = newDb.prepare(`
    INSERT INTO user (id, name, email, email_verified, image, created_at, updated_at, two_factor_enabled, role, banned, ban_reason, ban_expires)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAccount = newDb.prepare(`
    INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMember = newDb.prepare(`
    INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?, ?)
`);

const existingMembers = new Set(
    (
        newDb.query('SELECT user_id FROM member WHERE organization_id = ?').all(defaultOrg.id) as {
            user_id: string;
        }[]
    ).map((r) => r.user_id),
);

for (const user of oldUsers) {
    if (existingEmails.has(user.email.toLowerCase())) {
        console.log(`  SKIP (exists): ${user.email}`);
        skipped++;
        continue;
    }

    const accounts = oldDb.query('SELECT * FROM account WHERE user_id = ?').all(user.id) as AccountRow[];

    newDb.transaction(() => {
        insertUser.run(
            user.id,
            user.name,
            user.email,
            user.email_verified,
            user.image,
            user.created_at,
            user.updated_at,
            user.two_factor_enabled,
            user.role,
            user.banned,
            user.ban_reason,
            user.ban_expires,
        );

        for (const acc of accounts) {
            insertAccount.run(
                acc.id,
                acc.account_id,
                acc.provider_id,
                acc.user_id,
                acc.access_token,
                acc.refresh_token,
                acc.id_token,
                acc.access_token_expires_at,
                acc.refresh_token_expires_at,
                acc.scope,
                acc.password,
                acc.created_at,
                acc.updated_at,
            );
        }

        if (!existingMembers.has(user.id)) {
            const memberId = crypto.randomUUID();
            const now = Math.floor(Date.now() / 1000);
            insertMember.run(memberId, defaultOrg.id, user.id, 'member', now);
        }
    })();

    console.log(`  MIGRATED: ${user.email} (${accounts.length} account(s))`);
    migrated++;
}

oldDb.close();
newDb.close();

console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`);
