import type { Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../../collab/db-config';
import { loadYjsState } from '../../collab/yjs-loader';
import type { Mount } from '../../mount';

export async function loadSheetsContent(mount: Mount, drivePath: DrivePath): Promise<Sheet[]> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return [];

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc } = loadYjsState(managedDb);
    const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
    if (!snapshot) return [];

    return JSON.parse(snapshot) as Sheet[];
}
