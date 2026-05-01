// Pure conversions between the two cell representations:
//   - `celldata`: sparse list of {r, c, v} entries (snapshot/persistence form)
//   - `data`: dense (Cell | null)[][] matrix (engine/state runtime form)
// Lives in the engine so replaySheetsOps can materialize data from a celldata-
// only snapshot before applying patches that target ['data', r, c]. State's
// api/common.ts re-exports from here to avoid duplication.

import type { Cell, CellWithRowAndCol } from '@workspace/lib/sheets';
import { maxBy, times } from 'es-toolkit/compat';

export type CellMatrix = (Cell | null)[][];

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

export function celldataToData(celldata: CellWithRowAndCol[], rowCount?: number, colCount?: number): CellMatrix | null {
    const lastRow = maxBy<CellWithRowAndCol>(celldata, 'r');
    const lastCol = maxBy<CellWithRowAndCol>(celldata, 'c');
    let lastRowNum = (lastRow?.r ?? 0) + 1;
    let lastColNum = (lastCol?.c ?? 0) + 1;
    if (rowCount != null && colCount != null && rowCount > 0 && colCount > 0) {
        lastRowNum = Math.max(lastRowNum, rowCount);
        lastColNum = Math.max(lastColNum, colCount);
    }
    if (!lastRowNum || !lastColNum) return null;
    const expandedData: CellMatrix = times(lastRowNum, () => times(lastColNum, () => null));
    for (const d of celldata) {
        if (d.r < lastRowNum && d.c < lastColNum) expandedData[d.r][d.c] = d.v;
    }
    return expandedData;
}
