// Text-overflow geometry: which text cells spill across their empty
// neighbours, as in Google Sheets and Excel.

import { cellDisplay, cellValue } from '../../engine/format';
import type { Cell } from '../../engine/types';
import { type Context, getFlowdata, getSheetConfig } from '../context';
import { normalizedCellAttr } from '../modules/cell';
import { getCellTextInfo } from '../modules/text';
import type { Sheet } from '../types';
import { colEndX, colStartX } from './geometry';
import type { CellOverflowItem, CellOverflowMap } from './types';

// Bounds the per-row walk for a source scrolled out of view: 256 columns is wider than any text a cell shows.
export const OVERFLOW_REACH_COLUMNS = 256;

// A value of any kind stops a spill, a space or a formula's empty result included, and so does a merge; style doesn't.
function blocksOverflow(cell: Cell | null | undefined): boolean {
    if (!cell) return false;
    const display = cellDisplay(cell);
    return cell.mc != null || cell.f != null || (display != null && display !== '');
}

function spillsText(cell: Cell | null | undefined): cell is Cell {
    const value = cellValue(cell);
    return (
        !!cell && cell.mc == null && normalizedCellAttr(cell, 'tb') === '1' && typeof value === 'string' && value !== ''
    );
}

// The columns one row's spilling text covers, keyed by source column; only spans
// reaching colStart..colEnd. Past the view's edges only the first value can reach
// in, since it blocks everything behind it.
export function rowOverflowSpans(
    r: number,
    row: (Cell | null)[],
    edges: number[],
    colStart: number,
    colEnd: number,
    textWidth: (cell: Cell, c: number) => number,
    colhidden?: Record<string, number>,
): Record<number, CellOverflowItem> | undefined {
    let spans: Record<number, CellOverflowItem> | undefined;

    const consider = (c: number) => {
        const cell = row[c];
        if (!spillsText(cell) || colhidden?.[c] != null) return;
        const align = normalizedCellAttr(cell, 'ht');
        const spillsLeft = align !== '1' && c > 0 && !blocksOverflow(row[c - 1]);
        const spillsRight = align !== '2' && c < row.length - 1 && !blocksOverflow(row[c + 1]);
        if (!spillsLeft && !spillsRight) return;

        const start = colStartX(edges, c, 0);
        const end = colEndX(edges, c, 0);
        const width = textWidth(cell, c);
        const extra = width - (end - start);
        if (extra <= 0) return;

        const textStart = align === '1' ? start : align === '2' ? start - extra : start - extra / 2;
        const textEnd = align === '1' ? end + extra : align === '2' ? end : end + extra / 2;
        let stc = c;
        let edc = c;
        while (stc > 0 && textStart < colStartX(edges, stc, 0) && !blocksOverflow(row[stc - 1])) stc -= 1;
        while (edc < row.length - 1 && textEnd > colEndX(edges, edc, 0) && !blocksOverflow(row[edc + 1])) edc += 1;

        if (stc < edc && stc <= colEnd && edc >= colStart) {
            spans ??= {};
            spans[c] = { r, stc, edc };
        }
    };

    for (let c = Math.max(0, colStart - 1); c >= Math.max(0, colStart - OVERFLOW_REACH_COLUMNS); c -= 1) {
        if (blocksOverflow(row[c])) {
            consider(c);
            break;
        }
    }
    for (let c = colStart; c <= colEnd; c += 1) consider(c);
    for (let c = colEnd + 1; c <= Math.min(row.length - 1, colEnd + OVERFLOW_REACH_COLUMNS); c += 1) {
        if (blocksOverflow(row[c])) {
            consider(c);
            break;
        }
    }

    return spans;
}

export function computeCellOverflowMap(
    sheetCtx: Context,
    canvas: CanvasRenderingContext2D,
    dataVerification: Sheet['dataVerification'],
    colStart: number,
    colEnd: number,
    rowStart: number,
    rowEnd: number,
): CellOverflowMap {
    const flowdata = getFlowdata(sheetCtx);
    const map: CellOverflowMap = {};
    if (!flowdata) return map;

    const colhidden = getSheetConfig(sheetCtx)?.colhidden;
    for (let r = rowStart; r <= rowEnd; r += 1) {
        const row = flowdata[r];
        if (row == null) continue;
        map[r] = rowOverflowSpans(
            r,
            row,
            sheetCtx.visibledatacolumn,
            colStart,
            colEnd,
            // A tick box shows a glyph; its label never spills.
            (cell, c) =>
                dataVerification?.[`${r}_${c}`]?.type === 'checkbox'
                    ? 0
                    : (getCellTextInfo(cell, canvas, sheetCtx, { r, c })?.textWidthAll ?? 0),
            colhidden,
        );
    }
    return map;
}

export function overflowColIn(map: CellOverflowMap, r: number, c: number, colEnd: number) {
    let colIn = false; // Whether this cell is within an overflow cell's render range
    let colLast = false; // Whether this cell is the last column in an overflow cell's render range
    let rowIndex: number | undefined; // Overflow cell row index
    let colIndex: number | undefined; // Overflow cell column index
    let stc: number | undefined;
    let edc: number | undefined;

    const row = map[r];
    if (row) {
        for (const ckey of Object.keys(row)) {
            const mapItem = row[Number(ckey)];
            if (c >= mapItem.stc && c <= mapItem.edc) {
                colIn = true;
                rowIndex = r;
                colIndex = Number(ckey);
                stc = mapItem.stc;
                edc = mapItem.edc;

                if (c === mapItem.edc || c === colEnd) {
                    colLast = true;
                    break;
                }
            }
        }
    }

    return {
        colIn,
        colLast,
        rowIndex,
        colIndex,
        stc,
        edc,
    };
}
