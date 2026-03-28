import { createAsyncSingleton } from '../../utils/singleton';
import { getServerDataPath } from '../config/paths';
import { openLocalDatabase } from '../core';
import { SHARE_REGISTRY_DB_CONFIG } from './db-config';

const getDb = createAsyncSingleton(async () => {
    const dbPath = getServerDataPath('eigen.db');
    return openLocalDatabase(SHARE_REGISTRY_DB_CONFIG, dbPath);
});

export async function getEigenDb() {
    const managed = await getDb();
    return managed.db;
}
