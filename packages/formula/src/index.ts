export type { Move } from './edit/move';
export type { LineEdit } from './edit/transform';
export type { Rewrite } from './recalc/edit-plan';
export { Engine } from './recalc/engine';
export type { CellAddress, EditResult, RecalcResult } from './recalc/recalc';
export type { CellSink, Literal, SheetSource } from './store/workbook';
export type { FormulaError } from './values/errors';
export { CALC, DIV0, ERROR, errorOf, NA, NAME, NULL, NUM, REF, SPILL, VALUE } from './values/errors';
