// The sheet calls of the Workbook's imperative API: hiding, showing and copying a sheet, and computing or seeding its
// formulas. A host reaches them through the Workbook's ref, and the menus call some of them inside an edit's recipe.

import type { CellRangeRef } from '@workspace/lib/types/chart';
import { cloneDeep } from 'es-toolkit/compat';
import { mapChartRefs } from '../../engine/chart-data';
import { copySheetName } from '../../engine/sheet-name';
import { api, createContextResolver, execfunction, setCellValue as setCellValueInternal } from '..';
import type { Context } from '../context';
import { initSheetData, leaveCurrentSheet } from '../modules';
import type { FormulaCell, SingleRange } from '../types';
import { getSheetIndex, sheetOrder } from '../utils';
import { dataToCelldata, getSheet } from './common';

export function getAllSheets(ctx: Context) {
    return ctx.sheets;
}

export { getSheet };

export function hideSheet(ctx: Context, sheetId: string) {
    if (ctx.allowEdit === false) return;
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    if (sheetId === ctx.currentSheetId && !leaveCurrentSheet(ctx, sheetId)) return;
    ctx.sheets[index].hide = 1;
    ctx.sheets[index].status = 0;
}

export function showSheet(ctx: Context, sheetId: string) {
    if (ctx.allowEdit === false) return;
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    ctx.sheets[index].hide = undefined;
}

export function copySheet(ctx: Context, sheetId: string) {
    if (ctx.allowEdit === false) return;
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    const order = sheetOrder(ctx.sheets[index]) + 1;
    const sheetName = copySheetName(
        ctx.sheets[index].name,
        ctx.sheets.map((sheet) => sheet.name),
    );
    const sheetData = cloneDeep(ctx.sheets[index]);
    const copyId = crypto.randomUUID();
    sheetData.id = copyId;
    delete sheetData.status;
    sheetData.celldata = dataToCelldata(sheetData.data);
    // A copy starts without comments, as a duplicated canvas element does: a card stays on the cells it was put on.
    for (const { v } of sheetData.celldata) delete v?.commentCardIds;
    // A copy's images and charts take fresh ids, and its charts read the copy where they read the sheet copied, as
    // in Excel and Google.
    const toCopy = (ref: CellRangeRef) => (ref.sheetId === sheetId ? { ...ref, sheetId: copyId } : ref);
    const withFreshId = <T extends { id: string }>(object: T): [string, T] => {
        const id = crypto.randomUUID();
        return [id, { ...object, id }];
    };
    sheetData.images = Object.fromEntries(Object.values(sheetData.images ?? {}).map(withFreshId));
    sheetData.charts = Object.fromEntries(
        Object.values(sheetData.charts ?? {}).map((chart) => withFreshId(mapChartRefs(chart, toCopy))),
    );
    api.addSheet(ctx, copyId, ctx.sheets[index].isPivotTable, sheetName, sheetData);
    api.setSheetOrder(ctx, { [copyId]: order });
    // The copy gets its cell matrix now, as a peer's tab builds it when the add arrives, so every read of the open
    // workbook's cells finds the copy's.
    const copyIndex = getSheetIndex(ctx, copyId);
    if (copyIndex != null) initSheetData(ctx, copyIndex, ctx.sheets[copyIndex]);
}

function calculateSheetFormula(ctx: Context, id: string, range?: SingleRange) {
    const index = getSheetIndex(ctx, id);
    if (index == null) return;
    const sheet = ctx.sheets[index];
    const { data } = sheet;
    if (!data) return;

    const rStart = range?.row[0] ?? 0;
    const rEnd = range?.row[1] ?? data.length - 1;
    const cStart = range?.column[0] ?? 0;
    const cEnd = range?.column[1] ?? data[0].length - 1;

    // The public setCellValue scans the whole recalc list for each cell it writes, which makes a large sheet's
    // recompute quadratic. This sweep visits every formula cell of the range once, so it rebuilds the list in one
    // pass and writes each value through the internal setCellValue, which leaves the list alone. Entries outside the
    // range stay.
    const newChain: FormulaCell[] = (sheet.calcChain ?? []).filter(
        (cc) => cc.id !== id || cc.r < rStart || cc.r > rEnd || cc.c < cStart || cc.c > cEnd,
    );

    // The resolver reads the live cells: the sweep runs in cell order, not in dependency order, and each evaluation
    // must see the writes before it.
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
        calculateSheetFormula(ctx, id, range);
        return;
    }
    for (const sheet of ctx.sheets) {
        if (sheet.id) calculateSheetFormula(ctx, sheet.id, range);
    }
}

// Rebuilds each sheet's recalc list from the cells that hold a formula, without computing any. The workbook calls it
// when it mounts, because the stored values are already current and computing them all takes a second on a large
// file. An edit then computes only the formulas it affects, and the formula map learns them from this list.
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
