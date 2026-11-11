// The caps on what one workbook may hold, in cells and in text, and on the work the xlsx reader does to build it. The
// reader charges a file against them as it reads it in the transform process, and an insert into an open workbook
// weighs the file with the workbook against the first two before it builds the tabs. So the caps and that weigh live
// apart from the reader, which an export or a compaction must not load.

import type { Cell, Sheet } from '@workspace/lib/sheets';
import { ApiError } from '../../core/errors';
import { IMPORT_MESSAGES } from '../messages';

// A cell costs about 480 B in the sheets alone, and recalc and the snapshot copy it. Every sheet's span counts too, so a
// tiny file can't declare far-apart cells whose grid recalc walks.
export const MAX_CELLS = 4_000_000;

// The snapshot spells a cell's text out per cell: its value, its display and a rich string's runs.
export const MAX_TEXT = 250_000_000;
// A shared formula's copy is translated, and a formula that uses a defined name is walked, before either is weighed.
export const MAX_SHARED_FORMULA_TEXT = 16_000_000;

// A workbook's stored cells and the characters of their text.
export type SheetsWeight = { cells: number; text: number };

// The file's sheets and the open workbook's weigh in one unit. The text is counted in fields the reader charges per
// cell, so a file weighs no more here than the reader let through.
export function sheetsWeight(sheets: readonly Sheet[]): SheetsWeight {
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
export function assertInsertFits(workbook: readonly Sheet[], file: SheetsWeight): void {
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
