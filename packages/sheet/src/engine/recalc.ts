// The server's recalc of a workbook nobody computed, such as an xlsx import whose recalc failed. recalcSheets takes
// the replayed sheets, orders their formula cells through the dependency graph and writes each cell's computed value
// and display string. A workbook the editor computed is stored as computed, so its readers skip this.
// extractDependencies, the walk that finds the cells a formula reads, builds the editor's formula map too.

import type { Cell, CellMatrix, Sheet } from '@workspace/lib/sheets';
import { createArrayResolver, withComputedValues } from './cell-resolver';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import { getCalculationOrder } from './dependency-graph';
import { cellsOf, DependencyIndex, dependencySlots } from './dependency-index';
import { booleanDisplay, numberDisplay } from './format';
import { FormulaEngine } from './formula-engine';
import { forEachRef, inlineNames } from './formula-shift';
import type { WalkContext } from './formula-utils';
import { isFormula, matrixWidth, resolveCellRange } from './formula-utils';
import { valueIsError } from './parser/error';
import { sheetFinder } from './parser/helper/cell';
import type { EvaluationResult, FormulaCellInfoMap, FormulaDependency } from './types';

// A sheet's dense `data`, by id, which the pass reads and writes.
type WorkingSheet = { id: string; name: string; data: CellMatrix };

type SheetExtent = { rows: number; columns: number };

