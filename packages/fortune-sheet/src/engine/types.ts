export type CellStyle = {
    bl?: number;
    it?: number;
    ff?: number | string;
    fs?: number;
    fc?: string;
    ht?: number;
    vt?: number;
    tb?: string;
    cl?: number;
    un?: number;
    tr?: string;
};

export type Cell = {
    v?: string | number | boolean;
    m?: string | number;
    mc?: { r: number; c: number; rs?: number; cs?: number };
    f?: string;
    ct?: { fa?: string; t?: string; s?: any };
    qp?: number;
    bg?: string;
    lo?: number;
    rt?: number;
    hl?: { r: number; c: number; id: string };
    commentChatNames?: string[];
} & CellStyle;

export type CellMatrix = (Cell | null)[][];

export type FormulaDependency = {
    row: [number, number];
    column: [number, number];
    sheetId: string | undefined;
};

type AncestorFormulaCell = {
    [rxcxix: string]: number;
};

export type FormulaCellInfo = {
    formulaDependency: FormulaDependency[];
    calc_funcStr: string;
    key: string;
    r: number;
    c: number;
    id: string;
    parents: AncestorFormulaCell;
    chidren: AncestorFormulaCell;
    color: string;
};

export type FormulaCellInfoMap = {
    [rxcxix: string]: FormulaCellInfo;
};

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
    value: Cell["v"];
    display: string;
    type: "number" | "string" | "boolean" | "date" | "error";
};

export type FormulaEngineState = {
    execFunctionGlobalData: Record<string, unknown>;
    formulaCellInfoMap: FormulaCellInfoMap | null;
    cellTextToIndexList: Record<string, FormulaDependency>;
};
