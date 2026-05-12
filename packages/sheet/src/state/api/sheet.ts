import { cloneDeep, isUndefined } from 'es-toolkit/compat';
import { v4 as uuidv4 } from 'uuid';
import type { CellMatrix } from '../../engine/types';
import { api, execfunction, insertUpdateFunctionGroup, locale } from '..';
import type { Context } from '../context';
import type { Sheet, SingleRange } from '../types';
import { getSheetIndex } from '../utils';
import { celldataToData, dataToCelldata, getSheet } from './common';

export function getAllSheets(ctx: Context) {
    return ctx.sheets;
}

export { getSheet };

export function initSheetData(draftCtx: Context, index: number, newData: Sheet): CellMatrix {
    const { celldata, row, column } = newData;
    const expandedData = celldataToData(
        celldata ?? [],
        row != null && row > 0 ? row : draftCtx.defaultrowNum,
        column != null && column > 0 ? column : draftCtx.defaultcolumnNum,
    );
    if (draftCtx.sheets[index] == null) {
        newData.data = expandedData;
        delete newData.celldata;
        draftCtx.sheets.push(newData);
    } else {
        draftCtx.sheets[index].data = expandedData;
        delete draftCtx.sheets[index].celldata;
        if (newData.config) {
            draftCtx.sheets[index].config = newData.config;
        }
    }
    return expandedData;
}

export function hideSheet(ctx: Context, sheetId: string) {
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    ctx.sheets[index].hide = 1;
    ctx.sheets[index].status = 0;
    const shownSheets = ctx.sheets.filter((sheet) => isUndefined(sheet.hide) || sheet?.hide !== 1);
    ctx.currentSheetId = shownSheets[0].id as string;
}

export function showSheet(ctx: Context, sheetId: string) {
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    ctx.sheets[index].hide = undefined;
}

function generateCopySheetName(ctx: Context, sheetId: string) {
    const { info } = locale(ctx);
    const copyWord = `(${info.copy}`;
    const SheetIndex = getSheetIndex(ctx, sheetId);
    if (SheetIndex == null) return sheetId;
    let sheetName = ctx.sheets[SheetIndex].name;
    const copy_i = sheetName.indexOf(copyWord);
    let index: number = 0;

    if (copy_i !== -1) {
        sheetName = sheetName.toString().substring(0, copy_i);
    }

    const nameCopy = sheetName + copyWord;
    const sheetNames = [];

    for (let i = 0; i < ctx.sheets.length; i += 1) {
        const fileName = ctx.sheets[i].name;
        sheetNames.push(fileName);
        const st_i = fileName.indexOf(nameCopy);

        if (st_i === 0) {
            index = index || 2;
            const ed_i = fileName.indexOf(')', st_i + nameCopy.length);
            // Excel-style copy suffix: "Sheet1 (2)". Extract and bump.
            const num = Number.parseInt(fileName.substring(st_i + nameCopy.length, ed_i), 10);
            if (Number.isFinite(num) && num >= index) {
                index = num + 1;
            }
        }
    }

    let sheetCopyName: string;

    do {
        const postfix = `${copyWord + (index || '')})`;
        const lengthLimit = 31 - postfix.length;
        sheetCopyName = sheetName;
        if (sheetCopyName.length > lengthLimit) {
            sheetCopyName = `${sheetCopyName.slice(0, lengthLimit - 1)}…`;
        }
        sheetCopyName += postfix;
        index = (index || 1) + 1;
    } while (sheetNames.indexOf(sheetCopyName) !== -1);

    return sheetCopyName;
}

export function copySheet(ctx: Context, sheetId: string) {
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    const order = ctx.sheets[index].order! + 1;
    const sheetName = generateCopySheetName(ctx, sheetId);
    const sheetData = cloneDeep(ctx.sheets[index]);
    delete sheetData.id;
    delete sheetData.status;
    sheetData.celldata = dataToCelldata(sheetData.data);
    delete sheetData.data;
    api.addSheet(ctx, undefined, uuidv4(), ctx.sheets[index].isPivotTable, sheetName, sheetData);
    const sheetOrderList: Record<string, number> = {};
    sheetOrderList[ctx.sheets[ctx.sheets.length - 1].id as string] = order;
    api.setSheetOrder(ctx, sheetOrderList);
}

function calculateSheetFromula(ctx: Context, id: string, range?: SingleRange) {
    const index = getSheetIndex(ctx, id);
    if (index == null) return;
    if (!ctx.sheets[index].data) return;

    if (!range) {
        range = {
            row: [0, ctx.sheets[index].data!.length - 1],
            column: [0, ctx.sheets[index].data![0].length - 1],
        };
    }
    const rowCount = range.row[1] - range.row[0] + 1;
    const columnCount = range.column[1] - range.column[0] + 1;

    for (let _r = 0; _r < rowCount; _r += 1) {
        for (let _c = 0; _c < columnCount; _c += 1) {
            const r = range.row[0] + _r;
            const c = range.column[0] + _c;

            const formula = ctx.sheets[index].data![r][c]?.f;
            if (!formula) {
                continue;
            }
            const result = execfunction(ctx, formula, r, c, id);
            api.setCellValue(ctx, r, c, result[1], null, { id });
            insertUpdateFunctionGroup(ctx, r, c, id);
        }
    }
}

export function calculateFormula(ctx: Context, id?: string, range?: SingleRange) {
    if (id) {
        calculateSheetFromula(ctx, id, range);
        return;
    }
    ctx.sheets.forEach((sheet_obj) => {
        if (!sheet_obj.id) return;
        calculateSheetFromula(ctx, sheet_obj.id, range);
    });
}
