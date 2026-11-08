// A row or column insert or delete from a menu, such as the context menu or the add-rows button. Each runs the op and
// returns the message to show when the op is refused, or null when it ran, so every surface words a refusal alike.

import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { RowColError } from '../../engine/rowcol';
import type { Context } from '../context';
import { deleteRowCol, insertRowCol } from '../modules/rowcol';
import { getSheetIndex } from '../utils';

export function tryInsertRowCol(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
    changeSelection: boolean = true,
): string | null {
    try {
        insertRowCol(ctx, op, changeSelection);
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        return op.type === 'row'
            ? `${MAX_SHEET_ROW_COUNT} row limit exceeded`
            : `${MAX_SHEET_COLUMN_COUNT} column limit exceeded`;
    }
    return null;
}

export function tryDeleteRowCol(
    ctx: Context,
    op: { type: 'row' | 'column'; start: number; end: number; id: string },
): string | null {
    const index = getSheetIndex(ctx, op.id);
    if (typeof index !== 'number') return null;
    const data = ctx.sheets[index].data;
    const total = op.type === 'row' ? (data?.length ?? 0) : (data?.[0]?.length ?? 0);
    if (total <= op.end - op.start + 1)
        return op.type === 'row' ? 'Cannot delete all rows' : 'Cannot delete all columns';
    deleteRowCol(ctx, op);
    return null;
}
