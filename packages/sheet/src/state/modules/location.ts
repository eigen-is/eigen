// Where a pointer is on the sheet. sheetPoint measures every mouse event of the grid and its headers from the cell
// area, whatever element received it, such as a press on a cell or a fill drag over a header. visibledatarow and
// visibledatacolumn hold each row's and column's far edge, so rowLocation and colLocation turn the point's sheet
// position into a row or a column.

import { sortedIndex } from 'es-toolkit/compat';
import type { Context } from '../context';
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

// A drag or a drop this close to the cell area's right edge is past it, on the vertical scrollbar.
export const SCROLLBAR_MARGIN = 14;

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

export function rowLocationByIndex(row_index: number, visibleRow: number[]) {
    return [row_index === 0 ? 0 : visibleRow[row_index - 1], visibleRow[row_index], row_index];
}

export function rowLocation(y: number, visibleRow: number[]) {
    const row_index = sortedIndex(visibleRow, y);
    return rowLocationByIndex(row_index >= visibleRow.length && y > 0 ? visibleRow.length - 1 : row_index, visibleRow);
}

export function colLocationByIndex(col_index: number, visibleCol: number[]) {
    return [col_index === 0 ? 0 : visibleCol[col_index - 1], visibleCol[col_index], col_index];
}

export function colLocation(x: number, visibleCol: number[]) {
    const col_index = sortedIndex(visibleCol, x);
    return colLocationByIndex(col_index >= visibleCol.length && x > 0 ? visibleCol.length - 1 : col_index, visibleCol);
}
