import {cloneDeep, filter, isNil} from "es-toolkit/compat";
import {Context, getFlowdata} from "../context";
import {normalizeSelection} from "./selection";

export function deleteCellInSave(
    cellSave: Record<string, number>,
    range: { row: any[]; column: any[] }
): Record<string, number> {
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            delete cellSave[`${r}_${c}`];
        }
    }
    return cellSave;
}

// Get the coordinates of cells matching the condition
export function getRangeArr(
    minR: number, // Selection row start
    maxR: number, // Selection row end
    minC: number, // Selection column start
    maxC: number, // Selection column end
    cellSave: Record<string, number>,
    rangeArr: { row: (number | null)[]; column: (number | null)[] }[],
    ctx: Context
): any {
    // Check if there are any matching cells; if count is 0, return immediately.
    if (Object.keys(cellSave).length === 0) {
        return rangeArr;
    }
    /**
     * str=>startRow, edr=>endRow, stc=>startColumn, edc=>endColumn
     * The four parameters record the maximum start and end values of matching cells, since multiple matching cells may be adjacent or non-adjacent
     */
    let stack_str = null;
    let stack_edr = null;
    let stack_stc = null;
    let stack_edc = null;
    const flowData = getFlowdata(ctx, ctx.currentSheetId);
    for (let r = minR; r <= maxR; r += 1) {
        for (let c = minC; c <= maxC; c += 1) {
            if (isNil(flowData)) break;
            const cell = flowData[r][c];
            // cellSave stores the coordinates of matching cells; look up matching cell coordinates
            if (`${r}_${c}` in cellSave) {
                // Check whether the condition is a merged cell
                if (!!cell?.mc?.cs && !!cell?.mc?.rs && !!cell?.mc?.r) {
                    if (stack_stc === null) {
                        // Record the coordinates of the merged-cell-matching cell in range
                        const range = {
                            row: [cell.mc.r, cell.mc.r + cell.mc.rs - 1],
                            column: [cell.mc.c, cell.mc.c + cell.mc.cs - 1],
                        };
                        rangeArr.push(range);
                        // Once the current matching cellSave coordinate is processed, it is no longer needed, so delete it
                        cellSave = deleteCellInSave(cellSave, range);
                        return getRangeArr(minR, maxR, minC, maxC, cellSave, rangeArr, ctx);
                    }
                    // Since a merged cell spans a large range, matching cells within a smaller range are recorded using the merged cell's full coordinates
                    if (stack_edc !== null && c < stack_edc) {
                        const range = {
                            row: [stack_str, stack_edr],
                            column: [stack_stc, stack_edc],
                        };
                        rangeArr.push(range);
                        cellSave = deleteCellInSave(cellSave, range);
                        return getRangeArr(minR, maxR, minC, maxC, cellSave, rangeArr, ctx);
                    }
                    break;
                } else if (stack_stc === null) {
                    // Matches condition and is not a merged cell, and is the first match in the range — record the range
                    stack_stc = c;
                    stack_edc = c;
                    stack_str = r;
                    stack_edr = r;
                } else if (stack_edc !== null && c > stack_edc) {
                    // Matches condition and is not a merged cell, and this one is outside the current range, so update the maximum end value
                    stack_edc = c;
                }
            } else if (stack_stc !== null) {
                if (cell !== null && cell.mc !== null) {
                    break;
                } else if (c < stack_stc) {
                } else if (stack_edc !== null && c <= stack_edc) {
                    // No more contiguous matching cells; record the combined range of the previously matched cells
                    const range = {
                        row: [stack_str, stack_edr],
                        column: [stack_stc, stack_edc],
                    };
                    rangeArr.push(range);
                    cellSave = deleteCellInSave(cellSave, range);
                    return getRangeArr(minR, maxR, minC, maxC, cellSave, rangeArr, ctx);
                } else {
                    stack_edr = r;
                }
            }
        }
    }
    if (stack_stc !== null) {
        const range = {
            row: [stack_str, stack_edr],
            column: [stack_stc, stack_edc],
        };
        rangeArr.push(range);
        cellSave = deleteCellInSave(cellSave, range);
        return getRangeArr(minR, maxR, minC, maxC, cellSave, rangeArr, ctx);
    }
    return rangeArr;
}

// Get the list of operations
export function getOptionValue(
    constants: Record<string, boolean>
): string | undefined {
    const tempConstans = cloneDeep(constants);
    const len = filter(tempConstans, (o) => o).length;
    let value;
    if (len === 0) {
        value = "";
    } else if (len === 5) {
        value = "all";
    } else {
        const arr: string[] = [];
        Object.entries(constants).forEach((entry) => {
            const [k, v] = entry;
            if (v) {
                if (k === "locationDate") {
                    arr.push("d");
                } else if (k === "locationDigital") {
                    arr.push("n");
                } else if (k === "locationString") {
                    arr.push("s,g");
                } else if (k === "locationBool") {
                    arr.push("b");
                } else if (k === "locationError") {
                    arr.push("e");
                }
            }
        });
        value = arr.join(",");
    }
    return value;
}

