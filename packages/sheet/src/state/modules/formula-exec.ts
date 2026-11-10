// Formula execution in the editor: evaluating a formula, building the formula graph and recomputing what an edit
// affects (execFunctionGroup). These read and write the workbook context, so they live in the state layer, while the
// parsing and evaluating they call into is the engine's. A sheet, row or column op recomputes in the engine's own
// batch, as every reader's does.

import { findSheetByName } from '../../engine/a1-notation';
import { createArrayResolver } from '../../engine/cell-resolver';
import { FormulaGraph } from '../../engine/formula-graph';
import { checkBracketNum, LAST_COLUMN, LAST_ROW, matrixWidth, resolveCellRange } from '../../engine/formula-utils';
import { evaluateFormulas } from '../../engine/recalc';
import type { Cell, CellResolver, FormulaDependency } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell } from '../types';
import { getSheetIndex } from '../utils';
import { setCellValue } from './cell';
import { snapshotContext } from './formula-cache';

// The cells a reference in the grid's UI covers, such as a link or a highlighted range: a whole column or row stops at
// its sheet's end. null when it covers none, or names a sheet with no matrix to show them on.
export function getcellrange(ctx: Context, txt: string): FormulaDependency | null {
    const range = resolveCellRange(
        {
            findSheet: (name) => findSheetByName(ctx.sheets, name),
            cellTextToIndexList: ctx.formulaCache.cellTextToIndexList,
        },
        txt,
        ctx.currentSheetId,
    );
    const data = range && getFlowdata(ctx, range.sheetId);
    if (range == null || data == null) return null;
    const lastRow = range.row[1] >= LAST_ROW ? data.length - 1 : range.row[1];
    const lastColumn = range.column[1] >= LAST_COLUMN ? matrixWidth(data) - 1 : range.column[1];
    if (lastRow < range.row[0] || lastColumn < range.column[0]) return null;
    return { row: [range.row[0], lastRow], column: [range.column[0], lastColumn], sheetId: range.sheetId };
}

type ComputeFormulaOptions = {
    id?: string;
    // A pass over many formulas shares one, so no formula takes its own snapshot of the workbook.
    resolver?: CellResolver;
};

// A formula's value, and its text with a missing closing bracket added.
export function computeFormula(
    ctx: Context,
    txt: string,
    {
        id = ctx.currentSheetId,
        resolver = createArrayResolver(snapshotContext(ctx).sheets),
    }: ComputeFormulaOptions = {},
): [Cell['v'], string] {
    const formula = checkBracketNum(txt) ? txt : `${txt})`;
    return [ctx.formulaCache.engine.evaluate(formula, id, resolver).value, formula];
}

export function warmFormulaGraph(ctx: Context): FormulaGraph {
    // Inside an edit ctx is an immer draft, and reading every formula through it is slow.
    ctx.formulaCache.graph ??= new FormulaGraph(snapshotContext(ctx).sheets);
    return ctx.formulaCache.graph;
}

// Builds the formula graph while the browser is idle, such as after a load or a replay of the op log, so neither waits
// for it and the next formula edit finds it ready. Returns the cancel.
export function warmFormulaGraphOnIdle(getContext: () => Context): () => void {
    const run = () => warmFormulaGraph(getContext());
    if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 2000 });
        return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 200);
    return () => clearTimeout(id);
}

// Recomputes the formulas at `formulasAt` and every formula that reads a cell in `changedCells` or one of those,
// directly or through another formula, and writes the values that changed. The cells are already written, and the
// formula graph already knows them. A clock or a random number recomputes here, as its author's value then goes out on
// the wire.
export function execFunctionGroup(
    ctx: Context,
    changedCells: readonly FormulaCell[],
    formulasAt: readonly FormulaCell[] = [],
): void {
    const graph = warmFormulaGraph(ctx);
    const formulas = formulasAt.flatMap(({ r, c, id }) => graph.formulaAt(id, r, c) ?? []);
    // Reading cells through immer drafts is slow, so the pass reads a plain view it can't write.
    const snapshot = snapshotContext(ctx);
    const runList = graph.affected(snapshot.sheets, changedCells, formulas);
    if (runList.length === 0) return;

    const results = evaluateFormulas(runList, snapshot.sheets, ctx.formulaCache.engine, false);

    // Most recomputed formulas land on their previous value, and a draft write is what immer's finalize pays for.
    for (const { r, c, id, formula, result } of results) {
        const idx = getSheetIndex(snapshot, id);
        if (idx == null) continue;
        const before = snapshot.sheets[idx].data?.[r]?.[c];
        if (before != null && before.v === result.value) continue;
        const { data } = ctx.sheets[idx];
        if (data != null) setCellValue(ctx, r, c, data, { v: result.value, f: formula });
    }
}
