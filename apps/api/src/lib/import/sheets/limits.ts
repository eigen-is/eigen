// The caps on what one workbook may hold, in cells and in text, and on the work the xlsx reader does to build it. The
// reader charges a file against them as it reads it in the transform process. An insert into an open workbook weighs
// the file with the workbook against the first two, on the main thread. So the caps and that weigh live apart from the
// reader, which the main thread must not load.

import type { Cell, Sheet } from '@workspace/lib/sheets';
import { ApiError } from '../../core/errors';
import type { SheetsWeight } from '../../document/transform/protocol';
import { IMPORT_MESSAGES } from '../messages';

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

// The transform weighs the file's sheets and the main thread the open workbook's, in one unit. The text is counted in
// the fields the reader charges per cell, so a file weighs no more here than the reader let through. What else the
// reader charges, such as borders, merges and the text of links and rules, is left out.
export function sheetsWeight(sheets: Sheet[]): SheetsWeight {
    let cells = 0;
    let text = 0;
    for (const sheet of sheets) {
        for (const { v } of sheet.celldata ?? []) {
            cells++;
            if (v) text += cellText(v);
        }
    }
    return { cells, text };
}

// The reader bounds each file alone, so an insert weighs the file with the workbook it joins against the same caps.
// Then no workbook grown by inserts holds more than one import may.
export function assertInsertFits(workbook: Sheet[], file: SheetsWeight): void {
    const { cells, text } = sheetsWeight(workbook);
    if (cells + file.cells > MAX_CELLS || text + file.text > MAX_TEXT) {
        throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
    }
}

function cellText(cell: Cell): number {
    let text = textLength(cell.v) + textLength(cell.m) + textLength(cell.f) + textLength(cell.ct?.fa);
    for (const run of cell.ct?.s ?? []) text += textLength(run.v);
    return text;
}

function textLength(value: unknown): number {
    return typeof value === 'string' ? value.length : 0;
}
