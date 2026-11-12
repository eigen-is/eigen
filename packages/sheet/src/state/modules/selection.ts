// The grid's cell selection: normalizing a range around its merges, moving the highlight with the keyboard,
// select all, clearing the selected cells' contents, the status bar's sum and count, and the format painter's
// paste. The keyboard and mouse handlers call it on the context they are changing.

import { numberDisplay } from '@workspace/formula/format';
import { cloneDeep, isEmpty, isNil, isNumber } from 'es-toolkit/compat';
import { cellDisplay, writeFormulaResult } from '../../engine/format';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { FormulaCell, Range, Selection } from '../types';
import { getSheetIndex } from '../utils';
import type { CarryTile } from './carry';
import { carriedLines, carryCells } from './carry';
import { getDataBySelectionNoCopy, mergeBorder, mergeMoveMain } from './cell';
import { hasPartMC } from './validation';

function scrollToHighlightCell(ctx: Context, r: number, c: number) {
    const { scrollLeft, scrollTop } = ctx;
    const winH = ctx.cellmainHeight;
    const winW = ctx.cellmainWidth;

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    const sheet = sheetIndex == null ? null : ctx.sheets[sheetIndex];

    if (!sheet) return;

    const frozen = sheet?.frozen;

    // Both axes go into one request, so a keyboard follow scrolls once.
    const request: { left?: number; top?: number } = {};

    if (r >= 0) {
        const row_focus = sheet?.frozen?.range?.row_focus || 0;
        const freezeH = frozen && r > row_focus ? ctx.visibledatarow[row_focus] : 0;
        const row = ctx.visibledatarow[r];
        const row_pre = r - 1 === -1 ? 0 : ctx.visibledatarow[r - 1];

        if (row - scrollTop - winH + 20 > 0) {
            request.top = row - winH + 20;
        } else if (row_pre - scrollTop - freezeH < 0) {
            const scrollAmount = Math.max(20, freezeH);
            request.top = row_pre - scrollAmount;
        }
    }

    if (c >= 0) {
        const column_focus = sheet?.frozen?.range?.column_focus || 0;
        const freezeW = frozen && c > column_focus ? ctx.visibledatacolumn[column_focus] : 0;
        const col = ctx.visibledatacolumn[c];
        const col_pre = c - 1 === -1 ? 0 : ctx.visibledatacolumn[c - 1];

        if (col - scrollLeft - winW + 20 > 0) {
            request.left = col - winW + 20;
        } else if (col_pre - scrollLeft - freezeW < 0) {
            const scrollAmount = Math.max(20, freezeW);
            request.left = col_pre - scrollAmount;
        }
    }

    if (request.left != null || request.top != null) {
        ctx.scrollRequest = request;
    }
}

export function seletedHighlistByindex(ctx: Context, r1: number, r2: number, c1: number, c2: number) {
    const row = ctx.visibledatarow[r2];
    const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];
    const col = ctx.visibledatacolumn[c2];
    const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

    if (isNumber(row) && isNumber(row_pre) && isNumber(col) && isNumber(col_pre)) {
        return {
            left: col_pre,
            width: col - col_pre - 1,
            top: row_pre,
            height: row - row_pre - 1,
        };
    }
    return null;
}

export function normalizeSelection<T extends Selection[] | undefined>(ctx: Context, selection: T): T {
    if (!selection) return selection;

    const flowdata = getFlowdata(ctx);
    if (!flowdata) return selection;

    for (let i = 0; i < selection.length; i += 1) {
        const r1 = selection[i].row[0];
        // A caller may pass a one-cell `[n]`; the missing end becomes `[n, n]`.
        const r2 = selection[i].row[1] ?? r1;
        const c1 = selection[i].column[0];
        const c2 = selection[i].column[1] ?? c1;

        const rf = selection[i].row_focus ?? r1;
        const cf = selection[i].column_focus ?? c1;

        const row = ctx.visibledatarow[r2];
        const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];
        const col = ctx.visibledatacolumn[c2];
        const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

        let row_f = ctx.visibledatarow[rf];
        let row_pre_f = rf - 1 === -1 ? 0 : ctx.visibledatarow[rf - 1];
        let col_f = ctx.visibledatacolumn[cf];
        let col_pre_f = cf - 1 === -1 ? 0 : ctx.visibledatacolumn[cf - 1];

        const margeset = mergeBorder(ctx, flowdata, rf, cf);
        if (margeset) {
            [row_pre_f, row_f] = margeset.row;
            [col_pre_f, col_f] = margeset.column;
        }

        selection[i].row = [r1, r2];
        selection[i].column = [c1, c2];

        selection[i].row_focus = rf;
        selection[i].column_focus = cf;

        selection[i].left = col_pre_f;
        selection[i].width = col_f - col_pre_f <= 0 ? 0 : col_f - col_pre_f - 1;
        selection[i].top = row_pre_f;
        selection[i].height = row_f - row_pre_f <= 0 ? 0 : row_f - row_pre_f - 1;

        selection[i].left_move = col_pre;
        selection[i].width_move = col - col_pre <= 0 ? 0 : col - col_pre - 1;
        selection[i].top_move = row_pre;
        selection[i].height_move = row - row_pre <= 0 ? 0 : row - row_pre - 1;
    }
    return selection;
}

