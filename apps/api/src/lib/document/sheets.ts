import type { Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

export async function readSheetsContent(mount: Mount, drivePath: DrivePath): Promise<Sheet[]> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigensheets data.db missing');

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc } = loadYjsState(managedDb);
    const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
    if (!snapshot) throw new Error('eigensheets data.db missing');

    return JSON.parse(snapshot) as Sheet[];
}

export function writeSheetsToYjs(doc: Y.Doc, sheets: Sheet[]): void {
    const json = JSON.stringify(sheets);
    doc.transact(() => {
        doc.getMap('state').set('snapshot', json);
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}
