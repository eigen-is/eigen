// The server's recalc of a workbook nobody computed, such as an xlsx import whose recalc failed. recalcSheets takes
// the replayed sheets, orders their formula cells through the dependency graph and writes each cell's computed value
// and display string. A workbook the editor computed is marked computed, and sheetsNeedRecalc lets it skip this.

import type { Cell, CellMatrix, Sheet } from '@workspace/lib/sheets';
import { createArrayResolver } from './cell-resolver';
import { celldataToData, dataToCelldata } from './celldata';
import { gridSize } from './defaults';
import { getCalculationOrder } from './dependency-graph';
import { cellsOf, DependencyIndex, dependencyBlocks } from './dependency-index';
import { booleanDisplay, numberDisplay } from './format';
import { FormulaEngine, isFormula } from './formula-engine';
import { iscelldata, isFunctionRange, resolveCellRange } from './formula-utils';
import type {
    CalcChainEntry,
    EvaluationResult,
    FormulaCellInfoMap,
    FormulaDependency,
    SheetWithCalcChain,
} from './types';

// A sheet's dense `data`, by id, which the ported graph builder reads where the editor reads its Context.
type WorkingSheet = { sheet: Sheet; id: string; name: string; data: CellMatrix };

type GraphCtx = {
    sheets: WorkingSheet[];
    indexById: Map<string, number>;
    // Resolved references, as the editor's formulaCache keeps them: by the reference's text for one into another
    // sheet, by `${text}_${sheetId}` for one into the formula's own.
    cellTextToIndexList: Record<string, FormulaDependency>;
};

type Extent = { rows: number; columns: number };

// A workbook needs the server's recalc when a sheet has formula cells but no calcChain, which is true only for an
// import whose recalc failed. The editor's flush and the import's recalc both write a calcChain, so the read path
// pays nothing.
export function sheetsNeedRecalc(sheets: SheetWithCalcChain[]): boolean {
    for (const sheet of sheets) {
        // recalcSheets skips a sheet without an id, so one must not arm the gate, or every read runs the pass for nothing.
        if (!sheet.id) continue;
        const { calcChain } = sheet;
        if (Array.isArray(calcChain) && calcChain.length > 0) {
            continue;
        }
        if (sheetHasFormula(sheet)) {
            return true;
        }
    }
    return false;
}

// Uses the isFormula check of the pass, so the gate and the pass agree on what a formula cell is: a stray `f` that
// doesn't start with `=` can't fire the gate on every read.
function sheetHasFormula(sheet: Sheet): boolean {
    if (sheet.data) {
        for (const row of sheet.data) {
            if (!row) continue;
            for (const cell of row) {
                if (cell?.f != null && isFormula(cell.f)) return true;
            }
        }
    }
    if (sheet.celldata) {
        for (const entry of sheet.celldata) {
            if (entry.v?.f != null && isFormula(entry.v.f)) return true;
        }
    }
    return false;
}

