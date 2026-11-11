// The marks in a cell's own box that take a press: a list chevron opens its list and a tick box toggles, and both sit
// where the selection's drag handles have their hit targets. cellGlyphAt is the one question the grid's mousedown and
// hover paths ask before a handle gets its say. A corner mark, such as a comment's, takes no press.

import type { Context } from '../context';
import { getFlowdata } from '../context';
import { mergeBorder } from './cell';
import { cellTextBox, isCheckboxClick, isDropdownChevronClick } from './data-validation';
import { colLocation, rowLocation } from './location';

export type CellGlyph = 'dropdown' | 'checkbox';

// Which glyph that takes a press sits under a sheet-space point, if any.
export function cellGlyphAt(ctx: Context, x: number, y: number): CellGlyph | undefined {
    const d = getFlowdata(ctx);
    if (!d) return undefined;
    let [rowPre, row, r] = rowLocation(y, ctx.visibledatarow);
    let [colPre, col, c] = colLocation(x, ctx.visibledatacolumn);
    const merged = mergeBorder(ctx, d, r, c);
    if (merged) {
        [rowPre, row, r] = merged.row;
        [colPre, col, c] = merged.column;
    }
    // The painter's edges of the cell, in sheet pixels. It takes a column's edges as they are and a row's top a pixel
    // higher, and the canvas shows a sheet pixel one to the left and one up.
    const box = cellTextBox(colPre + 1, rowPre, col + 1, row + 1);
    if (isDropdownChevronClick(ctx, r, c, box, x, y)) return 'dropdown';
    if (isCheckboxClick(ctx, r, c, box, x, y)) return 'checkbox';
    return undefined;
}
