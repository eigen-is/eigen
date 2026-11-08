// Finds a sheet on the workbook's context: the one an id names, or the current sheet. The state modules and the sheet
// calls find their sheet here, so a bad id throws instead of handing back undefined.

import type { Context } from '../context';
import { getSheetIndex } from '../utils';

export type SheetLookup = { id?: string };

export function getSheet(ctx: Context, { id }: SheetLookup = {}) {
    const index = getSheetIndex(ctx, id ?? ctx.currentSheetId);
    if (index == null) throw new Error('sheet not found');
    return ctx.sheets[index];
}
