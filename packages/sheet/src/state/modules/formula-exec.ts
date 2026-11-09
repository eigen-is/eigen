// Formula execution in the editor: evaluating a formula, building the formula map from the cells, recomputing the cells
// an edit affects (execFunctionGroup) and what a sheet, row or column op affects (recomputeAfterOps). These read and
// write the workbook context, so they live in the state layer, while the parsing and evaluating they call into is the
// engine's.

import { findSheetByName } from '../../engine/a1-notation';
import { createArrayResolver } from '../../engine/cell-resolver';
import { checkBracketNum, LAST_COLUMN, LAST_ROW, matrixWidth, resolveCellRange } from '../../engine/formula-utils';
import { affectedFormulas, evaluateFormulas, recomputeAfter } from '../../engine/recalc';
import { seedsOf } from '../../engine/replay-ops';
import type { Cell, CellResolver, FormulaCellInfoMap, FormulaDependency } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, Op } from '../types';
import { getSheetIndex } from '../utils';
import { setCellValue } from './cell';
import { registerFormulas, snapshotContext } from './formula-cache';

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

export function warmFormulaCellInfoMap(ctx: Context): FormulaCellInfoMap {
    if (ctx.formulaCache.formulaCellInfoMap != null) return ctx.formulaCache.formulaCellInfoMap;
    // Inside an edit ctx is an immer draft, and reading every formula through it is slow.
    const snap = snapshotContext(ctx);
    const map: FormulaCellInfoMap = {};
    ctx.formulaCache.formulaCellInfoMap = map;
    for (const { id, data } of snap.sheets) {
        if (data) registerFormulas(snap, id, data);
    }
    return map;
}

// Builds the formula map while the browser is idle, such as after a load or a replay of the op log, so neither waits
// for it and the next formula edit finds it ready. Returns the cancel.
export function warmFormulaCellInfoMapOnIdle(getContext: () => Context): () => void {
    const run = () => warmFormulaCellInfoMap(getContext());
    if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 2000 });
        return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 200);
    return () => clearTimeout(id);
}

// Recomputes the formulas at `formulasAt` and every formula that reads a cell in `changedCells` or one of those,
// directly or through another formula, and writes the values that changed. The cells are already written, and the
// formula map already knows them. A clock or a random number recomputes here, as its author's value then goes out on
// the wire.
export function execFunctionGroup(
    ctx: Context,
    changedCells: readonly FormulaCell[],
    formulasAt: readonly FormulaCell[] = [],
): void {
    const formulaCellInfoMap = warmFormulaCellInfoMap(ctx);
    const { dependencyIndex, engine } = ctx.formulaCache;
    const formulas = formulasAt.flatMap(({ r, c, id }) => formulaCellInfoMap[`r${r}c${c}i${id}`] ?? []);
    const runList = affectedFormulas({ formulaCellInfoMap, dependencyIndex }, changedCells, formulas);
    if (runList.length === 0) return;

    // Reading cells through immer drafts is slow, so the pass reads a plain view it can't write.
    const snapshot = snapshotContext(ctx);
    const results = evaluateFormulas(runList, snapshot.sheets, engine, false);

    // Most recomputed formulas land on their previous value, and a draft write is what immer's finalize pays for.
    for (const { r, c, id, formula, result } of results) {
        const idx = getSheetIndex(snapshot, id);
        // A deleted sheet's formula-map entries linger until the next rebuild; this skip makes them harmless.
        if (idx == null) continue;
        const before = snapshot.sheets[idx].data?.[r]?.[c];
        if (before != null && before.v === result.value) continue;
        const { data } = ctx.sheets[idx];
        if (data != null) setCellValue(ctx, r, c, data, { v: result.value, f: formula });
    }
}

// What a batch's sheet, row or column ops affect, computed as every other reader computes it, once all of it applied.
// The formula map it builds is the one the next edit uses.
export function recomputeAfterOps(ctx: Context, ops: readonly Op[]): void {
    const seeds = seedsOf(ops);
    if (!seeds) return;
    warmFormulaCellInfoMap(ctx);
    const { sheets } = snapshotContext(ctx);
    const next = recomputeAfter(sheets, seeds, { engine: ctx.formulaCache.engine });
    for (const [i, { data }] of next.entries()) {
        if (data !== sheets[i].data) ctx.sheets[i].data = data;
    }
}
