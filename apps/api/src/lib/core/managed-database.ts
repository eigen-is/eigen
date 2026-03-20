import type Database from 'bun:sqlite';
import {Database as BunDatabase} from 'bun:sqlite';
import {type BunSQLiteDatabase, drizzle} from 'drizzle-orm/bun-sqlite';
import * as fs from 'node:fs';
import * as path from 'path';

export type SchemaType = Record<string, unknown>;

export type Migration = {
    version: number;
    up: (db: Database) => void;
};

export type DatabaseConfig<S extends SchemaType> = {
    name: string;
    currentVersion: number;
    schema: S;
    migrations: Migration[];
};

export type SyncCallbacks = {
    onOpen?: () => Promise<void>;
    onSync?: () => Promise<void>;
    onClose?: () => Promise<void>;
};

export class ManagedDatabase<S extends SchemaType> {
    private config: DatabaseConfig<S>;
    private localPath: string;
    private callbacks: SyncCallbacks;
    private rawDb: Database | null = null;
    private drizzleDb: BunSQLiteDatabase<S> | null = null;
    private syncTimer: Timer | null = null;
    private lastSyncedChanges = 0;

    constructor(
        config: DatabaseConfig<S>,
        localPath: string,
        callbacks: SyncCallbacks = {}
    ) {
        this.config = config;
        this.localPath = localPath;
        this.callbacks = callbacks;
    }

    async open(autoSyncMs = 30000): Promise<BunSQLiteDatabase<S>> {
        if (this.drizzleDb) return this.drizzleDb;

        await this.callbacks.onOpen?.();

        const dir = path.dirname(this.localPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true});
        }

        this.rawDb = new BunDatabase(this.localPath, {create: true});
        this.rawDb.run('PRAGMA journal_mode = WAL;');
        this.rawDb.run('PRAGMA foreign_keys = ON;');
        this.rawDb.run('PRAGMA busy_timeout = 5000;');

        this.rawDb.exec(`
            CREATE TABLE IF NOT EXISTS __schema_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO __schema_version (id, version) VALUES (1, 0);
        `);

        await this.runMigrations();

        this.drizzleDb = drizzle(this.rawDb, {schema: this.config.schema}) as BunSQLiteDatabase<S>;
        this.lastSyncedChanges = 0;

        if (this.callbacks.onSync && autoSyncMs > 0) {
            this.syncTimer = setInterval(() => this.sync(), autoSyncMs);
        }

        return this.drizzleDb;
    }

    private async runMigrations(): Promise<void> {
        if (!this.rawDb) return;

        const row = this.rawDb.query('SELECT version FROM __schema_version WHERE id = 1').get() as { version: number };
        let currentVersion = row?.version ?? 0;

        const pending = this.config.migrations
            .filter(m => m.version > currentVersion)
            .sort((a, b) => a.version - b.version);

        for (const migration of pending) {
            console.log(`[${this.config.name}] Migrating v${currentVersion} → v${migration.version}`);
            this.rawDb.run('BEGIN');
            try {
                migration.up(this.rawDb);
                this.rawDb.run('UPDATE __schema_version SET version = ? WHERE id = 1', [migration.version]);
                this.rawDb.run('COMMIT');
            } catch (e) {
                this.rawDb.run('ROLLBACK');
                throw e;
            }
            currentVersion = migration.version;
        }
    }

    private getTotalChanges(): number {
        if (!this.rawDb) return 0;
        const row = this.rawDb.query('SELECT total_changes() as tc').get() as { tc: number } | null;
        return row?.tc ?? 0;
    }

    private get isDirty(): boolean {
        return this.getTotalChanges() !== this.lastSyncedChanges;
    }

    async sync(): Promise<void> {
        if (!this.isDirty || !this.callbacks.onSync) return;

        this.rawDb?.run('PRAGMA wal_checkpoint(PASSIVE);');
        await this.callbacks.onSync();
        this.lastSyncedChanges = this.getTotalChanges();
        console.log(`[${this.config.name}] Synced`);
    }

    async close(): Promise<void> {
        if (!this.rawDb) return;

        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        await this.sync();
        this.rawDb?.run('PRAGMA wal_checkpoint(TRUNCATE);');
        this.rawDb?.close();
        this.rawDb = null;
        this.drizzleDb = null;

        this.deleteJournalFiles();

        await this.callbacks.onClose?.();
    }

    private deleteJournalFiles(): void {
        const shmPath = `${this.localPath}-shm`;
        const walPath = `${this.localPath}-wal`;
        try {
            if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
            if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        } catch (error) {
            console.warn(`Failed to delete journal files for ${this.localPath}:`, error);
        }
    }

    get db(): BunSQLiteDatabase<S> {
        if (!this.drizzleDb) throw new Error('Database not open');
        return this.drizzleDb;
    }
}

export async function openLocalDatabase<S extends SchemaType>(
    config: DatabaseConfig<S>,
    absolutePath: string
): Promise<ManagedDatabase<S>> {
    const db = new ManagedDatabase(config, absolutePath);
    await db.open();
    return db;
}
