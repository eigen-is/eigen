// The types of the sheet engine: the cell and range shapes it shares with the rest of Eigen, the editor's extra
// sheet settings and filter criteria, and the engine's own types for formulas, their dependencies and the parser.

import type { Sheet, SheetConfig } from '@workspace/lib/sheets';
import type { DependencyIndex } from './dependency-index';
import type { CellCoordinate } from './parser/helper/cell';

// Sheet data shapes (Cell, CellMatrix, SingleRange, ConditionalFormatRule, …) live
// in `@workspace/lib/sheets` to avoid a workspace cycle (sheet depends on lib,
// not vice versa). Re-exported here so engine code keeps importing from `./types`
// without churning every file.
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

import type { Cell, CellMatrix } from '@workspace/lib/sheets';

// Row and column size overrides the state layer writes and the engine's row and column shifter moves, on top of the
// config lib stores.
export type EditorSheetConfigExtras = {
    customHeight?: Record<string, number>;
    customWidth?: Record<string, number>;
};

// The config shape the editor and the op replay actually operate on: the wire shape plus the
// editor-only per-row/col flags above.
export type ExtendedSheetConfig = SheetConfig & EditorSheetConfigExtras;

// Filter-by-condition rule names. The names overlapping conditional formatting
// reuse the CF conditionNames (greaterThan, lessThan, equal, between, …); each
// maps 1:1 onto a label in `FILTER_CONDITION_ITEMS`.
// `values` carries the rule's operands: none for is(Not)Empty, one for
// text/date/compare rules, two for (not)between.
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
    values: string[];
};

// One column's filter. Every writer sets every field. `byCondition` is set when the column
// filters by a condition instead of by values or color. Fields an older snapshot stored, which
// nothing reads any more, pass through the index signature.
export type FilterEntry = {
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

// Cell reference used as an endpoint of a range (`A1:B3`). The sheet name lives
// on the start endpoint only — the end inherits it.
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
    // The keys of the formulas that read this cell.
    dependents: readonly string[];
};

export type FormulaCellInfoMap = {
    [rxcxix: string]: FormulaCellInfo;
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

export type FormulaEngineState = {
    formulaCellInfoMap: FormulaCellInfoMap | null;
    // Reverse lookup cell → formulas reading it; mirrors formulaCellInfoMap
    // and must reset with it.
    dependencyIndex: DependencyIndex;
};

// Scalar value that can appear in a formula expression or as a cell value, an error a cell holds included.
// Range/array shapes are expressed via `FormulaArg`.
export type FormulaValue = string | number | boolean | null | undefined | Error;

// Arguments accepted by formula operators and functions. Scalars for single cells,
// 1D arrays for row/column ranges, 2D arrays for rectangular ranges. A scalar may
// be an Error because an operator's output (which may be an in-band Error from a
// short-circuit branch or a formulajs error sentinel) becomes the input of its
// parent in the grammar — short-circuit functions like IF/IFERROR/AND/OR
// inspect Error operands directly to decide what to return.
export type FormulaArg = FormulaValue | FormulaValue[] | FormulaValue[][];

// Return shape produced by operators and formula functions — same shape space
// as `FormulaArg`, an Error included for in-band error propagation. formulajs returns
// Error sentinels (e.g. `error.value`) and our short-circuit logic relies on
// arithmetic operators returning Error rather than throwing so the grammar can
// keep reducing (an untaken IF branch may discard the Error). The top-level
// `parse()` unwraps any Error result into a `{error}` field for callers.
export type FormulaOutput = FormulaArg;

export type ParseResult = {
    error: string | null;
    // biome-ignore lint/suspicious/noExplicitAny: formula result is dynamic (scalar, array, Date, error) — consumers narrow at use, tightening forces ~70 test casts with no safety gain
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
