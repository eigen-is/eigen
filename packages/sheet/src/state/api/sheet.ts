// The sheet calls on the workbook's context, such as hiding, copying or ordering a sheet, and seeding its recalc list.
// Most of them write the context they are given, so a caller runs them inside an edit's recipe.

import type { CellRangeRef } from '@workspace/lib/types/chart';
import { cloneDeep, sortBy } from 'es-toolkit/compat';
import { dataToCelldata } from '../../engine/celldata';
import { mapChartRefs } from '../../engine/chart-data';
import { copySheetName } from '../../engine/sheet-name';
import type { Context } from '../context';
import { addSheet, initSheetData, leaveCurrentSheet } from '../modules';
import type { FormulaCell } from '../types';
import { getSheetIndex, sheetOrder } from '../utils';

export function getAllSheets(ctx: Context) {
    return ctx.sheets;
}

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
    // The formula map is built from every sheet's recalc list, which must name the copy, not the sheet copied.
    sheetData.calcChain = sheetData.calcChain?.map((entry) => ({ ...entry, id: copyId }));
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
    addSheet(ctx, copyId, sheetName, sheetData);
    setSheetOrder(ctx, { [copyId]: order });
    // The copy gets its cell matrix now, as a peer's tab builds it when the add arrives, so every read of the open
    // workbook's cells finds the copy's.
    const copyIndex = getSheetIndex(ctx, copyId);
    if (copyIndex != null) initSheetData(ctx, copyIndex, ctx.sheets[copyIndex]);
    // A formula map built before the copy, such as while the browser was idle after a load, lacks the copy's formulas.
    // A peer's add reads them into the map once its batch applied; here the next edit builds the map again.
    ctx.formulaCache.formulaCellInfoMap = null;
}

// Sets the given sheets' orders and renumbers every sheet from 0, so the tab strip and the sheet list agree.
export function setSheetOrder(ctx: Context, orderList: Record<string, number>) {
    for (const sheet of ctx.sheets) {
        if (sheet.id in orderList) sheet.order = orderList[sheet.id];
    }
    for (const [i, sheet] of sortBy(ctx.sheets, ['order']).entries()) {
        sheet.order = i;
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
