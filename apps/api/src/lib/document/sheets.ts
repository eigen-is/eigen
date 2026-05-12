import type { Op, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { replaySheetsOps } from '@workspace/sheet/engine';
import type * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

// Returns Sheet[] directly (vs. {content, mediaByName} like the doc/slides readers)
// because the sheets export and preview pipelines fetch media lazily from the mount
// per-cell rather than bundling it upfront — see lib/export/sheets/{html,pdf,xlsx}.ts.
export async function readSheetsContent(mount: Mount, drivePath: DrivePath): Promise<Sheet[]> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigensheets data.db missing');

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc } = loadYjsState(managedDb);
    const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
    const opBatches = doc.getArray<Op[]>('ops').toArray();
    const sheets = (snapshot ? JSON.parse(snapshot) : []) as Sheet[];
    return replaySheetsOps(sheets, opBatches);
}

export function writeSheetsToYjs(doc: Y.Doc, sheets: Sheet[]): void {
    const json = JSON.stringify(sheets);
    doc.transact(() => {
        doc.getMap('state').set('snapshot', json);
        const ops = doc.getArray('ops');
        if (ops.length > 0) ops.delete(0, ops.length);
    });
}
