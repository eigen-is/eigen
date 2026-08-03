import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../../collab/db-config';
import { readYjsStatePayload, type YjsStatePayload } from '../../collab/yjs-loader';
import type { Mount } from '../../mount';

// Main-thread capture of a collab document's persisted state for Worker transfer.
// Resolves the container's data.db through the Mount (which owns the
// ManagedDatabase lifecycle) and copies the compressed blobs out in a short
// transaction — the Worker never sees the Mount or the database.
export async function captureCollabSource(mount: Mount, drivePath: DrivePath): Promise<YjsStatePayload> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error(`${drivePath.name}: data.db missing`);
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    return readYjsStatePayload(managedDb);
}
