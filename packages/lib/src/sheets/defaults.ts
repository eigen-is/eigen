// The sizes every reader of a workbook must agree on: a row's and a column's default pixels, the header strips, the
// pixels a run of tracks takes, and the largest grid a sheet may hold. The editor, the op replay and the server's
// renderers read them here, since a floating image stored in pixels lands over other cells where two readers differ.

import { isRecord } from '../core/guards';
import type { Sheet } from './types';

// In CSS pixels, for a row or column with no stored size on a sheet with no default of its own, which only an import
// sets.
export const SHEET_DEFAULT_COL_WIDTH = 100;
export const SHEET_DEFAULT_ROW_HEIGHT = 20;

export function sheetDefaultColWidth(sheet: Pick<Sheet, 'defaultColWidth'>): number {
    return sheet.defaultColWidth ?? SHEET_DEFAULT_COL_WIDTH;
}

export function sheetDefaultRowHeight(sheet: Pick<Sheet, 'defaultRowHeight'>): number {
    return sheet.defaultRowHeight ?? SHEET_DEFAULT_ROW_HEIGHT;
}

// The laid-out pixels across the columns or rows `from` to `to`, a hidden one none. A peer can store anything as a
// length, so one that is no number reads as the default.
export function sheetColumnsWidth(sheet: Pick<Sheet, 'config' | 'defaultColWidth'>, from: number, to: number): number {
    const { colhidden, columnlen } = sheet.config ?? {};
    return tracksLength(from, to, colhidden, columnlen, sheetDefaultColWidth(sheet));
}

export function sheetRowsHeight(sheet: Pick<Sheet, 'config' | 'defaultRowHeight'>, from: number, to: number): number {
    const { rowhidden, rowlen } = sheet.config ?? {};
    return tracksLength(from, to, rowhidden, rowlen, sheetDefaultRowHeight(sheet));
}

// The track `px` from the grid's start lands in, and the pixels into it. A hidden track holds no pixel, so a boundary
// starts the next shown one, and past the grid is the last track with the rest as its offset.
export function sheetTrackAt(
    sheet: Pick<Sheet, 'config' | 'defaultColWidth' | 'defaultRowHeight'>,
    axis: 'column' | 'row',
    px: number,
): { index: number; offsetPx: number } {
    const { colhidden, columnlen, rowhidden, rowlen } = sheet.config ?? {};
    const [hidden, lengths, fallback, count] =
        axis === 'column'
            ? [colhidden, columnlen, sheetDefaultColWidth(sheet), REFERENCE_COLUMN_COUNT]
            : [rowhidden, rowlen, sheetDefaultRowHeight(sheet), REFERENCE_ROW_COUNT];
    let start = 0;
    let length = 0;
    for (let track = 0; track < count; track++) {
        length = trackLength(track, hidden, lengths, fallback);
        if (px < start + length) return { index: track, offsetPx: px - start };
        start += length;
    }
    return { index: count - 1, offsetPx: px - start + length };
}

function tracksLength(
    from: number,
    to: number,
    hidden: Record<string, number> | undefined,
    lengths: Record<string, number> | undefined,
    fallback: number,
): number {
    let length = 0;
    for (let track = from; track <= to; track++) length += trackLength(track, hidden, lengths, fallback);
    return length;
}

// A track is hidden by its key, whatever it holds: the editor stores 0.
function trackLength(
    track: number,
    hidden: Record<string, number> | undefined,
    lengths: Record<string, number> | undefined,
    fallback: number,
): number {
    if (hidden?.[track] != null) return 0;
    const stored = Number(lengths?.[track] ?? fallback);
    return Number.isFinite(stored) ? stored : fallback;
}

// The header strips and the cell text size a fresh workbook starts with, which the chart's Edit data grid draws at too.
export const SHEET_ROW_HEADER_WIDTH = 46;
export const SHEET_COLUMN_HEADER_HEIGHT = 20;
export const SHEET_DEFAULT_FONT_SIZE = 10; // points

// Excel's grid (A1:XFD1048576): imported workbooks carry refs this far out, past the sheet's own insert limits.
export const REFERENCE_ROW_COUNT = 1048576;
export const REFERENCE_COLUMN_COUNT = 16384;

// The most slots one sheet's matrix holds, its rows by its columns. Every reader builds the matrix whole, and recalc
// builds each row at least a default grid wide, so the xlsx reader charges a file's sheets against it together.
export const MAX_GRID_SLOTS = 110_000_000;

// Whether a reader may build the sheet's matrix: its stated size and its farthest stored cell lie within Excel's
// grid, and the rows by the columns within the slot cap. A peer can store any number as a size or a cell's place.
export function sheetFitsGrid({ row = 0, column = 0, celldata }: Record<string, unknown>): boolean {
    if (!isCount(row, REFERENCE_ROW_COUNT) || !isCount(column, REFERENCE_COLUMN_COUNT)) return false;
    let rows = row;
    let columns = column;
    for (const cell of Array.isArray(celldata) ? celldata : []) {
        if (!isRecord(cell)) return false;
        const { r, c } = cell;
        if (!isCount(r, REFERENCE_ROW_COUNT - 1) || !isCount(c, REFERENCE_COLUMN_COUNT - 1)) return false;
        rows = Math.max(rows, r + 1);
        columns = Math.max(columns, c + 1);
    }
    return rows * columns <= MAX_GRID_SLOTS;
}

function isCount(value: unknown, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}
