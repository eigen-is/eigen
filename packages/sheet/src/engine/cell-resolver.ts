import type { CalcChainEntry, CellMatrix, CellResolver, SheetInfo } from './types';

export type { CellResolver } from './types';

export type SheetData = {
    id: string;
    name: string;
    data: CellMatrix | null;
    calculationChain: CalcChainEntry[];
    dynamicArrayCompute: unknown[];
};

// Id/name maps built once: the recalc inner loop resolves a cell per formula
// dependency, and a linear find per read is what makes a large workbook crawl.
export function createArrayResolver(sheets: SheetData[]): CellResolver {
    const byId = new Map<string, SheetData>();
    const byName = new Map<string, SheetData>();
    for (const sheet of sheets) {
        // First wins — an imported doc can carry two sheets under one name.
        if (!byId.has(sheet.id)) byId.set(sheet.id, sheet);
        if (!byName.has(sheet.name)) byName.set(sheet.name, sheet);
    }

    return {
        getCell(sheetId, row, col) {
            return byId.get(sheetId)?.data?.[row]?.[col] ?? null;
        },
        getSheetIdByName(name) {
            return byName.get(name)?.id ?? null;
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
