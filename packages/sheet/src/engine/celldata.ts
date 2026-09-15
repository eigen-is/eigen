// Pure conversions between the two cell representations:
//   - `celldata`: sparse list of {r, c, v} entries (snapshot/persistence form)
//   - `data`: dense (Cell | null)[][] matrix (engine/state runtime form)
// State's api/common.ts re-exports from here to avoid duplication.

import type { CellMatrix, CellWithRowAndCol } from '@workspace/lib/sheets';
import { maxBy, times } from 'es-toolkit/compat';

export function dataToCelldata(data: CellMatrix | undefined): CellWithRowAndCol[] {
    const celldata: CellWithRowAndCol[] = [];
    if (!data) return celldata;
    for (let r = 0; r < data.length; r += 1) {
        for (let c = 0; c < data[r].length; c += 1) {
            const v = data[r][c];
            if (v != null) celldata.push({ r, c, v });
        }
    }
    return celldata;
}

export function celldataToData(celldata: CellWithRowAndCol[], rowCount: number, colCount: number): CellMatrix {
    const lastRow = maxBy<CellWithRowAndCol>(celldata, 'r');
    const lastCol = maxBy<CellWithRowAndCol>(celldata, 'c');
    const lastRowNum = Math.max((lastRow?.r ?? 0) + 1, rowCount);
    const lastColNum = Math.max((lastCol?.c ?? 0) + 1, colCount);
    const expandedData: CellMatrix = times(lastRowNum, () => times(lastColNum, () => null));
    for (const d of celldata) {
        expandedData[d.r][d.c] = d.v;
    }
    return expandedData;
}
