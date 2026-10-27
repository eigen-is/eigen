// Pure conversions between a sheet's two cell forms: `celldata`, the sparse list of {r, c, v} entries a snapshot
// stores, and `data`, the dense matrix the engine and the editor state work on. The state layer re-exports both, so
// there is one copy of each conversion.

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

// A peer can store any number as a cell's row or column, and the matrix has no slot for one that is not an index, so
// such a cell is dropped rather than failing every read of the workbook.
export function celldataToData(celldata: CellWithRowAndCol[], rowCount: number, colCount: number): CellMatrix {
    const placed = celldata.filter((d) => isIndex(d.r) && isIndex(d.c));
    const lastRow = maxBy<CellWithRowAndCol>(placed, 'r');
    const lastCol = maxBy<CellWithRowAndCol>(placed, 'c');
    const lastRowNum = Math.max((lastRow?.r ?? 0) + 1, rowCount);
    const lastColNum = Math.max((lastCol?.c ?? 0) + 1, colCount);
    const expandedData: CellMatrix = times(lastRowNum, () => times(lastColNum, () => null));
    for (const d of placed) {
        expandedData[d.r][d.c] = d.v;
    }
    return expandedData;
}

function isIndex(value: number): boolean {
    return Number.isInteger(value) && value >= 0;
}
