// The sheet calls of the Workbook's imperative API: hiding, showing and copying a sheet, and computing or seeding its
// formulas. A host reaches them through the Workbook's ref, and the menus call some of them inside an edit's recipe.

import type { CellRangeRef } from '@workspace/lib/types/chart';
import { cloneDeep } from 'es-toolkit/compat';
import { mapChartRefs } from '../../engine/chart-data';
import { copySheetName } from '../../engine/sheet-name';
import { api, createContextResolver, execfunction, setCellValue as setCellValueInternal } from '..';
import type { Context } from '../context';
import { leaveCurrentSheet } from '../modules';
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
    delete sheetData.data;
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
    api.addSheet(ctx, undefined, copyId, ctx.sheets[index].isPivotTable, sheetName, sheetData);
    const sheetOrderList: Record<string, number> = {};
    sheetOrderList[copyId] = order;
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
