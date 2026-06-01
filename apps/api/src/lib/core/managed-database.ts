import type Database from 'bun:sqlite';
import { Database as BunDatabase } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { time } from '../../utils/timing';
import { isTest } from '../config/env';
import type { RetentionPolicy } from '../versioning/retention';

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
    snapshot?: {
        policy: RetentionPolicy;
        /** Trigger a snapshot when at least this many writes have accumulated. */
        writesPerSnapshot: number;
    };
};

export type SyncCallbacks = {
    onOpen?: () => Promise<void>;
    onSync?: () => Promise<void>;
    onClose?: () => Promise<void>;
    onSnapshot?: () => Promise<void>;
};

export class ManagedDatabase<S extends SchemaType> {
    private config: DatabaseConfig<S>;
    private localPath: string;
    private callbacks: SyncCallbacks;
    private rawDb: Database | null = null;
    private drizzleDb: BunSQLiteDatabase<S> | null = null;
    private syncTimer: Timer | null = null;
    private lastSyncedChanges = 0;
    private lastSnapshotChanges = 0;

    constructor(config: DatabaseConfig<S>, localPath: string, callbacks: SyncCallbacks = {}) {
        this.config = config;
        this.localPath = localPath;
        this.callbacks = callbacks;
    }

    async open(autoSyncMs = 30000): Promise<BunSQLiteDatabase<S>> {
        if (this.drizzleDb) return this.drizzleDb;
        return time(`ManagedDatabase.open ${this.config.name}`, () => this.openCold(autoSyncMs));
    }

    private async openCold(autoSyncMs: number): Promise<BunSQLiteDatabase<S>> {
        await this.callbacks.onOpen?.();

        const dir = path.dirname(this.localPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.rawDb = new BunDatabase(this.localPath, { create: true });
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

        this.drizzleDb = drizzle(this.rawDb, { schema: this.config.schema }) as BunSQLiteDatabase<S>;
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
            .filter((m) => m.version > currentVersion)
            .sort((a, b) => a.version - b.version);

        for (const migration of pending) {
            if (!isTest()) {
                const msg =
                    currentVersion === 0
                        ? `Init v${migration.version}`
                        : `Migrating v${currentVersion} → v${migration.version}`;
                console.log(`[${this.config.name}] ${msg}`);
            }
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

    private get changesSinceLastSnapshot(): number {
        return this.getTotalChanges() - this.lastSnapshotChanges;
    }

    private async sync(opts: { forceSnapshot?: boolean } = {}): Promise<void> {
        if (this.isDirty && this.callbacks.onSync) {
            this.rawDb?.run('PRAGMA wal_checkpoint(PASSIVE);');
            await this.callbacks.onSync();
            this.lastSyncedChanges = this.getTotalChanges();
            console.log(`[${this.config.name}] Synced`);
        }
        if (this.config.snapshot && this.callbacks.onSnapshot) {
            const unsnapshotted = this.changesSinceLastSnapshot;
            // Force only triggers when there's something new to snapshot. Without
            // this guard, close() during restore fires a redundant snapshot that
            // races with the deletePath(data.db) coming up next.
            const due =
                unsnapshotted > 0 && (opts.forceSnapshot || unsnapshotted >= this.config.snapshot.writesPerSnapshot);
            if (due) {
                this.lastSnapshotChanges = this.getTotalChanges();
                // Fire-and-forget: snapshot failures must not block sync or close.
                this.callbacks
                    .onSnapshot()
                    .catch((err) => console.error(`[${this.config.name}] snapshot failed:`, err));
            }
        }
    }

    // Public sync entry point — callers (e.g. Mount.createDatabase) use this
    // to guarantee the current state has been pushed through the configured
    // sync callback before returning, instead of waiting for the 30s timer.
    async flush(): Promise<void> {
        await this.sync();
    }

    async close(): Promise<void> {
        if (!this.rawDb) return;

        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        await this.sync({ forceSnapshot: true });
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
    absolutePath: string,
): Promise<ManagedDatabase<S>> {
    const db = new ManagedDatabase(config, absolutePath);
    await db.open();
    return db;
}
