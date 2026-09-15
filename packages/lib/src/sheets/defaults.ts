// The size, in CSS pixels, of a track the user never resized. A row or column without a
// stored `rowlen`/`columnlen` falls back to these, so the editor grid, the op replay and
// the server-side HTML/PDF/preview renderer must all read them from here — two spellings
// drift, and floating images (stored as pixel positions) then land over different cells
// on screen than in an export.
export const SHEET_DEFAULT_COL_WIDTH = 100;
export const SHEET_DEFAULT_ROW_HEIGHT = 20;
