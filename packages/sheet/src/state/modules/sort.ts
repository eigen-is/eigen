import { clone, findIndex } from 'es-toolkit/compat';
import numeral from 'numeral';
import type { Cell, CellMatrix } from '../../engine/types';
import { type Context, diff, getFlowdata, isdatetime, isRealNull, isRealNum } from '..';
import { createContextResolver, execfunction, functionCopy, update } from '.';
import { jfrefreshgrid } from './refresh';

export function orderbydata(isAsc: boolean, index: number, data: (Cell | null)[][]) {
    if (isAsc == null) {
        isAsc = true;
    }
    const a = (x: (Cell | null)[], y: (Cell | null)[]) => {
        const x1: Cell['v'] = x[index] != null ? x[index]?.v : undefined;
        const y1: Cell['v'] = y[index] != null ? y[index]?.v : undefined;
        if (isRealNull(x1)) {
            return isAsc ? 1 : -1;
        }

        if (isRealNull(y1)) {
            return isAsc ? -1 : 1;
        }
        if (isdatetime(x1) && isdatetime(y1)) {
            return diff(String(x1), String(y1));
        }
        if (isRealNum(x1) && isRealNum(y1)) {
            const y1Value = numeral(y1).value();
            const x1Value = numeral(x1).value();
            if (y1Value == null || x1Value == null) return 0;
            return x1Value - y1Value;
        }
        if (!isRealNum(x1) && !isRealNum(y1)) {
            return String(x1).localeCompare(String(y1), 'zh');
        }
        if (!isRealNum(x1)) {
            return 1;
        }
        if (!isRealNum(y1)) {
            return -1;
        }
        return 0;
    };
    const d = (x: (Cell | null)[], y: (Cell | null)[]) => a(y, x);
    const sortedData = clone(data);
    sortedData.sort(isAsc ? a : d);

    // calc row offsets
    const rowOffsets = sortedData.map((r, i) => {
        const origIndex = findIndex(data, (origR) => origR === r);
        return i - origIndex;
    });

    return { sortedData, rowOffsets };
}

export function sortDataRange(
    ctx: Context,
    sheetData: CellMatrix,
    dataRange: CellMatrix,
    index: number,
    isAsc: boolean,
    str: number,
    edr: number,
    stc: number,
    edc: number,
) {
    const { sortedData, rowOffsets } = orderbydata(isAsc, index, dataRange);

    // Live resolver, hoisted: one per sort instead of one snapshot per formula.
    const resolver = createContextResolver(ctx);
    for (let r = str; r <= edr; r += 1) {
        for (let c = stc; c <= edc; c += 1) {
            const cell = sortedData[r - str][c - stc];
            if (cell?.f) {
                const moveOffset = rowOffsets[r - str];
                let func = cell.f;
                if (moveOffset > 0) {
                    func = `=${functionCopy(func, 'down', moveOffset)}`;
                } else if (moveOffset < 0) {
                    func = `=${functionCopy(func, 'up', -moveOffset)}`;
                }
                const funcV = execfunction(ctx, func, r, c, undefined, undefined, true, undefined, resolver);
                [, cell!.v, cell!.f] = funcV;
                cell.m = update(cell.ct?.fa || 'General', cell.v);
            }
            sheetData[r][c] = cell;
        }
    }

    jfrefreshgrid(ctx, sheetData, [{ row: [str, edr], column: [stc, edc] }]);
}

export function sortSelection(ctx: Context, isAsc: boolean, colIndex: number = 0) {
    // if (!checkProtectionAuthorityNormal(ctx.currentSheetIndex, "sort")) {
    //   return;
    // }
    if (ctx.allowEdit === false) return;
    if (ctx.selections == null) return;
    if (ctx.selections.length > 1) {
        // if (isEditMode()) {
        //   alert("Cannot perform this action on a multi-selection. Please select a single range and try again.");
        // } else {
        //   tooltip.info(
        //     "Cannot perform this action on a multi-selection. Please select a single range and try again.",
        //     ""
        //   );
        // }

        return;
    }

    if (isAsc == null) {
        isAsc = true;
    }
    // const d = editor.deepCopyFlowData(Store.flowdata);
    const flowdata = getFlowdata(ctx);
    const d = flowdata;
    if (d == null) return;

    const r1 = ctx.selections[0].row[0];
    const r2 = ctx.selections[0].row[1];
    const c1 = ctx.selections[0].column[0];
    const c2 = ctx.selections[0].column[1];

    let str: number | null = null;
    let edr: number | undefined;

    for (let r = r1; r <= r2; r += 1) {
        if (d[r] != null && d[r][c1] != null) {
            const cell = d[r][c1];
            if (cell == null) return; //
            if (cell.mc != null || isRealNull(cell.v)) {
                continue;
            }
            if (str == null && /[\u4e00-\u9fa5]+/g.test(`${cell.v}`)) {
                str = r + 1;
                edr = r + 1;
                continue;
            }

            if (str == null) {
                str = r;
            }

            edr = r;
        }
    }

    if (str == null || str > r2) {
        return;
    }

    let hasMc = false; // Whether the sort selection has merged cells
    const data: CellMatrix = [];
    if (edr == null) return;
    for (let r = str; r <= edr; r += 1) {
        const data_row = [];
        for (let c = c1; c <= c2; c += 1) {
            if (d[r][c] != null && d[r][c]?.mc != null) {
                hasMc = true;
                break;
            }

            data_row.push(d[r][c]);
        }

        data.push(data_row);
    }

    if (hasMc) {
        // if (isEditMode()) {
        //   alert("The selection contains merged cells. Cannot perform this action!");
        // } else {
        //   tooltip.info("The selection contains merged cells. Cannot perform this action!", "");
        // }

        return;
    }

    sortDataRange(ctx, d, data, colIndex, isAsc, str, edr, c1, c2);
}
