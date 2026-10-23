import { CHART_MAX_SIDE } from '../charts/spec';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from './defaults';
import type { SheetChart } from './types';

type Box = Pick<SheetChart, 'x' | 'y' | 'width' | 'height'>;

// Excel's grid at the default track sizes: a chart's corner lies on it.
const GRID_WIDTH = REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH;
const GRID_HEIGHT = REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT;

// A sheet chart's box as the import and the editor's writers store it and the painters draw it: a file or a peer can
// store any number, and a side past CHART_MAX_SIDE stalls every painter, at a trillion px overflowing its stack.
export function sheetChartBox({ x, y, width, height }: Box): Box {
    return {
        x: within(x, 0, GRID_WIDTH),
        y: within(y, 0, GRID_HEIGHT),
        width: within(width, 1, CHART_MAX_SIDE),
        height: within(height, 1, CHART_MAX_SIDE),
    };
}

function within(value: number, min: number, max: number): number {
    const clamped = Math.min(max, Math.max(min, value));
    return Number.isNaN(clamped) ? min : clamped;
}
