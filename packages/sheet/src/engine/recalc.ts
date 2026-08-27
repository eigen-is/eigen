// Server-side full recalc of a workbook's formula cells (Option R).
//
// Turns a persisted `Sheet[]` (snapshot + replayed ops) into a `Sheet[]` whose
// formula cells carry engine-computed `v` and `m`. The single target population
// is docs the client never computed for us: xlsx-imported-never-opened files
// and crash/race divergence (see docs/SHEETS.md § Server-side recalc). Live-
// edited docs already persist fresh values as ops, so the read path gates this
// off for them via `sheetsNeedRecalc`.
//
// The dependency-graph builder is a faithful PORT of the state layer's
// `setFormulaCellInfo`/`getcellrange`/`isFunctionRange` (state/modules/
// formula-cache.ts + formula-exec.ts). The engine has zero state imports (hard
// boundary), so the logic is duplicated here over a plain `Sheet[]` instead of
// a `Context`. The INDIRECT/OFFSET/INDEX special-casing is preserved — a
// from-scratch extractor would mis-order those (audit Risk 8).

import type { Cell, CellMatrix, Sheet } from '@workspace/lib/sheets';
import { createArrayResolver } from './cell-resolver';
import { celldataToData, dataToCelldata } from './celldata';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT } from './defaults';
import { getCalculationOrder } from './dependency-graph';
import { DependencyIndex } from './dependency-index';
import { booleanDisplay, update } from './format';
import { FormulaEngine, isFormula } from './formula-engine';
import { calPostfixExpression, iscelldata, operatorjson, operatorPriority } from './formula-utils';
import type { CalcChainEntry, EvaluationResult, FormulaCellInfoMap, FormulaDependency } from './types';

