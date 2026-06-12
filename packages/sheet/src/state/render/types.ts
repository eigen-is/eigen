import type { ComputeMap } from '../../engine/conditional-format';
import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';

export const defaultStyle = {
    fillStyle: '#000000',
    textBaseline: 'middle',
    strokeStyle: 'rgba(0, 0, 0, 0.1)',
} as const;

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

// Per-cell-key rects consumed by the border pass.
export type BorderOffsetMap = Record<string, { startY: number; startX: number; endY: number; endX: number }>;

// Everything one drawMain pass shares with the per-cell render calls. Built
// once at the top of drawMain; freeze regions each get their own pass.
export type RenderPass = {
    sheetCtx: Context;
    renderCtx: CanvasRenderingContext2D;
    offsetLeft: number;
    offsetTop: number;
    scrollWidth: number;
    scrollHeight: number;
    drawWidth: number;
    drawHeight: number;
    rowStart: number;
    rowEnd: number;
    colStart: number;
    colEnd: number;
    flowdata: CellMatrix;
    cfCompute: ComputeMap | null;
    cellOverflowMap: CellOverflowMap;
    drawGridLines: boolean;
};
