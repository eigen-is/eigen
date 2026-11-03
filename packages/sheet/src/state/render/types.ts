// The types the canvas painter's passes share: the pass itself, which drawMain builds once per pane, the
// cells it collects, and the map of text that spills into empty neighbours.

import type { ComputeMap } from '../../engine/conditional-format';
import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import type { DataValidationRule } from '../types';

// Overflow map: per-row map of cell-column → the source-cell that overflows
// into this column (text wraps across adjacent empty cells).
export type CellOverflowItem = { r: number; stc: number; edc: number };
export type CellOverflowMap = Record<number, Record<number, CellOverflowItem> | undefined>;

// A visible cell scheduled for rendering. Merged cells accumulate the extent
// of their spanned rows/columns onto their first-seen item before the merge
// reprocess pass re-renders them full-size.
export type CellRenderItem = {
    r: number;
    c: number;
    startX: number;
    startY: number;
    endY: number;
    endX: number;
};

// Everything one drawMain pass shares with the per-cell render calls. Built
// once at the top of drawMain; freeze regions each get their own pass.
export type RenderPass = {
    sheetCtx: Context;
    renderCtx: CanvasRenderingContext2D;
    offsetLeft: number;
    offsetTop: number;
    scrollWidth: number;
    scrollHeight: number;
    // Where the sheet's top-left corner falls on the canvas.
    origin: { x: number; y: number };
    drawWidth: number;
    drawHeight: number;
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
    flowdata: CellMatrix;
    cfCompute: ComputeMap | null;
    // The rule over a cell of the current sheet, built once per pass from the rules in view (validationLookup).
    validationAt: (r: number, c: number) => DataValidationRule | undefined;
    cellOverflowMap: CellOverflowMap;
    drawGridLines: boolean;
    // The cells add their grid lines here, and drawMain strokes them all at once. That saves thousands of
    // strokes per draw, and a corner where two lines cross is blended once, not twice.
    gridLines: Path2D;
};
