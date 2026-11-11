// A row or column insert or delete from a menu, such as the context menu or the add-rows button. Each runs the op, or
// leaves the notice that says why it is refused, so every surface words a refusal alike.

import { RowColError } from '../../engine/rowcol';
import type { Context } from '../context';
import { deleteRowCol, insertRowCol } from '../modules/rowcol';
import { getSheetIndex } from '../utils';

export function tryInsertRowCol(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
    changeSelection: boolean = true,
) {
    try {
        insertRowCol(ctx, op, changeSelection);
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        ctx.warnDialog = e.message;
    }
}

export function tryDeleteRowCol(ctx: Context, op: { type: 'row' | 'column'; start: number; end: number; id: string }) {
    const index = getSheetIndex(ctx, op.id);
    if (typeof index !== 'number') return;
    const data = ctx.sheets[index].data;
    const total = op.type === 'row' ? (data?.length ?? 0) : (data?.[0]?.length ?? 0);
    if (total <= op.end - op.start + 1) {
        ctx.warnDialog = op.type === 'row' ? 'Cannot delete all rows' : 'Cannot delete all columns';
        return;
    }
    deleteRowCol(ctx, op);
}
