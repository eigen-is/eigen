// Computes stored formula values with no DOM, so every reader lands on the same ones. recalcSheets computes what an
// imported workbook holds no value or an error for and trusts the rest, which is Excel's. recomputeAfter runs on every
// reader after a batch with a sheet, row or column op, over the formula graph the reader holds, seeded with what the op
// can affect, such as the lines it opened or closed. evaluateFormulas is the pass both share with the editor's
// recompute of an edit.

import type { Cell, CellMatrix, Sheet } from '@workspace/lib/sheets';
import { computedKey, createArrayResolver, withComputedValues } from './cell-resolver';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import { writeFormulaResult } from './format';
import { FormulaEngine } from './formula-engine';
import type { CellAt, WorkingSheet } from './formula-graph';
import { FormulaGraph } from './formula-graph';
import { isFormula, matrixWidth } from './formula-utils';
import { valueIsError } from './parser/error';
import type { EvaluationResult, FormulaCellInfo } from './types';

type FormulaResult = CellAt & { formula: string; result: EvaluationResult };

// What bounds an untrusted workbook's formulas. Past any of them a pass throws before it evaluates. Without them there
// is no bound.
export type RecalcBudgets = {
    maxDependencySlots?: number;
    maxDependencyVisits?: number;
    maxDependencyEdges?: number;
    maxCellsRead?: number;
};

// What a structural op can affect: the readers of `cells` and of each cell on `lines`, and every formula `reads` picks.
export type RecomputeSeeds = {
    cells: readonly CellAt[];
    lines: readonly { id: string; type: 'row' | 'column'; line: number }[];
    reads: (formula: string) => boolean;
};

// An import's values are Excel's, so only a formula with no value of its own or a stored error is evaluated.
export function recalcSheets(sheets: readonly Sheet[], budgets: RecalcBudgets = {}): Sheet[] {
    const working = sheets.map((sheet) => ({ id: sheet.id, name: sheet.name, data: ensureWorkingData(sheet) }));
    const finish = () =>
        sheets.map((sheet, i) => ({ ...sheet, data: working[i].data, celldata: dataToCelldata(working[i].data) }));
    if (!working.some(({ data }) => data.some((row) => row?.some(lacksValue)))) return finish();

    const graph = new FormulaGraph(working, budgets);
    const order = graph
        .affected(working, [], Object.values(graph.formulas))
        .filter(({ id, r, c }) => lacksValue(working.find((w) => w.id === id)?.data[r]?.[c] ?? null));
    const engine = new FormulaEngine({ maxCellsRead: budgets.maxCellsRead });
    for (const { id, r, c, result } of evaluateFormulas(order, working, engine, true)) {
        const row = working.find((w) => w.id === id)?.data[r];
        const existing = row?.[c];
        if (!row || existing == null) continue;
        row[c] = withResult(existing, result);
    }
    return finish();
}

// The sheets with what the seeds affect computed again, over the formula graph the caller holds for them. Every reader
// runs it, so the values stay off the wire: a clock or a random number keeps its stored value, as every tab must agree.
// Past a budget the values stay as they were, and the op they follow stands.
export function recomputeAfter<S extends WorkingSheet>(
    sheets: S[],
    seeds: RecomputeSeeds,
    graph: FormulaGraph,
    engine: FormulaEngine,
): S[] {
    try {
        const chosen = Object.values(graph.formulas).filter(({ formula }) => seeds.reads(formula));
        const order = graph.affected(sheets, [...seeds.cells, ...cellsOnLines(sheets, seeds.lines)], chosen);
        return withResults(sheets, evaluateFormulas(order, sheets, engine, true));
    } catch (e) {
        if (e instanceof RangeError) return sheets;
        throw e;
    }
}

