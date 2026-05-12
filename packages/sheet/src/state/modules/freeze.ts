import { sortedIndex } from 'es-toolkit/compat';
import {
    type Context,
    colLocationByIndex,
    type Freezen,
    type GlobalCache,
    getSheetIndex,
    rowLocationByIndex,
} from '..';

function cutVolumn(arr: number[], cutindex: number) {
    if (cutindex <= 0) {
        return arr;
    }
    const ret = arr.slice(cutindex);
    return ret;
}

function frozenTofreezen(ctx: Context, cache: GlobalCache, sheetId: string) {
    // get frozen type
    const idx = getSheetIndex(ctx, sheetId);
    if (idx == null) return;
    const file = ctx.sheets[idx];
    const { frozen } = file;

    if (frozen == null) {
        delete cache.freezen;
        return;
    }

    const freezen: Freezen = {};

    let { range } = frozen;
    if (!range) {
        range = {
            row_focus: 0,
            column_focus: 0,
        };
    }
    let { type } = frozen;
    if (type === 'row') {
        type = 'rangeRow';
    } else if (type === 'column') {
        type = 'rangeColumn';
    } else if (type === 'both') {
        type = 'rangeBoth';
    }

    // transform to freezen
    if (type === 'rangeRow' || type === 'rangeBoth') {
        const scrollTop = 0;
        let row_st = sortedIndex(ctx.visibledatarow, scrollTop);

        const { row_focus } = range;

        if (row_focus > row_st) {
            row_st = row_focus;
        }

        if (row_st === -1) {
            row_st = 0;
        }

        freezen.horizontal = {
            freezenhorizontaldata: {
                pos: ctx.visibledatarow[row_st],
                boundary: row_st + 1,
                scroll: scrollTop,
                cumulative: cutVolumn(ctx.visibledatarow, row_st + 1),
                edge: ctx.visibledatarow[row_st] - 2 - scrollTop + ctx.columnHeaderHeight,
            },
        };
    }
    if (type === 'rangeColumn' || type === 'rangeBoth') {
        const scrollLeft = 0;
        let col_st = sortedIndex(ctx.visibledatacolumn, scrollLeft);

        const { column_focus } = range;

        if (column_focus > col_st) {
            col_st = column_focus;
        }

        if (col_st === -1) {
            col_st = 0;
        }

        freezen.vertical = {
            freezenverticaldata: {
                pos: ctx.visibledatacolumn[col_st],
                boundary: col_st + 1,
                scroll: scrollLeft,
                cumulative: cutVolumn(ctx.visibledatacolumn, col_st + 1),
                edge: ctx.visibledatacolumn[col_st] - 2 - scrollLeft + ctx.rowHeaderWidth,
            },
        };
    }

    cache.freezen ||= {};
    cache.freezen[ctx.currentSheetId] = freezen;
}

export function initFreeze(ctx: Context, cache: GlobalCache, sheetId: string) {
    frozenTofreezen(ctx, cache, sheetId);
}

export function scrollToFrozenRowCol(ctx: Context, freeze: Freezen | undefined) {
    const select_save = ctx.luckysheet_select_save;
    if (!select_save) return;

    let row: number | undefined;
    const { row_focus } = select_save[0];
    if (row_focus === select_save[0].row[0]) {
        [, row] = select_save[0].row;
    } else if (row_focus === select_save[0].row[1]) {
        [row] = select_save[0].row;
    }

    let column: number | undefined;
    const { column_focus } = select_save[0];
    if (column_focus === select_save[0].column[0]) {
        [, column] = select_save[0].column;
    } else if (column_focus === select_save[0].column[1]) {
        [column] = select_save[0].column;
    }

    const verticalData = freeze?.vertical?.freezenverticaldata;
    const horizontalData = freeze?.horizontal?.freezenhorizontaldata;

    if (verticalData != null && column != null) {
        let freezen_colindex = verticalData.boundary + sortedIndex(verticalData.cumulative, ctx.scrollLeft);

        if (column >= ctx.visibledatacolumn.length) {
            column = ctx.visibledatacolumn.length - 1;
        }

        if (freezen_colindex >= ctx.visibledatacolumn.length) {
            freezen_colindex = ctx.visibledatacolumn.length - 1;
        }

        const column_px = ctx.visibledatacolumn[column];
        const freezen_px = ctx.visibledatacolumn[freezen_colindex];

        if (column_px <= freezen_px + verticalData.edge) {
            ctx.scrollLeft = 0;
        }
    }

    if (horizontalData != null && row != null) {
        let freezen_rowindex = horizontalData.boundary + sortedIndex(horizontalData.cumulative, ctx.scrollTop);

        if (row >= ctx.visibledatarow.length) {
            row = ctx.visibledatarow.length - 1;
        }

        if (freezen_rowindex >= ctx.visibledatarow.length) {
            freezen_rowindex = ctx.visibledatarow.length - 1;
        }

        const row_px = ctx.visibledatarow[row];
        const freezen_px = ctx.visibledatarow[freezen_rowindex];

        if (row_px <= freezen_px + horizontalData.edge) {
            ctx.scrollTop = 0;
        }
    }
}

export function getFrozenHandleTop(ctx: Context) {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    if (idx == null) return ctx.scrollTop;

    const sheet = ctx.sheets[idx];
    if (
        sheet?.frozen?.type === 'row' ||
        sheet?.frozen?.type === 'rangeRow' ||
        sheet?.frozen?.type === 'rangeBoth' ||
        sheet?.frozen?.type === 'both'
    ) {
        return rowLocationByIndex(sheet?.frozen?.range?.row_focus || 0, ctx.visibledatarow)[1] + ctx.scrollTop;
    }
    return ctx.scrollTop;
}

export function getFrozenHandleLeft(ctx: Context) {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    if (idx == null) return ctx.scrollLeft;

    const sheet = ctx.sheets[idx];
    if (
        sheet?.frozen?.type === 'column' ||
        sheet?.frozen?.type === 'rangeColumn' ||
        sheet?.frozen?.type === 'rangeBoth' ||
        sheet?.frozen?.type === 'both'
    ) {
        return (
            colLocationByIndex(sheet?.frozen?.range?.column_focus || 0, ctx.visibledatacolumn)[1] - 2 + ctx.scrollLeft
        );
    }
    return ctx.scrollLeft;
}