// A formula that reads the wall clock / RNG. Frozen during server recalc so
// passive exports/search stay deterministic (neither Excel nor Sheets recompute
// a closed-file read — audit Q5/DP7b). Detected on the formula text with a
// word boundary + call paren: `MYRAND(` misses (no `\b` between the two word
// chars `Y` and `R`), while a literal `"NOW()"` string arg still MATCHES — `\b`
// fires at the quote→`N` transition — so such a formula is frozen too. That
// over-match is harmless: freezing is the safe direction, keeping the last
// cached value rather than recomputing. RANDBETWEEN precedes RAND so the longer
// name wins.
const VOLATILE_RE = /\b(?:NOW|TODAY|RANDBETWEEN|RAND)\s*\(/i;

function isVolatileFormula(formula: string): boolean {
    return VOLATILE_RE.test(formula);
}

// Ported from state's columnCharToIndex (state/utils). NOT engine's
// columnLabelToIndex: that returns -1 for '' where this returns NaN, and the
// range parser below distinguishes "no column part" (NaN → whole row) from
// "column A" via the NaN sentinel.
function columnCharToIndex(a: string): number {
    if (a == null || a.length === 0) {
        return NaN;
    }
    const str = a.toLowerCase().split('');
    const al = str.length;
    let numout = 0;
    for (let i = 0; i < al; i += 1) {
        const charnum = str[i].charCodeAt(0) - 96;
        numout += charnum * 26 ** (al - i - 1);
    }
    if (numout === 0) {
        return NaN;
    }
    return numout - 1;
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

function dataById(g: GraphCtx, id: string): CellMatrix | null {
    const idx = g.indexById.get(id);
    return idx == null ? null : g.sheets[idx].data;
}

// ── Ported dependency extraction (state/modules/formula-exec.ts) ───────────────

const simpleSheetName = '[A-Za-z0-9_À-ʯ]+';
const quotedSheetName = "'(?:(?!').|'')*'";
const sheetNameRegexp = `(${simpleSheetName}|${quotedSheetName})!`;
const rowColumnRegexp = `[$]?[A-Za-z]+[$]?[0-9]+`;
const rowColumnWithSheetName = `(?:${sheetNameRegexp})?(${rowColumnRegexp})`;
const LABEL_EXTRACT_REGEXP = new RegExp(`^${rowColumnWithSheetName}(?:[:]${rowColumnWithSheetName})?$`);

function addToCellIndexList(g: GraphCtx, txt: string, infoObj: FormulaDependency | null): void {
    if (txt == null || txt.length === 0 || infoObj == null) {
        return;
    }
    if (txt.indexOf('!') > -1) {
        txt = txt.replace(/\\'/g, "'").replace(/''/g, "'");
        g.cellTextToIndexList[txt] = infoObj;
    } else {
        g.cellTextToIndexList[`${txt}_${infoObj.sheetId}`] = infoObj;
    }
}

// Port of getcellrange: resolve a single cell / range reference into a
// FormulaDependency. `formulaId` is always the formula cell's sheet id (state
// passes formulaCell.id in every call), so the ctx.currentSheetId fallback is
// dropped. `data` is that sheet's matrix, consulted for same-sheet whole-range
// bounds.
function getcellrange(g: GraphCtx, txt: string, formulaId: string, data: CellMatrix | null): FormulaDependency | null {
    if (txt == null || txt.length === 0) {
        return null;
    }
    const flowdata = data ?? dataById(g, formulaId);

    let rangetxt = '';
    let sheetId: string | undefined;
    let sheetdata: CellMatrix | null | undefined = null;

    if (txt.indexOf('!') > -1) {
        if (txt in g.cellTextToIndexList) {
            return g.cellTextToIndexList[txt];
        }

        const matchRes = txt.match(LABEL_EXTRACT_REGEXP);
        if (matchRes == null) {
            return null;
        }
        const [, sheettxt1, starttxt1, sheettxt2, starttxt2] = matchRes;
        if (sheettxt2 != null && sheettxt1 !== sheettxt2) {
            return null;
        }
        rangetxt = starttxt2 ? `${starttxt1}:${starttxt2}` : starttxt1;
        const sheettxt = sheettxt1.replace(/^'|'$/g, '').replace(/\\'/g, "'").replace(/''/g, "'");

        for (const w of g.sheets) {
            if (sheettxt === w.name) {
                sheetId = w.id;
                sheetdata = w.data;
                break;
            }
        }
    } else {
        if (`${txt}_${formulaId}` in g.cellTextToIndexList) {
            return g.cellTextToIndexList[`${txt}_${formulaId}`];
        }
        const index = g.indexById.get(formulaId);
        if (index == null) {
            return null;
        }
        sheetId = g.sheets[index].id;
        sheetdata = flowdata;
        rangetxt = txt;
    }

    if (sheetdata == null) {
        return null;
    }

    if (rangetxt.indexOf(':') === -1) {
        const row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
        const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));

        if (!Number.isNaN(row) && !Number.isNaN(col)) {
            const item: FormulaDependency = { row: [row, row], column: [col, col], sheetId };
            addToCellIndexList(g, txt, item);
            return item;
        }
        return null;
    }

    const rangetxtArr = rangetxt.split(':');
    const row: [number, number] = [-1, -1];
    const col: [number, number] = [-1, -1];
    row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ''), 10) - 1;
    row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ''), 10) - 1;
    if (Number.isNaN(row[0])) {
        row[0] = 0;
    }
    if (Number.isNaN(row[1])) {
        row[1] = sheetdata.length - 1;
    }
    if (row[0] > row[1]) {
        return null;
    }
    col[0] = columnCharToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ''));
    col[1] = columnCharToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ''));
    if (Number.isNaN(col[0])) {
        col[0] = 0;
    }
    if (Number.isNaN(col[1])) {
        col[1] = sheetdata[0].length - 1;
    }
    if (col[0] > col[1]) {
        return null;
    }

    const item: FormulaDependency = { row, column: col, sheetId };
    addToCellIndexList(g, txt, item);
    return item;
}

// Port of checkSpecialFunctionRange: fires the range callback for the quoted
// range argument of an INDIRECT/OFFSET/INDEX call once isFunctionRange has
// rewritten the formula into the luckysheet_* special-reference form. The
// state version also stamped ctx.calculateSheetId (a UI side-effect) — dropped.
function checkSpecialFunctionRange(function_str: string, cellRangeFunction: (str: string) => void): void {
    if (
        function_str.substring(0, 30) === 'luckysheet_getSpecialReference' ||
        function_str.substring(0, 20) === 'luckysheet_function.'
    ) {
        if (function_str.substring(0, 20) === 'luckysheet_function.') {
            let funcName = function_str.split('.')[1];
            if (funcName != null) {
                funcName = funcName.toUpperCase();
                if (funcName !== 'INDIRECT' && funcName !== 'OFFSET' && funcName !== 'INDEX') {
                    return;
                }
            }
        }

        const commaParts = function_str.split(',');
        const quoted = commaParts[commaParts.length - 1].split("'");
        if (quoted.length < 2) return;

        const str_nb = quoted[1].trim();
        if (iscelldata(str_nb)) {
            cellRangeFunction(str_nb);
        }
    }
}

