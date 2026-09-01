// Canonical grid dimensions for an empty sheet. The editor (Workbook settings →
// initSheetData) expands every sheet without explicit row/column to this grid,
// so the op replay must materialize the same grid — a smaller base makes
// patches beyond the celldata extent fail to resolve. state's defaultSettings
// and defaultContext derive from these; never re-list the numbers inline.

import type { Sheet } from '@workspace/lib/sheets';
import { normalizeSheetConfig } from './sheet-config';

export const DEFAULT_SHEET_ROW_COUNT = 100;
export const DEFAULT_SHEET_COLUMN_COUNT = 26;

// A factory rather than a shared constant: Workbook's initSheetData mutates the
// sheets handed to it (writes `data`, deletes `celldata`), so a module-level
// constant would be aliased and mutated across mounts. The id must stay
// 'sheet-1' — pending op batches in existing docs reference it.
export function createDefaultSheets(): Sheet[] {
    const sheet: Sheet = { name: 'Sheet1', id: 'sheet-1', order: 0, celldata: [] };
    normalizeSheetConfig(sheet);
    return [sheet];
}
