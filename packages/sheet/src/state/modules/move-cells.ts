import type { BorderInfo, CellBorderInfo, RangeBorderInfo } from '@workspace/lib/sheets';
import { cloneDeep, set } from 'es-toolkit/compat';
import { cfSplitRange } from '../../engine/conditional-format';
import type { Cell, SingleRange } from '../../engine/types';

import { type Context, getFlowdata } from '../context';
import { en } from '../locale/en';
import type { GlobalCache } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';
import { getBorderInfoCompute } from './border';
import { getdatabyselection } from './cell';
import { colLocation, colLocationByIndex, mousePosition, rowLocation, rowLocationByIndex } from './location';
import { jfrefreshgrid } from './refresh';
import { normalizeSelection } from './selection';
import { hasPartMC } from './validation';

const dragCellThreshold = 8;

function getCellLocationByMouse(ctx: Context, e: MouseEvent, scrollEl: HTMLDivElement, container: HTMLDivElement) {
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollEl.scrollLeft;
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollEl.scrollTop;

    return {
        row: rowLocation(y, ctx.visibledatarow),
        column: colLocation(x, ctx.visibledatacolumn),
    };
}

export function onCellsMoveStart(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    const allowEdit = isAllowEdit(ctx);
    if (allowEdit === false) {
        // Selection drag is disabled in this mode
        return;
    }

    globalCache.dragCellStartPos = { x: e.pageX, y: e.pageY };
    ctx.cellSelectMoving = true;
    ctx.scrolling = true;

    let {
        row: [row_pre, row, row_index],
        column: [col_pre, col, col_index],
    } = getCellLocationByMouse(ctx, e, scrollEl, container);

    const range = ctx.selections?.at(-1);
    if (range == null) return;

    if (row_index < range.row[0]) {
        [row_index] = range.row;
    } else if (row_index > range.row[1]) [, row_index] = range.row;
    if (col_index < range.column[0]) {
        [col_index] = range.column;
    } else if (col_index > range.column[1]) [, col_index] = range.column;
    [row_pre, row] = rowLocationByIndex(row_index, ctx.visibledatarow);
    [col_pre, col] = colLocationByIndex(col_index, ctx.visibledatacolumn);

    ctx.cellSelectMoveIndex = [row_index, col_index];

    // The move preview renders once per overlay pane region; write every copy —
    // each region's clip shows exactly its portion.
    const eles = container.querySelectorAll<HTMLDivElement>('.sheet-cell-selected-move');
    if (eles.length === 0) return;
    for (const ele of eles) {
        ele.style.left = `${col_pre}px`;
        ele.style.top = `${row_pre}px`;
        ele.style.width = `${col - col_pre - 1}px`;
        ele.style.height = `${row - row_pre - 1}px`;
        ele.style.display = 'block';
    }

    e.stopPropagation();
}

