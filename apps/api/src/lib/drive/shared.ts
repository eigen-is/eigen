// Opens the database of a Home that holds what it keeps about other owners' paths, such as its copies of the paths
// shared with it, behind "Shared with me", and the paths its user lately opened or was notified about, behind Recent.
// A Drive opens it when it loads.

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../config/paths';
import type { Home } from '../home';
import { SHARED_DB_CONFIG } from './db-config';
import type * as sharedSchema from './sharedschema';

export type SharedDb = BunSQLiteDatabase<typeof sharedSchema>;

export async function getSharedDatabase(home: Home): Promise<SharedDb> {
    const managedDb = await home.getLocalDatabase(SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB);
    return managedDb.db;
}
