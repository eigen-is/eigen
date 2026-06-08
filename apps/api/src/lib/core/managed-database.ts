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
        // Trigger a snapshot once at least this many writes have accumulated.
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
    private forceDirty = false;
    // When true, openCold opens with { create: false } so a MISSING working copy throws instead of
    // silently materialising an empty db. Set by Mount for "open existing" document dbs — the file is
    // known to exist (metadata.db has its row), so a fresh empty db here means lost data, not a new doc.
    private mustExist: boolean;

    constructor(config: DatabaseConfig<S>, localPath: string, callbacks: SyncCallbacks = {}, mustExist = false) {
        this.config = config;
        this.localPath = localPath;
        this.callbacks = callbacks;
        this.mustExist = mustExist;
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

        // mustExist ⇒ open existing read-write WITHOUT create, so a missing working copy throws
        // instead of silently becoming an empty db. Bun needs an explicit access mode when create
        // is off, otherwise it raises SQLITE_MISUSE.
        this.rawDb = this.mustExist
            ? new BunDatabase(this.localPath, { readwrite: true, create: false })
            : new BunDatabase(this.localPath, { create: true });
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
            this.syncTimer = setInterval(() => {
                this.tick().catch((err) => console.error(`[${this.config.name}] sync tick failed:`, err));
            }, autoSyncMs);
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
        return this.forceDirty || this.getTotalChanges() !== this.lastSyncedChanges;
    }

    // Force the next sync() to run even though total_changes() looks unchanged.
    // Crash recovery: Mount.buildDocumentDb reuses a temp file that survived an
    // unclean shutdown, but total_changes() resets to 0 on the fresh connection, so
    // isDirty would read false and the close-time cleanupTemp would silently drop the
    // unsynced bytes. Marking dirty guarantees they re-reach storage. Cleared on sync.
    markDirty(): void {
        this.forceDirty = true;
    }

    // Push pending writes to storage. Snapshots are handled separately by
    // snapshotIfDue() so that an explicit flush() (e.g. from a snapshot callback
    // that flushes the cached db first) can't re-enter the snapshot trigger.
    private async sync(): Promise<void> {
        if (this.isDirty && this.callbacks.onSync) {
            this.rawDb?.run('PRAGMA wal_checkpoint(PASSIVE);');
            await this.callbacks.onSync();
            this.lastSyncedChanges = this.getTotalChanges();
            this.forceDirty = false;
            console.log(`[${this.config.name}] Synced`);
        }
    }

    // Take a version snapshot when enough writes have accumulated since the last
    // one (or `force`, used at close, for any unsnapshotted change). The snapshot
    // callback copies the on-disk db, so the caller must have the latest state
    // checkpointed to the main file first (sync() runs PASSIVE; close() TRUNCATEs).
    // Awaited — a fire-and-forget snapshot would race close()'s file teardown and,
    // during restore eviction, the imminent data.db replace.
    private async snapshotIfDue(force = false): Promise<void> {
        if (!this.config.snapshot || !this.callbacks.onSnapshot) return;
        const total = this.getTotalChanges();
        const unsnapshotted = total - this.lastSnapshotChanges;
        if (unsnapshotted <= 0 || (!force && unsnapshotted < this.config.snapshot.writesPerSnapshot)) return;
        await this.callbacks.onSnapshot();
        this.lastSnapshotChanges = total;
    }

    // Periodic auto-sync: push writes, then snapshot if the threshold is crossed.
    private async tick(): Promise<void> {
        await this.sync();
        await this.snapshotIfDue();
    }

    // Public sync entry point — callers (e.g. Mount.createDatabase) use this
    // to guarantee the current state has been pushed through the configured
    // sync callback before returning, instead of waiting for the 30s timer.
    async flush(): Promise<void> {
        await this.sync();
    }

    // Write a frozen, WAL-complete copy of the current DB to destPath via VACUUM INTO.
    // The write-behind upload pipeline (Phase 1b) uploads this copy, not the live file
    // (which keeps mutating as the user edits). VACUUM INTO captures committed-but-
    // uncheckpointed WAL frames, so the copy is complete without a prior checkpoint.
    stageCopy(destPath: string): void {
        if (!this.rawDb) throw new Error('Database not open');
        this.rawDb.run('VACUUM INTO ?', [destPath]);
    }

    // skipFinalSnapshot: callers about to discard the on-disk file (eviction
    // inside Drive.restoreContainer) opt out so the close-time snapshot can't
    // prune the snapshot the restore is about to read from.
    async close(opts: { skipFinalSnapshot?: boolean } = {}): Promise<void> {
        if (!this.rawDb) return;

        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        await this.sync();
        // Fold the WAL into the main file before snapshotting: local backends copy
        // this on-disk file (TRUNCATE makes it complete), remote backends copy the
        // object sync() uploaded. A snapshot failure is caught so it can't block close.
        this.rawDb?.run('PRAGMA wal_checkpoint(TRUNCATE);');
        if (!opts.skipFinalSnapshot) {
            await this.snapshotIfDue(true).catch((err) =>
                console.error(`[${this.config.name}] close snapshot failed:`, err),
            );
        }
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
