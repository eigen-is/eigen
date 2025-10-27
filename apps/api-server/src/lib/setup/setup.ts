import { drizzle } from "drizzle-orm/bun-sqlite";
import { user, account, session, verification } from '../../../auth-schema';
import { count, eq } from "drizzle-orm";
import { auth } from "../auth/auth";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

function getSetupDb() {
    // Use relative path to match users.ts and auth.ts
    const dbPath = './data/users3.db';
    const dataDir = dirname(dbPath);
    
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    
    return drizzle(dbPath, {
        schema: {
            user,
            account,
            session,
            verification,
        },
    });
}


async function initializeDatabaseSchema(): Promise<{ success: boolean; error?: string }> {
    try {
        console.log('🔄 Initializing database schema...');
        
        // Create tables directly using Drizzle
        const db = getSetupDb();
        
        // Create user table
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

        // Create session table
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
            "active_organization_id" text
        )`);

        // Create account table
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

        // Create verification table
        await db.run(`CREATE TABLE IF NOT EXISTS "verification" (
            "id" text PRIMARY KEY NOT NULL,
            "identifier" text NOT NULL,
            "value" text NOT NULL,
            "expires_at" integer NOT NULL,
            "created_at" integer,
            "updated_at" integer
        )`);

        console.log('✅ Database schema initialization completed!');
        return { success: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Database initialization failed:', errorMessage);
        return { success: false, error: errorMessage };
    }
}

export async function hasAnyUsers(): Promise<boolean> {
    try {
        // First ensure database schema exists
        await initializeDatabaseSchema();
        
        const db = getSetupDb();
        const result = await db.select({ count: count() }).from(user);
        return result[0].count > 0;
    } catch (error) {
        // If database doesn't exist or table doesn't exist, no users exist
        console.log('Database check failed, assuming no users exist:', error);
        return false;
    }
}

export async function createFirstAdminUser(email: string, password: string, name: string) {
    try {
        // First, initialize the database schema if needed
        const schemaResult = await initializeDatabaseSchema();
        if (!schemaResult.success) {
            return {
                success: false,
                error: `Database initialization failed: ${schemaResult.error}`
            };
        }

        // Use better-auth to create the user with proper password hashing
        const result = await auth.api.signUpEmail({
            body: {
                email,
                password,
                name,
            }
        });

        if (!result.user) {
            throw new Error('Failed to create user');
        }

        // Update user role to admin
        const db = getSetupDb();
        await db.update(user)
            .set({ role: 'admin' })
            .where(eq(user.id, result.user.id));

        return {
            success: true,
            user: result.user
        };
    } catch (error) {
        console.error('Failed to create first admin user:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export async function isSetupRequired(): Promise<boolean> {
    return !(await hasAnyUsers());
}
