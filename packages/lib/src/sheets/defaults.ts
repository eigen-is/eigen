// The size, in CSS pixels, of a track the user never resized. A row or column without a
// stored `rowlen`/`columnlen` falls back to these, so the editor grid, the op replay and
// the server-side HTML/PDF/preview renderer must all read them from here — two spellings
// drift, and floating images (stored as pixel positions) then land over different cells
// on screen than in an export.
export const SHEET_DEFAULT_COL_WIDTH = 100;
export const SHEET_DEFAULT_ROW_HEIGHT = 20;

// The header strips and the cell text size a fresh workbook starts with, which the chart Edit data
// grid draws at too, so it looks like a sheet.
export const SHEET_ROW_HEADER_WIDTH = 46;
export const SHEET_COLUMN_HEADER_HEIGHT = 20;
export const SHEET_DEFAULT_FONT_SIZE = 10; // points

// Excel's grid (A1:XFD1048576): imported workbooks carry refs this far out, past the sheet's own insert limits.
export const REFERENCE_ROW_COUNT = 1048576;
export const REFERENCE_COLUMN_COUNT = 16384;