export function selectTitlesMap(rangeMap: Record<string, number>, range1: number, range2: number) {
    const map: Record<string, number> = rangeMap || {};
    for (let i = range1; i <= range2; i += 1) {
        map[i] ??= 0;
    }
    return map;
}

export function selectTitlesRange(map: Record<string, number>) {
    const mapArr = Object.keys(map).map(Number);

    mapArr.sort((a, b) => {
        return a - b;
    });

    let rangeArr: number[][] | undefined;
    let item = [];

    if (mapArr.length > 1) {
        rangeArr = [];
        for (let j = 1; j < mapArr.length; j += 1) {
            if (mapArr[j] - mapArr[j - 1] === 1) {
                item.push(mapArr[j - 1]);

                if (j === mapArr.length - 1) {
                    item.push(mapArr[j]);
                    rangeArr.push(item);
                }
            } else {
                if (j === 1) {
                    if (j === mapArr.length - 1) {
                        item.push(mapArr[j - 1]);
                        rangeArr.push(item);
                        rangeArr.push([mapArr[j]]);
                    } else {
                        rangeArr.push([mapArr[0]]);
                    }
                } else if (j === mapArr.length - 1) {
                    item.push(mapArr[j - 1]);
                    rangeArr.push(item);
                    rangeArr.push([mapArr[j]]);
                } else {
                    item.push(mapArr[j - 1]);
                    rangeArr.push(item);
                    item = [];
                }
            }
        }
    } else {
        rangeArr = [];
        rangeArr.push([mapArr[0]]);
    }

    return rangeArr;
}

// The cell fields the format painter replaces with the source's, as distinct from the value it leaves.
const PAINTED_FORMATS = ['bg', 'fc', 'ct', 'ht', 'vt', 'bl', 'it', 'cl', 'un', 'fs', 'ff', 'tb'] as const;

export function pasteHandlerOfPaintModel(
    ctx: Context,
    { sheetId, range: sourceRange }: NonNullable<Context['painterSource']>,
) {
    const lines = carriedLines(ctx, sheetId, [sourceRange]);
    if (!lines) return;
    const height = lines.rows.length;
    const width = lines.columns.length;
    if (height === 0 || width === 0) return;

    if (!ctx.selections) return;
    const last = ctx.selections[ctx.selections.length - 1];
    const top = last.row[0];
    let bottom = last.row[1];
    const left = last.column[0];
    let right = last.column[1];

    if (top === bottom && left === right) {
        // One selected cell takes the whole copied block, unless the block would land over part of a merge.
        if (hasPartMC(ctx, top, top + height - 1, left, left + width - 1)) {
            return;
        }

        bottom = top + height - 1;
        right = left + width - 1;
    }

    const tileRows = Math.ceil((bottom - top + 1) / height);
    const tileColumns = Math.ceil((right - left + 1) / width);

    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return;
    // The painter paints the grid there is and never grows it, so the last tiles stop at its edge too.
    const lastRow = Math.min(bottom + 1, flowdata.length);
    const lastColumn = Math.min(right + 1, flowdata[0].length);

    const tiles: CarryTile[] = [];
    for (let th = 0; th < tileRows; th += 1) {
        for (let tc = 0; tc < tileColumns; tc += 1) {
            const row = top + th * height;
            const column = left + tc * width;
            tiles.push({
                row,
                column,
                height: Math.min(height, lastRow - row),
                width: Math.min(width, lastColumn - column),
            });
        }
    }

    carryCells(ctx, lines, tiles, ({ source, r, c }) => {
        // The destination keeps its value and takes the source's formats. An empty source has none to give.
        const value = cloneDeep(source) ?? {};
        const cell = flowdata[r][c] ?? {};
        const ownType = cell.ct?.t;
        if (ownType === 'inlineStr') {
            delete value.ct;
        } else {
            for (const item of PAINTED_FORMATS) Reflect.deleteProperty(cell, item);
        }

        // The value and the link stay the destination's.
        delete value.v;
        delete value.m;
        delete value.f;
        delete value.link;
        if (value.ct?.t === 'inlineStr') {
            delete value.ct;
        }

        Object.assign(cell, value);
        if (cell.ct?.t === 'inlineStr' && cell.ct.s) {
            for (const item of cell.ct.s) {
                Object.assign(item, value);
            }
        }
        // The painted format changes how the kept value shows, not what it is: text someone typed stays text.
        if (cell.f != null || typeof cell.v === 'number') writeFormulaResult(cell, cell.v);
        else if (cell.v != null) (cell.ct ??= { fa: 'General' }).t = ownType ?? 'g';
        return cell;
    });
}

