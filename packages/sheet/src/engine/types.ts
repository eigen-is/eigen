// The types of the sheet engine: the cell and range shapes it shares with the rest of Eigen, the editor's extra
// sheet settings and filter criteria, and the engine's own types for formulas, their dependencies and the parser.

import type { Cell, CellMatrix, Sheet, SheetConfig } from '@workspace/lib/sheets';
import type { CellCoordinate } from './parser/helper/cell';

// The stored sheet shapes live in lib, which can't import this package, and the engine reads them from here.
export type {
    Cell,
    CellMatrix,
    CellStyle,
    CellType,
    CellWithRowAndCol,
    ConditionalFormatRule,
    DefaultConditionalFormatRule,
    InlineStringSegment,
    Range,
    SingleRange,
} from '@workspace/lib/sheets';

// Row and column size overrides the state layer writes and the engine's row and column shifter moves, on top of the
// config lib stores.
export type EditorSheetConfigExtras = {
    customHeight?: Record<string, number>;
    customWidth?: Record<string, number>;
};

export type ExtendedSheetConfig = SheetConfig & EditorSheetConfigExtras;

// A filter-by-condition rule. A name it shares with conditional formatting, such as greaterThan, means the same there.
export type FilterConditionName =
    | 'isEmpty'
    | 'isNotEmpty'
    | 'textContains'
    | 'textNotContains'
    | 'textStartsWith'
    | 'textEndsWith'
    | 'textEquals'
    | 'dateEqual'
    | 'dateBefore'
    | 'dateAfter'
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'equal'
    | 'notEqual'
    | 'between'
    | 'notBetween';

export type FilterCondition = {
    conditionName: FilterConditionName;
    // The rule's operands: none for isEmpty and isNotEmpty, two for between and notBetween, one for the rest.
    values: string[];
};

// One column's filter. Fields an older snapshot stored, which nothing reads any more, pass through the index signature.
export type FilterEntry = {
    // Set when the column filters by a condition instead of by values or color.
    byCondition?: FilterCondition;
    // Legacy data and a peer's op can leave it out on an entry that hides no rows.
    rowhidden?: Record<string, number>;
    optionstate: boolean;
    str: number;
    edr: number;
    cindex: number;
    stc: number;
    edc: number;
    [key: string]: unknown;
};

// The sheet the row and column shifter moves: the stored shape plus the editor's filter criteria, which ride the
// ops and move with their rows.
export type ShiftedSheet = Sheet & { filter?: Record<string, FilterEntry> };

// Single cell reference resolved from a label like `A1` or `Sheet1!$A$1`.
export type CellInfo = {
    label: string;
    row: CellCoordinate;
    column: CellCoordinate;
    sheetName: string | null;
};

// An endpoint of a range such as `A1:B3`. Only the start carries the sheet name, and the end reads the same sheet.
export type RangeCell = {
    row: CellCoordinate;
    column: CellCoordinate;
    label: string;
    sheetName?: string | null;
};

export type FormulaDependency = {
    row: [number, number];
    column: [number, number];
    sheetId: string | undefined;
};

export type FormulaCellInfo = {
    formula: string;
    key: string;
    r: number;
    c: number;
    id: string;
};

export type FormulaCellInfoMap = {
    [key: string]: FormulaCellInfo;
};

export type CellResolver = {
    getCell(sheetId: string, row: number, col: number): Cell | null;
    getSheetIdByName(name: string): string | null;
    getSheetData(sheetId: string): CellMatrix | null;
    hasSheet(sheetId: string): boolean;
};

export type EvaluationResult = {
    value: Cell['v'];
    // The error is an operator applied to an array, which this build can't evaluate.
    arrayOperation?: boolean;
};

// A scalar in a formula or a cell, an error a cell holds included.
export type FormulaValue = string | number | boolean | null | undefined | Error;

// What an operator or function takes: a scalar for a cell, an array for a range. A scalar may be an Error, since an
// operand is another operator's output, which IF, IFERROR, AND and OR inspect to decide what to return.
export type FormulaArg = FormulaValue | FormulaValue[] | FormulaValue[][];

// What an operator or function returns. An error is returned rather than thrown, so an untaken IF branch drops it.
export type FormulaOutput = FormulaArg;

export type ParseResult = {
    error: string | null;
    // biome-ignore lint/suspicious/noExplicitAny: a scalar, an array, a Date or an error, which each reader narrows
    result: any;
    arrayOperation?: boolean;
};

export type ParserOptions = {
    // How far the evaluated cell sits from the cell the formula was written for; relative refs move by it.
    rowOffset?: number;
    colOffset?: number;
    readCell?: (cell: CellInfo) => FormulaValue;
    readRange?: (start: RangeCell, end: RangeCell) => FormulaValue[] | FormulaValue[][];
};

// A parsed formula; only the Parser that compiled it can evaluate it.
export type CompiledFormula = () => unknown;
