// Opens the database of a Home that holds what it keeps about other owners' paths, such as which paths were shared
// with it, behind "Shared with me", and which its user lately opened or was notified about, behind Recent. A Drive
// opens it when it loads.

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../config/paths';
import type { Home } from '../home';
import { SHARED_DB_CONFIG } from './db-config';
import type * as sharedSchema from './shared-schema';

export type SharedDb = BunSQLiteDatabase<typeof sharedSchema>;

export async function getSharedDatabase(home: Home): Promise<SharedDb> {
    const managedDb = await home.getLocalDatabase(SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB);
    return managedDb.db;
}