function rowHasMerged(ctx: Context, r: number, c1: number, c2: number) {
    let hasMerged = false;
    const flowData = getFlowdata(ctx);
    if (isNil(flowData) || isNil(flowData[r])) return false;
    for (let c = c1; c <= c2; c += 1) {
        const cell = flowData[r][c];
        if (!isNil(cell) && 'mc' in cell) {
            hasMerged = true;
            break;
        }
    }

    return hasMerged;
}

function colHasMerged(ctx: Context, c: number, r1: number, r2: number) {
    let hasMerged = false;
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) return false;
    const merge = getSheetConfig(ctx)?.merge;
    for (let r = r1; r <= r2; r += 1) {
        const cell = flowData[r]?.[c];
        if (!isNil(merge) && !isNil(cell) && 'mc' in cell && !isNil(cell.mc)) {
            hasMerged = true;
            break;
        }
    }
    return hasMerged;
}

function getRowMerge(ctx: Context, rIndex: number, c1: number, c2: number) {
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) return [null, null];
    const merge = getSheetConfig(ctx)?.merge;
    const r2 = flowData.length - 1;
    let str = null;
    if (rIndex > 0) {
        for (let r = rIndex; r >= 0; r -= 1) {
            for (let c = c1; c <= c2; c += 1) {
                const cell = flowData[r][c];
                if (!isNil(cell) && !isNil(cell.mc) && 'mc' in cell && !isNil(merge)) {
                    const mc = merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(str) || mc.r < str) {
                        str = mc.r;
                    }
                }
            }
            if (!isNil(str) && rowHasMerged(ctx, str - 1, c1, c2) && str > 0) {
                r = str;
            } else {
                break;
            }
        }
    } else {
        str = 0;
    }
    let end = null;
    if (rIndex < r2) {
        for (let r = rIndex; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
                const cell = flowData[r][c];
                if (!isNil(cell) && !isNil(cell.mc) && 'mc' in cell && !isNil(merge)) {
                    const mc = merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(end) || mc.r + mc.rs - 1 > end) {
                        end = mc.r + mc.rs - 1;
                    }
                }
            }
            if (!isNil(end) && rowHasMerged(ctx, end + 1, c1, c2) && end < r2) {
                r = end;
            } else {
                break;
            }
        }
    } else {
        end = r2;
    }
    return [str, end];
}

function getColMerge(ctx: Context, cIndex: number, r1: number, r2: number) {
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) {
        return [null, null];
    }
    const merge = getSheetConfig(ctx)?.merge;
    const c2 = flowData[0].length - 1;
    let str = null;
    if (cIndex > 0) {
        for (let c = cIndex; c >= 0; c -= 1) {
            for (let r = r1; r <= r2; r += 1) {
                const cell = flowData[r][c];
                if (!isNil(merge) && !isNil(cell) && 'mc' in cell && !isNil(cell.mc)) {
                    const mc = merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(str) || mc.c < str) {
                        str = mc.c;
                    }
                }
            }
            if (!isNil(str) && colHasMerged(ctx, str - 1, r1, r2) && str > 0) {
                c = str;
            } else {
                break;
            }
        }
    } else {
        str = 0;
    }
    let end = null;
    if (cIndex < c2) {
        for (let c = cIndex; c <= c2; c += 1) {
            for (let r = r1; r <= r2; r += 1) {
                const cell = flowData[r][c];
                if (!isNil(merge) && !isNil(cell) && 'mc' in cell && !isNil(cell.mc)) {
                    const mc = merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(end) || mc.c + mc.cs - 1 > end) {
                        end = mc.c + mc.cs - 1;
                    }
                }
            }

            if (!isNil(end) && colHasMerged(ctx, end + 1, r1, r2) && end < c2) {
                c = end;
            } else {
                break;
            }
        }
    } else {
        end = c2;
    }
    return [str, end];
}

