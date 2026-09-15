// Canonical grid dimensions for an empty sheet. The editor (Workbook settings →
// initSheetData) expands every sheet without explicit row/column to this grid,
// so the op replay must materialize the same grid — a smaller base makes
// patches beyond the celldata extent fail to resolve. state's defaultSettings
// and defaultContext derive from these; never re-list the numbers inline.

import type { Sheet } from '@workspace/lib/sheets';
import { normalizeSheetConfig } from './sheet-config';

export const DEFAULT_SHEET_ROW_COUNT = 100;
export const DEFAULT_SHEET_COLUMN_COUNT = 26;

// Ceilings an insert may reach but not pass. The help center quotes both.
export const MAX_SHEET_ROW_COUNT = 10000;
export const MAX_SHEET_COLUMN_COUNT = 1000;

// The grid a sheet materializes into: its own row/column when it carries a usable pair,
// else the default grid. One spelling, so replay and recalc always materialize the same
// base — a smaller one makes ops recorded against the editor's grid fail to resolve.
export function gridSize(sheet: Pick<Sheet, 'row' | 'column'>): { row: number; column: number } {
    return {
        row: sheet.row != null && sheet.row > 0 ? sheet.row : DEFAULT_SHEET_ROW_COUNT,
        column: sheet.column != null && sheet.column > 0 ? sheet.column : DEFAULT_SHEET_COLUMN_COUNT,
    };
}

// A factory rather than a shared constant: Workbook's initSheetData mutates the
// sheets handed to it (writes `data`, deletes `celldata`), so a module-level
// constant would be aliased and mutated across mounts. The id must stay
// 'sheet-1' — pending op batches in existing docs reference it.
export function createDefaultSheets(): Sheet[] {
    const sheet: Sheet = { name: 'Sheet1', id: 'sheet-1', order: 0, celldata: [] };
    normalizeSheetConfig(sheet);
    return [sheet];
}
