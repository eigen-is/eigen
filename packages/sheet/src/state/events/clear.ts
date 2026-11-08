// Clearing the selection's contents, or the active image or chart, for the Delete key and the menus.

import type { Context } from '../context';
import { deleteActiveObject } from '../modules/floating';
import { jfrefreshgrid } from '../modules/refresh';
import { deleteSelectedCellText } from '../modules/selection';

export function clearSelectedContents(ctx: Context) {
    if (ctx.allowEdit === false) return;
    if (ctx.activeObject) {
        deleteActiveObject(ctx);
    } else {
        deleteSelectedCellText(ctx);
    }
    jfrefreshgrid(ctx, null, undefined);
}
