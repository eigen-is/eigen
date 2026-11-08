// Clearing the selection's contents, or the active image or chart, for the Delete key and the menus.

import type { Context } from '../context';
import { deleteActiveObject } from '../modules/floating';
import { jfrefreshgrid } from '../modules/refresh';
import { deleteSelectedCellText } from '../modules/selection';

const CLEAR_ERRORS: Record<string, string> = {
    partMC: 'Cannot perform this operation on partially merged cells',
    dataNullError: 'Cannot perform this operation on data that does not exist',
};

// Returns the message to show when the clear is refused, or null when it ran.
export function clearSelectedContents(ctx: Context): string | null {
    if (ctx.allowEdit === false) return null;
    let error: string | null = null;
    if (ctx.activeObject) {
        deleteActiveObject(ctx);
    } else {
        error = CLEAR_ERRORS[deleteSelectedCellText(ctx)] ?? null;
    }
    jfrefreshgrid(ctx, null, undefined);
    return error;
}
