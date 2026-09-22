import { forEach, isNil, isNumber, isPlainObject } from 'es-toolkit/compat';
import { numberDisplay } from '../../engine/format';
import type { Cell, CellMatrix, CellStyle } from '../../engine/types';
import type { Context } from '../context';
import {
    delFunctionGroup,
    dropCellCache,
    fillTouchesMerge,
    getTypeItemHide,
    normalizeSelection,
    setCellValue as setCellValueInternal,
    setFormulaCellInfo,
    updateCell,
    updateDropCell,
    updateFormatCell,
} from '../modules';
import type { SingleRange } from '../types';
import { type CommonOptions, getSheet } from './common';
import { sheetNotFound } from './errors';

// Cell keys handled by `updateFormatCell` (range-aware style writes) rather than
// by direct assignment in setCellValue. Order is documentation-only — the lookup
// is by `.has()`. Comments on the cell shape live on the Cell/CellStyle types.
const FORMAT_KEYS: ReadonlySet<string> = new Set([
    'bg',
    'ff',
    'fc',
    'bl',
    'it',
    'fs',
    'cl',
    'un',
    'vt',
    'ht',
    'mc',
    'tb',
    'rt',
    'qp',
]);

export function getCellValue(
    ctx: Context,
    row: number,
    column: number,
    options: CommonOptions & { type?: keyof Cell } = {},
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error('row or column cannot be null or undefined');
    }
    const sheet = getSheet(ctx, options);
    const { type = 'v' } = options;
    const targetSheetData = sheet.data;
    if (!targetSheetData) {
        throw sheetNotFound();
    }
    const cellData = targetSheetData[row]?.[column];
    let ret: Cell[keyof Cell] | string | null = null;

    if (cellData && isPlainObject(cellData)) {
        if (cellData.ct && cellData.ct.fa === 'yyyy-MM-dd') {
            ret = cellData.m;
        } else if (cellData.ct?.t === 'inlineStr') {
            ret = (cellData.ct.s ?? []).reduce((prev, cur) => prev + (cur.v ?? ''), '');
        } else {
            ret = cellData[type];
        }
    }

    if (ret === undefined) {
        ret = null;
    }

    return ret;
}

export function setCellValue(
    ctx: Context,
    row: number,
    column: number,
    value: Cell | string | number | boolean | null | undefined,
    cellInput: HTMLDivElement | null,
    options: CommonOptions = {},
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error('row or column cannot be null or undefined');
    }

    const sheet = getSheet(ctx, options);

    const { data } = sheet;

    if (value == null || value.toString().length === 0) {
        dropFormula(ctx, sheet.id!, data, row, column);
        setCellValueInternal(ctx, row, column, data, value);
    } else if (value instanceof Object) {
        if (!data) throw sheetNotFound();
        const curv: Cell = {};
        if (data[row]?.[column] == null) {
            data[row][column] = {};
        }
        const cell = data[row][column]!;
        if (value.f != null && value.v == null) {
            curv.f = value.f;
            if (value.ct != null) {
                curv.ct = value.ct;
            }
            updateCell(ctx, row, column, cellInput, curv); // update formula value
        } else {
            if (value.ct != null) {
                curv.ct = value.ct;
            }
            if (value.f != null) {
                curv.f = value.f;
            }
            if (value.v != null) {
                curv.v = value.v;
            } else {
                curv.v = cell.v;
            }
            if (value.m != null) {
                curv.m = value.m;
            }
            if (value.f == null) dropFormula(ctx, sheet.id!, data, row, column);
            else delFunctionGroup(ctx, row, column, sheet.id);
            setCellValueInternal(ctx, row, column, data, curv); // update text value
        }
        forEach(value, (v, attr) => {
            if (FORMAT_KEYS.has(attr)) {
                updateFormatCell(ctx, data!, attr as keyof CellStyle, v as string | number, row, row, column, column); // change range format
            } else {
                // forEach hands us `attr: string` (Cell key as plain key); the union of
                // value-shapes can't be statically aligned with the union of key-shapes.
                (cell as Record<string, unknown>)[attr] = v;
            }
        });
        data![row][column] = cell;
    } else {
        if (value.toString().substr(0, 1) === '=' || value.toString().substr(0, 5) === '<span') {
            updateCell(ctx, row, column, cellInput, value); // update formula value or convert inline string html to object
        } else {
            dropFormula(ctx, sheet.id!, data, row, column);
            setCellValueInternal(ctx, row, column, data, value);
        }
    }
}

// A kept `f` would store the value as the formula's text result; typed entry drops it too.
function dropFormula(ctx: Context, sheetId: string, data: CellMatrix | undefined, row: number, column: number) {
    delFunctionGroup(ctx, row, column, sheetId);
    const cell = data?.[row]?.[column];
    if (cell?.f == null) return;
    delete cell.f;
    setFormulaCellInfo(ctx, { r: row, c: column, id: sheetId }, data, sheetId);
}

export function clearCell(ctx: Context, row: number, column: number, options: CommonOptions = {}) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error('row or column cannot be null or undefined');
    }

    const sheet = getSheet(ctx, options);

    const cell = sheet.data?.[row]?.[column];

    if (cell && isPlainObject(cell)) {
        delete cell.m;
        delete cell.v;

        if (cell.f != null) dropFormula(ctx, sheet.id!, sheet.data, row, column);
    }
}

export function setCellFormat(
    ctx: Context,
    row: number,
    column: number,
    attr: keyof Cell,
    value: unknown,
    options: CommonOptions = {},
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error('row or column cannot be null or undefined');
    }

    if (!attr) {
        throw new Error('attr cannot be null or undefined');
    }

    const sheet = getSheet(ctx, options);

    const targetSheetData = sheet.data!;

    const cellData = targetSheetData?.[row]?.[column] || {};

    const ctValue = value as { fa?: string; t?: string } | null | undefined;

    // special format
    if (attr === 'ct' && (!ctValue || ctValue.fa == null || ctValue.t == null)) {
        throw new Error("'fa' and 't' should be present in value when attr is 'ct'");
    } else if (attr === 'ct' && !isNil(cellData.v)) {
        cellData.m = numberDisplay(cellData.v, ctValue!.fa);
    }

    (cellData as Record<string, unknown>)[attr] = value;

    targetSheetData[row][column] = cellData;
}

export function autoFillCell(
    ctx: Context,
    copyRange: SingleRange,
    applyRange: SingleRange,
    direction: 'up' | 'down' | 'left' | 'right',
) {
    if (fillTouchesMerge(ctx, copyRange, applyRange)) return;
    dropCellCache.copyRange = copyRange;
    dropCellCache.applyRange = applyRange;
    dropCellCache.direction = direction;
    const typeItemHide = getTypeItemHide(ctx);
    if (
        !typeItemHide[0] &&
        !typeItemHide[1] &&
        !typeItemHide[2] &&
        !typeItemHide[3] &&
        !typeItemHide[4] &&
        !typeItemHide[5] &&
        !typeItemHide[6]
    ) {
        dropCellCache.applyType = '0';
    } else {
        dropCellCache.applyType = '1';
    }
    ctx.selections = normalizeSelection(ctx, [
        {
            row: [Math.min(copyRange.row[0], applyRange.row[0]), Math.max(copyRange.row[1], applyRange.row[1])],
            column: [
                Math.min(copyRange.column[0], applyRange.column[0]),
                Math.max(copyRange.column[1], applyRange.column[1]),
            ],
        },
    ]);
    updateDropCell(ctx);
}
