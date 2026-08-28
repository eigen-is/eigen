import { cloneDeep, isUndefined } from 'es-toolkit/compat';
import { v4 as uuidv4 } from 'uuid';
import type { CellMatrix } from '../../engine/types';
import { api, createContextResolver, en, execfunction, setCellValue as setCellValueInternal } from '..';
import { type Context, normalizeSheetConfig } from '../context';
import type { FormulaCell, Sheet, SingleRange } from '../types';
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
    normalizeSheetConfig(draftCtx.sheets[index]);
    return expandedData;
}

export function hideSheet(ctx: Context, sheetId: string) {
    if (ctx.allowEdit === false) return;
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    ctx.sheets[index].hide = 1;
    ctx.sheets[index].status = 0;
    const shownSheets = ctx.sheets.filter((sheet) => isUndefined(sheet.hide) || sheet?.hide !== 1);
    ctx.currentSheetId = shownSheets[0].id as string;
}

export function showSheet(ctx: Context, sheetId: string) {
    if (ctx.allowEdit === false) return;
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    ctx.sheets[index].hide = undefined;
}

function generateCopySheetName(ctx: Context, sheetId: string) {
    const { info } = en;
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
    if (ctx.allowEdit === false) return;
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
    const sheet = ctx.sheets[index];
    if (!sheet.data) return;
    const data = sheet.data;

    const rStart = range?.row[0] ?? 0;
    const rEnd = range?.row[1] ?? data.length - 1;
    const cStart = range?.column[0] ?? 0;
    const cEnd = range?.column[1] ?? data[0].length - 1;

    // The public setCellValue + insertUpdateFunctionGroup pair each linear-scan
    // calcChain to dedupe, so batch recompute used to be quadratic per sheet
    // (78k formulas → 25s on import). We're visiting every formula cell in the
    // range exactly once, so we can rebuild calcChain in one pass and write
    // values via the underlying setCellValueInternal (which doesn't touch the
    // chain at all). Entries outside the range are preserved.
    const newChain: FormulaCell[] = (sheet.calcChain ?? []).filter(
        (cc) => cc.id !== id || cc.r < rStart || cc.r > rEnd || cc.c < cStart || cc.c > cEnd,
    );

    // Live (unsnapshotted) resolver: this sweep runs in cell order, not
    // dependency order, and each evaluation must see the writes before it.
    const resolver = createContextResolver(ctx);
    for (let r = rStart; r <= rEnd; r += 1) {
        for (let c = cStart; c <= cEnd; c += 1) {
            const cell = data[r][c];
            if (!cell?.f) continue;
            const [, value] = execfunction(ctx, cell.f, r, c, id, undefined, false, true, resolver);
            setCellValueInternal(ctx, r, c, data, value);
            newChain.push({ r, c, id });
        }
    }

    sheet.calcChain = newChain;
}

export function calculateFormula(ctx: Context, id?: string, range?: SingleRange) {
    if (id) {
        calculateSheetFromula(ctx, id, range);
        return;
    }
    for (const sheet_obj of ctx.sheets) {
        if (!sheet_obj.id) continue;
        calculateSheetFromula(ctx, sheet_obj.id, range);
    }
}

// Walk each sheet's data once and rebuild calcChain from cells that carry a
// formula — but don't evaluate anything. Edits trigger execFunctionGroup which
// reads calcChain to lazy-prime formulaCellInfoMap and recomputes only the
// affected sub-graph. Used at mount when the imported/persisted values are
// already current and a full re-evaluation would waste a second on a large file.
export function seedCalcChain(ctx: Context) {
    for (const sheet of ctx.sheets) {
        const { id, data } = sheet;
        if (!id || !data) continue;
        const chain: FormulaCell[] = [];
        for (let r = 0; r < data.length; r += 1) {
            const row = data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c += 1) {
                if (row[c]?.f) chain.push({ r, c, id });
            }
        }
        sheet.calcChain = chain;
    }
}