export function onCellsMove(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    if (!ctx.cellSelectMoving) return;
    if (globalCache.dragCellStartPos != null) {
        const deltaX = Math.abs(globalCache.dragCellStartPos.x - e.pageX);
        const deltaY = Math.abs(globalCache.dragCellStartPos.y - e.pageY);
        if (deltaX < dragCellThreshold && deltaY < dragCellThreshold) {
            return;
        }
        globalCache.dragCellStartPos = undefined;
    }
    const [x, y] = mousePosition(e.pageX, e.pageY, ctx);

    const rect = container.getBoundingClientRect();
    const winH = rect.height - 20;
    const winW = rect.width - 60;

    const { row: rowL, column } = getCellLocationByMouse(ctx, e, scrollEl, container);
    let [row_pre, row] = rowL;
    let [col_pre, col] = column;
    const row_index = rowL[2];
    const col_index = column[2];

    const row_index_original = ctx.cellSelectMoveIndex[0];
    const col_index_original = ctx.cellSelectMoveIndex[1];
    if (ctx.selections == null) return;
    let row_s = ctx.selections[0].row[0] - row_index_original + row_index;
    let row_e = ctx.selections[0].row[1] - row_index_original + row_index;

    let col_s = ctx.selections[0].column[0] - col_index_original + col_index;
    let col_e = ctx.selections[0].column[1] - col_index_original + col_index;

    if (row_s < 0 || y < 0) {
        row_s = 0;
        row_e = ctx.selections[0].row[1] - ctx.selections[0].row[0];
    }

    if (col_s < 0 || x < 0) {
        col_s = 0;
        col_e = ctx.selections[0].column[1] - ctx.selections[0].column[0];
    }

    if (row_e >= ctx.visibledatarow.length - 1 || y > winH) {
        row_s = ctx.visibledatarow.length - 1 - ctx.selections[0].row[1] + ctx.selections[0].row[0];
        row_e = ctx.visibledatarow.length - 1;
    }

    if (col_e >= ctx.visibledatacolumn.length - 1 || x > winW) {
        col_s = ctx.visibledatacolumn.length - 1 - ctx.selections[0].column[1] + ctx.selections[0].column[0];
        col_e = ctx.visibledatacolumn.length - 1;
    }

    col_pre = col_s - 1 === -1 ? 0 : ctx.visibledatacolumn[col_s - 1];
    col = ctx.visibledatacolumn[col_e];
    row_pre = row_s - 1 === -1 ? 0 : ctx.visibledatarow[row_s - 1];
    row = ctx.visibledatarow[row_e];

    for (const ele of container.querySelectorAll<HTMLDivElement>('.sheet-cell-selected-move')) {
        ele.style.left = `${col_pre}px`;
        ele.style.top = `${row_pre}px`;
        ele.style.width = `${col - col_pre - 2}px`;
        ele.style.height = `${row - row_pre - 2}px`;
        ele.style.display = 'block';
    }
}

