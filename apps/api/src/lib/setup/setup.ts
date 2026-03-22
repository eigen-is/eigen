import {drizzle} from "drizzle-orm/bun-sqlite";
import {auth} from "../auth/auth";
import {
    getServerConfig,
    isSetupRequired as checkSetupRequired,
    saveServerConfig,
    type ServerConfig
} from "../config/server-config";
import {updateServerSettings} from "../config/server-settings";
import {existsSync, mkdirSync} from "fs";
import {dirname} from "path";
import {randomBytes} from "crypto";
import {getServerDataPath} from "../config/paths";

export const isSetupRequired = checkSetupRequired;

async function initializeDatabaseSchema(): Promise<void> {
    const dbPath = getServerDataPath('users3.db');
    const dataDir = dirname(dbPath);

    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, {recursive: true});
    }

    const db = drizzle(dbPath);

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
        "ban_expires" integer
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
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
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
        "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "team" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
        "created_at" integer NOT NULL,
        "updated_at" integer
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS "team_member" (
        "id" text PRIMARY KEY NOT NULL,
        "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
        "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "created_at" integer
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
}

export type SetupInput = {
    domain: string;
    orgName: string;
    storageType: 'local-fullnames' | 'local-id' | 's3';
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKeyId?: string;
    s3SecretAccessKey?: string;
    s3Endpoint?: string;
    adminEmail: string;
    adminPassword: string;
    adminName: string;
};

export type SetupResult = {
    success: boolean;
    message?: string;
    error?: string;
    user?: { id: string; email: string; name: string };
};

export async function getSetupStatus() {
    const setupRequired = isSetupRequired();

    if (!setupRequired) {
        const config = getServerConfig();
        return {setupRequired: false, domain: config?.domain};
    }

    return {setupRequired: true};
}

export async function completeSetup(input: SetupInput): Promise<SetupResult> {
    if (!isSetupRequired()) {
        return {success: false, error: "Setup has already been completed"};
    }

    if (!input.domain) {
        return {success: false, error: "Domain is required"};
    }

    if (!input.orgName) {
        return {success: false, error: "Organization name is required"};
    }

    if (!input.storageType) {
        return {success: false, error: "Storage type is required"};
    }

    if (input.storageType === 's3') {
        if (!input.s3Bucket || !input.s3Region || !input.s3AccessKeyId || !input.s3SecretAccessKey) {
            return {success: false, error: "S3 configuration requires bucket, region, access key, and secret key"};
        }
    }

    if (!input.adminEmail || !input.adminPassword || !input.adminName) {
        return {success: false, error: "Admin email, password, and name are required"};
    }

    if (input.adminPassword.length < 8) {
        return {success: false, error: "Password must be at least 8 characters long"};
    }

    try {
        await initializeDatabaseSchema();

        const user = await auth.api.createUser({
            body: {
                email: input.adminEmail,
                password: input.adminPassword,
                name: input.adminName,
                role: 'admin',
            }
        });

        if (!user) {
            throw new Error('Failed to create admin user');
        }

        // Create default organization via better-auth API
        const orgSlug = input.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const org = await auth.api.createOrganization({
            body: {
                name: input.orgName,
                slug: orgSlug,
                userId: user.user.id,
            },
        });

        if (!org) {
            throw new Error('Failed to create default organization');
        }

        const serverConfig: ServerConfig = {
            domain: input.domain,
            orgName: input.orgName,
            orgId: org.id,
            storage: {
                type: input.storageType,
                s3: input.storageType === 's3' ? {
                    bucket: input.s3Bucket!,
                    region: input.s3Region!,
                    accessKeyId: input.s3AccessKeyId!,
                    secretAccessKey: input.s3SecretAccessKey!,
                    endpoint: input.s3Endpoint ?? '',
                    prefix: '',
                } : undefined
            },
            secret: randomBytes(32).toString('base64'),
            setupCompleted: true,
            setupCompletedAt: new Date().toISOString()
        };

        await saveServerConfig(serverConfig);

        await updateServerSettings({
            defaults: {mount: {storageType: input.storageType}}
        });

        return {
            success: true,
            message: "Setup completed successfully",
            user: {id: user.user.id, email: user.user.email, name: user.user.name}
        };
    } catch (error) {
        console.error('Setup failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Setup failed'
        };
    }
}
