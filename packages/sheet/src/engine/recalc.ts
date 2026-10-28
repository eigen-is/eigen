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
import { inlineNames } from './formula-shift';
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
            // Our result is unreliable when it is an error, or when the formula uses a name the engine can't resolve.
            // It never overwrites a cached value that is no error, because that value is Excel's. A function Excel has
            // and the engine lacks is such an error, even inside IFERROR. Skipping the execFunctionGlobalData seed too
            // makes the formulas downstream read the cached value. A cell with no cached value still shows the error.
            const unreliable = () => result.type === 'error' || usesUnknownName(engine, info.calc_funcStr);
            if (hasNonErrorCachedValue(existing) && unreliable()) continue;
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
function extractDependencies(g: GraphCtx, formula: string, sheetId: string, data: CellMatrix): FormulaDependency[] {
    const upper = formula.toUpperCase();
    const buildsReference = upper.includes('INDIRECT(') || upper.includes('OFFSET(') || upper.includes('INDEX(');

    const dependencies: FormulaDependency[] = [];
    if (buildsReference) {
        isFunctionRange(formula, (reference: string) => {
            const range = resolveCellRange(g.sheets, g.cellTextToIndexList, reference.trim(), sheetId, data);
            if (range != null) {
                dependencies.push(range);
            }
        });
    } else {
        for (const token of tokenize(formula)) {
            if (token.length <= 1) {
                continue;
            }

            if (!iscelldata(token)) {
                continue;
            }

            const range = resolveCellRange(g.sheets, g.cellTextToIndexList, token.trim(), sheetId, data);
            if (range == null) {
                continue;
            }

            dependencies.push(range);
        }
    }

    return dependencies;
}

const OPERATORS = /==|!=|<>|<=|>=|[,()=+-/*%&^><]/;

// Splits a formula at its operators, where a split on the operators alone would cut a quoted sheet name such as
// '1-2' or a string. A double-quoted string is one token. A single-quoted sheet name is one token with the reference
// after it, so ='1-2'!A1+5 gives '1-2'!A1 and 5.
function tokenize(formula: string): string[] {
    let tokenStart = 0;
    let singleQuoteStart = -1;
    let doubleQuoteStart = -1;
    const tokens: string[] = [];
    // The index in tokens of each single-quoted sheet name.
    const sheetNameTokens: number[] = [];
    for (let j = 0; j < formula.length; j += 1) {
        const char = formula.charAt(j);
        if (char === "'" && doubleQuoteStart === -1) {
            if (singleQuoteStart === -1) {
                if (tokenStart !== j) {
                    tokens.push(...formula.substring(tokenStart, j).split(OPERATORS));
                }
                singleQuoteStart = j;
                tokenStart = j;
            } else {
                // Two quotes in a row are an escaped quote inside the name.
                if (j < formula.length - 1 && formula.charAt(j + 1) === "'") {
                    j += 1;
                } else {
                    tokenStart = j + 1;
                    tokens.push(formula.substring(singleQuoteStart, tokenStart));
                    sheetNameTokens.push(tokens.length - 1);
                    singleQuoteStart = -1;
                }
            }
        } else if (char === '"' && singleQuoteStart === -1) {
            if (doubleQuoteStart === -1) {
                if (tokenStart !== j) {
                    tokens.push(...formula.substring(tokenStart, j).split(OPERATORS));
                }
                doubleQuoteStart = j;
                tokenStart = j;
            } else {
                if (j < formula.length - 1 && formula.charAt(j + 1) === '"') {
                    j += 1;
                } else {
                    tokenStart = j + 1;
                    tokens.push(formula.substring(doubleQuoteStart, tokenStart));
                    doubleQuoteStart = -1;
                }
            }
        }
    }
    if (tokenStart !== formula.length) {
        tokens.push(...formula.substring(tokenStart).split(OPERATORS));
    }
    // Glue each sheet name to the token after it, its `!A1`. Back to front, so the splices don't move the indexes
    // still to come.
    for (let k = sheetNameTokens.length - 1; k >= 0; k -= 1) {
        const index = sheetNameTokens[k];
        if (index !== tokens.length - 1) {
            tokens[index] += tokens[index + 1];
            tokens.splice(index + 1, 1);
        }
    }
    return tokens;
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
