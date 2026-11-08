// Clearing the selection's contents, or the active image or chart. The Delete key and the menus call it, and it
// recomputes the formulas that read what it cleared.

import type { Context } from '../context';
import { deleteActiveObject } from '../modules/floating';
import { recomputeCells } from '../modules/refresh';
import { deleteSelectedCellText } from '../modules/selection';

export function clearSelectedContents(ctx: Context) {
    if (ctx.allowEdit === false) return;
    if (ctx.activeObject) {
        deleteActiveObject(ctx);
    } else {
        recomputeCells(ctx, deleteSelectedCellText(ctx));
    }
}
