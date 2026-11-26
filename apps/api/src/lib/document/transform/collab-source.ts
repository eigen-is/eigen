// Captures a collab document's stored state on the main thread for the transform process, such as an
// export or a convert. It finds the container's data.db through the Mount and copies the compressed blobs
// out while it holds the database, so the transform never sees the Mount or the database. The state route
// reads only the version here, which names a cached state without reading a blob.

import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../../collab/db-config';
import type * as schema from '../../collab/schema';
import type { YjsStatePayload, YjsStateVersion } from '../../collab/yjs-loader';
import { readYjsStatePayload, readYjsStateVersion } from '../../collab/yjs-loader';
import type { ManagedDatabase } from '../../core/managed-database';
import type { Mount } from '../../mount';
import { CONTAINER_DATA_DB } from '../../mount/container-dbs';

export async function captureCollabSource(mount: Mount, drivePath: DrivePath): Promise<YjsStatePayload> {
    return withDataDb(mount, drivePath, readYjsStatePayload);
}

export async function readCollabStateVersion(mount: Mount, drivePath: DrivePath): Promise<YjsStateVersion> {
    return withDataDb(mount, drivePath, readYjsStateVersion);
}

async function withDataDb<T>(
    mount: Mount,
    drivePath: DrivePath,
    read: (managedDb: ManagedDatabase<typeof schema>) => T,
): Promise<T> {
    const dataDbPath = await mount.getChildByName(drivePath.id, CONTAINER_DATA_DB);
    if (!dataDbPath) throw new Error(`${drivePath.name}: data.db missing`);
    return mount.withDatabase(COLLAB_DB_CONFIG, dataDbPath.id, async (managedDb) => read(managedDb));
}
