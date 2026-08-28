import type { SheetConfig } from '@workspace/lib/sheets';
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
    ColorGradationRule,
    ConditionalFormatConditionName,
    ConditionalFormatRule,
    DataBarRule,
    DefaultConditionalFormatRule,
    IconsRule,
    InlineStringSegment,
    Range,
    SingleRange,
} from '@workspace/lib/sheets';
export type { CellCoordinate };

import type { Cell, CellMatrix } from '@workspace/lib/sheets';

// Editor-only SheetConfig overlay: structural per-row/col flags the state layer
// reads/writes and the engine's row/col shifter shifts, but the BE/wire-shape
// `SheetConfig` in `@workspace/lib/sheets` never serializes. Hoisted here so
// state's `SheetConfig` and `engine/rowcol.ts::ExtendedSheetConfig` share one
// declaration instead of independently re-listing the same four fields.
export type EditorSheetConfigExtras = {
    rowReadOnly?: Record<string, number>;
    colReadOnly?: Record<string, number>;
    customHeight?: Record<string, number>;
    customWidth?: Record<string, number>;
};

// The config shape the editor and the op replay actually operate on: the wire shape plus the
// editor-only per-row/col flags above.
export type ExtendedSheetConfig = SheetConfig & EditorSheetConfigExtras;

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

// Dependency-graph adjacency: maps the `${r}_${c}_${index}` key of each
// adjacent formula cell to a refcount. Used as both the `parents` and
// `chidren` field type on FormulaCellInfo (engine) and FormulaCell (state).
export type AncestorFormulaCell = {
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
    getSheetIdByName(name: string): string | null;
    getSheetData(sheetId: string): CellMatrix | null;
    getSheets(): SheetInfo[];
};

export type SheetInfo = {
    id: string;
    name: string;
    calculationChain: CalcChainEntry[];
    dynamicArrayCompute: unknown[];
};

// Calc-chain entry: dependency-graph node for a formula cell. Engine producers
// always stamp `r`/`c`/`id`; state's UI ordering layer adds an optional
// `index` used by formula-cache.execFunctionExist consumers.
export type CalcChainEntry = {
    r: number;
    c: number;
    id: string;
    index?: number;
};

export type EvaluationResult = {
    value: Cell['v'];
    display: string;
    type: 'number' | 'string' | 'boolean' | 'date' | 'error';
};

export type FormulaEngineState = {
    execFunctionGlobalData: Record<string, unknown>;
    formulaCellInfoMap: FormulaCellInfoMap | null;
    // Reverse lookup cell → formulas reading it; mirrors formulaCellInfoMap
    // and must reset with it.
    dependencyIndex: DependencyIndex;
    cellTextToIndexList: Record<string, FormulaDependency>;
};

// Scalar value that can appear in a formula expression or as a cell value.
// Range/array shapes are expressed via `FormulaArg`.
export type FormulaValue = string | number | boolean | null | undefined;

// Arguments accepted by formula operators and functions. Scalars for single cells,
// 1D arrays for row/column ranges, 2D arrays for rectangular ranges. Includes
// `Error` because an operator's output (which may be an in-band Error from a
// short-circuit branch or a formulajs error sentinel) becomes the input of its
// parent in the grammar — short-circuit functions like IF/IFERROR/AND/OR
// inspect Error operands directly to decide what to return.
export type FormulaArg = FormulaValue | FormulaValue[] | FormulaValue[][] | Error;

// Return shape produced by operators and formula functions — same shape space
// as `FormulaArg`, plus `Error` for in-band error propagation. formulajs returns
// Error sentinels (e.g. `error.value`) and our short-circuit logic relies on
// arithmetic operators returning Error rather than throwing so the grammar can
// keep reducing (an untaken IF branch may discard the Error). The top-level
// `parse()` unwraps any Error result into a `{error}` field for callers.
export type FormulaOutput = FormulaValue | FormulaValue[] | FormulaValue[][] | Error;

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
