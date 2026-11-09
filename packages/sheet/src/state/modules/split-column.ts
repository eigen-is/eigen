// Split text to columns: the separator pattern built from the dialog's choices, the preview of the split selected
// column, and the write that spreads each cell's parts over the columns to its right. The parts replace what those
// cells held, a formula included, and the formulas that read them recompute.

import type { Context } from '../context';
import { getFlowdata } from '../context';
import { getCellValue, setCellValue } from './cell';

export function updateMoreCell(r: number, c: number, dataMatrix: string[][], ctx: Context) {
    if (ctx.allowEdit === false) return;
    const flowdata = getFlowdata(ctx);
    for (let i = 0; i < dataMatrix.length; i += 1) {
        for (let j = 0; j < dataMatrix[i].length; j += 1) {
            setCellValue(ctx, r + i, c + j, flowdata, dataMatrix[i][j]);
        }
    }
}

export function getRegStr(selected: ReadonlySet<string>, otherValue: string) {
    const separators: string[] = [];
    if (selected.has('Tab')) separators.push('\\t');
    if (selected.has('semicolon')) separators.push(';');
    if (selected.has('comma')) separators.push(',');
    if (selected.has('space')) separators.push('\\s');
    if (selected.has('other') && otherValue !== '') separators.push(otherValue);
    const regStr = separators.join('|');
    return selected.has('splitsimple') ? `[${regStr}]+` : regStr;
}

// One row of pieces per selected cell, the short rows padded to the widest. With no pattern, each cell is one piece.
export function getDataArr(regStr: string, ctx: Context) {
    const selection = ctx.selections?.[0];
    const data = getFlowdata(ctx);
    if (!selection || !data) return [];
    const [r1, r2] = selection.row;
    const c = selection.column[0];
    const reg = regStr === '' ? null : new RegExp(regStr, 'g');
    const rows: string[][] = [];
    for (let r = r1; r <= r2; r += 1) {
        const text = String(getCellValue(r, c, data, 'm') ?? getCellValue(r, c, data) ?? '');
        rows.push(reg ? text.split(reg) : [text]);
    }
    const width = Math.max(...rows.map((row) => row.length));
    return rows.map((row) => Array.from({ length: width }, (_, j) => row[j] ?? ''));
}