type HighlightCellWalk = {
    row: number | undefined;
    row_pre: number | undefined;
    row_index: number | undefined;
    row_index_ed: number | undefined;
    col: number | undefined;
    col_pre: number | undefined;
    col_index: number | undefined;
    col_index_ed: number | undefined;
    moveX: number;
    moveY: number;
};

// Advances the focused cell by `index` along `position`, across merges on both ends.
// Off a merge, a selection keys its range off the clamped cursor and a formula range off the moved anchor.
function computeMoveHighlightCell(
    ctx: Context,
    flowdata: NonNullable<ReturnType<typeof getFlowdata>>,
    last: Selection,
    position: 'down' | 'right',
    index: number,
    indexFromMove: boolean,
): HighlightCellWalk {
    const datarowlen = flowdata.length;
    const datacolumnlen = flowdata[0].length;

    let curR = last.row_focus ?? last.row[0];
    let curC = last.column_focus ?? last.column[0];

    const margeset = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset) {
        const str_r = margeset.row[2];
        const end_r = margeset.row[3];

        const str_c = margeset.column[2];
        const end_c = margeset.column[3];

        if (index > 0) {
            if (position === 'down') {
                curR = end_r;
                curC = str_c;
            } else if (position === 'right') {
                curR = str_r;
                curC = end_c;
            }
        } else {
            curR = str_r;
            curC = str_c;
        }
    }

    let moveX = isNil(last.moveXY) ? curR : last.moveXY.x;
    let moveY = isNil(last.moveXY) ? curC : last.moveXY.y;

    if (position === 'down') {
        curR += index;
        moveX = curR;
    } else if (position === 'right') {
        curC += index;
        moveY = curC;
    }

    if (curR >= datarowlen) {
        curR = datarowlen - 1;
        moveX = curR;
    }

    if (curR < 0) {
        curR = 0;
        moveX = curR;
    }

    if (curC >= datacolumnlen) {
        curC = datacolumnlen - 1;
        moveY = curC;
    }

    if (curC < 0) {
        curC = 0;
        moveY = curC;
    }

    const margeset2 = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset2) {
        const [row_pre, row, row_index, row_index_ed] = margeset2.row;
        const [col_pre, col, col_index, col_index_ed] = margeset2.column;
        return { row, row_pre, row_index, row_index_ed, col, col_pre, col_index, col_index_ed, moveX, moveY };
    }

    const row = ctx.visibledatarow[moveX];
    const row_pre = moveX - 1 === -1 ? 0 : ctx.visibledatarow[moveX - 1];
    const col = ctx.visibledatacolumn[moveY];
    const col_pre = moveY - 1 === -1 ? 0 : ctx.visibledatacolumn[moveY - 1];
    const anchorR = indexFromMove ? moveX : curR;
    const anchorC = indexFromMove ? moveY : curC;

    return {
        row,
        row_pre,
        row_index: anchorR,
        row_index_ed: anchorR,
        col,
        col_pre,
        col_index: anchorC,
        col_index_ed: anchorC,
        moveX,
        moveY,
    };
}

