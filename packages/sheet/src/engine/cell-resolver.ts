// A CellResolver over a plain list of sheets, such as the replayed sheets recalcSheets computes on the server. The
// formula engine reads cells and finds sheets by name through it. The editor has its own resolver over its context.

import { sheetFinder } from './parser/helper/cell';
import type { CalcChainEntry, CellMatrix, CellResolver, SheetInfo } from './types';

export type { CellResolver } from './types';

export type SheetData = {
    id: string;
    name: string;
    data: CellMatrix | null;
    calculationChain: CalcChainEntry[];
    dynamicArrayCompute: unknown[];
};

// The maps by id and by name are built once. The recalc resolves a cell per formula dependency, and a linear find per
// read is what makes a large workbook crawl.
export function createArrayResolver(sheets: SheetData[]): CellResolver {
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
        getSheets(): SheetInfo[] {
            return sheets.map((s) => ({
                id: s.id,
                name: s.name,
                calculationChain: s.calculationChain,
                dynamicArrayCompute: s.dynamicArrayCompute,
            }));
        },
    };
}
