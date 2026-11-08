// The marks a cell paints in its own box: the two data-validation affordances, a list chevron and a tick box, and
// the corner triangles. A press on any of them belongs to the cell: it opens the list, toggles the box, or just
// selects the marked cell, and never reaches the selection's drag handles, whose hit targets straddle the same
// corners. cellGlyphAt is the one question the grid's mousedown and hover paths ask before a handle gets its say.

import { CELL_INDICATOR_SIZE } from '@workspace/lib/constants/comment-indicator';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { getRealCellValue, isForcedStringNumber, mergeBorder } from './cell';
import type { CellGlyphRect } from './data-validation';
import {
    cellPassesRule,
    cellTextBox,
    getCellDataValidation,
    isCheckboxClick,
    isDropdownChevronClick,
} from './data-validation';
import { colLocation, rowLocation } from './location';

export type CellGlyph = 'dropdown' | 'checkbox' | 'comment' | 'invalid' | 'forced-string';

// The square a corner triangle is drawn in, anchored on the cell corner itself (the 1px is the grid line). The painter
// and the hit test share it.
export function cellIndicatorRect(corner: 'left' | 'right', left: number, top: number, right: number): CellGlyphRect {
    return { x: (corner === 'left' ? left : right - CELL_INDICATOR_SIZE) - 1, y: top, size: CELL_INDICATOR_SIZE };
}

function inGlyph(rect: CellGlyphRect, x: number, y: number) {
    return x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size;
}

// Which painted glyph sits under a sheet-space point, if any.
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
    const cell = d[r]?.[c];
    if (cell?.commentCardIds?.length && inGlyph(cellIndicatorRect('right', colPre, rowPre, col), x, y)) {
        return 'comment';
    }
    // The painter draws the two top-left triangles only on a cell with a value, so the hit test claims the corner only
    // there too.
    const value = cell ? getRealCellValue(r, c, d) : null;
    if (value != null && value.toString().length > 0 && inGlyph(cellIndicatorRect('left', colPre, rowPre, col), x, y)) {
        const rule = getCellDataValidation(ctx, r, c);
        if (rule && !cellPassesRule(ctx, rule, cell)) return 'invalid';
        if (isForcedStringNumber(cell)) return 'forced-string';
    }
    return undefined;
}
