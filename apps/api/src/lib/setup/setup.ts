import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { S3Config } from '@workspace/lib/types/mount';
import type { SetupResult, SetupStatus } from '@workspace/lib/types/settings';
import { validateEmailAddress, validateUsername } from '@workspace/lib/validation';
import { auth } from '../auth/auth';
import { getServerDataPath } from '../config/paths';
import { getMailDomain, isSetupRequired, updateServerConfig } from '../config/server-config';
import { updateServerSettings } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { checkS3Connection } from '../storage/s3-storage';
import { clearSetupToken } from './setup-token';

async function resetAuthDatabase(): Promise<void> {
    const dbPath = getServerDataPath('users3.db');
    const dataDir = dirname(dbPath);

    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    const db = new Database(dbPath);

    await db.run(`CREATE TABLE IF NOT EXISTS "user" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "email_verified" integer NOT NULL,
        "image" text,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL,
        "two_factor_enabled" integer,
        "role" text,
        "banned" integer,
        "ban_reason" text,
        "ban_expires" integer,
        "last_login_at" integer
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "session" (
        "id" text PRIMARY KEY NOT NULL,
        "expires_at" integer NOT NULL,
        "token" text NOT NULL UNIQUE,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL,
        "ip_address" text,
        "user_agent" text,
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "impersonated_by" text,
        "active_organization_id" text,
        "active_team_id" text
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "account" (
        "id" text PRIMARY KEY NOT NULL,
        "account_id" text NOT NULL,
        "provider_id" text NOT NULL,
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "access_token" text,
        "refresh_token" text,
        "id_token" text,
        "access_token_expires_at" integer,
        "refresh_token_expires_at" integer,
        "scope" text,
        "password" text,
        "created_at" integer NOT NULL,
        "updated_at" integer NOT NULL
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "verification" (
        "id" text PRIMARY KEY NOT NULL,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expires_at" integer NOT NULL,
        "created_at" integer,
        "updated_at" integer
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "two_factor" (
        "id" text PRIMARY KEY NOT NULL,
        "secret" text NOT NULL,
        "backup_codes" text NOT NULL,
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "verified" integer,
        "failed_verification_count" integer,
        "locked_until" integer
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "organization" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "slug" text UNIQUE,
        "logo" text,
        "created_at" integer NOT NULL,
        "metadata" text
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "member" (
        "id" text PRIMARY KEY NOT NULL,
        "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "role" text NOT NULL,
        "created_at" integer NOT NULL
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "invitation" (
        "id" text PRIMARY KEY NOT NULL,
        "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
        "email" text NOT NULL,
        "role" text,
        "status" text NOT NULL,
        "expires_at" integer NOT NULL,
        "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "team_id" text,
        "created_at" integer
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "team" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
        "created_at" integer NOT NULL,
        "updated_at" integer,
        "member_count" integer NOT NULL DEFAULT 0
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "team_member" (
        "id" text PRIMARY KEY NOT NULL,
        "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "created_at" integer,
        "membership_key" text UNIQUE
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "apikey"
                  (
                      "id"
                      text
                      PRIMARY
                      KEY
                      NOT
                      NULL,
                      "config_id"
                      text
                      NOT
                      NULL,
                      "name"
                      text,
                      "start"
                      text,
                      "reference_id"
                      text
                      NOT
                      NULL,
                      "prefix"
                      text,
                      "key"
                      text
                      NOT
                      NULL,
                      "refill_interval"
                      integer,
                      "refill_amount"
                      integer,
                      "last_refill_at"
                      integer,
                      "enabled"
                      integer,
                      "rate_limit_enabled"
                      integer,
                      "rate_limit_time_window"
                      integer,
                      "rate_limit_max"
                      integer,
                      "request_count"
                      integer,
                      "remaining"
                      integer,
                      "last_request"
                      integer,
                      "expires_at"
                      integer,
                      "created_at"
                      integer
                      NOT
                      NULL,
                      "updated_at"
                      integer
                      NOT
                      NULL,
                      "permissions"
                      text,
                      "metadata"
                      text
                  )`);

    // completeSetup() — the only caller — runs only while setup is incomplete, so rows
    // here are normally orphans from an earlier attempt that failed partway, and
    // clearing them lets a retry succeed instead of colliding with the admin email's
    // UNIQUE constraint. But setupCompleted lives in config.json, a separate file: were
    // that lost or reset while users3.db survived, these rows would be real data — so
    // snapshot the database first. Clearing is then always recoverable, never destructive.
    const { n: existingUsers } = db.query<{ n: number }, []>('SELECT count(*) AS n FROM "user"').get()!;
    if (existingUsers > 0) {
        const backupPath = getServerDataPath(`users3.backup-${Date.now()}.db`);
        writeFileSync(backupPath, db.serialize());
        console.warn(
            `[setup] users3.db already held ${existingUsers} user(s); backed up to ${backupPath} before clearing`,
        );
    }

    // Children before parents so the deletes hold regardless of FK enforcement.
    for (const table of [
        'team_member',
        'team',
        'member',
        'invitation',
        'session',
        'account',
        'two_factor',
        'apikey',
        'verification',
        'user',
        'organization',
    ]) {
        await db.run(`DELETE FROM "${table}"`);
    }

    db.close();
}

