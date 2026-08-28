import { forEach, isNumber, isPlainObject, isUndefined } from 'es-toolkit/compat';
import { type Context, editableConfig } from '../context';
import { deleteRowCol, insertRowCol } from '../modules';
import { getSheetIndex } from '../utils';
import { type CommonOptions, getSheet } from './common';
import { invalidParams } from './errors';

export function freeze(
    ctx: Context,
    type: 'row' | 'column' | 'both',
    range: { row: number; column: number },
    options: CommonOptions = {},
) {
    const sheet = getSheet(ctx, options);

    const typeMap = {
        row: 'rangeRow',
        column: 'rangeColumn',
        both: 'rangeBoth',
    } as const;
    const innerType = typeMap[type];

    sheet.frozen = {
        type: innerType,
        range: {
            column_focus: range.column,
            row_focus: range.row,
        },
    };
}

export function insertRowOrColumn(
    ctx: Context,
    type: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
    options: CommonOptions = {},
) {
    if (
        !['row', 'column'].includes(type) ||
        !isNumber(index) ||
        !isNumber(count) ||
        !['lefttop', 'rightbottom'].includes(direction)
    ) {
        throw invalidParams();
    }

    const sheet = getSheet(ctx, options);
    insertRowCol(ctx, { type, index, count, direction, id: sheet.id! });
}

export function deleteRowOrColumn(
    ctx: Context,
    type: 'row' | 'column',
    start: number,
    end: number,
    options: CommonOptions = {},
) {
    if (!['row', 'column'].includes(type) || !isNumber(start) || !isNumber(end)) {
        throw invalidParams();
    }

    const sheet = getSheet(ctx, options);

    deleteRowCol(ctx, { type, start, end, id: sheet.id! });
}

export function hideRowOrColumn(ctx: Context, rowColInfo: string[], type: 'row' | 'column') {
    if (!['row', 'column'].includes(type)) {
        throw invalidParams();
    }

    if (!ctx?.config) return;

    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;

    if (type === 'row') {
        const rowhidden = (ctx.config.rowhidden ??= {});
        for (const r of rowColInfo) rowhidden[r] = 0;
    } else {
        const colhidden = (ctx.config.colhidden ??= {});
        for (const r of rowColInfo) colhidden[r] = 0;
    }
    ctx.sheets[index].config = ctx.config;
}

export function showRowOrColumn(ctx: Context, rowColInfo: string[], type: 'row' | 'column') {
    if (!['row', 'column'].includes(type)) {
        throw invalidParams();
    }

    if (!ctx?.config) return;

    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;

    if (type === 'row') {
        const rowhidden = (ctx.config.rowhidden ??= {});
        for (const r of rowColInfo) delete rowhidden[r];
    } else {
        const colhidden = (ctx.config.colhidden ??= {});
        for (const r of rowColInfo) delete colhidden[r];
    }
    ctx.sheets[index].config = ctx.config;
}

export function setRowHeight(
    ctx: Context,
    rowInfo: Record<string, number>,
    options: CommonOptions = {},
    custom: boolean = false,
) {
    if (!isPlainObject(rowInfo)) {
        throw invalidParams();
    }

    const sheet = getSheet(ctx, options);

    const cfg = editableConfig(ctx, sheet);
    if (cfg.rowlen == null) {
        cfg.rowlen = {};
    }

    forEach(rowInfo, (len, r) => {
        if (Number(r) >= 0) {
            if (Number(len) >= 0) {
                cfg.rowlen![Number(r)] = Number(len);
                if (custom && isUndefined(cfg.customHeight)) {
                    cfg.customHeight = { [r]: 1 };
                } else if (custom) {
                    cfg.customHeight![r] = 1;
                }
            }
        }
    });
}

export function setColumnWidth(
    ctx: Context,
    columnInfo: Record<string, number>,
    options: CommonOptions = {},
    custom: boolean = false,
) {
    if (!isPlainObject(columnInfo)) {
        throw invalidParams();
    }

    const sheet = getSheet(ctx, options);

    const cfg = editableConfig(ctx, sheet);
    if (cfg.columnlen == null) {
        cfg.columnlen = {};
    }

    forEach(columnInfo, (len, c) => {
        if (Number(c) >= 0) {
            if (Number(len) >= 0) {
                cfg.columnlen![Number(c)] = Number(len);
                if (custom && isUndefined(cfg.customWidth)) {
                    cfg.customWidth = { [c]: 1 };
                } else if (custom) {
                    cfg.customWidth![c] = 1;
                }
            }
        }
    });
}

export function getRowHeight(ctx: Context, rows: number[], options: CommonOptions = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw invalidParams();
    }

    const sheet = getSheet(ctx, options);

    const cfg = sheet.config || {};
    const rowlen = cfg.rowlen || {};

    const rowlenObj: Record<string, number> = {};

    for (const item of rows) {
        if (item >= 0) {
            rowlenObj[item] = rowlen[item] || ctx.defaultrowlen;
        }
    }

    return rowlenObj;
}

export function getColumnWidth(ctx: Context, columns: number[], options: CommonOptions = {}) {
    if (!Array.isArray(columns) || columns.length === 0) {
        throw invalidParams();
    }

    const sheet = getSheet(ctx, options);

    const cfg = sheet.config || {};
    const columnlen = cfg.columnlen || {};

    const columnlenObj: Record<string, number> = {};

    for (const item of columns) {
        if (item >= 0) {
            columnlenObj[item] = columnlen[item] || ctx.defaultcollen;
        }
    }

    return columnlenObj;
}
