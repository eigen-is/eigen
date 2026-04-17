import type {Cell, CellMatrix, FormulaCellInfoMap, FormulaDependency} from "../state/types";

export type CellResolver = {
    getCell(sheetId: string, row: number, col: number): Cell | null;
    getRange(
        sheetId: string,
        startRow: number,
        startCol: number,
        endRow: number,
        endCol: number
    ): (Cell | null)[][];
    getSheetIdByName(name: string): string | null;
    getSheetData(sheetId: string): CellMatrix | null;
    getSheets(): SheetInfo[];
};

export type SheetInfo = {
    id: string;
    name: string;
    calculationChain: CalculationChainEntry[];
    dynamicArrayCompute: unknown[];
};

export type CalculationChainEntry = {
    r: number;
    c: number;
    id: string;
};

export type EvaluationResult = {
    value: unknown;
    display: string;
    type: "number" | "string" | "boolean" | "date" | "error";
};

export type FormulaEngineState = {
    execFunctionGlobalData: Record<string, unknown>;
    formulaCellInfoMap: FormulaCellInfoMap | null;
    cellTextToIndexList: Record<string, FormulaDependency>;
};
