// How a function makes a reference it worked out, as OFFSET does: one rectangle of a sheet, checked against the
// grid, since a reference that leaves it names no cells.

import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { FormulaError } from './errors';
import { REF } from './errors';
import type { Reference } from './value';
import { ValueType } from './value';

// The rectangle with these corners, both included, or #REF! when it leaves the grid.
export function rectangle(
    sheet: number,
    top: number,
    left: number,
    bottom: number,
    right: number,
): Reference | FormulaError {
    if (top < 0 || left < 0 || bottom >= GRID_ROWS || right >= GRID_COLUMNS || top > bottom || left > right) return REF;
    return { type: ValueType.Reference, sheet, top, left, bottom, right, next: null };
}
