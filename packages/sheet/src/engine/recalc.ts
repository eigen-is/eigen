// Computes stored formula values with no DOM, so every reader lands on the same ones. recalcSheets fills in what an
// imported workbook holds no value for and trusts the rest, which is Excel's. recomputeAfter runs on every reader after
// a batch with a sheet, row or column op, seeded with what the op can affect, such as the lines it opened or closed.
// affectedFormulas and evaluateFormulas are the walk and the pass they share with the editor's recompute of an edit.
// extractDependencies, the walk that finds the cells a formula reads, builds the editor's formula map too.

import type { Cell, CellMatrix, Sheet } from '@workspace/lib/sheets';
import { computedKey, createArrayResolver, withComputedValues } from './cell-resolver';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import { getCalculationOrder } from './dependency-graph';
import { cellsOf, DependencyIndex, dependencySlots } from './dependency-index';
import { booleanDisplay, formulaResultType, numberDisplay } from './format';
import { FormulaEngine } from './formula-engine';
import { walkFormulaRefs } from './formula-shift';
import type { WalkContext } from './formula-utils';
import { isFormula, matrixWidth, resolveCellRange } from './formula-utils';
import { valueIsError } from './parser/error';
import { sheetFinder } from './parser/helper/cell';
import type { EvaluationResult, FormulaCellInfo, FormulaCellInfoMap, FormulaDependency } from './types';

// A sheet's dense `data`, by id, which a pass reads and writes.
type WorkingSheet = { id: string; name: string; data?: CellMatrix | null };

type SheetExtent = { rows: number; columns: number };

type CellAt = Pick<FormulaCellInfo, 'r' | 'c' | 'id'>;

type FormulaGraph = { formulaCellInfoMap: FormulaCellInfoMap; dependencyIndex: DependencyIndex };

export type FormulaResult = CellAt & { formula: string; result: EvaluationResult };

// What bounds an untrusted workbook's formulas. Past any of them a pass throws before the work. Without them there is
// no bound.
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

    const { formulaCellInfoMap, dependencyIndex } = indexFormulas(working, budgets);
    const infos = Object.values(formulaCellInfoMap);
    for (const info of infos) info.dependents = dependencyIndex.dependentsOf(info.id, info.r, info.c);
    const order = getCalculationOrder(infos, formulaCellInfoMap).filter(({ id, r, c }) =>
        lacksValue(working.find((w) => w.id === id)?.data[r]?.[c] ?? null),
    );
    const engine = new FormulaEngine({ maxCellsRead: budgets.maxCellsRead });
    for (const { id, r, c, result } of evaluateFormulas(order, working, engine, true)) {
        const row = working.find((w) => w.id === id)?.data[r];
        const existing = row?.[c];
        if (!row || existing == null) continue;
        // The matrix may hold the input snapshot's frozen cells, so write a copy.
        const cell: Cell = { ...existing };
        writeCellValue(cell, result);
        row[c] = cell;
    }
    return finish();
}

// The sheets with what the seeds affect computed again. Every reader runs it, so the values stay off the wire: a clock
// or a random number keeps its stored value, as every tab must agree. The editor hands its engine, whose formula map it
// has built. Past a budget the values stay as they were, and the op they follow stands.
export function recomputeAfter<S extends WorkingSheet>(
    sheets: S[],
    seeds: RecomputeSeeds,
    { engine, budgets = {} }: { engine?: FormulaEngine; budgets?: RecalcBudgets } = {},
): S[] {
    try {
        const graph = engine?.state.formulaCellInfoMap
            ? { ...engine.state, formulaCellInfoMap: engine.state.formulaCellInfoMap }
            : indexFormulas(sheets, budgets);
        const chosen = Object.values(graph.formulaCellInfoMap).filter(({ formula }) => seeds.reads(formula));
        const order = affectedFormulas(graph, [...seeds.cells, ...cellsOnLines(sheets, seeds.lines)], chosen);
        const results = evaluateFormulas(
            order,
            sheets,
            engine ?? new FormulaEngine({ maxCellsRead: budgets.maxCellsRead }),
            true,
        );
        return withResults(sheets, results);
    } catch (e) {
        if (e instanceof RangeError) return sheets;
        throw e;
    }
}