// Four budgets bound what an untrusted workbook's formulas may cost, and past any of them the recalc throws before the
// work. `maxDependencySlots` bounds the slots the dependency index lists the formulas' ranges in (dependencySlots).
// `maxDependencyVisits` bounds the entries a lookup of each formula cell visits in the index (lookupVisits), which is
// the time the links take to weigh and to make. `maxDependencyEdges` bounds the links between the formulas, one for
// each formula and formula cell it reads, which is their memory. `maxCellsRead` bounds the cells their evaluation
// reads, each range read cut to its sheet. So many ranges over a large sheet can't cost minutes and gigabytes. The
// server passes all four, and without them there is no bound.
export function recalcSheets(
    sheets: readonly Sheet[],
    {
        maxDependencySlots = Number.POSITIVE_INFINITY,
        maxDependencyVisits = Number.POSITIVE_INFINITY,
        maxDependencyEdges = Number.POSITIVE_INFINITY,
        maxCellsRead = Number.POSITIVE_INFINITY,
    } = {},
): Sheet[] {
    // 1. Materialize each sheet's dense data, by id.
    const working: WorkingSheet[] = [];
    const byId = new Map<string, WorkingSheet>();
    for (const sheet of sheets) {
        if (!sheet.id) continue;
        const w = { id: sheet.id, name: sheet.name, data: ensureWorkingData(sheet) };
        byId.set(w.id, w);
        working.push(w);
    }

    const walk: WalkContext = { findSheet: sheetFinder(working), cellTextToIndexList: {} };
    const extents = new Map<string, SheetExtent>();
    for (const w of working) extents.set(w.id, { rows: w.data.length, columns: matrixWidth(w.data) });

    // 2. Find the formula cells by scanning the data, and index the ranges each one reads.
    const infoMap: FormulaCellInfoMap = {};
    const depIndex = new DependencyIndex();
    let slots = 0;
    for (const w of working) {
        for (let r = 0; r < w.data.length; r += 1) {
            const rowArr = w.data[r];
            if (!rowArr) continue;
            for (let c = 0; c < rowArr.length; c += 1) {
                const f = rowArr[c]?.f;
                if (!isFormula(f)) continue;
                const key = `r${r}c${c}i${w.id}`;
                const deps = extractDependencies(walk, f, w.id);
                infoMap[key] = {
                    formula: f,
                    key,
                    r,
                    c,
                    id: w.id,
                    dependents: [],
                };
                const indexed = deps.flatMap((dep) => withinSheet(dep, extents) ?? []);
                slots += dependencySlots(indexed);
                if (slots > maxDependencySlots) throw new RangeError('Formula ranges past the dependency budget');
                depIndex.set(key, indexed);
            }
        }
    }

    const allInfos = Object.values(infoMap);
    if (allInfos.length === 0) {
        return finalize(byId, sheets);
    }

    // 3. Weigh the links before making them. A whole column read by every formula in it costs the index one slot per
    //    formula, but the formulas square: 20,000 `=COUNT(A:A)` make 400 million links, minutes and gigabytes to build.
    //    The visits come first and cost nothing to count. A range near many formula cells that covers none makes no
    //    link but costs each of them a visit, so without them counting the links could take as long as making them.
    let visits = 0;
    for (const info of allInfos) {
        visits += depIndex.lookupVisits(info.id, info.r, info.c);
        if (visits > maxDependencyVisits) throw new RangeError('Formula references past the visit budget');
    }
    let edges = 0;
    for (const info of allInfos) {
        edges += depIndex.countDependents(info.id, info.r, info.c);
        if (edges > maxDependencyEdges) throw new RangeError('Formula references past the edge budget');
    }

    // 4. Link each formula to the formulas that read its cell.
    for (const info of allInfos) info.dependents = depIndex.dependentsOf(info.id, info.r, info.c);

    // 5. Order them. A cycle neither throws nor hangs.
    const order = getCalculationOrder(allInfos, infoMap);

    // 6. Evaluate in order. A computed value reaches the formulas downstream through `computed`, which the resolver reads
    //    before the matrices the pass writes, so they read the value without the type the cell keeps. Volatiles keep their
    //    value. Each cell is guarded, so one poisoned formula never stops the pass.
    const engine = new FormulaEngine({ maxCellsRead });
    const computed = new Map<string, Cell>();
    const resolver = withComputedValues(createArrayResolver(working), computed);
    // A read past the budget fails its formula, which the pass would carry on past: it stops at the next.
    const overRead = () => {
        if (engine.cellsRead > maxCellsRead) throw new RangeError('Formula ranges read past the cell budget');
    };
    for (const info of order) {
        overRead();
        if (VOLATILE_RE.test(info.formula)) continue;
        try {
            const result = engine.evaluate(info.formula, info.id, resolver);
            const rowArr = byId.get(info.id)?.data[info.r];
            if (!rowArr) continue;
            const existing = rowArr[info.c];
            if (existing == null) continue;
            // Our result is unreliable when it is an error, or when the formula uses a name the engine can't resolve.
            // It never overwrites a cached value that is no error, because that value is Excel's. A function Excel has
            // and the engine lacks is such an error, even inside IFERROR. Leaving it out of `computed` too makes the formulas
            // downstream read the cached value. A cell with no cached value still shows the error.
            const unreliable = () => result.type === 'error' || usesUnknownName(engine, info.formula);
            if (hasNonErrorCachedValue(existing) && unreliable()) continue;
            computed.set(`${info.r}_${info.c}_${info.id}`, { v: result.value });
            // The matrix may hold the input snapshot's frozen cells, so write a copy.
            const cell: Cell = { ...existing };
            writeCellValue(cell, result);
            rowArr[info.c] = cell;
        } catch {
            // An unexpected throw, such as ERROR_REF for a bad sheet name, leaves the cached value.
        }
    }
    overRead();

    // 7. Write celldata from the computed data.
    return finalize(byId, sheets);
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

// The ranges a formula reads, for the server's pass and the editor's formula map alike: every reference in its text,
// a function's arguments included, as Excel lists a cell's precedents. The reference INDEX returns lies inside its range
// argument, so that argument covers it. OFFSET and INDIRECT build a reference the text doesn't hold, which only matters
// once the engine can compute them.
export function extractDependencies(walk: WalkContext, formula: string, sheetId: string): FormulaDependency[] {
    const dependencies: FormulaDependency[] = [];
    forEachRef(formula, (reference) => {
        const range = resolveCellRange(walk, reference, sheetId);
        if (range != null) dependencies.push(range);
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

// A formula that reads the clock or a random number. The server keeps its cached value, as Excel does when it reads a
// closed file, so an export is the same every time. The check reads the formula text, so a string such as "NOW()"
// matches too, which only keeps a value that could have been recomputed. RANDBETWEEN comes before RAND, so the longer
// name wins.
const VOLATILE_RE = /\b(?:NOW|TODAY|RANDBETWEEN|RAND)\s*\(/i;

// A name as Excel spells one: a letter, `_` or `\` first, then letters, digits, `_`, `.`, `\` or `?`.
const NAME_RE = /^[\p{L}_\\][\p{L}\p{N}_.\\?]*$/u;

// True when the formula uses a name the engine can't resolve, such as a defined name the import couldn't inline. Its
// #NAME? is one IFERROR traps, and the fallback is not what Excel computed. inlineNames hands over every leaf that is
// no ref, such as a number or TRUE, and a name Excel reads past its last column (RhoCO2) where the engine reads a cell.
function usesUnknownName(engine: FormulaEngine, formula: string): boolean {
    let unknown = false;
    inlineNames(formula, (name) => {
        if (NAME_RE.test(name) && !engine.isKnownName(name)) unknown = true;
        return undefined;
    });
    return unknown;
}

// True when a cell holds a value that is no error: not empty, not flagged `ct.t === 'e'`, and no error string.
function hasNonErrorCachedValue(cell: Cell): boolean {
    if (cell.v == null || cell.ct?.t === 'e') return false;
    return typeof cell.v !== 'string' || !valueIsError(cell.v);
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

function finalize(byId: ReadonlyMap<string, WorkingSheet>, sheets: readonly Sheet[]): Sheet[] {
    return sheets.map((sheet) => {
        const w = sheet.id ? byId.get(sheet.id) : undefined;
        return w ? { ...sheet, data: w.data, celldata: dataToCelldata(w.data) } : sheet;
    });
}