// Evaluates formulas in order, each value reaching the next through `computed`, which the resolver reads before the
// matrices, so a reader gets the value without the type the cell keeps. A cell the pass leaves alone is read as stored:
// a clock or a random number when `keepVolatile` says so, and whatever a formula holds, a number, an error or empty
// text, when this build can't evaluate its text.
export function evaluateFormulas(
    order: readonly FormulaCellInfo[],
    sheets: readonly WorkingSheet[],
    engine: FormulaEngine,
    keepVolatile: boolean,
): FormulaResult[] {
    const stored = createArrayResolver(sheets);
    const computed = new Map<string, Cell>();
    const resolver = withComputedValues(stored, computed);
    const results: FormulaResult[] = [];
    for (const { formula, r, c, id } of order) {
        // A read past the budget fails its formula, which the pass would carry on past: it stops at the next.
        engine.assertWithinCellBudget();
        if (keepVolatile && VOLATILE_RE.test(formula)) continue;
        try {
            const result = engine.evaluate(formula, id, resolver);
            const cell = stored.getCell(id, r, c);
            if (cell?.v != null && engine.cantEvaluate(formula, result)) continue;
            computed.set(computedKey(r, c, id), { v: result.value });
            results.push({ r, c, id, formula, result });
        } catch {
            // An unexpected throw, such as ERROR_REF for a bad sheet name, leaves the stored value.
        }
    }
    engine.assertWithinCellBudget();
    return results;
}

function cellsOnLines(sheets: readonly WorkingSheet[], lines: RecomputeSeeds['lines']): CellAt[] {
    const cells: CellAt[] = [];
    for (const { id, type, line } of lines) {
        const data = sheets.find((sheet) => sheet.id === id)?.data;
        if (!data || line < 0) continue;
        if (type === 'row') {
            if (line >= data.length) continue;
            const width = matrixWidth(data);
            for (let c = 0; c < width; c += 1) cells.push({ r: line, c, id });
        } else {
            for (let r = 0; r < data.length; r += 1) cells.push({ r, c: line, id });
        }
    }
    return cells;
}

// The sheets with each changed value written. The input may be frozen, and a sheet or row nothing changed keeps its
// object, so an op that changes no value writes nothing.
function withResults<S extends WorkingSheet>(sheets: S[], results: readonly FormulaResult[]): S[] {
    const written = new Map<string, CellMatrix>();
    const byId = new Map(sheets.map((sheet) => [sheet.id, sheet]));
    for (const { r, c, id, result } of results) {
        const before = byId.get(id)?.data;
        const existing = before?.[r]?.[c];
        if (!before || existing == null || existing.v === result.value) continue;
        let data = written.get(id);
        if (!data) {
            data = [...before];
            written.set(id, data);
        }
        if (data[r] === before[r]) data[r] = [...before[r]];
        data[r][c] = withResult(existing, result);
    }
    if (written.size === 0) return sheets;
    return sheets.map((sheet) => {
        const data = written.get(sheet.id);
        return data ? { ...sheet, data } : sheet;
    });
}

// A sheet's dense `data`, built from `celldata` when it has none, as the editor's initSheetData does: a resolver over
// empty `data` computes every formula to a blank. The rows are copies, so the write-back never changes a frozen input.
function ensureWorkingData(sheet: Sheet): CellMatrix {
    if (sheet.data) {
        return sheet.data.map((row) => (row ? row.slice() : row));
    }
    const { row, column } = gridSize(sheet);
    return celldataToData(sheet.celldata ?? [], row, column);
}

// RANDBETWEEN comes before RAND, so the longer name wins.
const VOLATILE_RE = /\b(?:NOW|TODAY|RANDBETWEEN|RAND)\s*\(/i;

// True for a formula an import computes: one holding nothing, an error flagged `ct.t === 'e'` or an error string.
function lacksValue(cell: Cell | null): boolean {
    if (!isFormula(cell?.f)) return false;
    if (cell?.v == null || cell.ct?.t === 'e') return true;
    return typeof cell.v === 'string' && valueIsError(cell.v);
}

// A copy of the cell with the result written, because the matrix may hold an input snapshot's frozen cells.
function withResult(existing: Cell, { value }: EvaluationResult): Cell {
    const cell: Cell = { ...existing, ct: existing.ct && { ...existing.ct } };
    writeFormulaResult(cell, value);
    return cell;
}
