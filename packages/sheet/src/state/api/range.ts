import { cloneDeep, isPlainObject } from 'es-toolkit/compat';
import type { Cell } from '../../engine/types';
import { getdatabyselection, getFlowdata, getRangetxt, type Selection } from '..';
import type { Context } from '../context';
import { normalizeSelection, rangeValueToHtml } from '../modules';
import type { Range, SingleRange } from '../types';
import { setCellFormat, setCellValue } from './cell';
import { type CommonOptions, getSheet } from './common';
import { invalidParams } from './errors';

export function getSelection(ctx: Context) {
    return ctx.selections?.map((selection) => ({
        row: selection.row,
        column: selection.column,
    }));
}

export function getFlattenRange(ctx: Context, range?: Range) {
    range = range || getSelection(ctx);

    const result: { r: number; c: number }[] = [];

    for (const ele of range ?? []) {
        const rs = ele.row;
        const cs = ele.column;
        for (let r = rs[0]; r <= rs[1]; r += 1) {
            for (let c = cs[0]; c <= cs[1]; c += 1) {
                result.push({ r, c });
            }
        }
    }
    return result;
}

export function getCellsByFlattenRange(ctx: Context, range?: { r: number; c: number }[]) {
    range = range || getFlattenRange(ctx);

    const flowdata = getFlowdata(ctx);
    if (!flowdata) return [];
    return range.map((item) => flowdata[item.r]?.[item.c]);
}

export function getSelectionCoordinates(ctx: Context) {
    const result: string[] = [];
    const rangeArr = cloneDeep(ctx.selections);
    const sheetId = ctx.currentSheetId;

    for (const ele of rangeArr ?? []) {
        const rangeText = getRangetxt(ctx, sheetId, {
            column: ele.column,
            row: ele.row,
        });
        result.push(rangeText);
    }

    return result;
}

export function getCellsByRange(ctx: Context, range: Selection, options: CommonOptions = {}) {
    if (!isPlainObject(range) && !Array.isArray(range)) {
        throw invalidParams();
    }
    const sheet = getSheet(ctx, options);
    return getdatabyselection(ctx, range, sheet.id!);
}

export function getHtmlByRange(ctx: Context, range: Range, options: CommonOptions = {}) {
    const sheet = getSheet(ctx, options);
    return rangeValueToHtml(ctx, sheet.id!, range);
}

export function setSelection(ctx: Context, range: Range, options: CommonOptions) {
    const sheet = getSheet(ctx, options);
    sheet.selections = normalizeSelection(ctx, range);
    if (ctx.currentSheetId === sheet.id) {
        ctx.selections = sheet.selections;
    }
}

export function setCellValuesByRange(
    ctx: Context,
    data: unknown[][],
    range: SingleRange,
    cellInput: HTMLDivElement | null,
    options: CommonOptions = {},
) {
    if (data == null) {
        throw invalidParams();
    }

    if (Array.isArray(range)) {
        throw new Error('setCellValuesByRange does not support multiple ranges');
    }

    if (!isPlainObject(range)) {
        throw invalidParams();
    }

    const rowCount = range.row[1] - range.row[0] + 1;
    const columnCount = range.column[1] - range.column[0] + 1;

    if (data.length !== rowCount || data[0].length !== columnCount) {
        throw new Error('data size does not match range');
    }

    for (let i = 0; i < rowCount; i += 1) {
        for (let j = 0; j < columnCount; j += 1) {
            const row = range.row[0] + i;
            const column = range.column[0] + j;
            setCellValue(
                ctx,
                row,
                column,
                data[i][j] as Cell | string | number | boolean | null | undefined,
                cellInput,
                options,
            );
        }
    }
}

export function setCellFormatByRange(
    ctx: Context,
    attr: keyof Cell,
    value: unknown,
    range: Range | SingleRange,
    options: CommonOptions = {},
) {
    if (isPlainObject(range)) {
        range = [range as SingleRange];
    }

    if (!Array.isArray(range)) {
        throw invalidParams();
    }

    for (const singleRange of range) {
        for (let r = singleRange.row[0]; r <= singleRange.row[1]; r += 1) {
            for (let c = singleRange.column[0]; c <= singleRange.column[1]; c += 1) {
                setCellFormat(ctx, r, c, attr, value, options);
            }
        }
    }
}
