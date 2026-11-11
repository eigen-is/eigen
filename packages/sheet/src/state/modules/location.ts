// Where a pointer is on the sheet. sheetPoint measures every mouse event of the grid and its headers from the cell
// area, whatever element received it, such as a press on a cell or a fill drag over a header. visibledatarow and
// visibledatacolumn hold each row's and column's far edge, so rowLocation and colLocation turn the point's sheet
// position into a row or a column, and cellRectAt gives a cell's rectangle, a merge's included.

import { sortedIndex } from 'es-toolkit/compat';
import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import type { CellRect } from '../types';
import { mergeBorder } from './cell';
import type { OverlayRegionSpec } from './freeze';
import { freezeOf } from './freeze';

// viewX and viewY are relative to the cell area's top left; x and y are the sheet place under the pointer.
// In a frozen pane x and y don't follow the scroll, and a point over a header or past the grid lies outside the area.
type SheetPoint = {
    viewX: number;
    viewY: number;
    width: number;
    height: number;
    x: number;
    y: number;
    inside: boolean;
    pane: OverlayRegionSpec['pane'];
};

export function sheetPoint(
    ctx: Context,
    e: Pick<MouseEvent, 'clientX' | 'clientY'>,
    cellArea: HTMLElement,
): SheetPoint {
    const { left, top, width, height } = cellArea.getBoundingClientRect();
    const viewX = e.clientX - left;
    const viewY = e.clientY - top;
    const freeze = freezeOf(ctx);
    const cols = freeze?.columns;
    const rows = freeze?.rows;
    const inCols = cols != null && viewX < cols.pos;
    const inRows = rows != null && viewY < rows.pos;
    return {
        viewX,
        viewY,
        width,
        height,
        x: viewX + (inCols ? 0 : cellArea.scrollLeft),
        y: viewY + (inRows ? 0 : cellArea.scrollTop),
        inside: viewX >= 0 && viewY >= 0 && viewX < width && viewY < height,
        pane: inRows && inCols ? 'corner' : inRows ? 'rows' : inCols ? 'cols' : 'main',
    };
}

export function rowLocationByIndex(index: number, visibleRow: number[]) {
    return [index === 0 ? 0 : visibleRow[index - 1], visibleRow[index], index];
}

export function rowLocation(y: number, visibleRow: number[]) {
    const index = sortedIndex(visibleRow, y);
    return rowLocationByIndex(index >= visibleRow.length && y > 0 ? visibleRow.length - 1 : index, visibleRow);
}

export function colLocationByIndex(index: number, visibleCol: number[]) {
    return [index === 0 ? 0 : visibleCol[index - 1], visibleCol[index], index];
}

export function colLocation(x: number, visibleCol: number[]) {
    const index = sortedIndex(visibleCol, x);
    return colLocationByIndex(index >= visibleCol.length && x > 0 ? visibleCol.length - 1 : index, visibleCol);
}

export function cellRectAt(ctx: Context, d: CellMatrix, r: number, c: number): CellRect {
    const rect = {
        top: r === 0 ? 0 : ctx.visibledatarow[r - 1],
        bottom: ctx.visibledatarow[r],
        left: c === 0 ? 0 : ctx.visibledatacolumn[c - 1],
        right: ctx.visibledatacolumn[c],
    };
    const merge = mergeBorder(ctx, d, r, c);
    if (merge) {
        [rect.top, rect.bottom] = merge.row;
        [rect.left, rect.right] = merge.column;
    }
    return rect;
}