export type SetupInput = {
    orgName: string;
    storageType: 'local-fullnames' | 'local-id' | 's3';
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKeyId?: string;
    s3SecretAccessKey?: string;
    s3Endpoint?: string;
    adminUsername: string;
    adminPassword: string;
    adminName: string;
};

export function getSetupStatus(): SetupStatus {
    return { setupRequired: isSetupRequired(), mailDomain: getMailDomain() };
}

// Two submits of the wizard would interleave resetAuthDatabase() with each other's admin creation.
let setupRunning = false;

// The route has checked the setup token and the shape of the input.
export async function completeSetup(input: SetupInput): Promise<SetupResult> {
    if (setupRunning) throw new ApiError(409, 'Setup is already running');
    setupRunning = true;
    try {
        let s3Config: S3Config | undefined;
        if (input.storageType === 's3') {
            if (!input.s3Bucket || !input.s3AccessKeyId || !input.s3SecretAccessKey) {
                throw new ApiError(400, 'S3 configuration requires bucket, access key, and secret key');
            }
            s3Config = {
                endpoint: input.s3Endpoint ?? '',
                bucket: input.s3Bucket,
                prefix: '',
                accessKeyId: input.s3AccessKeyId,
                secretAccessKey: input.s3SecretAccessKey,
                region: input.s3Region,
            };
            const s3Result = await checkS3Connection(s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
        }

        const username = input.adminUsername.toLowerCase();
        const usernameErr = validateUsername(username);
        if (usernameErr) throw new ApiError(400, usernameErr);
        const adminEmail = `${username}@${getMailDomain()}`;
        if (!validateEmailAddress(adminEmail)) throw new ApiError(400, `${adminEmail} is not a valid email address`);

        await resetAuthDatabase();

        // better-auth's errors (a duplicate email, a bad slug) reach the wizard as 400s with their own message.
        let user: Awaited<ReturnType<typeof auth.api.createUser>>;
        let org: Awaited<ReturnType<typeof auth.api.createOrganization>>;
        try {
            user = await auth.api.createUser({
                body: {
                    email: adminEmail,
                    password: input.adminPassword,
                    name: input.adminName,
                    role: 'admin',
                },
            });

            const orgSlug = input.orgName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            org = await auth.api.createOrganization({
                body: { name: input.orgName, slug: orgSlug, userId: user.user.id },
            });
        } catch (error) {
            console.error('Setup failed during admin/org creation:', error);
            throw new ApiError(400, error instanceof Error ? error.message : 'Setup failed');
        }
        if (!org) throw new Error('Failed to create default organization');

        await updateServerSettings({ defaults: { mount: { storageType: input.storageType, s3Config } } });

        // setupCompleted flips here — written last so a failure in any step above leaves
        // setup re-runnable: isSetupRequired() stays true and resetAuthDatabase() clears
        // the partial state on the next attempt.
        await updateServerConfig({
            orgName: input.orgName,
            orgId: org.id,
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString(),
        });
        clearSetupToken();

        return { user: { id: user.user.id, email: user.user.email, name: user.user.name } };
    } finally {
        setupRunning = false;
    }
}
