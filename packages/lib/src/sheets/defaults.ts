import type { Sheet } from './types';

// The size, in CSS pixels, of a track the user never resized. A row or column without a
// stored `rowlen`/`columnlen` falls back to its sheet's default, and a sheet without one
// (all but an imported one) to these, so the editor grid, the op replay and the
// server-side HTML/PDF/preview renderer must all read them through the two helpers below —
// two spellings drift, and floating images (stored as pixel positions) then land over
// different cells on screen than in an export.
export const SHEET_DEFAULT_COL_WIDTH = 100;
export const SHEET_DEFAULT_ROW_HEIGHT = 20;

export function sheetDefaultColWidth(sheet: Pick<Sheet, 'defaultColWidth'>): number {
    return sheet.defaultColWidth ?? SHEET_DEFAULT_COL_WIDTH;
}

export function sheetDefaultRowHeight(sheet: Pick<Sheet, 'defaultRowHeight'>): number {
    return sheet.defaultRowHeight ?? SHEET_DEFAULT_ROW_HEIGHT;
}

// The laid-out pixels across the columns or rows `from` to `to`, a hidden one none: the walk the server's HTML, PDF and
// preview grid and overlay and the xlsx import's chart anchors share. Geometry is schemaless at the Yjs boundary, so a
// stored length that isn't a number reads as the default.
export function sheetColumnsWidth(sheet: Pick<Sheet, 'config' | 'defaultColWidth'>, from: number, to: number): number {
    const { colhidden, columnlen } = sheet.config ?? {};
    return tracksLength(from, to, colhidden, columnlen, sheetDefaultColWidth(sheet));
}

export function sheetRowsHeight(sheet: Pick<Sheet, 'config' | 'defaultRowHeight'>, from: number, to: number): number {
    const { rowhidden, rowlen } = sheet.config ?? {};
    return tracksLength(from, to, rowhidden, rowlen, sheetDefaultRowHeight(sheet));
}

// Where `px` from the grid's start lands across the columns or rows: the track and the pixels into it, so the walk above
// over the tracks before it plus the offset is `px` again. A hidden track holds no pixel, so a boundary starts the next
// shown track; past the grid is the last track, the rest its offset. The xlsx export's chart anchors are its cells.
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

// The header strips and the cell text size a fresh workbook starts with, which the chart Edit data
// grid draws at too, so it looks like a sheet.
export const SHEET_ROW_HEADER_WIDTH = 46;
export const SHEET_COLUMN_HEADER_HEIGHT = 20;
export const SHEET_DEFAULT_FONT_SIZE = 10; // points

// Excel's grid (A1:XFD1048576): imported workbooks carry refs this far out, past the sheet's own insert limits.
export const REFERENCE_ROW_COUNT = 1048576;
export const REFERENCE_COLUMN_COUNT = 16384;
