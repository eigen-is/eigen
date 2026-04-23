import type { CalculationChainEntry, Cell, CellMatrix, CellResolver, SheetInfo } from './types';

export type { CellResolver } from './types';

export type SheetData = {
    id: string;
    name: string;
    data: CellMatrix | null;
    calculationChain: CalculationChainEntry[];
    dynamicArrayCompute: unknown[];
};

export function createArrayResolver(sheets: SheetData[]): CellResolver {
    return {
        getCell(sheetId, row, col) {
            const sheet = sheets.find((s) => s.id === sheetId);
            return sheet?.data?.[row]?.[col] ?? null;
        },
        getRange(sheetId, startRow, startCol, endRow, endCol) {
            const sheet = sheets.find((s) => s.id === sheetId);
            const result: (Cell | null)[][] = [];
            for (let r = startRow; r <= endRow; r++) {
                const row: (Cell | null)[] = [];
                for (let c = startCol; c <= endCol; c++) {
                    row.push(sheet?.data?.[r]?.[c] ?? null);
                }
                result.push(row);
            }
            return result;
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
