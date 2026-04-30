import type { Op, Sheet } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import type { DrivePath } from '@workspace/lib/types/drive';
import { applyPatches, enablePatches } from 'immer';
import type * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

enablePatches();

function replaySheetsOps(sheets: Sheet[], opBatches: Op[][]): Sheet[] {
    let result = sheets;
    for (const batch of opBatches) {
        const [patches, specialOps] = opToPatchOnSheets(result, batch);
        result = applyPatches(result, patches);
        for (const op of specialOps) {
            if (op.op === 'addSheet') {
                result = [...result, op.value as Sheet];
            } else if (op.op === 'deleteSheet' && op.id) {
                result = result.filter((s) => s.id !== op.id);
            } else {
                // Row/col replay needs cell-matrix shifting coupled to fortune-sheet's
                // formula recompute path, which is DOM-dependent at module evaluation.
                // The FE editor's beforeunload snapshot flush self-corrects this within
                // the editing session.
                console.warn(`[sheets] ${op.op} replay deferred (row/col needs cell-matrix shift)`);
            }
        }
    }
    return result;
}

export async function readSheetsContent(mount: Mount, drivePath: DrivePath): Promise<Sheet[]> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigensheets data.db missing');

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc } = loadYjsState(managedDb);
    const snapshot = doc.getMap('state').get('snapshot') as string | undefined;
    const opBatches = doc.getArray<Op[]>('ops').toArray();
    if (!snapshot && opBatches.length === 0) {
        throw new Error('eigensheets data.db missing');
    }

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
