import type { CellCoordinate } from './parser/helper/cell.ts';

export type { CellCoordinate };

// Single cell reference resolved from a label like `A1` or `Sheet1!$A$1`.
export type CellInfo = {
    label: string;
    row: CellCoordinate;
    column: CellCoordinate;
    sheetName: string | null;
};

// Cell reference used as an endpoint of a range (`A1:B3`). The sheet name lives
// on the start endpoint only — the end inherits it.
export type RangeCell = {
    row: CellCoordinate;
    column: CellCoordinate;
    label: string;
    sheetName?: string | null;
};

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

export type InlineStringSegment = {
    v?: string;
    si?: number;
    measureText?: unknown;
} & CellStyle;

export type CellType = {
    fa?: string;
    t?: string;
    s?: InlineStringSegment[];
};

export type Cell = {
    v?: string | number | boolean;
    m?: string | number;
    mc?: { r: number; c: number; rs?: number; cs?: number };
    f?: string;
    ct?: CellType;
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
    getRange(sheetId: string, startRow: number, startCol: number, endRow: number, endCol: number): (Cell | null)[][];
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
    value: Cell['v'];
    display: string;
    type: 'number' | 'string' | 'boolean' | 'date' | 'error';
};

export type FormulaEngineState = {
    execFunctionGlobalData: Record<string, unknown>;
    formulaCellInfoMap: FormulaCellInfoMap | null;
    cellTextToIndexList: Record<string, FormulaDependency>;
};

// Scalar value that can appear in a formula expression or as a cell value.
// Range/array shapes are expressed via `FormulaArg`.
export type FormulaValue = string | number | boolean | null | undefined;

// Arguments accepted by formula operators and functions. Scalars for single cells,
// 1D arrays for row/column ranges, 2D arrays for rectangular ranges.
export type FormulaArg = FormulaValue | FormulaValue[] | FormulaValue[][];

// Return shape produced by operators and formula functions — same shape space
// as `FormulaArg`, but used in return position where the distinction from a
// scalar-expected arg is informative at call sites.
export type FormulaOutput = FormulaValue | FormulaValue[] | FormulaValue[][];

// User-registered formula function. The parser passes all evaluated arguments
// as a single `params` array (not spread), matching the parser convention.
export type FormulaFunction = (params: FormulaArg[]) => FormulaOutput;

// Acknowledgement callback the parser passes to `callCellValue` / `callRangeValue` /
// `callFunction` / `callVariable` listeners so they can supply the resolved value.
export type ParserDoneCallback = (value: unknown) => void;

export type ParseResult = {
    error: string | null;
    // biome-ignore lint/suspicious/noExplicitAny: formula result is dynamic (scalar, array, Date, error) — consumers narrow at use, tightening forces ~70 test casts with no safety gain
    result: any;
};

export type ParserOptions = {
    sheetId?: string;
    [key: string]: unknown;
};

// biome-ignore lint/suspicious/noExplicitAny: event-emitter boundary — per-event args are typed at call sites
export type ParserEventListener = (...args: any[]) => void;
