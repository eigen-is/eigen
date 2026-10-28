// The share registry's database, eigen.db in the server data folder, opened once and shared by the process. The
// registry reads and writes it, and other code, such as the server backup, goes through the same handle.

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { createAsyncSingleton } from '../../utils/singleton';
import { getServerDataPath, SERVER_DATABASES } from '../config/paths';
import { openLocalDatabase } from '../core';
import { SHARE_REGISTRY_DB_CONFIG } from './db-config';
import type * as schema from './schema';

const getDb = createAsyncSingleton(() =>
    openLocalDatabase(SHARE_REGISTRY_DB_CONFIG, getServerDataPath(SERVER_DATABASES.shares)),
);

export async function getEigenDb(): Promise<BunSQLiteDatabase<typeof schema>> {
    return (await getDb()).db;
}

// The server backup's copy, through the handle the server writes with.
export async function stageEigenDbCopy(destPath: string): Promise<void> {
    (await getDb()).stageCopy(destPath);
}
