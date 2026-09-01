// Public surface of the sheet engine — pure, DOM-free, framework-free.
// BE consumers (document/sheets reader, exporters, previews) import from
// `@workspace/sheet/engine` rather than the package root so they don't
// pull React or any state-layer modules. Keep this barrel restricted to symbols
// safe for Node/server use; anything that reaches into `state/` belongs in the
// package-root export instead.

export {
    columnIndexToLabel,
    parseA1Range,
    quoteSheetName,
    rowIndexToLabel,
    toA1,
    unquoteSheetName,
} from './a1-notation';
export { createArrayResolver } from './cell-resolver';
export type {
    CellFormatStyle,
    ComputeMap,
    ConditionalFormatFormulaEvaluator,
    DataBar,
    EvaluateConditionalFormatOptions,
} from './conditional-format';
export { evaluateConditionalFormat } from './conditional-format';
// CF rule shapes (`ConditionalFormatRule` etc.) live in `@workspace/lib/sheets` and
// are surfaced through `./types` re-exports below.
export { createDefaultSheets } from './defaults';
export { booleanDisplay, update } from './format';
export { FormulaEngine } from './formula-engine';
export { type FormulaShiftMode, functionCopy } from './formula-shift';
export { iscelldata } from './formula-utils';
export { recalcSheets, sheetsNeedRecalc } from './recalc';
export { normalizeSheetConfig, replaySheetsOps, withMaterializedData } from './replay-ops';
export type { DeleteRowColOp, InsertRowColOp, RowColErrorCode } from './rowcol';
export type {
    CalcChainEntry,
    CellResolver,
    EvaluationResult,
    FormulaEngineState,
    SheetInfo,
} from './types';
