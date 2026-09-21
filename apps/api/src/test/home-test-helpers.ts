import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SSEvent } from '@workspace/lib/types/sse';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import type { Home } from '../lib/home';

// A domain class over a temp home directory with no booted app behind it: the stub Home supplies only the
// members a domain touches — a memoized getLocalDatabase (so a second init() reuses the same connection), the
// current user, and a broadcast sink. The Contacts and Calendar harnesses are both built on this.

export type TestHomeUser = { id: string; email: string; name: string };

export type TestHomeDomain = { init: () => Promise<void> };

export type TestHome<T> = {
    instance: T;
    dir: string;
    user: TestHomeUser;
    broadcasts: SSEvent[];
    // The ManagedDatabase this home opened under relativePath, for assertions against the raw index.
    database: <S extends SchemaType>(relativePath: string) => Promise<ManagedDatabase<S>>;
    // A restart: a fresh instance over the same directory and user, carrying none of this one's memory.
    reopen: () => Promise<TestHome<T>>;
    // Close at most one harness per home dir: the second close unlinks a -shm another handle still maps, and
    // sqlite answers SQLITE_IOERR_VNODE. A restart test closes the reopened half and leaves the first open.
    close: () => Promise<void>;
};

let counter = 0;

// A second call over a directory a test already has is the restart simulation, which is why dir and user are
// arguments rather than something the harness owns.
export async function openTestHome<T extends TestHomeDomain>(
    create: (home: Home) => T,
    dir: string,
    user: TestHomeUser,
): Promise<TestHome<T>> {
    mkdirSync(dir, { recursive: true });
    const broadcasts: SSEvent[] = [];
    const dbCache = new Map<string, Promise<ManagedDatabase<SchemaType>>>();
    const getLocalDatabase = ((config: DatabaseConfig<SchemaType>, relativePath: string) => {
        let entry = dbCache.get(relativePath);
        if (!entry) {
            entry = (async () => {
                const mdb = new ManagedDatabase(config, join(dir, relativePath));
                await mdb.open(0);
                return mdb;
            })();
            dbCache.set(relativePath, entry);
        }
        return entry;
    }) as Home['getLocalDatabase'];
    const home = {
        homeDir: dir,
        user,
        getLocalDatabase,
        broadcast: (e: SSEvent) => broadcasts.push(e),
    } as unknown as Home;
    const instance = create(home);
    await instance.init();
    return {
        instance,
        dir,
        user,
        broadcasts,
        database: async <S extends SchemaType>(relativePath: string) =>
            (await dbCache.get(relativePath)!) as unknown as ManagedDatabase<S>,
        reopen: () => openTestHome(create, dir, user),
        close: async () => {
            for (const entry of dbCache.values()) await (await entry).close();
        },
    };
}

// Each harness gets its own home-N subdir under `root`, mkdir'd here so no shared beforeAll hook is needed (an
// imported module's top-level hooks wouldn't fire per importing test file).
export function makeTestHome<T extends TestHomeDomain>(create: (home: Home) => T, root: string): Promise<TestHome<T>> {
    const n = counter++;
    return openTestHome(create, join(root, `home-${n}`), {
        id: randomUUID(),
        email: `me-${n}@test.local`,
        name: 'Ada Lovelace',
    });
}
