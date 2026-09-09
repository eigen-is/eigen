import { PATHS } from '../core';
import type { Home } from '../home';
import { SHARED_DB_CONFIG } from './db-config';

export async function getSharedDatabase(home: Home) {
    const managedDb = await home.getLocalDatabase(SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB);
    return managedDb.db;
}
