// The frozen panes as the grid shows them. freezeOf reads the current sheet's frozen pane as the pane bounds that the
// canvas, the overlays and the mouse handlers use, on the geometry of the same context, and the helpers here place the
// overlay panes and the headers' freeze handles.

import { freezesColumns, freezesRows } from '@workspace/lib/sheets';
import type { Context } from '../context';
import type { Freeze } from '../types';
import { getSheetIndex } from '../utils';
import { colLocationByIndex, rowLocationByIndex } from './location';

export function freezeOf(ctx: Context): Freeze | undefined {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    const frozen = idx == null ? undefined : ctx.sheets[idx].frozen;
    if (frozen == null) return undefined;

    const freeze: Freeze = {};
    const range = frozen.range ?? { row_focus: 0, column_focus: 0 };

    if (freezesRows(frozen)) {
        const row = Math.max(range.row_focus, 0);
        freeze.rows = { pos: ctx.visibledatarow[row], boundary: row + 1 };
    }
    if (freezesColumns(frozen)) {
        const column = Math.max(range.column_focus, 0);
        freeze.columns = { pos: ctx.visibledatacolumn[column], boundary: column + 1 };
    }

    return freeze;
}

// One pane of the overlays: a fixed rect inside the cell area whose content follows the scroll on its free axes. A
// frozen axis pins at fixedLeft or fixedTop, and null follows the scroll.
export type OverlayRegionSpec = {
    pane: 'main' | 'rows' | 'cols' | 'corner';
    left: number;
    top: number;
    width: number;
    height: number;
    clip: boolean;
    fixedLeft: number | null;
    fixedTop: number | null;
};

// The overlay panes, laid out as the canvas draws them. A band shows the sheet up to pos, pinned at the view's edge.
// The rects change only with the freeze or the row and column sizes, never with a scroll.
export function computeOverlayRegions(
    freeze: Freeze | undefined,
    viewWidth: number,
    viewHeight: number,
): OverlayRegionSpec[] {
    const rows = freeze?.rows;
    const cols = freeze?.columns;
    const bandH = rows?.pos ?? 0;
    const bandW = cols?.pos ?? 0;

    if (!rows && !cols) {
        return [
            {
                pane: 'main',
                left: 0,
                top: 0,
                width: viewWidth,
                height: viewHeight,
                clip: false,
                fixedLeft: null,
                fixedTop: null,
            },
        ];
    }

    const regions: OverlayRegionSpec[] = [
        {
            pane: 'main',
            left: bandW,
            top: bandH,
            width: viewWidth - bandW,
            height: viewHeight - bandH,
            clip: true,
            fixedLeft: null,
            fixedTop: null,
        },
    ];
    if (rows) {
        regions.push({
            pane: 'rows',
            left: bandW,
            top: 0,
            width: viewWidth - bandW,
            height: bandH,
            clip: true,
            fixedLeft: null,
            fixedTop: 0,
        });
    }
    if (cols) {
        regions.push({
            pane: 'cols',
            left: 0,
            top: bandH,
            width: bandW,
            height: viewHeight - bandH,
            clip: true,
            fixedLeft: 0,
            fixedTop: null,
        });
    }
    if (rows && cols) {
        regions.push({
            pane: 'corner',
            left: 0,
            top: 0,
            width: bandW,
            height: bandH,
            clip: true,
            fixedLeft: 0,
            fixedTop: 0,
        });
    }
    return regions;
}

// A header shares the panes one axis at a time, so its clips can never drift from the body's, and never moves across
// its own width or height.
export function computeColumnHeaderRegions(
    freeze: Freeze | undefined,
    viewWidth: number,
    headerHeight: number,
): OverlayRegionSpec[] {
    const columns = freeze?.columns;
    return computeOverlayRegions(columns ? { columns } : undefined, viewWidth, headerHeight).map((region) => ({
        ...region,
        fixedTop: 0,
    }));
}

export function computeRowHeaderRegions(
    freeze: Freeze | undefined,
    headerWidth: number,
    viewHeight: number,
): OverlayRegionSpec[] {
    const rows = freeze?.rows;
    return computeOverlayRegions(rows ? { rows } : undefined, headerWidth, viewHeight).map((region) => ({
        ...region,
        fixedLeft: 0,
    }));
}

// The one region holding a cell, where an overlay that must exist once renders, such as the cell editor.
// boundary is the first index outside the frozen pane.
export function overlayRegionForCell(
    regions: OverlayRegionSpec[],
    freeze: Freeze | undefined,
    r: number,
    c: number,
): OverlayRegionSpec {
    const rows = freeze?.rows;
    const cols = freeze?.columns;
    const inRows = rows != null && r < rows.boundary;
    const inCols = cols != null && c < cols.boundary;
    const key = inRows && inCols ? 'corner' : inRows ? 'rows' : inCols ? 'cols' : 'main';
    return regions.find((region) => region.pane === key) ?? regions[0];
}

// A selection drag whose far end has gone behind a frozen band scrolls back to the start, so the cells it reaches show.
// The main pane starts at the band's width plus the scroll, and a far end past that is in view.
export function scrollToFrozenRowCol(ctx: Context) {
    const selection = ctx.selections?.at(-1);
    if (!selection) return;

    const column = farEnd(selection.column, selection.column_focus);
    const row = farEnd(selection.row, selection.row_focus);
    const freeze = freezeOf(ctx);
    const columns = freeze?.columns;
    const rows = freeze?.rows;

    const request: { left?: number; top?: number } = {};
    if (
        columns &&
        column != null &&
        selection.column[1] >= columns.boundary &&
        ctx.visibledatacolumn[column] <= columns.pos + ctx.scrollLeft
    ) {
        request.left = 0;
    }
    if (
        rows &&
        row != null &&
        selection.row[1] >= rows.boundary &&
        ctx.visibledatarow[row] <= rows.pos + ctx.scrollTop
    ) {
        request.top = 0;
    }
    if (request.left != null || request.top != null) ctx.scrollRequest = request;
}

// The end of a selection's rows or columns away from its focus. A focus inside a merge is at neither end.
function farEnd([first, last]: readonly number[], focus: number | undefined) {
    if (focus === first) return last;
    return focus === last ? first : undefined;
}

export function getFrozenHandleTop(ctx: Context) {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    const frozen = idx == null ? undefined : ctx.sheets[idx].frozen;
    if (!freezesRows(frozen)) return ctx.scrollTop;
    return rowLocationByIndex(frozen?.range?.row_focus ?? 0, ctx.visibledatarow)[1] + ctx.scrollTop;
}

export function getFrozenHandleLeft(ctx: Context) {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    const frozen = idx == null ? undefined : ctx.sheets[idx].frozen;
    if (!freezesColumns(frozen)) return ctx.scrollLeft;
    return colLocationByIndex(frozen?.range?.column_focus ?? 0, ctx.visibledatacolumn)[1] - 2 + ctx.scrollLeft;
}