export function moveHighlightCell(
    ctx: Context,
    position: 'down' | 'right',
    index: number,
    type: 'rangeOfSelect' | 'rangeOfFormula',
) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (type === 'rangeOfSelect') {
        const last = ctx.selections?.[ctx.selections.length - 1];
        if (!last) return;

        const walk = computeMoveHighlightCell(ctx, flowdata, last, position, index, false);
        const { row_index, row_index_ed, col_index, col_index_ed, moveX, moveY } = walk;

        if (isNil(row_index) || isNil(row_index_ed) || isNil(col_index) || isNil(col_index_ed)) {
            console.error('moveHighlightCell: row_index or row_index_ed or col_index or col_index_ed is nil');
            return;
        }

        last.row = [row_index, row_index_ed];
        last.column = [col_index, col_index_ed];
        last.row_focus = row_index;
        last.column_focus = col_index;
        last.moveXY = { x: moveX, y: moveY };

        normalizeSelection(ctx, ctx.selections);
        scrollToHighlightCell(ctx, row_index, col_index);
    } else if (type === 'rangeOfFormula') {
        const last = ctx.formulaCache.func_selectedrange;
        if (!last) return;

        const walk = computeMoveHighlightCell(ctx, flowdata, last, position, index, true);
        const { row, row_pre, row_index, row_index_ed, col, col_pre, col_index, col_index_ed, moveX, moveY } = walk;

        if (
            isNil(col) ||
            isNil(col_pre) ||
            isNil(row) ||
            isNil(row_pre) ||
            isNil(row_index) ||
            isNil(row_index_ed) ||
            isNil(col_index) ||
            isNil(col_index_ed)
        ) {
            console.error('moveHighlightCell: some values of func_selectedrange is nil');
            return;
        }

        ctx.formulaCache.func_selectedrange = {
            left: col_pre,
            width: col - col_pre - 1,
            top: row_pre,
            height: row - row_pre - 1,
            left_move: col_pre,
            width_move: col - col_pre - 1,
            top_move: row_pre,
            height_move: row - row_pre - 1,
            row: [row_index, row_index_ed],
            column: [col_index, col_index_ed],
            row_focus: row_index,
            column_focus: col_index,
            moveXY: { x: moveX, y: moveY },
        };
    }
}

