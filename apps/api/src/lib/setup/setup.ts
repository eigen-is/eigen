import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { user } from '../../../auth-schema';
import { count, eq } from "drizzle-orm";
import { auth } from "../auth/auth";
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { getServerDataPath } from "../config/paths";

function getAuthDb() {
    const dbPath = getServerDataPath('users3.db');
    const dataDir = dirname(dbPath);
    
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    
    return drizzle(dbPath);
}

async function initializeDatabaseSchema(): Promise<{ success: boolean; error?: string }> {
    try {
        const dbPath = getServerDataPath('users3.db');
        const dataDir = dirname(dbPath);
        
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }

        const db = drizzle(dbPath);
        const migrationsFolder = resolve(import.meta.dir, '../../../../drizzle');
        
        migrate(db, { migrationsFolder });

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
        
        const db = getAuthDb();
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
        const db = getAuthDb();
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
