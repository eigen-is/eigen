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
import { isKnownFunction } from './parser/evaluate-by-operator/evaluate-by-operator';
import type {
    CalcChainEntry,
    EvaluationResult,
    FormulaCellInfoMap,
    FormulaDependency,
    SheetWithCalcChain,
} from './types';

// A formula that reads the wall clock / RNG. Frozen during server recalc so
// passive exports/search stay deterministic (neither Excel nor Sheets recompute
// a closed-file read). Detected on the formula text with a word boundary +
// call paren: `MYRAND(` misses (no `\b` between the two word
// chars `Y` and `R`), while a literal `"NOW()"` string arg still MATCHES — `\b`
// fires at the quote→`N` transition — so such a formula is frozen too. That
// over-match is harmless: freezing is the safe direction, keeping the last
// cached value rather than recomputing. RANDBETWEEN precedes RAND so the longer
// name wins.
const VOLATILE_RE = /\b(?:NOW|TODAY|RANDBETWEEN|RAND)\s*\(/i;

function isVolatileFormula(formula: string): boolean {
    return VOLATILE_RE.test(formula);
}

// A string or a quoted sheet name, whose text may read like a call. A doubled quote stands for one inside it.
const QUOTED_RE = /"(?:[^"]|"")*"|'(?:[^']|'')*'/g;
// A name the grammar reads as a function, because a `(` follows it.
const CALL_RE = /(?<![\w.])[A-Za-z_][\w.]*(?=\()/g;

// True when the formula calls a function the engine lacks, such as FILTER or LET. IFERROR traps the #NAME? that
// function gives, so the result is no error, yet it is not what Excel computed.
function callsUnknownFunction(formula: string): boolean {
    for (const [name] of formula.replace(QUOTED_RE, '""').matchAll(CALL_RE)) {
        if (!isKnownFunction(name)) return true;
    }
    return false;
}

// Materialized, id-keyed view the ported graph builder reads instead of a
// Context. `data` is always the dense matrix (never celldata).
type WorkingSheet = { sheet: Sheet; id: string; name: string; data: CellMatrix };

type GraphCtx = {
    sheets: WorkingSheet[];
    indexById: Map<string, number>;
    // Memoization of resolved cell references, mirroring
    // formulaCache.cellTextToIndexList. Keyed by the raw ref text (cross-sheet)
    // or `${text}_${sheetId}` (same-sheet).
    cellTextToIndexList: Record<string, FormulaDependency>;
};

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

// ── Write-back ─────────────────────────────────────────────────────────────────

// Mirrors the client's setCellValue where cheap: error sentinels carry ct.t 'e', the rest display like the editor.
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

// True when a cell already holds a usable computed value — a non-nil `v` that is
// neither a `'#…'` error string nor flagged `ct.t === 'e'`. An engine error must
// not overwrite such a value during recalc (see the evaluate loop).
function hasNonErrorCachedValue(cell: Cell): boolean {
    if (cell.v == null || cell.ct?.t === 'e') {
        return false;
    }
    if (typeof cell.v === 'string' && cell.v.startsWith('#')) {
        return false;
    }
    return true;
}

// ── Formula-cell discovery + read-path gate ────────────────────────────────────

// A doc needs server recalc when a sheet carries formula cells but no populated
// calcChain — true exactly for an import whose recalc failed.
// Editor-flushed snapshots (and docs recalc'd at import) carry calcChain, so the
// gate stays off and the read path pays nothing.
export function sheetsNeedRecalc(sheets: SheetWithCalcChain[]): boolean {
    for (const sheet of sheets) {
        // recalcSheets skips id-less sheets, so arming on one re-fires the pass on
        // every read for nothing.
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

// Uses the same isFormula check as discovery below, so the gate and the pass
// agree on what counts as a formula cell (a stray non-'=' `f` can't re-fire the
// gate on every read).
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

// ── Orchestration ──────────────────────────────────────────────────────────────

// Materialize a sheet's dense `data` from `celldata` when missing, mirroring the
// editor's initSheetData / replay's withMaterializedData (a resolver over null
// `data` recomputes everything to blanks). Rows are freshly
// sliced so writeback never mutates a frozen (immer) input matrix.
function ensureWorkingData(sheet: Sheet): CellMatrix {
    if (sheet.data) {
        return sheet.data.map((row) => (row ? row.slice() : row));
    }
    const { row, column } = gridSize(sheet);
    return celldataToData(sheet.celldata ?? [], row, column);
}

type Extent = { rows: number; columns: number };

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

// `maxDependencyBlocks` bounds what the formulas' ranges cost the dependency index (dependencyBlocks), and
// `maxCellsRead` what their evaluation reads (each range read, cut to its sheet, costs its cells): past either the
// recalc throws before the work, so many ranges over a large sheet can't cost minutes and gigabytes. The server passes
// both for an untrusted workbook; without them there is no bound.
export function recalcSheets(
    sheets: Sheet[],
    { maxDependencyBlocks = Number.POSITIVE_INFINITY, maxCellsRead = Number.POSITIVE_INFINITY } = {},
): Sheet[] {
    // 1. Materialize a working view: dense data per sheet, id/name index.
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

    // 2. Discover formula cells by scanning data (never trust calcChain)
    //    and build each cell's dependency ranges via the ported graph builder.
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
                    // A malformed formula must not abort discovery — treat it as
                    // dependency-free (it still evaluates, in-band, below).
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
        // No formulas: still return a normalized shape (synced celldata +
        // calcChain) so the read gate recognizes the doc as computed.
        return finalize(working, sheets, calcChainBySheet);
    }

    // 3. Build parent edges: parents[key] means "the formula at key depends on
    //    me" (dependency-graph.ts convention). dependentsOf returns the formulas
    //    reading this cell, i.e. exactly this cell's dependents.
    for (const info of allInfos) {
        for (const depKey of depIndex.dependentsOf(info.id, info.r, info.c)) {
            info.parents[depKey] = 1;
        }
    }

    // 4. Topological order (cycle-tolerant by construction — no throw, no hang).
    const order = getCalculationOrder(allInfos, infoMap);

    // 5. Evaluate in order. Freshly-computed values travel via the engine's
    //    execFunctionGlobalData cache (checked before the resolver), so a
    //    downstream cell reads its upstream result. Volatiles are frozen. Each
    //    cell is guarded so one poisoned formula never aborts the pass.
    const engine = new FormulaEngine({ maxCellsRead });
    // Resolver over the working sheets: mirrors createArrayResolver's persisted
    // shape but reads the live `data` matrices we mutate during the ordered pass.
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
            // Our result is unreliable when it is an error, or when the formula calls a function the engine lacks. It
            // never overwrites a cached value that is no error, because that value is Excel's. Skipping the
            // execFunctionGlobalData seed too makes the formulas downstream read the cached value. A cell with no
            // cached value still shows the error.
            const unreliable = result.type === 'error' || callsUnknownFunction(info.calc_funcStr);
            if (unreliable && hasNonErrorCachedValue(existing)) continue;
            engine.state.execFunctionGlobalData[`${info.r}_${info.c}_${info.id}`] = { v: result.value };
            // Clone before writing: the materialized matrix may reference the
            // input snapshot's (frozen) cell objects.
            const cell: Cell = { ...existing };
            writeCellValue(cell, result);
            rowArr[info.c] = cell;
        } catch {
            // Unexpected throw (e.g. ERROR_REF on a bad sheet name): leave the
            // cached value in place.
        }
    }
    overRead();

    // 6. Sync celldata from the computed data + stamp calcChain.
    return finalize(working, sheets, calcChainBySheet);
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
