// The frozen panes as the grid shows them. initFreeze turns a sheet's frozen pane into the pane bounds that the canvas,
// the overlays and the scroll read, and the helpers here place the overlay panes and the headers' freeze handles.
// The sheet view calls initFreeze, for example when the sheet or its sizes change, and callers such as the headers and
// the drag handlers use the rest.

import { freezesColumns, freezesRows, SHEET_COLUMN_HEADER_HEIGHT, SHEET_ROW_HEADER_WIDTH } from '@workspace/lib/sheets';
import { sortedIndex } from 'es-toolkit/compat';
import type { Context, Freezen, GlobalCache } from '..';
import { colLocationByIndex, getSheetIndex, rowLocationByIndex } from '..';

export function initFreeze(ctx: Context, cache: GlobalCache, sheetId: string) {
    const idx = getSheetIndex(ctx, sheetId);
    if (idx == null) return;
    const { frozen } = ctx.sheets[idx];

    if (frozen == null) {
        delete cache.freezen;
        return;
    }

    const freezen: Freezen = {};
    const range = frozen.range ?? { row_focus: 0, column_focus: 0 };

    // The panes are measured from the top-left of the sheet, scrolled to 0.
    if (freezesRows(frozen)) {
        const row = Math.max(range.row_focus, 0);
        freezen.horizontal = {
            freezenhorizontaldata: {
                pos: ctx.visibledatarow[row],
                boundary: row + 1,
                scroll: 0,
                cumulative: ctx.visibledatarow.slice(row + 1),
                edge: ctx.visibledatarow[row] - 2 + SHEET_COLUMN_HEADER_HEIGHT,
            },
        };
    }
    if (freezesColumns(frozen)) {
        const column = Math.max(range.column_focus, 0);
        freezen.vertical = {
            freezenverticaldata: {
                pos: ctx.visibledatacolumn[column],
                boundary: column + 1,
                scroll: 0,
                cumulative: ctx.visibledatacolumn.slice(column + 1),
                edge: ctx.visibledatacolumn[column] - 2 + SHEET_ROW_HEADER_WIDTH,
            },
        };
    }

    cache.freezen ||= {};
    cache.freezen[ctx.currentSheetId] = freezen;
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

// The overlay panes, laid out as the canvas draws its panes. A band shows the sheet up to pos, pinned at the edge of the
// view. The rects change only with the freeze or the row and column sizes, never with a scroll.
export function computeOverlayRegions(
    freeze: Freezen | undefined,
    viewWidth: number,
    viewHeight: number,
): OverlayRegionSpec[] {
    const hData = freeze?.horizontal?.freezenhorizontaldata;
    const vData = freeze?.vertical?.freezenverticaldata;
    const bandH = hData ? hData.pos - hData.scroll : 0;
    const bandW = vData ? vData.pos - vData.scroll : 0;

    if (!hData && !vData) {
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
    if (hData) {
        regions.push({
            pane: 'rows',
            left: bandW,
            top: 0,
            width: viewWidth - bandW,
            height: bandH,
            clip: true,
            fixedLeft: null,
            fixedTop: hData.scroll,
        });
    }
    if (vData) {
        regions.push({
            pane: 'cols',
            left: 0,
            top: bandH,
            width: bandW,
            height: viewHeight - bandH,
            clip: true,
            fixedLeft: vData.scroll,
            fixedTop: null,
        });
    }
    if (hData && vData) {
        regions.push({
            pane: 'corner',
            left: 0,
            top: 0,
            width: bandW,
            height: bandH,
            clip: true,
            fixedLeft: vData.scroll,
            fixedTop: hData.scroll,
        });
    }
    return regions;
}

// A header shares the panes one axis at a time, so its clips can never drift from the body's, and never moves across
// its own width or height.
export function computeColumnHeaderRegions(
    freeze: Freezen | undefined,
    viewWidth: number,
    headerHeight: number,
): OverlayRegionSpec[] {
    const vertical = freeze?.vertical;
    return computeOverlayRegions(vertical ? { vertical } : undefined, viewWidth, headerHeight).map((region) => ({
        ...region,
        fixedTop: 0,
    }));
}

export function computeRowHeaderRegions(
    freeze: Freezen | undefined,
    headerWidth: number,
    viewHeight: number,
): OverlayRegionSpec[] {
    const horizontal = freeze?.horizontal;
    return computeOverlayRegions(horizontal ? { horizontal } : undefined, headerWidth, viewHeight).map((region) => ({
        ...region,
        fixedLeft: 0,
    }));
}

// The one region holding a cell, where an overlay that must exist once renders, such as the cell editor. boundary is the
// first index outside the frozen pane.
export function overlayRegionForCell(
    regions: OverlayRegionSpec[],
    freeze: Freezen | undefined,
    r: number,
    c: number,
): OverlayRegionSpec {
    const hData = freeze?.horizontal?.freezenhorizontaldata;
    const vData = freeze?.vertical?.freezenverticaldata;
    const inRows = hData != null && r < hData.boundary;
    const inCols = vData != null && c < vData.boundary;
    const key = inRows && inCols ? 'corner' : inRows ? 'rows' : inCols ? 'cols' : 'main';
    return regions.find((region) => region.pane === key) ?? regions[0];
}

export function scrollToFrozenRowCol(ctx: Context, freeze: Freezen | undefined) {
    const selections = ctx.selections;
    if (!selections) return;

    let row: number | undefined;
    const { row_focus } = selections[0];
    if (row_focus === selections[0].row[0]) {
        [, row] = selections[0].row;
    } else if (row_focus === selections[0].row[1]) {
        [row] = selections[0].row;
    }

    let column: number | undefined;
    const { column_focus } = selections[0];
    if (column_focus === selections[0].column[0]) {
        [, column] = selections[0].column;
    } else if (column_focus === selections[0].column[1]) {
        [column] = selections[0].column;
    }

    const verticalData = freeze?.vertical?.freezenverticaldata;
    const horizontalData = freeze?.horizontal?.freezenhorizontaldata;

    const request: { left?: number; top?: number } = {};

    if (verticalData != null && column != null) {
        let freezen_colindex = verticalData.boundary + sortedIndex(verticalData.cumulative, ctx.scrollLeft);

        if (column >= ctx.visibledatacolumn.length) {
            column = ctx.visibledatacolumn.length - 1;
        }

        if (freezen_colindex >= ctx.visibledatacolumn.length) {
            freezen_colindex = ctx.visibledatacolumn.length - 1;
        }

        const column_px = ctx.visibledatacolumn[column];
        const freezen_px = ctx.visibledatacolumn[freezen_colindex];

        if (column_px <= freezen_px + verticalData.edge) {
            request.left = 0;
        }
    }

    if (horizontalData != null && row != null) {
        let freezen_rowindex = horizontalData.boundary + sortedIndex(horizontalData.cumulative, ctx.scrollTop);

        if (row >= ctx.visibledatarow.length) {
            row = ctx.visibledatarow.length - 1;
        }

        if (freezen_rowindex >= ctx.visibledatarow.length) {
            freezen_rowindex = ctx.visibledatarow.length - 1;
        }

        const row_px = ctx.visibledatarow[row];
        const freezen_px = ctx.visibledatarow[freezen_rowindex];

        if (row_px <= freezen_px + horizontalData.edge) {
            request.top = 0;
        }
    }

    if (request.left != null || request.top != null) {
        ctx.scrollRequest = request;
    }
}

export function getFrozenHandleTop(ctx: Context) {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    const frozen = idx == null ? undefined : ctx.sheets[idx].frozen;
    if (!freezesRows(frozen)) return ctx.scrollTop;
    return rowLocationByIndex(frozen?.range?.row_focus || 0, ctx.visibledatarow)[1] + ctx.scrollTop;
}

export function getFrozenHandleLeft(ctx: Context) {
    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    const frozen = idx == null ? undefined : ctx.sheets[idx].frozen;
    if (!freezesColumns(frozen)) return ctx.scrollLeft;
    return colLocationByIndex(frozen?.range?.column_focus || 0, ctx.visibledatacolumn)[1] - 2 + ctx.scrollLeft;
}
