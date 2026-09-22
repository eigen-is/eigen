import { Database as BunDatabase } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { like, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase, withAutoFinalize } from '../../lib/core';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-managed-db-${Date.now()}`);
const items = sqliteTable('items', { id: integer('id').primaryKey({ autoIncrement: true }), v: text('v') });
type Schema = { items: typeof items };

function makeConfig(writesPerSnapshot: number): DatabaseConfig<Schema> {
    return {
        name: 'test-md',
        currentVersion: 1,
        schema: { items },
        migrations: [
            { version: 1, up: (db) => db.run('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)') },
        ],
        snapshot: { policy: DEFAULT_RETENTION, writesPerSnapshot },
    };
}

let counter = 0;
const nextDbPath = () => join(TEST_DIR, `md-${counter++}.db`);

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('ManagedDatabase open-vs-create intent', () => {
    test('mustExist refuses to create a missing database instead of silently making an empty one', async () => {
        // An "open existing" must honor the caller's knowledge (from metadata.db) that the db
        // exists. Opening an absent working copy with create:true silently produced an empty db —
        // the 2026-06-08 data-loss shape. With mustExist, a missing file throws instead of creating.
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {}, true);
        await expect(db.open(0)).rejects.toThrow();
    });

    test('mustExist refuses an existing-but-empty (0-byte) database', async () => {
        // A 0-byte file is a valid empty SQLite, so { create: false } opens it happily — the exact
        // shape a failed S3 GET leaves. mustExist must reject it rather than serve an empty db.
        const dbPath = nextDbPath();
        writeFileSync(dbPath, '');
        const db = new ManagedDatabase(makeConfig(1000), dbPath, {}, true);
        await expect(db.open(0)).rejects.toThrow();
    });
});

describe('ManagedDatabase durability option', () => {
    // 0 = OFF, 1 = NORMAL, 2 = FULL.
    const synchronousOf = (mdb: ManagedDatabase<Schema>) =>
        (mdb.db.all(sql`PRAGMA synchronous`)[0] as { synchronous: number }).synchronous;

    // What WAL alone gives on this SQLite build: NORMAL on macOS's system library
    // (SQLITE_DEFAULT_WAL_SYNCHRONOUS=1), FULL on bun's bundled Linux one. Only the FULL option is absolute.
    const walDefault = () => {
        const raw = new BunDatabase(nextDbPath(), { create: true });
        raw.run('PRAGMA journal_mode = WAL;');
        const value = (raw.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
        raw.close();
        return value;
    };

    test('a config asking for FULL gets it, and one that does not keeps the WAL default', async () => {
        const normal = new ManagedDatabase(makeConfig(1000), nextDbPath());
        await normal.open(0);
        expect(synchronousOf(normal)).toBe(walDefault());
        await normal.close({ skipFinalSnapshot: true });

        const full = new ManagedDatabase({ ...makeConfig(1000), synchronous: 'FULL' }, nextDbPath());
        await full.open(0);
        expect(synchronousOf(full)).toBe(2);
        await full.close({ skipFinalSnapshot: true });
    });
});

describe('ManagedDatabase migration rollback', () => {
    test('a migration that throws mid-way rolls back atomically and leaves the db reopenable at v1', async () => {
        const dbPath = nextDbPath();
        const v1 = new ManagedDatabase(makeConfig(1000), dbPath, {});
        await v1.open(0);
        v1.db.insert(items).values({ v: 'v1-data' }).run();
        await v1.close({ skipFinalSnapshot: true });

        // The v2 migration executes DDL + DML, then throws — open() must reject and the
        // BEGIN/ROLLBACK wrapper must discard BOTH statements, not just the version bump.
        const failing: DatabaseConfig<Schema> = {
            ...makeConfig(1000),
            currentVersion: 2,
            migrations: [
                ...makeConfig(1000).migrations,
                {
                    version: 2,
                    up: (db) => {
                        db.run('ALTER TABLE items ADD COLUMN extra TEXT');
                        db.run("INSERT INTO items (v) VALUES ('v2-row')");
                        throw new Error('migration boom');
                    },
                },
            ],
        };
        const v2 = new ManagedDatabase(failing, dbPath, {}, true);
        await expect(v2.open(0)).rejects.toThrow('migration boom');
        // A failed open releases its own raw handle — inspecting the file below needs no close().

        // On-disk state is untouched v1: version stayed 1, no v2 row, no v2 column.
        // (readwrite: a readonly connection can't create the -shm a WAL-mode db needs)
        const raw = new BunDatabase(dbPath, { readwrite: true, create: false });
        expect(
            (raw.query('SELECT version FROM __schema_version WHERE id = 1').get() as { version: number }).version,
        ).toBe(1);
        expect(raw.query('SELECT v FROM items').all()).toEqual([{ v: 'v1-data' }]);
        expect((raw.query('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name)).toEqual([
            'id',
            'v',
        ]);
        raw.close();

        // With the failing migration removed, the file reopens cleanly at v1.
        const reopened = new ManagedDatabase(makeConfig(1000), dbPath, {}, true);
        await reopened.open(0);
        expect(reopened.db.select().from(items).all()).toEqual([{ id: 1, v: 'v1-data' }]);
        await reopened.close({ skipFinalSnapshot: true });
    });
});

describe('ManagedDatabase future-version guard', () => {
    test('refuses to open a database newer than the binary supports', async () => {
        // A rollback to an older binary after a schema bump would otherwise silently open the
        // newer on-disk schema and mangle it. The guard reads __schema_version before migrating
        // and refuses anything past currentVersion.
        const dbPath = nextDbPath();
        const raw = new BunDatabase(dbPath, { create: true });
        raw.exec(`CREATE TABLE __schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0);
                  INSERT INTO __schema_version (id, version) VALUES (1, 99);`);
        raw.close();

        const db = new ManagedDatabase(makeConfig(1000), dbPath, {}, true);
        await expect(db.open(0)).rejects.toThrow(/newer/);
    });

    test('refuses a schema stamp that is not an integer', async () => {
        // Only our own migrations write the stamp, so anything else is a db we do not understand.
        // `'abc' > 1` is false: without the guard the db opened with no migration run and every
        // query on the missing tables failed later instead of the open failing loud.
        const dbPath = nextDbPath();
        const raw = new BunDatabase(dbPath, { create: true });
        raw.exec(`CREATE TABLE __schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0);
                  INSERT INTO __schema_version (id, version) VALUES (1, 'abc');`);
        raw.close();

        const db = new ManagedDatabase(makeConfig(1000), dbPath, {}, true);
        await expect(db.open(0)).rejects.toThrow(/schema stamp/);
    });

    test('opens a database sitting at exactly currentVersion', async () => {
        // The guard is `>`, not `>=`: an already-migrated db reopens cleanly at currentVersion.
        const dbPath = nextDbPath();
        const db = new ManagedDatabase(makeConfig(1000), dbPath, {});
        await db.open(0);
        await db.close({ skipFinalSnapshot: true });

        const reopened = new ManagedDatabase(makeConfig(1000), dbPath, {}, true);
        await reopened.open(0);
        await reopened.close({ skipFinalSnapshot: true });
    });
});

describe('ManagedDatabase snapshot lifecycle', () => {
    test('flush() pushes writes to storage but does NOT take a version snapshot', async () => {
        // Regression: flush() used to run the snapshot trigger, so a snapshot
        // callback that itself flushes the cached db (Mount.snapshotContainerDataDb)
        // re-entered and fired a second, preserve-hint-less snapshot.
        let syncs = 0;
        let snapshots = 0;
        const db = new ManagedDatabase(makeConfig(3), nextDbPath(), {
            onSync: async () => {
                syncs++;
            },
            onSnapshot: async () => {
                snapshots++;
                return 'taken';
            },
        });
        await db.open(0);
        for (let i = 0; i < 10; i++) db.db.insert(items).values({ v: 'x' }).run();

        await db.flush();

        expect(syncs).toBe(1);
        expect(snapshots).toBe(0);
        await db.close({ skipFinalSnapshot: true });
    });

    test('close() awaits the final snapshot instead of firing and forgetting it', async () => {
        // Regression: close() fired onSnapshot fire-and-forget, then immediately
        // checkpoint(TRUNCATE)'d and deleted the journals — the async snapshot
        // copy raced the file teardown.
        let snapshotFinished = false;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {},
            onSnapshot: async () => {
                await new Promise((r) => setTimeout(r, 20));
                snapshotFinished = true;
                return 'taken';
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();

        await db.close();

        expect(snapshotFinished).toBe(true);
    });

    test('periodic tick still snapshots once the write threshold is crossed', async () => {
        let snapshots = 0;
        const db = new ManagedDatabase(makeConfig(3), nextDbPath(), {
            onSync: async () => {},
            onSnapshot: async () => {
                snapshots++;
                return 'taken';
            },
        });
        await db.open(10);
        for (let i = 0; i < 5; i++) db.db.insert(items).values({ v: 'x' }).run();
        await new Promise((r) => setTimeout(r, 50));

        expect(snapshots).toBeGreaterThanOrEqual(1);
        await db.close({ skipFinalSnapshot: true });
    });
});

describe('ManagedDatabase lifecycle serialization', () => {
    test('a parked tick makes flush and close queue instead of running a second onSync', async () => {
        // Regression: ticks were fire-and-forget, flush() called sync() directly and close() only
        // cleared the timer — so two onSync callbacks could stage the same db at once, and close
        // could tear the db down with one still in flight.
        let syncs = 0;
        let active = 0;
        let overlapped = false;
        let release!: () => void;
        const held = new Promise<void>((r) => {
            release = r;
        });
        let first = true;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {
                syncs++;
                active++;
                if (active > 1) overlapped = true;
                if (first) {
                    first = false;
                    await held; // hold the first tick's sync open across everything below
                }
                active--;
            },
        });
        await db.open(5);
        db.db.insert(items).values({ v: 'x' }).run();
        await new Promise((r) => setTimeout(r, 20)); // let the timer fire and park inside onSync

        const flushed = db.flush();
        const closing = db.close({ skipFinalSnapshot: true });
        setTimeout(release, 20);
        await flushed;
        await closing;

        expect(overlapped).toBe(false);
        expect(active).toBe(0); // close awaited the in-flight sync instead of tearing down under it

        // A flush landing after close must not call back into a torn-down db — with rawDb null,
        // total_changes() reads 0 while lastSyncedChanges doesn't, so isDirty said "sync me".
        const syncsAtClose = syncs;
        await db.flush();
        expect(syncs).toBe(syncsAtClose);
    });

    test('a snapshot callback that flushes the same db deadlocks neither the tick nor the close', async () => {
        // versioning/snapshot.ts flushes the cached db it is about to copy, and for a container's
        // data.db that is the very instance running onSnapshot — so onSnapshot → flush() re-enters.
        // flush() must never queue behind the lifecycle op the tick or close is holding.
        let snapshots = 0;
        const db: ManagedDatabase<Schema> = new ManagedDatabase(makeConfig(1), nextDbPath(), {
            onSync: async () => {},
            onSnapshot: async () => {
                await db.flush();
                snapshots++;
                return 'taken';
            },
        });
        await db.open(5);
        db.db.insert(items).values({ v: 'x' }).run();
        await new Promise((r) => setTimeout(r, 30));
        expect(snapshots).toBeGreaterThanOrEqual(1); // tick path

        db.db.insert(items).values({ v: 'y' }).run();
        await db.close();
        expect(snapshots).toBeGreaterThanOrEqual(2); // close path
    });
});

describe('ManagedDatabase close teardown', () => {
    test('close() tears down (db closed, journals gone, onClose ran) even when onSync throws', async () => {
        // A throwing onSync used to abort close() before the teardown, leaking the raw db
        // handle and the working copy until process exit. The sync error must still reach
        // the caller (they catch + log), but the teardown must run regardless.
        let onCloseRan = false;
        const dbPath = nextDbPath();
        const db = new ManagedDatabase(makeConfig(1000), dbPath, {
            onSync: async () => {
                throw new Error('sync boom');
            },
            onClose: async () => {
                onCloseRan = true;
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();

        await expect(db.close({ skipFinalSnapshot: true })).rejects.toThrow('sync boom');

        expect(onCloseRan).toBe(true);
        expect(() => db.db).toThrow('Database not open');
        expect(existsSync(`${dbPath}-wal`)).toBe(false);
    });
});

describe('ManagedDatabase statement finalization', () => {
    test('drizzle statements are finalized as they run, so the raw handle closes strictly', () => {
        // Drizzle prepares one bun:sqlite statement per execution and leaves it to GC; sqlite refuses
        // a strict close (SQLITE_BUSY) while any survive — including a collected wrapper whose native
        // handle hasn't been swept yet, which no amount of Bun.gc() can force. Every execution path
        // drizzle has (run/all/get/values, transactions, savepoints, relational queries) must leave
        // nothing behind.
        const raw = new BunDatabase(nextDbPath(), { create: true });
        raw.run('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
        const db = drizzle(withAutoFinalize(raw), { schema: { items } });

        db.insert(items).values({ v: 'a' }).run();
        db.transaction((tx) => {
            tx.insert(items).values({ v: 'b' }).run();
            tx.transaction((inner) => inner.insert(items).values({ v: 'c' }).run());
        });
        expect(db.select().from(items).all()).toHaveLength(3);
        expect(db.select().from(items).get()?.v).toBe('a');
        expect(db.query.items.findMany().sync()).toHaveLength(3);
        expect(db.select({ v: items.v }).from(items).all()[2]?.v).toBe('c');

        expect(() => raw.close(true)).not.toThrow();
    });
});

describe('ManagedDatabase close releases the file (no zombie close)', () => {
    test('close → reopen of the SAME path works', async () => {
        // Every local-key reopen takes exactly this path, so close() must be strict (statements
        // finalized, see above) and release the file before the next open.
        const dbPath = nextDbPath();
        const db = new ManagedDatabase(makeConfig(1000), dbPath, { onSync: async () => {} });
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();
        await db.close({ skipFinalSnapshot: true });

        const reopened = new ManagedDatabase(makeConfig(1000), dbPath, { onSync: async () => {} }, true);
        await reopened.open(0);
        expect(reopened.db.select().from(items).all()).toHaveLength(1);
        await reopened.close({ skipFinalSnapshot: true });
    });
});

describe('ManagedDatabase dirty tracking', () => {
    test('markDirty() forces the next sync even when nothing changed since the last one', async () => {
        // Phase 1a: crash recovery reuses a temp whose total_changes() reset to 0, so the
        // DB looks clean. markDirty() guarantees the unsynced bytes are re-synced instead
        // of being silently dropped by the close-time cleanupTemp.
        let syncs = 0;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {
                syncs++;
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();
        await db.flush();
        expect(syncs).toBe(1);

        // No new writes → not dirty → flush is a no-op.
        await db.flush();
        expect(syncs).toBe(1);

        // markDirty() makes the next flush sync despite an unchanged total_changes().
        db.markDirty();
        await db.flush();
        expect(syncs).toBe(2);

        // The forced sync clears the flag — a subsequent clean flush does nothing.
        await db.flush();
        expect(syncs).toBe(2);

        await db.close({ skipFinalSnapshot: true });
    });

    test('a write landing DURING the sync callback stays dirty and re-syncs (AUDIT 2b)', async () => {
        // onSync freezes the bytes it stages up front (Mount's VACUUM INTO); a write that lands
        // during the callback's later awaits is NOT in that copy. sync() used to set the watermark
        // to total_changes() AFTER the await, so that racing write was counted as synced but never
        // staged — silent tail-loss. It must remain dirty and re-sync on the next tick.
        let syncs = 0;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {
                syncs++;
                // Model the concurrent write: it lands after the (notional) staged copy is frozen,
                // so its bytes never reach storage in THIS sync.
                if (syncs === 1) db.db.insert(items).values({ v: 'concurrent' }).run();
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'first' }).run();

        await db.flush();
        expect(syncs).toBe(1);

        // The concurrent write was never staged, so the db is still dirty and this flush re-syncs
        // it. Under the pre-fix watermark (captured after the await) this was a silent no-op.
        await db.flush();
        expect(syncs).toBe(2);

        await db.close({ skipFinalSnapshot: true });
    });
});

describe('ManagedDatabase leaves its journals to SQLite', () => {
    test('a clean last close leaves no -wal or -shm behind', async () => {
        const dbPath = nextDbPath();
        const db = new ManagedDatabase(makeConfig(1000), dbPath);
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();
        await db.close({ skipFinalSnapshot: true });

        expect(existsSync(dbPath)).toBe(true);
        expect(existsSync(`${dbPath}-wal`)).toBe(false);
        expect(existsSync(`${dbPath}-shm`)).toBe(false);
    });

    test("a close while another process holds the file keeps that process's writes", async () => {
        // Unlinking the journals by hand after close left a second connection writing into a WAL
        // nobody else could see: its writes vanished for the next opener and its later checkpoint
        // corrupted the file (the 2026-09-22 metadata.db).
        const dbPath = nextDbPath();
        const first = new ManagedDatabase(makeConfig(1000), dbPath);
        await first.open(0);
        first.db.insert(items).values({ v: 'first' }).run();

        const other = spawnHolder(dbPath);
        try {
            await other.send('read');
            await first.close({ skipFinalSnapshot: true });
            await other.send('write 20');

            const next = new ManagedDatabase(makeConfig(1000), dbPath);
            await next.open(0);
            expect(countLike(next, 'other-%')).toBe(20);
            next.db.insert(items).values({ v: 'next' }).run();
            await other.send('write 20');
            await other.send('exit');
            await next.close({ skipFinalSnapshot: true });
        } finally {
            other.proc.kill();
        }

        const check = new BunDatabase(dbPath, { readwrite: true, create: false });
        try {
            expect(check.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()).toEqual({
                integrity_check: 'ok',
            });
            expect(countLikeRaw(check, 'other-%')).toBe(40);
            expect(countLikeRaw(check, 'next')).toBe(1);
        } finally {
            check.close();
        }
    });
});

function countLike(db: ManagedDatabase<Schema>, pattern: string): number | undefined {
    return db.db.select({ n: sql<number>`count(*)` }).from(items).where(like(items.v, pattern)).get()?.n;
}

function countLikeRaw(db: BunDatabase, pattern: string): number | undefined {
    return db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM items WHERE v LIKE ?').get(pattern)?.n;
}

// A second process on the same file: each stdin line is one command, answered by one stdout line.
const HOLDER_SCRIPT = `
import { Database } from 'bun:sqlite';
const db = new Database(process.env.DB_PATH);
db.run('PRAGMA busy_timeout = 5000');
let written = 0;
for await (const line of console) {
    const [command, count] = line.split(' ');
    if (command === 'read') db.query('SELECT count(*) FROM items').get();
    if (command === 'write') {
        for (let i = 0; i < Number(count); i++) db.run('INSERT INTO items (v) VALUES (?)', ['other-' + written++]);
    }
    if (command === 'exit') db.close(true);
    console.log('done');
    if (command === 'exit') process.exit(0);
}
`;

function spawnHolder(dbPath: string) {
    const proc = Bun.spawn([process.execPath, '-e', HOLDER_SCRIPT], {
        env: { ...process.env, DB_PATH: dbPath },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const send = async (command: string): Promise<void> => {
        proc.stdin.write(`${command}\n`);
        proc.stdin.flush();
        while (!buffered.includes('\n')) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`the holder process exited before answering ${command}`);
            buffered += decoder.decode(value);
        }
        buffered = buffered.slice(buffered.indexOf('\n') + 1);
    };
    return { proc, send };
}