// The selection arm and the formula arm look like clones but differ inside several merge branches and in how they
// write back. Unifying them would change behavior.
export function moveHighlightRange(
    ctx: Context,
    position: 'down' | 'right',
    index: number,
    type: 'rangeOfSelect' | 'rangeOfFormula',
) {
    let row: number;
    let row_pre: number;
    let col: number;
    let col_pre: number;
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) return;
    if (isNil(ctx.selections)) return;
    if (type === 'rangeOfSelect') {
        const last = ctx.selections[ctx.selections.length - 1];
        let curR = last.row[0];
        let endR = last.row[1];
        let curC = last.column[0];
        let endC = last.column[1];
        const rf = last.row_focus;
        const cf = last.column_focus;
        if (isNil(rf) || isNil(cf)) return;
        const datarowlen = flowData.length;
        const datacolumnlen = flowData[0].length;
        if (position === 'down') {
            if (rowHasMerged(ctx, rf, curC, endC)) {
                const rfMerge = getRowMerge(ctx, rf, curC, endC);
                const rf_str = rfMerge[0];
                const rf_end = rfMerge[1];
                if (!isNil(rf_str) && rf_str > curR && rf_end === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (!isNil(rf_end) && rf_end < endR && rf_str === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                    }
                    endR += index;
                } else {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            } else {
                if (rf > curR && rf === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (rf < endR && rf === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, endR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                    }
                    endR += index;
                } else if (rf === curR && rf === endR) {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            }
            if (endR >= datarowlen) {
                endR = datarowlen - 1;
            }
            if (endR < 0) {
                endR = 0;
            }
            if (curR >= datarowlen) {
                curR = datarowlen - 1;
            }
            if (curR < 0) {
                curR = 0;
            }
        } else {
            if (colHasMerged(ctx, cf, curR, endR)) {
                const cfMerge = getColMerge(ctx, cf, curR, endR);
                const cf_str = cfMerge[0];
                const cf_end = cfMerge[1];
                if (!isNil(cf_str) && cf_str > curC && cf_end === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                    }
                    curC += index;
                } else if (!isNil(cf_end) && cf_end < endC && cf_str === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }
                    endC += index;
                } else {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            } else {
                if (cf > curC && cf === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                    }
                    curC += index;
                } else if (cf < endC && cf === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }
                    endC += index;
                } else if (cf === curC && cf === endC) {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            }
            if (endC >= datacolumnlen) {
                endC = datacolumnlen - 1;
            }
            if (endC < 0) {
                endC = 0;
            }
            if (curC >= datacolumnlen) {
                curC = datacolumnlen - 1;
            }
            if (curC < 0) {
                curC = 0;
            }
        }
        let rowseleted: number[] = [curR, endR];
        let columnseleted: number[] = [curC, endC];
        row = ctx.visibledatarow[endR];
        row_pre = curR - 1 === -1 ? 0 : ctx.visibledatarow[curR - 1];
        col = ctx.visibledatacolumn[endC];
        col_pre = curC - 1 === -1 ? 0 : ctx.visibledatacolumn[curC - 1];
        const changeparam = mergeMoveMain(
            ctx,
            columnseleted,
            rowseleted,
            row_pre,
            row - row_pre - 1,
            col_pre,
            col - col_pre - 1,
        );
        if (!isNil(changeparam)) {
            [columnseleted, rowseleted] = changeparam;
        }
        last.row = rowseleted;
        last.column = columnseleted;
        normalizeSelection(ctx, ctx.selections);

        if (position === 'down') {
            const rowToScroll = last.row_focus === last.row[0] ? last.row[1] : last.row[0];
            scrollToHighlightCell(ctx, rowToScroll, -1);
        } else {
            const columnToScroll = last.column_focus === last.column[0] ? last.column[1] : last.column[0];
            scrollToHighlightCell(ctx, -1, columnToScroll);
        }
    } else if (type === 'rangeOfFormula') {
        const last = ctx.formulaCache.func_selectedrange;
        if (isNil(last)) return;
        let curR = last.row[0];
        let endR = last.row[1];
        let curC = last.column[0];
        let endC = last.column[1];
        const rf = last.row_focus;
        const cf = last.column_focus;

        const datarowlen = flowData.length;
        const datacolumnlen = flowData[0].length;

        if (position === 'down') {
            if (!isNil(rf) && rowHasMerged(ctx, rf, curC, endC)) {
                const rfMerge = getRowMerge(ctx, rf, curC, endC);
                const rf_str = rfMerge[0];
                const rf_end = rfMerge[1];
                if (!isNil(rf_str) && rf_str > curR && rf_end === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (!isNil(rf_end) && rf_end < endR && rf_str === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, endR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                        endR += index;
                    }
                } else {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            } else {
                if (!isNil(rf) && rf > curR && rf === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (!isNil(rf) && rf < endR && rf === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, endR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                    }
                    endR += index;
                } else if (rf === curR && rf === endR) {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            }
            if (endR >= datarowlen) {
                endR = datarowlen - 1;
            }
            if (endR < 0) {
                endR = 0;
            }
            if (curR >= datarowlen) {
                curR = datarowlen - 1;
            }
            if (curR < 0) {
                curR = 0;
            }
        } else {
            if (!isNil(cf) && colHasMerged(ctx, cf, curR, endR)) {
                const cfMerge = getColMerge(ctx, cf, curR, endR);
                const cf_str = cfMerge[0];
                const cf_end = cfMerge[1];
                if (!isNil(cf_str) && cf_str > curC && cf_end === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                    }

                    curC += index;
                } else if (!isNil(cf_end) && cf_end < endC && cf_str === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }

                    endC += index;
                } else {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            } else {
                if (!isNil(cf) && cf > curC && cf === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                    }

                    curC += index;
                } else if (!isNil(cf) && cf < endC && cf === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }

                    endC += index;
                } else if (cf === curC && cf === endC) {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            }
            if (endC >= datacolumnlen) {
                endC = datacolumnlen - 1;
            }
            if (endC < 0) {
                endC = 0;
            }
            if (curC >= datacolumnlen) {
                curC = datacolumnlen - 1;
            }
            if (curC < 0) {
                curC = 0;
            }
        }
        let rowseleted = [curR, endR];
        let columnseleted = [curC, endC];

        row = ctx.visibledatarow[endR];
        row_pre = curR - 1 === -1 ? 0 : ctx.visibledatarow[curR - 1];
        col = ctx.visibledatacolumn[endC];
        col_pre = curC - 1 === -1 ? 0 : ctx.visibledatacolumn[curC - 1];

        let top = row_pre;
        let height = row - row_pre - 1;
        let left = col_pre;
        let width = col - col_pre - 1;

        const changeparam = mergeMoveMain(ctx, columnseleted, rowseleted, top, height, left, width);
        if (!isNil(changeparam)) {
            [columnseleted, rowseleted, top, height, left, width] = changeparam;
        }
        ctx.formulaCache.func_selectedrange = {
            left,
            width,
            top,
            height,
            left_move: left,
            width_move: width,
            top_move: top,
            height_move: height,
            row: rowseleted,
            column: columnseleted,
            row_focus: rf,
            column_focus: cf,
        };
    }
}

