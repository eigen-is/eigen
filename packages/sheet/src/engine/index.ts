// Public surface of the sheet engine — pure, DOM-free, framework-free.
// BE consumers (document/sheets reader, exporters, previews) import from
// `@workspace/sheet/engine` rather than the package root so they don't
// pull React or any state-layer modules. Keep this barrel restricted to symbols
// safe for Node/server use; anything that reaches into `state/` belongs in the
// package-root export instead.

export {
    columnIndexToLabel,
    columnLabelToIndex,
    parseA1,
    parseA1Range,
    rowIndexToLabel,
    rowLabelToIndex,
    toA1,
    unquoteSheetName,
} from './a1-notation';
export { createArrayResolver } from './cell-resolver';
export { celldataToData, dataToCelldata } from './celldata';
export type {
    CellFormatStyle,
    ComputeMap,
    ConditionalFormatFormulaEvaluator,
    DataBar,
    EvaluateConditionalFormatOptions,
} from './conditional-format';
export { cfSplitRange, evaluateConditionalFormat, getColorGradation } from './conditional-format';
// CF rule shapes (`ConditionalFormatRule` etc.) live in `@workspace/lib/sheets` and
// are surfaced through `./types` re-exports below.
export {
    detectCycle,
    getCalculationOrder,
    matchDependencies,
} from './dependency-graph';
export { datenum_local, genarate, is_date, update, valueShowEs } from './format';
export { FormulaEngine, isCellReference, isFormula } from './formula-engine';
export { detectAbsolute, type FormulaShiftMode, functionCopy, functionStrChange } from './formula-shift';
export {
    calPostfixExpression,
    checkBracketNum,
    iscelldata,
    operatorjson,
    operatorPriority,
} from './formula-utils';
export { replaySheetsOps } from './replay-ops';
export {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    type DeleteRowColOp,
    type InsertRowColOp,
    RowColError,
    type RowColErrorCode,
} from './rowcol';
export type {
    CalcChainEntry,
    CellResolver,
    EvaluationResult,
    FormulaEngineState,
    SheetInfo,
} from './types';