// Port of isFunctionRange: transforms a formula (fragment) into the postfix
// luckysheet_* form the state layer used, detecting special references along
// the way. Only its side-effect (invoking cellRangeFunction via
// checkSpecialFunctionRange on each INDIRECT/OFFSET/INDEX range) matters to us;
// the returned string is used only for the recursive assembly. ctx is not
// needed — the callback closes over the GraphCtx.
function isFunctionRange(txt: string, cellRangeFunction: (str: string) => void): string {
    if (txt.substring(0, 1) === '=') {
        txt = txt.substring(1);
    }

    const funcstack = txt.split('');
    let i = 0;
    let str = '';
    let function_str = '';

    const matchConfig = { bracket: 0, comma: 0, squote: 0, dquote: 0, compare: 0, braces: 0 };

    const cal1: string[] = [];
    const cal2: string[] = [];
    const bracket: number[] = [];
    while (i < funcstack.length) {
        const s = funcstack[i];

        if (s === '(' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            if (str.length > 0 && bracket.length === 0) {
                str = str.toUpperCase();
                if (str.indexOf(':') > -1) {
                    const funcArray = str.split(':');
                    function_str += `luckysheet_getSpecialReference(true,'${funcArray[0]
                        .trim()
                        .replace(/'/g, "\\'")}', luckysheet_function.${funcArray[1]}.f(#lucky#`;
                } else {
                    function_str += `luckysheet_function.${str}.f(`;
                }
                bracket.push(1);
                str = '';
            } else if (bracket.length === 0) {
                function_str += '(';
                bracket.push(0);
                str = '';
            } else {
                bracket.push(0);
                str += s;
            }
        } else if (s === ')' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            bracket.pop();

            if (bracket.length === 0) {
                let functionS = isFunctionRange(str, cellRangeFunction);
                if (functionS.indexOf('#lucky#') > -1) {
                    functionS = `${functionS.replace(/#lucky#/g, '')})`;
                }
                function_str += `${functionS})`;
                str = '';
            } else {
                str += s;
            }
        } else if (s === '{' && matchConfig.squote === 0 && matchConfig.dquote === 0) {
            str += '{';
            matchConfig.braces += 1;
        } else if (s === '}' && matchConfig.squote === 0 && matchConfig.dquote === 0) {
            str += '}';
            matchConfig.braces -= 1;
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                if (i < funcstack.length - 1 && funcstack[i + 1] === '"') {
                    i += 1;
                    str += '\x7F';
                } else {
                    matchConfig.dquote -= 1;
                    str += '"';
                }
            } else {
                matchConfig.dquote += 1;
                str += '"';
            }
        } else if (s === "'" && matchConfig.dquote === 0) {
            str += "'";

            if (matchConfig.squote > 0) {
                if (i < funcstack.length - 1 && funcstack[i + 1] === "'") {
                    i += 1;
                    str += "'";
                } else {
                    matchConfig.squote -= 1;
                }
            } else {
                matchConfig.squote += 1;
            }
        } else if (s === ',' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            if (bracket.length <= 1) {
                let functionS = isFunctionRange(str, cellRangeFunction);
                if (functionS.indexOf('#lucky#') > -1) {
                    functionS = `${functionS.replace(/#lucky#/g, '')})`;
                }
                function_str += `${functionS},`;
                str = '';
            } else {
                str += ',';
            }
        } else if (
            s in operatorjson &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            let s_next = '';
            const op = operatorPriority;

            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            if (s + s_next in operatorjson) {
                if (bracket.length === 0) {
                    if (str.trim().length > 0) {
                        cal2.unshift(isFunctionRange(str.trim(), cellRangeFunction));
                    } else if (function_str.trim().length > 0) {
                        cal2.unshift(function_str.trim());
                    }

                    if (cal1[0] in operatorjson) {
                        let stackCeilPri = op[cal1[0]];

                        while (cal1.length > 0 && stackCeilPri != null) {
                            cal2.unshift(cal1.shift()!);
                            stackCeilPri = op[cal1[0]];
                        }
                    }

                    cal1.unshift(s + s_next);

                    function_str = '';
                    str = '';
                } else {
                    str += s + s_next;
                }

                i += 1;
            } else {
                if (bracket.length === 0) {
                    if (str.trim().length > 0) {
                        cal2.unshift(isFunctionRange(str.trim(), cellRangeFunction));
                    } else if (function_str.trim().length > 0) {
                        cal2.unshift(function_str.trim());
                    }

                    if (cal1[0] in operatorjson) {
                        let stackCeilPri = op[cal1[0]];
                        stackCeilPri = stackCeilPri == null ? 1000 : stackCeilPri;

                        let sPri = op[s];
                        sPri = sPri == null ? 1000 : sPri;

                        while (cal1.length > 0 && sPri >= stackCeilPri) {
                            cal2.unshift(cal1.shift()!);

                            stackCeilPri = op[cal1[0]];
                            stackCeilPri = stackCeilPri == null ? 1000 : stackCeilPri;
                        }
                    }

                    cal1.unshift(s);

                    function_str = '';
                    str = '';
                } else {
                    str += s;
                }
            }
        } else {
            if (matchConfig.dquote === 0 && matchConfig.squote === 0) {
                str += s.trim();
            } else {
                str += s;
            }
        }

        if (i === funcstack.length - 1) {
            let endstr = '';
            let str_nb = str.trim().replace(/'/g, "\\'");
            if (iscelldata(str_nb) && str_nb.substring(0, 1) !== ':') {
                endstr = `luckysheet_getcelldata('${str_nb}')`;
            } else if (str_nb.substring(0, 1) === ':') {
                str_nb = str_nb.substring(1);
                if (iscelldata(str_nb)) {
                    endstr = `luckysheet_getSpecialReference(false,${function_str},'${str_nb}')`;
                }
            } else {
                str = str.trim();

                const regx = /{.*?}/;
                if (regx.test(str) && str.substring(0, 1) !== '"' && str.substring(str.length - 1, 1) !== '"') {
                    const arraytxt = regx.exec(str)?.[0];
                    const arraystart = str.search(regx);

                    if (arraystart > 0) {
                        endstr += str.substring(0, arraystart);
                    }

                    endstr += `luckysheet_getarraydata('${arraytxt}')`;

                    if (arraytxt != null && arraystart + arraytxt.length < str.length) {
                        endstr += str.substring(arraystart + arraytxt.length, str.length);
                    }
                } else {
                    endstr = str;
                }
            }

            if (endstr.length > 0) {
                cal2.unshift(endstr);
            }

            if (cal1.length > 0) {
                if (function_str.length > 0) {
                    cal2.unshift(function_str);
                    function_str = '';
                }

                while (cal1.length > 0) {
                    cal2.unshift(cal1.shift()!);
                }
            }

            if (cal2.length > 0) {
                function_str = calPostfixExpression(cal2);
            } else {
                function_str += endstr;
            }
        }

        i += 1;
    }
    checkSpecialFunctionRange(function_str, cellRangeFunction);
    return function_str;
}

