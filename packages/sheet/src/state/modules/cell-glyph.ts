import { type Context, getFlowdata } from '../context';
import { getRealCellValue, mergeBorder } from './cell';
import {
    type CellGlyphRect,
    cellTextBox,
    getCellDataVerification,
    isCheckboxClick,
    isDropdownChevronClick,
    validateCellData,
} from './data-verification';
import { colLocation, rowLocation } from './location';

// The marks a cell paints in its own box: the two data-verification affordances
// and the corner triangles. A press on any of them belongs to the cell — it
// opens the list, toggles the box, or just selects the marked cell — and never
// to the selection's drag handles, whose DOM hit targets straddle the same
// corners. cellGlyphAt is the one predicate the mousedown path (OverlayVisuals)
// and the hover path (events/mouse-drag.ts) consult before a handle gets its say.
export type CellGlyph = 'dropdown' | 'checkbox' | 'comment' | 'invalid';

// Corner indicators: a comment top-right, an invalid value or a forced string
// top-left. One size for all three so they read as one family of marks.
export const CELL_INDICATOR_SIZE = 11;

// The square the corner triangle is drawn in, anchored on the cell corner itself
// (the 1px is the grid line): one leg along the top edge, one down the side.
// The painter (render/cells.ts) and the hit test share this one construction.
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
    // Same condition the painter draws the mark under: a rule, a value to judge.
    const rule = getCellDataVerification(ctx, r, c);
    const value = cell ? getRealCellValue(r, c, d) : null;
    if (
        rule &&
        value != null &&
        value.toString().length > 0 &&
        !validateCellData(ctx, rule, value) &&
        inGlyph(cellIndicatorRect('left', colPre, rowPre, col), x, y)
    ) {
        return 'invalid';
    }
    return undefined;
}
