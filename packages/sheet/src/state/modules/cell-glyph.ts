// The marks a cell paints in its own box. Two of them take a press: a list chevron opens its list and a tick box
// toggles, and both sit where the selection's drag handles have their hit targets. cellGlyphAt is the one question the
// grid's mousedown and hover paths ask before a handle gets its say. The corner marks, such as a comment's, take no
// press, so this file only says where the painter draws them.

import { CELL_INDICATOR_SIZE } from '@workspace/lib/constants/comment-indicator';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { mergeBorder } from './cell';
import type { CellGlyphRect } from './data-validation';
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
    const box = cellTextBox(colPre, rowPre, col, row);
    if (isDropdownChevronClick(ctx, r, c, box, x, y)) return 'dropdown';
    if (isCheckboxClick(ctx, r, c, box, x, y)) return 'checkbox';
    return undefined;
}

// The square a corner triangle is drawn in, anchored on the cell corner itself (the 1px is the grid line).
export function cellIndicatorRect(corner: 'left' | 'right', left: number, top: number, right: number): CellGlyphRect {
    return { x: (corner === 'left' ? left : right - CELL_INDICATOR_SIZE) - 1, y: top, size: CELL_INDICATOR_SIZE };
}
