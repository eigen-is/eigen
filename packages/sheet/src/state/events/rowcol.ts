import { RowColError } from '../../engine';
import type { Context } from '../context';
import { deleteRowCol, insertRowCol } from '../modules/rowcol';
import { getSheetIndex } from '../utils';

// Run an insert/delete and map the engine's guard failures to a user-facing
// message — shared by the context menus, the menu bar menus and the bottom
// add-rows button, so the guards and wording can't drift between surfaces.
// Returns the message to alert, or null when the operation succeeded.

export function tryInsertRowCol(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
    changeSelection: boolean = true,
): string | null {
    try {
        insertRowCol(ctx, op, changeSelection);
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        if (e.code === 'maxExceeded')
            return op.type === 'row' ? '10000 row limit exceeded' : '1000 column limit exceeded';
        return op.type === 'row' ? 'Cannot insert on a read-only row' : 'Cannot insert into a read-only column';
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
    try {
        deleteRowCol(ctx, op);
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        return op.type === 'row' ? 'Cannot delete a read-only row' : 'Cannot delete a read-only column';
    }
    return null;
}