// Returns the cells it cleared, for the recompute to name: every cell of a select-all would make clearing a large and
// mostly empty selection slow.
export function deleteSelectedCellText(ctx: Context): FormulaCell[] {
    const changed: FormulaCell[] = [];

    const selection = ctx.selections;
    if (selection && !isEmpty(selection)) {
        const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
        const data = sheetIndex == null ? undefined : ctx.sheets[sheetIndex].data;
        if (sheetIndex == null || !data) return changed;

        for (const { row, column } of selection) {
            if (hasPartMC(ctx, row[0], row[1], column[0], column[1])) {
                ctx.warnDialog = 'Cannot perform this operation on partially merged cells';
                return changed;
            }
        }

        for (const { row, column } of selection) {
            for (let r = row[0]; r <= row[1]; r += 1) {
                data[r] ??= [];
                for (let c = column[0]; c <= column[1]; c += 1) {
                    // Delete leaves a cell its format, as Excel and Google Sheets do. The value, the formula, a rich
                    // cell's runs and a link go, and the link's blue underline goes with the link, as removeHyperlink
                    // does. A formatted cell with no contents is left alone, so it writes nothing.
                    const cell = data[r][c];
                    if (!cell) continue;
                    const { v, m, f, qp, link, ct, ...format } = cell;
                    if (v == null && m == null && f == null && qp == null && link == null && ct?.s == null) continue;
                    if (link) {
                        delete format.fc;
                        delete format.un;
                    }
                    changed.push({ r, c, id: ctx.currentSheetId });
                    if (ct) {
                        const { s: _runs, ...type } = ct;
                        data[r][c] = { ...format, ct: type.t === 'inlineStr' ? { ...type, t: 'g' } : type };
                    } else {
                        data[r][c] = format;
                    }
                }
            }
        }
    }
    return changed;
}

export function selectIsOverlap(ctx: Context, range?: Range) {
    const ranges = range ?? ctx.selections ?? [];

    let overlap = false;
    const seen: Record<string, true> = {};

    for (let s = 0; s < ranges.length; s += 1) {
        const str_r = ranges[s].row[0];
        const end_r = ranges[s].row[1];
        const str_c = ranges[s].column[0];
        const end_c = ranges[s].column[1];

        for (let r = str_r; r <= end_r; r += 1) {
            for (let c = str_c; c <= end_c; c += 1) {
                if (`${r}_${c}` in seen) {
                    overlap = true;
                    break;
                }
                seen[`${r}_${c}`] = true;
            }
        }
    }

    return overlap;
}

export function selectAll(ctx: Context) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    ctx.selectionActive = false;

    ctx.selections = [
        {
            row: [0, flowdata.length - 1],
            column: [0, flowdata[0].length - 1],
            row_focus: 0,
            column_focus: 0,
            row_select: true,
            column_select: true,
        },
    ];

    normalizeSelection(ctx, ctx.selections);
}

export function calcSelectionInfo(ctx: Context) {
    const selection = ctx.selections ?? [];
    let numberC = 0;
    let count = 0;
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (let s = 0; s < selection.length; s += 1) {
        const data = getDataBySelectionNoCopy(ctx, selection[s]);
        for (let r = 0; r < data.length; r += 1) {
            for (let c = 0; c < data[0].length; c += 1) {
                const cell = data[r][c];
                const ct = cell?.ct?.t;
                const value = cellDisplay(cell);
                // Numeric cells read v, as parseFloat cannot read m's currency symbols and separators. A nil v is NaN, not 0.
                const valueNumber = ct === 'n' ? Number(cell?.v ?? Number.NaN) : parseFloat(String(value));
                if ((ct === 'n' || ct === 'g') && !Number.isNaN(valueNumber)) {
                    count += 1;
                    sum += valueNumber;
                    max = Math.max(valueNumber, max);
                    min = Math.min(valueNumber, min);
                    numberC += 1;
                } else if (value != null) {
                    count += 1;
                }
            }
        }
    }
    const average = numberDisplay(sum / numberC, '0.00');
    const sumStr = numberDisplay(sum, '0.00');
    const maxStr = numberDisplay(max, '0.00');
    const minStr = numberDisplay(min, '0.00');
    return { numberC, count, sum: sumStr, max: maxStr, min: minStr, average };
}
