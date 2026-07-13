import type { CalcChainEntry, CellMatrix, CellResolver, SheetInfo } from './types';

export type { CellResolver } from './types';

export type SheetData = {
    id: string;
    name: string;
    data: CellMatrix | null;
    calculationChain: CalcChainEntry[];
    dynamicArrayCompute: unknown[];
};

export function createArrayResolver(sheets: SheetData[]): CellResolver {
    return {
        getCell(sheetId, row, col) {
            const sheet = sheets.find((s) => s.id === sheetId);
            return sheet?.data?.[row]?.[col] ?? null;
        },
        getSheetIdByName(name) {
            return sheets.find((s) => s.name === name)?.id ?? null;
        },
        getSheetData(sheetId) {
            return sheets.find((s) => s.id === sheetId)?.data ?? null;
        },
        getSheets(): SheetInfo[] {
            return sheets.map((s) => ({
                id: s.id ?? '',
                name: s.name,
                calculationChain: s.calculationChain ?? [],
                dynamicArrayCompute: s.dynamicArrayCompute ?? [],
            }));
        },
    };
}
