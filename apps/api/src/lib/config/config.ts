import {drizzle} from "drizzle-orm/bun-sqlite";
import {systemConfig} from "./schema";
import {eq} from "drizzle-orm";
import {existsSync, mkdirSync} from "fs";
import {dirname} from "path";
import {getServerDataPath} from "./paths";

// Configuration defaults
export type SystemConfig = {
    domain: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    smtpFrom: string;
    enabledApps: string[];
    maxFileSize: number;
    allowRegistration: boolean;
    storageType: 'local-fullnames' | 'local-id' | 's3';
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
};

export const DEFAULT_CONFIG: SystemConfig = {
    domain: "localhost:8000",
    smtpHost: "localhost",
    smtpPort: 1025,
    smtpUser: "",
    smtpPassword: "",
    smtpFrom: "noreply@eigen.local",
    enabledApps: ["index", "mail", "drive", "docs", "contacts", "space", "calendar", "stickies"],
    maxFileSize: 104857600,
    allowRegistration: false,
    storageType: 'local-id',
};

let configDb: ReturnType<typeof drizzle> | null = null;
let cachedConfig: SystemConfig | null = null;

function getConfigDb() {
    if (configDb) return configDb;

    const dbPath = getServerDataPath('config.db');
    const dataDir = dirname(dbPath);

    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, {recursive: true});
    }

    configDb = drizzle(dbPath, {
        schema: {
            systemConfig,
        },
    });

    return configDb;
}

async function initializeConfigDatabase(): Promise<void> {
    const db = getConfigDb();

    // Create table if not exists
    await db.run(`CREATE TABLE IF NOT EXISTS "system_config" (
        "key" text PRIMARY KEY NOT NULL,
        "value" text NOT NULL,
        "updated_at" integer NOT NULL
    )`);
}

export async function isSystemConfigured(): Promise<boolean> {
    try {
        await initializeConfigDatabase();
        const db = getConfigDb();
        const result = await db.select().from(systemConfig).where(eq(systemConfig.key, 'storageType')).get();
        return !!result;
    } catch (error) {
        console.error('Error checking system configuration:', error);
        return false;
    }
}

export async function getConfig<K extends keyof SystemConfig>(key: K): Promise<SystemConfig[K]> {
    try {
        await initializeConfigDatabase();
        const db = getConfigDb();
        const result = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).get();

        if (result) {
            return JSON.parse(result.value);
        }

        // Return default if not found
        return DEFAULT_CONFIG[key];
    } catch (error) {
        console.error(`Error getting config for ${key}:`, error);
        return DEFAULT_CONFIG[key];
    }
}

export async function setConfig<K extends keyof SystemConfig>(key: K, value: SystemConfig[K]): Promise<void> {
    await initializeConfigDatabase();
    const db = getConfigDb();

    await db.insert(systemConfig)
        .values({
            key,
            value: JSON.stringify(value),
            updatedAt: new Date(),
        })
        .onConflictDoUpdate({
            target: systemConfig.key,
            set: {
                value: JSON.stringify(value),
                updatedAt: new Date(),
            },
        });

    // Clear cache
    cachedConfig = null;
}

export async function getAllConfig(): Promise<SystemConfig> {
    if (cachedConfig) return cachedConfig;

    await initializeConfigDatabase();
    const db = getConfigDb();
    const results = await db.select().from(systemConfig).all();

    const config: Partial<SystemConfig> = {};

    for (const row of results) {
        config[row.key as keyof SystemConfig] = JSON.parse(row.value);
    }

    // Merge with defaults for any missing values
    cachedConfig = {...DEFAULT_CONFIG, ...config};
    return cachedConfig;
}

export async function setAllConfig(config: Partial<SystemConfig>): Promise<void> {
    await initializeConfigDatabase();

    for (const [key, value] of Object.entries(config)) {
        await setConfig(key as keyof SystemConfig, value as any);
    }

    cachedConfig = null;
}

export function getPublicConfig(): Partial<SystemConfig> {
    // Only return non-sensitive config for frontend
    return {
        domain: cachedConfig?.domain || DEFAULT_CONFIG.domain,
        enabledApps: cachedConfig?.enabledApps || DEFAULT_CONFIG.enabledApps,
        maxFileSize: cachedConfig?.maxFileSize || DEFAULT_CONFIG.maxFileSize,
        allowRegistration: cachedConfig?.allowRegistration || DEFAULT_CONFIG.allowRegistration,
    };
}
