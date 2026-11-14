// One SQLite database of the server, opened through Drizzle: it runs the versioned migrations, tracks whether
// writes are pending, syncs them on a timer and at close, and says when a version is due. The caller says what a
// sync, an open, a close and a version mean, such as a document database's upload. Server, Home and container
// databases all open through this class.

import type { Statement } from 'bun:sqlite';
import { constants, Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import { time } from '../../utils/timing';
import type { RetentionPolicy } from '../versioning/retention';
import { ApiError } from './errors';

export type SchemaType = Record<string, unknown>;

type Migration = {
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
    // For a database that holds the truth rather than an index of it: a power loss must not lose an
    // acknowledged write. Every other database keeps the default of the SQLite it runs on, which differs by platform.
    synchronous?: 'FULL';
};

// The transaction handle drizzle hands a `db.transaction(cb)` callback, for the schema of one database.
export type Tx<S extends SchemaType> = Parameters<Parameters<BunSQLiteDatabase<S>['transaction']>[0]>[0];

export type SyncCallbacks = {
    onOpen?: () => Promise<void>;
    onSync?: () => Promise<void>;
    // syncFailed: the final sync threw, so the working copy holds bytes storage lacks.
    onClose?: (syncFailed: boolean) => Promise<void>;
    // 'skipped': the container lock was busy, so the snapshot stays due and the next tick tries again.
    onSnapshot?: () => Promise<'taken' | 'skipped'>;
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
    // A tick, a flush and a close run one at a time: two syncs would stage the same bytes and race their watermark,
    // and a close would tear the database down under the other. A callback runs under it, so it must not flush.
    private lifecycleLock = new Semaphore(1);
    // An open of a file metadata.db has a row for, so a missing or empty one means lost data, not a new database.
    private mustExist: boolean;

    public constructor(config: DatabaseConfig<S>, localPath: string, callbacks: SyncCallbacks = {}, mustExist = false) {
        this.config = config;
        this.localPath = localPath;
        this.callbacks = callbacks;
        this.mustExist = mustExist;
    }

    public get db(): BunSQLiteDatabase<S> {
        if (!this.drizzleDb) throw new Error('Database not open');
        return this.drizzleDb;
    }

    public async open(autoSyncMs = 30000): Promise<BunSQLiteDatabase<S>> {
        return time(`ManagedDatabase.open ${this.config.name}`, () => this.openFile(autoSyncMs));
    }

    // skipFinalSnapshot is for a caller about to discard the file, such as a restore, whose final snapshot could
    // prune the version that restore is about to read.
    public async close(opts: { skipFinalSnapshot?: boolean } = {}): Promise<void> {
        // Before the wait, so no tick queues behind this close.
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }

        await this.lifecycleLock.run(async () => {
            const raw = this.rawDb;
            if (!raw) return; // a concurrent close reached the teardown first

            // The teardown runs even when the final sync throws; onClose learns of the failure.
            let syncFailed = true;
            try {
                await this.sync();
                syncFailed = false;
            } finally {
                // After a failed sync storage lacks the tail, so a snapshot would miss it.
                if (!opts.skipFinalSnapshot && !syncFailed) {
                    await this.snapshotIfDue(true).catch((err) =>
                        console.error(`[${this.config.name}] close snapshot failed:`, err),
                    );
                }
                // Statements are finalized as they run, so a strict close succeeds. Should one still be live, sqlite
                // keeps the connection as a zombie until it is finalized.
                try {
                    raw.close(true);
                } catch (err) {
                    console.warn(`[${this.config.name}] lazy close:`, err);
                    raw.close();
                }
                this.rawDb = null;
                this.drizzleDb = null;

                await this.callbacks.onClose?.(syncFailed);
            }
        });
    }

    private async openFile(autoSyncMs: number): Promise<BunSQLiteDatabase<S>> {
        await this.callbacks.onOpen?.();

        const dir = path.dirname(this.localPath);
        fs.mkdirSync(dir, { recursive: true });

        if (this.mustExist) {
            // A failed or empty S3 GET leaves a 0-byte file, itself a valid empty SQLite. Opening it would wipe the
            // document, so the caller fetches the stored object again or fails loud.
            const size = fs.existsSync(this.localPath) ? fs.statSync(this.localPath).size : -1;
            if (size <= 0) {
                throw new ApiError(503, `${this.config.name}: expected an existing database at ${this.localPath}`);
            }
        }

        this.rawDb = this.mustExist
            ? new Database(this.localPath, { readwrite: true, create: false })
            : new Database(this.localPath, { create: true });
        // A failed open, from corrupt bytes or a throwing migration, must not leak the handle and its mapped journals.
        try {
            // macOS's system SQLite keeps -wal and -shm after the last close; turn that off so the
            // last connection removes them, once its exclusive lock proves no other process has the file.
            this.rawDb.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
            this.rawDb.run('PRAGMA journal_mode = WAL;');
            // Per connection, so it is re-applied on every open, not stored in the file.
            if (this.config.synchronous === 'FULL') this.rawDb.run('PRAGMA synchronous = FULL;');
            this.rawDb.run('PRAGMA foreign_keys = ON;');
            this.rawDb.run('PRAGMA busy_timeout = 5000;');
            // onSync may copy the main file while commits go on, so only the sync's own checkpoint may write it.
            if (this.callbacks.onSync) this.rawDb.run('PRAGMA wal_autocheckpoint = 0;');

            this.rawDb.exec(`
                CREATE TABLE IF NOT EXISTS __schema_version (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    version INTEGER NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO __schema_version (id, version) VALUES (1, 0);
            `);

            this.runMigrations(this.rawDb);
        } catch (e) {
            this.rawDb.close();
            this.rawDb = null;
            throw e;
        }

        this.drizzleDb = drizzle(withAutoFinalize(this.rawDb), { schema: this.config.schema });

        if (this.callbacks.onSync && autoSyncMs > 0) {
            this.syncTimer = setInterval(() => {
                this.tick().catch((err) => console.error(`[${this.config.name}] sync tick failed:`, err));
            }, autoSyncMs);
        }

        return this.drizzleDb;
    }

    private runMigrations(db: Database): void {
        const stamp = db
            .query<{ version: number }, []>('SELECT version FROM __schema_version WHERE id = 1')
            .get()?.version;
        if (stamp === undefined || !Number.isInteger(stamp)) {
            throw new ApiError(503, `${this.config.name}: unreadable schema stamp ${stamp}`);
        }
        let currentVersion = stamp;

        if (currentVersion > this.config.currentVersion) {
            throw new ApiError(
                503,
                `${this.config.name}: database is at schema v${currentVersion}, newer than this server supports (v${this.config.currentVersion})`,
            );
        }

        const pending = this.config.migrations
            .filter((m) => m.version > currentVersion)
            .sort((a, b) => a.version - b.version);

        for (const migration of pending) {
            const msg =
                currentVersion === 0
                    ? `Init v${migration.version}`
                    : `Migrating v${currentVersion} → v${migration.version}`;
            console.log(`[${this.config.name}] ${msg}`);
            db.run('BEGIN');
            try {
                migration.up(db);
                db.run('UPDATE __schema_version SET version = ? WHERE id = 1', [migration.version]);
                db.run('COMMIT');
            } catch (e) {
                db.run('ROLLBACK');
                throw e;
            }
            currentVersion = migration.version;
        }
    }

    private getTotalChanges(): number {
        if (!this.rawDb) throw new Error('Database not open');
        const [row] = this.rawDb.query<{ tc: number }, []>('SELECT total_changes() as tc').all();
        return row.tc;
    }

    // For an open that adopts a crash temp: the fresh connection counts no change for its unsynced bytes, so a sync
    // would find it clean and the close would drop them. No change count is ever -1, so both are owed.
    public markDirty(): void {
        this.lastSyncedChanges = -1;
        this.lastSnapshotChanges = -1;
    }

    private async sync(): Promise<void> {
        if (!this.callbacks.onSync) return;
        // Read before the await: onSync stages the bytes up front, so a write during its later awaits stays dirty.
        const syncedChanges = this.getTotalChanges();
        if (syncedChanges === this.lastSyncedChanges) return;
        this.rawDb?.run('PRAGMA wal_checkpoint(PASSIVE);');
        await this.callbacks.onSync();
        this.lastSyncedChanges = syncedChanges;
        console.log(`[${this.config.name}] Synced`);
    }

    // onSnapshot is awaited, because a snapshot left running would race the teardown of a close or the replace of a
    // restore.
    private async snapshotIfDue(force = false): Promise<void> {
        if (!this.config.snapshot || !this.callbacks.onSnapshot) return;
        const total = this.getTotalChanges();
        const unsnapshotted = total - this.lastSnapshotChanges;
        if (unsnapshotted <= 0) return;
        if (!force && unsnapshotted < this.config.snapshot.writesPerSnapshot) return;
        if ((await this.callbacks.onSnapshot()) !== 'skipped') {
            this.lastSnapshotChanges = total;
        }
    }

    private async tick(): Promise<void> {
        await this.lifecycleLock.run(async () => {
            await this.sync();
            await this.snapshotIfDue();
        });
    }

    public async flush(): Promise<void> {
        await this.lifecycleLock.run(() => this.sync());
    }

    // VACUUM INTO captures committed WAL frames, so the copy is complete with no checkpoint.
    public stageCopy(destPath: string): void {
        if (!this.rawDb) throw new Error('Database not open');
        this.rawDb.run('VACUUM INTO ?', [destPath]);
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

// Drizzle prepares one statement per execution and leaves it to GC, and sqlite refuses a strict close while any
// survive. So each is finalized right after its one run. Migrations get the raw handle, as they reuse statements.
function withAutoFinalize(db: Database): Database {
    return new Proxy(db, {
        get(target, prop) {
            if (prop === 'prepare') {
                return (...args: Parameters<Database['prepare']>) => finalizeAfterRun(target.prepare(...args));
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

const STATEMENT_RUNNERS = new Set<string | symbol>(['run', 'all', 'get', 'values']);

function finalizeAfterRun(stmt: Statement): Statement {
    return new Proxy(stmt, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            if (!STATEMENT_RUNNERS.has(prop)) return value.bind(target);
            return (...args: unknown[]) => {
                try {
                    return value.apply(target, args);
                } finally {
                    target.finalize();
                }
            };
        },
    });
}
