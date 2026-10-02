import { sortBy } from 'es-toolkit/compat';
import type { Context, Sheet } from '..';
import { addSheet as addSheetInternal } from '../modules';
import type { Settings } from '../settings';

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
