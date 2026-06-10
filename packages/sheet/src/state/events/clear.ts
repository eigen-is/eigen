import type { Context } from '../context';
import { removeActiveImage } from '../modules/image';
import { jfrefreshgrid } from '../modules/refresh';
import { deleteSelectedCellText } from '../modules/selection';
import { isAllowEdit } from '../utils';

const CLEAR_ERRORS: Record<string, string> = {
    partMC: 'Cannot perform this operation on partially merged cells',
    allowEdit: 'Cannot perform this operation in read-only mode',
    dataNullError: 'Cannot perform this operation on data that does not exist',
};

// Clears the active image or the selected cells' contents — shared by the Delete
// key, the edit menu, and the context menus. Returns a user-facing error message,
// or null when the clear succeeded.
export function clearSelectedContents(ctx: Context): string | null {
    if (!isAllowEdit(ctx)) return null;
    let error: string | null = null;
    if (ctx.activeImg != null) {
        removeActiveImage(ctx);
    } else {
        error = CLEAR_ERRORS[deleteSelectedCellText(ctx)] ?? null;
    }
    jfrefreshgrid(ctx, null, undefined);
    return error;
}
