import type { CellWithRowAndCol, Sheet } from '@workspace/lib/sheets';
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

    const sheets = JSON.parse(snapshot) as Sheet[];
    for (const sheet of sheets) {
        if (!sheet.celldata && sheet.data) {
            sheet.celldata = dataToCelldata(sheet.data);
        }
    }
    return sheets;
}

function dataToCelldata(data: (unknown | null)[][]): CellWithRowAndCol[] {
    const celldata: CellWithRowAndCol[] = [];
    for (let r = 0; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
            const v = row[c];
            if (v != null) {
                celldata.push({ r, c, v: v as CellWithRowAndCol['v'] });
            }
        }
    }
    return celldata;
}
