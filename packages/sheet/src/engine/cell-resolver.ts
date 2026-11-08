// A CellResolver over a list of sheets, such as the replayed sheets recalcSheets computes on the server or the sheets
// of the editor's context. The formula engine reads cells and finds sheets by name through it. It reads each sheet's
// matrix when asked, so over live sheets an evaluation sees the writes before it.

import { sheetFinder } from './parser/helper/cell';
import type { CellMatrix, CellResolver } from './types';

export type { CellResolver } from './types';

export type SheetData = {
    id: string;
    name: string;
    data?: CellMatrix | null;
};

// The maps by id and by name are built once. The recalc resolves a cell per formula dependency, and a linear find per
// read is what makes a large workbook crawl.
export function createArrayResolver(sheets: readonly SheetData[]): CellResolver {
    const byId = new Map<string, SheetData>();
    // The first wins, because an imported doc can carry two sheets under one id, as under one name.
    for (const sheet of sheets) if (!byId.has(sheet.id)) byId.set(sheet.id, sheet);
    const findSheet = sheetFinder(sheets);

    return {
        getCell(sheetId, row, col) {
            return byId.get(sheetId)?.data?.[row]?.[col] ?? null;
        },
        getSheetIdByName(name) {
            return findSheet(name)?.id ?? null;
        },
        getSheetData(sheetId) {
            return byId.get(sheetId)?.data ?? null;
        },
        hasSheet(sheetId) {
            return byId.has(sheetId);
        },
    };
}