// Port of setFormulaCellInfo's dependency-extraction body (state/modules/
// formula-cache.ts:224-324). Returns the ranges a formula reads. The
// INDIRECT/OFFSET/INDEX branch routes through the ported isFunctionRange; the
// normal branch runs the same quote-aware tokenizer.
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
            const range = getcellrange(g, str_nb.trim(), sheetId, data);
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

            const range = getcellrange(g, t.trim(), sheetId, data);
            if (range == null) {
                continue;
            }

            formulaDependency.push(range);
        }
    }

    return formulaDependency;
}

// ── Write-back (DP6a) ──────────────────────────────────────────────────────────

// Derive `m` (display) + `v` from an evaluation result, mirroring the client's
// setCellValue where it is cheap to: error sentinels become `v = m = '#…'` with
// `ct.t = 'e'`; booleans render TRUE/FALSE; a cell carrying a usable format mask
// gets `m = update(ct.fa, v)`; everything else falls back to `String(v)`. The
// mask-less numeric/date inference the client does via `genarate` is accepted
// as small drift (audit DP6a) rather than re-coupling the format decision tree.
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
        // `result.type` does not narrow `value`; the previous inline ternary read it
        // for truth the same way.
        cell.m = booleanDisplay(Boolean(result.value));
        return;
    }

    // A numeric result whose cell carries a real format mask renders through it
    // (currency/percent/date/custom). numfmt always yields a display string.
    const fa = cell.ct?.fa;
    if (fa != null && fa !== 'General' && typeof result.value === 'number') {
        cell.m = update(fa, result.value);
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
// calcChain — true exactly for imported-never-opened / crash-diverged docs.
// Editor-flushed snapshots (and docs recalc'd at import) carry calcChain, so the
// gate stays off and the read path pays nothing (audit DP1b/DP4b).
export function sheetsNeedRecalc(sheets: Sheet[]): boolean {
    for (const sheet of sheets) {
        const calcChain = (sheet as SheetWithCalcChain).calcChain;
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

// calcChain is an editor-only excess field the wire Sheet type omits; recalc
// writes it so the read gate recognises a computed doc (audit DP4).
type SheetWithCalcChain = Sheet & { calcChain?: CalcChainEntry[] };

// ── Orchestration ──────────────────────────────────────────────────────────────

// Materialize a sheet's dense `data` from `celldata` when missing, mirroring the
// editor's initSheetData / replay's withMaterializedData (a resolver over null
// `data` recomputes everything to blanks — audit Risk 2). Rows are freshly
// sliced so writeback never mutates a frozen (immer) input matrix.
function ensureWorkingData(sheet: Sheet): CellMatrix {
    if (sheet.data) {
        return sheet.data.map((row) => (row ? row.slice() : row));
    }
    const row = sheet.row != null && sheet.row > 0 ? sheet.row : DEFAULT_SHEET_ROW_COUNT;
    const column = sheet.column != null && sheet.column > 0 ? sheet.column : DEFAULT_SHEET_COLUMN_COUNT;
    return celldataToData(sheet.celldata ?? [], row, column);
}

export function recalcSheets(sheets: Sheet[]): Sheet[] {
    // 1. Materialize a working view: dense data per sheet, id/name index.
    const working: WorkingSheet[] = [];
    const indexById = new Map<string, number>();
    for (const sheet of sheets) {
        if (!sheet.id) continue;
        indexById.set(sheet.id, working.length);
        working.push({ sheet, id: sheet.id, name: sheet.name, data: ensureWorkingData(sheet) });
    }

    const g: GraphCtx = { sheets: working, indexById, cellTextToIndexList: {} };

    // 2. Discover formula cells by scanning data (never trust calcChain — DP4b)
    //    and build each cell's dependency ranges via the ported graph builder.
    const infoMap: FormulaCellInfoMap = {};
    const depIndex = new DependencyIndex();
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
                    chidren: {},
                    color: 'w',
                };
                depIndex.set(key, deps);
            }
        }
    }

    const allInfos = Object.values(infoMap);
    if (allInfos.length === 0) {
        // No formulas: still return a normalized shape (synced celldata +
        // calcChain) so the read gate recognises the doc as computed.
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
    const engine = new FormulaEngine();
    // Resolver over the working sheets: mirrors createArrayResolver's persisted
    // shape but reads the live `data` matrices we mutate during the ordered pass.
    const resolver = createArrayResolver(
        working.map((w) => ({ id: w.id, name: w.name, data: w.data, calculationChain: [], dynamicArrayCompute: [] })),
    );
    for (const info of order) {
        if (isVolatileFormula(info.calc_funcStr)) continue;
        try {
            const result = engine.evaluate(info.calc_funcStr, info.id, info.r, info.c, resolver);
            const idx = indexById.get(info.id);
            if (idx == null) continue;
            const rowArr = working[idx].data[info.r];
            if (!rowArr) continue;
            const existing = rowArr[info.c];
            if (existing == null) continue;
            // An engine error must never overwrite a good cached value: functions
            // this build lacks (XLOOKUP, TEXTJOIN, LET, FILTER, …) evaluate to
            // #NAME?, which would otherwise destroy Excel's correct cached result
            // at import. When the cell already carries a non-error cached value,
            // keep it AND skip the execFunctionGlobalData seed so downstream
            // formulas read that cached value through the resolver — not the error
            // (same freeze-is-safe direction as volatiles). Cells with no cached
            // value still get the error sentinel (better than a silent blank).
            if (result.type === 'error' && hasNonErrorCachedValue(existing)) continue;
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
