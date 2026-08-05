import { type Context, getFlowdata } from '../context';
import { getCellValue, setCellValue } from './cell';

// Generate 2D array
export function getNullData(rlen: number, clen: number) {
    const arr = [];
    for (let r = 0; r < rlen; r += 1) {
        const rowArr = [];

        for (let c = 0; c < clen; c += 1) {
            rowArr.push('');
        }
        arr.push(rowArr);
    }
    return arr;
}

// Batch update data to table
export function updateMoreCell(r: number, c: number, dataMatrix: string[][], ctx: Context) {
    if (ctx.allowEdit === false) return;
    const flowdata = getFlowdata(ctx);
    for (let i = 0; i < dataMatrix.length; i += 1) {
        for (let j = 0; j < dataMatrix[i].length; j += 1) {
            const v = dataMatrix[i][j];
            setCellValue(ctx, r + i, c + j, flowdata, v);
        }
    }
}

// Build the split-regex source from the user's checkbox/text-input selection.
// Order matters: each separator appends to the alternation; "splitsimple" wraps
// the result with `[...]+` and must be applied last.
export function getRegStr(selected: ReadonlySet<string>, otherValue: string) {
    let regStr = '';
    let mark = 0;
    const append = (token: string, separator = '|') => {
        if (mark > 0) regStr += separator;
        regStr += token;
        mark += 1;
    };
    if (selected.has('Tab')) {
        regStr += '\\t';
        mark += 1;
    }
    if (selected.has('semicolon')) {
        append(';');
    }
    if (selected.has('comma')) {
        append(',');
    }
    if (selected.has('space')) {
        append('\\s');
    }
    if (selected.has('other') && otherValue !== '') {
        append(otherValue);
    }
    if (selected.has('splitsimple')) {
        regStr = `[${regStr}]+`;
    }
    return regStr;
}

// Get split data
export function getDataArr(regStr: string, ctx: Context) {
    let arr: string[][] = [];
    if (!ctx.selections?.length) return arr;
    const r1 = ctx.selections[0].row[0];
    const r2 = ctx.selections[0].row[1];
    const c = ctx.selections[0].column[0];
    const data = getFlowdata(ctx);
    if (regStr !== null && regStr !== '') {
        const reg = new RegExp(regStr, 'g');
        const dataArr = [];
        for (let r = r1; r <= r2; r += 1) {
            let rowArr = [];
            const cell = data![r][c];
            let value: string | number | boolean | null | undefined;
            if (cell !== null && cell.m !== null) {
                value = cell.m;
            } else {
                value = getCellValue(r, c, data!);
            }
            if (value === null || value === undefined) {
                value = '';
            }
            rowArr = value.toString().split(reg);
            dataArr.push(rowArr);
        }
        const rlen = dataArr.length;
        let clen = 0;
        for (let i = 0; i < rlen; i += 1) {
            if (dataArr[i].length > clen) {
                clen = dataArr[i].length;
            }
        }
        arr = getNullData(rlen, clen);
        for (let i = 0; i < arr.length; i += 1) {
            for (let j = 0; j < arr[0].length; j += 1) {
                if (dataArr[i][j] != null) {
                    arr[i][j] = dataArr[i][j];
                }
            }
        }
    } else {
        for (let r = r1; r <= r2; r += 1) {
            const rowArr = [];
            const cell = data![r][c];
            let value: string | number | boolean | null | undefined;
            if (cell !== null && cell.m !== null) {
                value = cell.m;
            } else {
                value = getCellValue(r, c, data!);
            }

            rowArr.push(value == null ? '' : String(value));

            arr.push(rowArr);
        }
    }
    return arr;
}
