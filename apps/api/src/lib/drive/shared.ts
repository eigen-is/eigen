// Opens the database of a Home that holds its copies of the paths other owners shared with it. A Drive opens it when
// it loads, and the functions behind "Shared with me" read and write it.

import { PATHS } from '../config/paths';
import type { Home } from '../home';
import { SHARED_DB_CONFIG } from './db-config';

export async function getSharedDatabase(home: Home) {
    const managedDb = await home.getLocalDatabase(SHARED_DB_CONFIG, PATHS.DRIVE.SHARED_DB);
    return managedDb.db;
}
