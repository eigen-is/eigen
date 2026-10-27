// Opens the database of a Home that lists the paths its owner has shared with others. Drive code uses it whenever it
// needs those rows.

import { PATHS } from '../config/paths';
import type { Home } from '../home';
import { SHARED_DB_CONFIG } from './db-config';

export async function getSharedDatabase(home: Home) {
    const managedDb = await home.getLocalDatabase(SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB);
    return managedDb.db;
}