// `maxDependencyBlocks` bounds what the formulas' ranges cost the dependency index (dependencyBlocks), and
// `maxCellsRead` what their evaluation reads (each range read, cut to its sheet, costs its cells): past either the
// recalc throws before the work, so many ranges over a large sheet can't cost minutes and gigabytes. The server passes
// both for an untrusted workbook; without them there is no bound.
export function recalcSheets(
    sheets: Sheet[],
    { maxDependencyBlocks = Number.POSITIVE_INFINITY, maxCellsRead = Number.POSITIVE_INFINITY } = {},
): Sheet[] {
    // 1. Materialize each sheet's dense data, by id.
    const working: WorkingSheet[] = [];
    const indexById = new Map<string, number>();
    for (const sheet of sheets) {
        if (!sheet.id) continue;
        indexById.set(sheet.id, working.length);
        working.push({ sheet, id: sheet.id, name: sheet.name, data: ensureWorkingData(sheet) });
    }

    const g: GraphCtx = { sheets: working, indexById, cellTextToIndexList: {} };
    const extents = new Map<string, Extent>();
    for (const w of working) {
        let columns = 0;
        for (const row of w.data) columns = Math.max(columns, row?.length ?? 0);
        extents.set(w.id, { rows: w.data.length, columns });
    }

    // 2. Find the formula cells by scanning the data, never trusting calcChain, and index the ranges each one reads.
    const infoMap: FormulaCellInfoMap = {};
    const depIndex = new DependencyIndex();
    let blocks = 0;
    const calcChainBySheet = new Map<string, CalcChainEntry[]>();
    for (const w of working) {
        const chain: CalcChainEntry[] = [];
        calcChainBySheet.set(w.id, chain);
        for (let r = 0; r < w.data.length; r += 1) {
            const rowArr = w.data[r];
            if (!rowArr) continue;
            for (let c = 0; c < rowArr.length; c += 1) {
                const f = rowArr[c]?.f;
                if (typeof f !== 'string' || !isFormula(f)) continue;
                chain.push({ r, c, id: w.id });
                const key = `r${r}c${c}i${w.id}`;
                let deps: FormulaDependency[];
                try {
                    deps = extractDependencies(g, f, w.id, w.data);
                } catch {
                    // A malformed formula must not stop the scan. It reads nothing here and still evaluates below.
                    deps = [];
                }
                infoMap[key] = {
                    formulaDependency: deps,
                    calc_funcStr: f,
                    key,
                    r,
                    c,
                    id: w.id,
                    parents: {},
                    children: {},
                    color: 'w',
                };
                const indexed = deps.flatMap((dep) => withinSheet(dep, extents) ?? []);
                blocks += dependencyBlocks(indexed);
                if (blocks > maxDependencyBlocks) throw new RangeError('Formula ranges past the dependency budget');
                depIndex.set(key, indexed);
            }
        }
    }

    const allInfos = Object.values(infoMap);
    if (allInfos.length === 0) {
        // No formulas: still write celldata and an empty calcChain, so the read gate sees the doc as computed.
        return finalize(working, sheets, calcChainBySheet);
    }

    // 3. Link each formula to the formulas that read its cell: parents[key] means the formula at key reads this one.
    for (const info of allInfos) {
        for (const depKey of depIndex.dependentsOf(info.id, info.r, info.c)) {
            info.parents[depKey] = 1;
        }
    }

    // 4. Order them. A cycle neither throws nor hangs.
    const order = getCalculationOrder(allInfos, infoMap);

    // 5. Evaluate in order. A computed value reaches the formulas downstream through the engine's
    //    execFunctionGlobalData, which it reads before the resolver, and the resolver reads the matrices the pass writes.
    //    Volatiles keep their value. Each cell is guarded, so one poisoned formula never stops the pass.
    const engine = new FormulaEngine({ maxCellsRead });
    const resolver = createArrayResolver(
        working.map((w) => ({ id: w.id, name: w.name, data: w.data, calculationChain: [], dynamicArrayCompute: [] })),
    );
    // A read past the budget fails its formula, which the pass would carry on past: it stops at the next.
    const overRead = () => {
        if (engine.cellsRead > maxCellsRead) throw new RangeError('Formula ranges read past the cell budget');
    };
    for (const info of order) {
        overRead();
        if (isVolatileFormula(info.calc_funcStr)) continue;
        try {
            const result = engine.evaluate(info.calc_funcStr, info.id, resolver);
            const idx = indexById.get(info.id);
            if (idx == null) continue;
            const rowArr = working[idx].data[info.r];
            if (!rowArr) continue;
            const existing = rowArr[info.c];
            if (existing == null) continue;
            // An error never overwrites a cached value that is no error, because that value is Excel's. A function
            // Excel has and the engine lacks is such an error, even inside IFERROR. Skipping the execFunctionGlobalData
            // seed too makes the formulas downstream read the cached value. A cell with no cached value still shows
            // the error.
            if (result.type === 'error' && hasNonErrorCachedValue(existing)) continue;
            engine.state.execFunctionGlobalData[`${info.r}_${info.c}_${info.id}`] = { v: result.value };
            // The matrix may hold the input snapshot's frozen cells, so write a copy.
            const cell: Cell = { ...existing };
            writeCellValue(cell, result);
            rowArr[info.c] = cell;
        } catch {
            // An unexpected throw, such as ERROR_REF for a bad sheet name, leaves the cached value.
        }
    }
    overRead();

    // 6. Write celldata from the computed data, and stamp each sheet's calcChain.
    return finalize(working, sheets, calcChainBySheet);
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

// The ranges a formula reads, as setFormulaCellInfo finds them in the editor. An INDIRECT, OFFSET or INDEX call goes
// through isFunctionRange; any other formula runs the same quote-aware tokenizer.
function extractDependencies(
    g: GraphCtx,
    calc_funcStr: string,
    sheetId: string,
    data: CellMatrix,
): FormulaDependency[] {
    const txt1 = calc_funcStr.toUpperCase();
    const isOffsetFunc = txt1.indexOf('INDIRECT(') > -1 || txt1.indexOf('OFFSET(') > -1 || txt1.indexOf('INDEX(') > -1;

    const formulaDependency: FormulaDependency[] = [];
    if (isOffsetFunc) {
        isFunctionRange(calc_funcStr, (str_nb: string) => {
            const range = resolveCellRange(g.sheets, g.cellTextToIndexList, str_nb.trim(), sheetId, data);
            if (range != null) {
                formulaDependency.push(range);
            }
        });
    } else if (!(calc_funcStr.substring(0, 2) === '="' && calc_funcStr.substring(calc_funcStr.length - 1, 1) === '"')) {
        let point = 0;
        let squote = -1;
        let dquote = -1;
        const formulaTextArray: string[] = [];
        const sq_end_array: number[] = [];
        const calc_funcStr_length = calc_funcStr.length;
        for (let j = 0; j < calc_funcStr_length; j += 1) {
            const char = calc_funcStr.charAt(j);
            if (char === "'" && dquote === -1) {
                if (squote === -1) {
                    if (point !== j) {
                        formulaTextArray.push(
                            ...calc_funcStr.substring(point, j).split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
                        );
                    }
                    squote = j;
                    point = j;
                } else {
                    if (j < calc_funcStr_length - 1 && calc_funcStr.charAt(j + 1) === "'") {
                        j += 1;
                    } else {
                        point = j + 1;
                        formulaTextArray.push(calc_funcStr.substring(squote, point));
                        sq_end_array.push(formulaTextArray.length - 1);
                        squote = -1;
                    }
                }
            } else if (char === '"' && squote === -1) {
                if (dquote === -1) {
                    if (point !== j) {
                        formulaTextArray.push(
                            ...calc_funcStr.substring(point, j).split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
                        );
                    }
                    dquote = j;
                    point = j;
                } else {
                    if (j < calc_funcStr_length - 1 && calc_funcStr.charAt(j + 1) === '"') {
                        j += 1;
                    } else {
                        point = j + 1;
                        formulaTextArray.push(calc_funcStr.substring(dquote, point));
                        dquote = -1;
                    }
                }
            }
        }
        if (point !== calc_funcStr_length) {
            formulaTextArray.push(
                ...calc_funcStr.substring(point, calc_funcStr_length).split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
            );
        }
        for (let j = sq_end_array.length - 1; j >= 0; j -= 1) {
            if (sq_end_array[j] !== formulaTextArray.length - 1) {
                formulaTextArray[sq_end_array[j]] += formulaTextArray[sq_end_array[j] + 1];
                formulaTextArray.splice(sq_end_array[j] + 1, 1);
            }
        }

        for (let j = 0; j < formulaTextArray.length; j += 1) {
            const t = formulaTextArray[j];
            if (t.length <= 1) {
                continue;
            }

            if ((t.substring(0, 1) === '"' && t.substring(t.length - 1, 1) === '"') || !iscelldata(t)) {
                continue;
            }

            const range = resolveCellRange(g.sheets, g.cellTextToIndexList, t.trim(), sheetId, data);
            if (range == null) {
                continue;
            }

            formulaDependency.push(range);
        }
    }

    return formulaDependency;
}

// A dependency cut to the cells its sheet holds, null when it holds none. Only a formula cell is looked up in the
// index, and each lies in its sheet's data, so `SUM(A1:XFD1048576)` costs the blocks the sheet spans, not 16 million.
function withinSheet(dep: FormulaDependency, extents: Map<string, Extent>): FormulaDependency | null {
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

function isVolatileFormula(formula: string): boolean {
    return VOLATILE_RE.test(formula);
}

// True when a cell holds a value that is no error: not empty, not flagged `ct.t === 'e'`, and no `#` error string.
function hasNonErrorCachedValue(cell: Cell): boolean {
    if (cell.v == null || cell.ct?.t === 'e') {
        return false;
    }
    if (typeof cell.v === 'string' && cell.v.startsWith('#')) {
        return false;
    }
    return true;
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

function finalize(working: WorkingSheet[], sheets: Sheet[], calcChainBySheet: Map<string, CalcChainEntry[]>): Sheet[] {
    const byId = new Map<string, WorkingSheet>();
    for (const w of working) byId.set(w.id, w);

    return sheets.map((sheet) => {
        if (!sheet.id) return sheet;
        const w = byId.get(sheet.id);
        if (!w) return sheet;
        const out: SheetWithCalcChain = {
            ...sheet,
            data: w.data,
            celldata: dataToCelldata(w.data),
            calcChain: calcChainBySheet.get(sheet.id) ?? [],
        };
        return out;
    });
}
