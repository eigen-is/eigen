// The caps on what one workbook may hold, in cells and in text, and on the work the xlsx reader does to build it. The
// reader charges a file against them as it reads it in the transform process. Inserting a file's sheets into an open
// workbook weighs the two together on the main thread, so the caps live apart from the reader, which it must not load.

// A cell costs about 480 B in the sheets alone, and recalc and the snapshot copy it: the cells emitted count, merged and
// validated ones among them, and every sheet's span, so a tiny file can't declare far-apart cells whose grid recalc
// walks. The byte cap catches a bomb of few cells.
export const MAX_CELLS = 4_000_000;

// The snapshot spells a cell's text out per cell, its value, its display and a rich string's runs; real workbooks emit
// under 120M characters.
export const MAX_TEXT = 250_000_000;
// A shared formula's copy is translated, and a formula that uses a defined name is walked, before either is weighed,
// at about 3M characters a second. The corpus spends at most 4.3M characters, 1.2M of them on names, in a GOV.UK
// inspections workbook of 24,706 copies. The budget is nearly four times that, about 5 s.
export const MAX_SHARED_FORMULA_TEXT = 16_000_000;
// Recalc materializes a sheet's rows by its columns, each at least a default grid's, at about 13 bytes a slot, so a
// narrow sheet's span is far smaller than its grid. The corpus builds at most 27.3M, in docling's inflated test file of
// one sheet of a million rows. Four times that recalcs in about a second at 1.4 GB.
export const MAX_GRID_SLOTS = 110_000_000;