export function onCellsMoveEnd(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    // Change selection box position and replace target cells
    if (!ctx.cellSelectMoving) return;
    ctx.cellSelectMoving = false;
    for (const ele of container.querySelectorAll<HTMLDivElement>('.sheet-cell-selected-move')) {
        ele.style.display = 'none';
    }
    if (globalCache.dragCellStartPos != null) {
        globalCache.dragCellStartPos = undefined;
        return;
    }

    const [x, y] = mousePosition(e.pageX, e.pageY, ctx);

    const rect = container.getBoundingClientRect();
    const winH = rect.height - 20;
    const winW = rect.width - 60;

    const {
        row: [, , row_index],
        column: [, , col_index],
    } = getCellLocationByMouse(ctx, e, scrollEl, container);

    const allowEdit = isAllowEdit(ctx, [
        {
            row: [row_index, row_index],
            column: [col_index, col_index],
        },
    ]);
    if (!allowEdit) return;

    const row_index_original = ctx.cellSelectMoveIndex[0];
    const col_index_original = ctx.cellSelectMoveIndex[1];

    if (row_index === row_index_original && col_index === col_index_original) {
        return;
    }

    const d = getFlowdata(ctx);
    if (d == null || ctx.selections == null) return;
    const last = ctx.selections[ctx.selections.length - 1];

    const data = cloneDeep(getdatabyselection(ctx, last, ctx.currentSheetId));

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) return;
    const { drag: locale_drag } = en;

    // Selection contains partial cells
    if (hasPartMC(ctx, last.row[0], last.row[1], last.column[0], last.column[1])) {
        ctx.warnDialog = locale_drag.noMerge;
        return;
    }

    let row_s = last.row[0] - row_index_original + row_index;
    let row_e = last.row[1] - row_index_original + row_index;
    let col_s = last.column[0] - col_index_original + col_index;
    let col_e = last.column[1] - col_index_original + col_index;

    if (row_s < 0 || y < 0) {
        row_s = 0;
        row_e = last.row[1] - last.row[0];
    }

    if (col_s < 0 || x < 0) {
        col_s = 0;
        col_e = last.column[1] - last.column[0];
    }

    if (row_e >= ctx.visibledatarow.length - 1 || y > winH) {
        row_s = ctx.visibledatarow.length - 1 - last.row[1] + last.row[0];
        row_e = ctx.visibledatarow.length - 1;
    }

    if (col_e >= ctx.visibledatacolumn.length - 1 || x > winW) {
        col_s = ctx.visibledatacolumn.length - 1 - last.column[1] + last.column[0];
        col_e = ctx.visibledatacolumn.length - 1;
    }

    // Replacement position contains partial cells
    if (hasPartMC(ctx, row_s, row_e, col_s, col_e)) {
        ctx.warnDialog = locale_drag.noMerge;
        return;
    }

    // Seeded only once the move is certain: every config write is syncable now that the
    // mirror is gone, so seeding above the guards would ship an op and burn an undo entry
    // for a move the user was told could not happen.
    const cfg = (ctx.sheets[sheetIndex].config ??= {});
    cfg.merge ??= {};

    const borderInfoCompute = getBorderInfoCompute(ctx, ctx.currentSheetId);

    const hyperLinkList: Record<
        string,
        {
            linkType: string;
            linkAddress: string;
        }
    > = {};
    // Delete data from original position
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    for (let r = last.row[0]; r <= last.row[1]; r += 1) {
        for (let c = last.column[0]; c <= last.column[1]; c += 1) {
            const cellData: Cell | null = d[r][c];

            if (cellData?.mc != null) {
                const mergeKey = `${cellData.mc.r}_${c}`;
                if (cfg.merge[mergeKey] != null) {
                    delete cfg.merge[mergeKey];
                }
            }

            d[r][c] = null;
            const link = ctx.sheets[index].hyperlink?.[`${r}_${c}`];
            if (link) {
                hyperLinkList[`${r}_${c}`] = link;
                delete ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) as number].hyperlink?.[`${r}_${c}`];
            }
        }
    }
    // Border. Three branches: non-slash range (rect-subtract via cfSplitRange),
    // cell entry (point check), slash range (per-cell containment of range[0]).
    // moveCells uses per-cell containment for slash because slash sits on a
    // single anchor cell, not a rect — different from paste's cutPaste path
    // (paste.ts:632-660) which passes slash through cfSplitRange anyway.
    if (cfg.borderInfo && cfg.borderInfo.length > 0) {
        const borderInfo: BorderInfo[] = [];

        for (let i = 0; i < cfg.borderInfo.length; i += 1) {
            const entry = cfg.borderInfo[i];

            if (entry.rangeType === 'range' && entry.borderType !== 'border-slash') {
                const bd_emptyRange: SingleRange[] = [];
                for (let j = 0; j < entry.range.length; j += 1) {
                    bd_emptyRange.push(
                        ...cfSplitRange(
                            entry.range[j],
                            { row: last.row, column: last.column },
                            { row: [row_s, row_e], column: [col_s, col_e] },
                            'restPart',
                        ),
                    );
                }

                entry.range = bd_emptyRange;
                borderInfo.push(entry);
            } else if (entry.rangeType === 'cell') {
                const bd_r = entry.value.row_index;
                const bd_c = entry.value.col_index;

                if (!(bd_r >= last.row[0] && bd_r <= last.row[1] && bd_c >= last.column[0] && bd_c <= last.column[1])) {
                    borderInfo.push(entry);
                }
            } else if (
                !(
                    entry.range[0].row[0] >= last.row[0] &&
                    entry.range[0].row[0] <= last.row[1] &&
                    entry.range[0].column[0] >= last.column[0] &&
                    entry.range[0].column[0] <= last.column[1]
                )
            ) {
                // remaining slash range entries that fall outside the move's source rect
                borderInfo.push(entry);
            }
        }

        cfg.borderInfo = borderInfo;
    }
    // Replacement position data update
    const offsetMC: Record<string, [number, number]> = {};
    for (let r = 0; r < data.length; r += 1) {
        for (let c = 0; c < data[0].length; c += 1) {
            const computeEntry = borderInfoCompute[`${r + last.row[0]}_${c + last.column[0]}`];
            if (computeEntry && !computeEntry.s) {
                const bd_obj: CellBorderInfo = {
                    rangeType: 'cell',
                    value: {
                        row_index: r + row_s,
                        col_index: c + col_s,
                        l: computeEntry.l,
                        r: computeEntry.r,
                        t: computeEntry.t,
                        b: computeEntry.b,
                    },
                };

                if (cfg.borderInfo == null) {
                    cfg.borderInfo = [];
                }

                cfg.borderInfo.push(bd_obj);
            } else if (computeEntry?.s) {
                const bd_obj: RangeBorderInfo = {
                    rangeType: 'range',
                    borderType: 'border-slash',
                    color: computeEntry.s.color,
                    style: computeEntry.s.style,
                    range: normalizeSelection(ctx, [{ row: [r + row_s, r + row_s], column: [c + col_s, c + col_s] }]),
                };

                if (cfg.borderInfo == null) {
                    cfg.borderInfo = [];
                }

                cfg.borderInfo.push(bd_obj);
            }

            let value = null;
            if (data[r] != null && data[r][c] != null) {
                value = data[r][c];
            }

            if (value?.mc != null) {
                const mc = Object.assign({}, value.mc);
                if ('rs' in value.mc) {
                    set(offsetMC, `${mc.r}_${mc.c}`, [r + row_s, c + col_s]);

                    value.mc.r = r + row_s;
                    value.mc.c = c + col_s;

                    set(cfg.merge, `${r + row_s}_${c + col_s}`, value.mc);
                } else {
                    set(value.mc, 'r', offsetMC[`${mc.r}_${mc.c}`][0]);
                    set(value.mc, 'c', offsetMC[`${mc.r}_${mc.c}`][1]);
                }
            }
            d[r + row_s][c + col_s] = value;
            if (hyperLinkList?.[`${r + last.row[0]}_${c + last.column[0]}`]) {
                ctx.sheets[index].hyperlink![`${r + row_s}_${c + col_s}`] = hyperLinkList?.[
                    `${r + last.row[0]}_${c + last.column[0]}`
                ] as {
                    linkType: string;
                    linkAddress: string;
                };
            }
        }
    }

    // Conditional format
    const cdformat = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) as number].conditionalFormatRules ?? [];
    if (cdformat != null && cdformat.length > 0) {
        for (let i = 0; i < cdformat.length; i += 1) {
            const cdformat_cellrange = cdformat[i].cellrange;
            const emptyRange: SingleRange[] = [];
            for (let j = 0; j < cdformat_cellrange.length; j += 1) {
                emptyRange.push(
                    ...cfSplitRange(
                        cdformat_cellrange[j],
                        { row: last.row, column: last.column },
                        { row: [row_s, row_e], column: [col_s, col_e] },
                        'allPart',
                    ),
                );
            }
            cdformat[i].cellrange = emptyRange;
        }
    }

    let rf: number;
    if (ctx.selections[0].row_focus === ctx.selections[0].row[0]) {
        rf = row_s;
    } else {
        rf = row_e;
    }

    let cf: number;
    if (ctx.selections[0].column_focus === ctx.selections[0].column[0]) {
        cf = col_s;
    } else {
        cf = col_e;
    }

    const range = [];
    range.push({ row: last.row, column: last.column });
    range.push({ row: [row_s, row_e], column: [col_s, col_e] });

    last.row = [row_s, row_e];
    last.column = [col_s, col_e];
    last.row_focus = rf;
    last.column_focus = cf;
    ctx.selections = normalizeSelection(ctx, [last]);

    jfrefreshgrid(ctx, d, range);
}
