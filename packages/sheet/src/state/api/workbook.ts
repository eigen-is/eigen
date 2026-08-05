import { isNumber, sortBy } from 'es-toolkit/compat';
import type { Context, Sheet } from '..';
import {
    addSheet as addSheetInternal,
    deleteSheet as deleteSheetInternal,
    updateSheet as updateSheetInternal,
} from '../modules';
import type { Settings } from '../settings';
import { type CommonOptions, getSheet } from './common';
import { invalidParams } from './errors';

export function addSheet(
    ctx: Context,
    settings?: Required<Settings>,
    newSheetID?: string,
    isPivotTable: boolean = false,
    sheetname: string | undefined = undefined,
    sheetData: Sheet | undefined = undefined,
) {
    addSheetInternal(ctx, settings, newSheetID, isPivotTable, sheetname, sheetData);
}

export function deleteSheet(ctx: Context, options: CommonOptions = {}) {
    const sheet = getSheet(ctx, options);
    deleteSheetInternal(ctx, sheet.id!);
}

export function updateSheet(ctx: Context, data: Sheet[]) {
    updateSheetInternal(ctx, data);
}

export function activateSheet(ctx: Context, options: CommonOptions = {}) {
    const sheet = getSheet(ctx, options);
    ctx.currentSheetId = sheet.id!;
}

export function setSheetName(ctx: Context, name: string, options: CommonOptions = {}) {
    const sheet = getSheet(ctx, options);
    sheet.name = name;
}

export function setSheetOrder(ctx: Context, orderList: Record<string, number>) {
    for (const sheet of ctx.sheets) {
        if (sheet.id! in orderList) {
            sheet.order = orderList[sheet.id!];
        }
    }
    // re-order starting from 0
    for (const [i, sheet] of sortBy(ctx.sheets, ['order']).entries()) {
        sheet.order = i;
    }
}

export function scroll(
    ctx: Context,
    scrollEl: HTMLDivElement | null,
    options: {
        scrollLeft?: number;
        scrollTop?: number;
        targetRow?: number;
        targetColumn?: number;
    },
) {
    if (options.scrollLeft != null) {
        if (!isNumber(options.scrollLeft)) {
            throw invalidParams();
        }
        if (scrollEl) {
            scrollEl.scrollLeft = options.scrollLeft;
        }
    } else if (options.targetColumn != null) {
        if (!isNumber(options.targetColumn)) {
            throw invalidParams();
        }
        const col_pre = options.targetColumn <= 0 ? 0 : ctx.visibledatacolumn[options.targetColumn - 1];
        if (scrollEl) {
            scrollEl.scrollLeft = col_pre;
        }
    }

    if (options.scrollTop != null) {
        if (!isNumber(options.scrollTop)) {
            throw invalidParams();
        }
        if (scrollEl) {
            scrollEl.scrollTop = options.scrollTop;
        }
    } else if (options.targetRow != null) {
        if (!isNumber(options.targetRow)) {
            throw invalidParams();
        }
        const row_pre = options.targetRow <= 0 ? 0 : ctx.visibledatarow[options.targetRow - 1];

        if (scrollEl) {
            scrollEl.scrollTop = row_pre;
        }
    }
}
