// The grid of a sheet that names no size of its own. The editor and the op replay both build every sheet through
// gridSize, because an op recorded against the editor's grid fails to resolve on a smaller one. It also holds the
// ceilings an insert may reach, and the sheet a new workbook starts with.

import type { Sheet } from '@workspace/lib/sheets';
import { normalizeSheetConfig } from './sheet-config';

export const DEFAULT_SHEET_ROW_COUNT = 100;
export const DEFAULT_SHEET_COLUMN_COUNT = 26;

// Ceilings an insert may reach but not pass. The help center quotes both.
export const MAX_SHEET_ROW_COUNT = 10000;
export const MAX_SHEET_COLUMN_COUNT = 1000;

export function gridSize(sheet: Pick<Sheet, 'row' | 'column'>): { row: number; column: number } {
    return {
        row: sheet.row != null && sheet.row > 0 ? sheet.row : DEFAULT_SHEET_ROW_COUNT,
        column: sheet.column != null && sheet.column > 0 ? sheet.column : DEFAULT_SHEET_COLUMN_COUNT,
    };
}

// A factory, because initSheetData writes to the sheets it gets.
export function createDefaultSheets(): Sheet[] {
    const sheet: Sheet = { name: 'Sheet1', id: 'sheet-1', order: 0, celldata: [] };
    normalizeSheetConfig(sheet);
    return [sheet];
}
