// Which comment card the pointer rests on in the grid, and where that cell is on the screen, for the hover card the
// host floats beside it. The grid's mouse move asks on every frame. A cell counts as under the pointer only over the
// grid's own surface: an image or a chart hides it, while the selection's handles, which straddle a selected cell's
// edges, do not.

import type { CommentHoverTarget } from '@workspace/lib/types/comments';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { mergeBorder } from './cell';
import { getCellRowColumn } from './hyperlink';
import { colLocationByIndex, rowLocationByIndex, sheetPoint } from './location';

const CELL_SURFACE = '.sheet-cell-table, .sheet-cs-draghandle, .sheet-cs-fillhandle';

export function commentHoverAt(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement): CommentHoverTarget | null {
    if (ctx.selectionActive || ctx.scrolling || ctx.editingCellPosition.length > 0) return null;
    if (!(e.target instanceof Element) || !e.target.closest(CELL_SURFACE)) return null;
    const flowdata = getFlowdata(ctx);
    const cell = getCellRowColumn(ctx, e, cellArea);
    if (!flowdata || !cell) return null;
    const { r, c } = cell;
    const cardId = flowdata[r]?.[c]?.commentCardIds?.[0];
    if (!cardId || !ctx.commentCards?.[cardId]) return null;

    // By index, as a merge's first bound from mergeBorder sits a pixel above its row.
    const merged = mergeBorder(ctx, flowdata, r, c);
    const [left] = colLocationByIndex(c, ctx.visibledatacolumn);
    const [top] = rowLocationByIndex(r, ctx.visibledatarow);
    const right = ctx.visibledatacolumn[merged?.column[3] ?? c];
    const bottom = ctx.visibledatarow[merged?.row[3] ?? r];
    const { x, y } = sheetPoint(ctx, e, cellArea);
    return { cardId, rect: new DOMRect(left + e.clientX - x, top + e.clientY - y, right - left, bottom - top) };
}