// Every formula that reads one of `cells`, the `chosen` ones, and every formula reading those in turn, each after what
// it reads. Each one's `dependents` is refilled so the sort sees fresh edges.
export function affectedFormulas(
    { formulaCellInfoMap, dependencyIndex }: FormulaGraph,
    cells: readonly CellAt[],
    chosen: readonly FormulaCellInfo[] = [],
): FormulaCellInfo[] {
    const affected = new Set(chosen);
    for (const cell of cells) {
        for (const key of dependencyIndex.dependentsOf(cell.id, cell.r, cell.c)) {
            const info = formulaCellInfoMap[key];
            if (info != null) affected.add(info);
        }
    }
    for (const node of affected) {
        node.dependents = dependencyIndex.dependentsOf(node.id, node.r, node.c);
        for (const key of node.dependents) {
            const info = formulaCellInfoMap[key];
            if (info != null) affected.add(info);
        }
    }
    return getCalculationOrder([...affected], formulaCellInfoMap);
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

// Finds the formula cells by scanning the data, indexes the ranges each one reads, and weighs the links before anyone
// makes them, since formulas reading one whole column square into links. The visits come first and cost nothing to
// count, because a range that covers no formula cell makes no link but costs a visit.
function indexFormulas(
    sheets: readonly WorkingSheet[],
    {
        maxDependencySlots = Number.POSITIVE_INFINITY,
        maxDependencyVisits = Number.POSITIVE_INFINITY,
        maxDependencyEdges = Number.POSITIVE_INFINITY,
    }: RecalcBudgets,
): FormulaGraph {
    const walk: WalkContext = { findSheet: sheetFinder(sheets), cellTextToIndexList: {} };
    const extents = new Map<string, SheetExtent>();
    for (const { id, data } of sheets) {
        if (data) extents.set(id, { rows: data.length, columns: matrixWidth(data) });
    }
    const formulaCellInfoMap: FormulaCellInfoMap = {};
    const dependencyIndex = new DependencyIndex();
    let slots = 0;
    for (const { id, data } of sheets) {
        for (let r = 0; r < (data?.length ?? 0); r += 1) {
            const row = data?.[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c += 1) {
                const f = row[c]?.f;
                if (!isFormula(f)) continue;
                const key = `r${r}c${c}i${id}`;
                formulaCellInfoMap[key] = { formula: f, key, r, c, id, dependents: [] };
                const indexed = extractDependencies(walk, f, id).flatMap((dep) => withinSheet(dep, extents) ?? []);
                slots += dependencySlots(indexed);
                if (slots > maxDependencySlots) throw new RangeError('Formula ranges past the dependency budget');
                dependencyIndex.set(key, indexed);
            }
        }
    }
    const infos = Object.values(formulaCellInfoMap);
    let visits = 0;
    for (const { id, r, c } of infos) {
        visits += dependencyIndex.lookupVisits(id, r, c);
        if (visits > maxDependencyVisits) throw new RangeError('Formula references past the visit budget');
    }
    let edges = 0;
    for (const { id, r, c } of infos) {
        edges += dependencyIndex.countDependents(id, r, c);
        if (edges > maxDependencyEdges) throw new RangeError('Formula references past the edge budget');
    }
    return { formulaCellInfoMap, dependencyIndex };
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
        const cell: Cell = { ...existing };
        writeCellValue(cell, result);
        data[r][c] = cell;
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

// The ranges a formula reads: every reference in its text, as Excel lists a cell's precedents. The reference INDEX
// returns lies inside its range argument, so that argument covers it.
export function extractDependencies(walk: WalkContext, formula: string, sheetId: string): FormulaDependency[] {
    const dependencies: FormulaDependency[] = [];
    walkFormulaRefs(formula, (reference) => {
        const range = resolveCellRange(walk, reference, sheetId);
        if (range != null) dependencies.push(range);
        return reference;
    });
    return dependencies;
}

// A dependency cut to the cells its sheet holds, null when it holds none. Only a formula cell is looked up in the
// index, and each lies in its sheet's data, so `SUM(A1:XFD1048576)` costs what the sheet spans, not 16 million blocks.
function withinSheet(dep: FormulaDependency, extents: ReadonlyMap<string, SheetExtent>): FormulaDependency | null {
    const cells = cellsOf(dep);
    const extent = cells && extents.get(cells.sheetId);
    if (!cells || extent == null) return null;
    const r1 = Math.min(extent.rows - 1, cells.r1);
    const c1 = Math.min(extent.columns - 1, cells.c1);
    if (cells.r0 > r1 || cells.c0 > c1) return null;
    return { row: [cells.r0, r1], column: [cells.c0, c1], sheetId: cells.sheetId };
}

// RANDBETWEEN comes before RAND, so the longer name wins.
const VOLATILE_RE = /\b(?:NOW|TODAY|RANDBETWEEN|RAND)\s*\(/i;

// True for a formula an import computes: one holding nothing, an error flagged `ct.t === 'e'` or an error string.
function lacksValue(cell: Cell | null): boolean {
    if (!isFormula(cell?.f)) return false;
    if (cell?.v == null || cell.ct?.t === 'e') return true;
    return typeof cell.v === 'string' && valueIsError(cell.v);
}

// Writes a result as the editor's setCellValue does, where that is cheap: an error shows its sentinel and carries
// ct.t 'e', any other value its display string.
function writeCellValue(cell: Cell, result: EvaluationResult): void {
    if (result.type === 'error') {
        const sentinel = String(result.value);
        cell.v = sentinel;
        cell.m = sentinel;
        cell.ct = { ...(cell.ct ?? {}), t: 'e' };
        return;
    }

    cell.v = result.value;
    if (cell.ct) cell.ct = { ...cell.ct, t: formulaResultType(cell.ct.fa, result.value) };

    if (result.type === 'boolean') {
        cell.m = booleanDisplay(Boolean(result.value));
        return;
    }

    if (typeof result.value === 'number') {
        cell.m = numberDisplay(result.value, cell.ct?.fa);
        return;
    }

    cell.m = result.value == null ? '' : String(result.value);
}
