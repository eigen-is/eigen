import type {Home} from "../home";
import {SHARED_DB_CONFIG} from "./db-config";

export async function getSharedDatabase(home: Home) {
    const managedDb = await home.getLocalDatabase(SHARED_DB_CONFIG, 'mounts/shared.db');
    return managedDb.db;
}