// Get the selection coordinates
export function getSelectRange(ctx: Context) {
    let range;
    // Check if the selection is a single cell; if so, expand the range to the entire sheet
    if (
        ctx.luckysheet_select_save?.length === 0 ||
        (ctx.luckysheet_select_save?.length === 1 &&
            ctx.luckysheet_select_save[0].row[0] ===
            ctx.luckysheet_select_save[0].row[1] &&
            ctx.luckysheet_select_save[0].column[0] ===
            ctx.luckysheet_select_save[0].column[1])
    ) {
        const flowdata = getFlowdata(ctx, ctx.currentSheetId);
        if (isNil(flowdata)) return [];
        range = [
            {row: [0, flowdata.length - 1], column: [0, flowdata[0].length - 1]},
        ];
    } else {
        range = cloneDeep(ctx.luckysheet_select_save) ?? [];
    }
    return range;
}

// Conditional location feature
export function applyLocation(
    range: { row: any[]; column: any[] }[],
    type: string,
    value: string | undefined,
    ctx: Context
) {
    let rangeArr: { column: any[]; row: any[] }[] = [];
    if (
        type === "locationFormula" ||
        type === "locationConstant" ||
        type === "locationNull"
    ) {
        // Formula, constant, empty value
        let minR = null;
        let maxR = null;
        let minC = null;
        let maxC = null;
        // cellSave: records coordinates of matching cells, e.g. 0_1
        const cellSave: Record<string, number> = {};
        const flowData = getFlowdata(ctx, ctx.currentSheetId);
        if (isNil(flowData)) return [];
        for (let s = 0; s < range.length; s += 1) {
            // Selection row start
            const st_r = range[s].row[0];
            // Selection row end
            const ed_r = range[s].row[1];
            // Selection column start
            const st_c = range[s].column[0];
            // Selection column end
            const ed_c = range[s].column[1];
            if (minR === null || minR < st_r) {
                minR = st_r;
            }
            if (maxR === null || maxR > ed_r) {
                maxR = ed_r;
            }
            if (minC === null || minC < st_c) {
                minC = st_c;
            }
            if (maxC === null || maxC > ed_c) {
                maxC = ed_c;
            }
            for (let r = st_r; r <= ed_r; r += 1) {
                for (let c = st_c; c <= ed_c; c += 1) {
                    let cell = flowData[r][c];
                    if (cell?.mc) {
                        cell = flowData[cell.mc.r][cell.mc.c];
                    }
                    if (
                        type === "locationFormula" &&
                        !!cell &&
                        cell.v !== null &&
                        !!cell.f &&
                        (value === "all" ||
                            (!!cell.ct &&
                                !!value &&
                                !!cell.ct.t &&
                                value.indexOf(cell.ct.t) > -1))
                    ) {
                        cellSave[`${r}_${c}`] = 0;
                    } else if (
                        type === "locationConstant" &&
                        cell?.v &&
                        (value === "all" || (cell?.ct?.t && value!.indexOf(cell.ct.t) > -1))
                    ) {
                        cellSave[`${r}_${c}`] = 0;
                    } else if (
                        type === "locationNull" &&
                        (cell === null || cell.v === null)
                    ) {
                        cellSave[`${r}_${c}`] = 0;
                    }
                }
            }
        }
        rangeArr = getRangeArr(minR, maxR, minC, maxC, cellSave, rangeArr, ctx);
    } else if (type === "locationCF") {
        // TODO location condition
        // Conditional format
        // const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
        // let ruleArr = ctx.luckysheetfile[index].luckysheet_conditionformat_save;
        // let {data} = ctx.luckysheetfile[index];
        // if (ruleArr === null || ruleArr?.length === 0) {
        //   return [];
        // }
    } else if (type === "locationRowSpan") {
        for (let s = 0; s < range.length; s += 1) {
            if (range[s].row[0] === range[s].row[1]) {
                continue;
            }
            const st_r = range[s].row[0];
            const ed_r = range[s].row[1];
            const st_c = range[s].column[0];
            const ed_c = range[s].column[1];
            for (let r = st_r; r <= ed_r; r += 1) {
                if ((r - st_r) % 2 === 0) {
                    rangeArr.push({row: [r, r], column: [st_c, ed_c]});
                }
            }
        }
    } else if (type === "locationColumnSpan") {
        // Alternating columns
        for (let s = 0; s < range.length; s += 1) {
            if (range[s].column[0] === range[s].column[1]) {
                continue;
            }

            const st_r = range[s].row[0];
            const ed_r = range[s].row[1];
            const st_c = range[s].column[0];
            const ed_c = range[s].column[1];

            for (let c = st_c; c <= ed_c; c += 1) {
                if ((c - st_c) % 2 === 0) {
                    rangeArr.push({row: [st_r, ed_r], column: [c, c]});
                }
            }
        }
    }
    if (rangeArr.length === 0) {
        // if(isEditMode()){
        //     alert(locale_location.locationTipNotFindCell);
        // }
        // else{
        //     tooltip.info("", locale_location.locationTipNotFindCell);
        // }
        return rangeArr;
    }
    ctx.luckysheet_select_save = normalizeSelection(ctx, rangeArr);
    return rangeArr;
}
