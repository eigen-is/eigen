import { createAsyncSingleton } from '../../utils/singleton';
import { getServerDataPath, SERVER_DATABASES } from '../config/paths';
import { openLocalDatabase } from '../core';
import { SHARE_REGISTRY_DB_CONFIG } from './db-config';

const getDb = createAsyncSingleton(async () => {
    const dbPath = getServerDataPath(SERVER_DATABASES.shares);
    return openLocalDatabase(SHARE_REGISTRY_DB_CONFIG, dbPath);
});

export async function getEigenDb() {
    const managed = await getDb();
    return managed.db;
}

// The server backup's copy, through the handle the server writes with.
export async function stageEigenDbCopy(destPath: string): Promise<void> {
    (await getDb()).stageCopy(destPath);
}
