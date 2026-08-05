import { isNil } from 'es-toolkit/compat';
import { current, isDraft } from 'immer';
import type { DependencyIndex } from '../../engine/dependency-index';
import { FormulaEngine, isFormula } from '../../engine/formula-engine';
import { iscelldata } from '../../engine/formula-utils';
import type {
    CalcChainEntry,
    CellMatrix,
    CellResolver,
    FormulaCellInfo,
    FormulaCellInfoMap,
    FormulaDependency,
} from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, History, Selection } from '../types';
import { getSheetIdByName } from '../utils';
import { getcellFormula } from './cell';
import { execfunction, getcellrange, isFunctionRange } from './formula-exec';

// Shared mutable state accessed by formula-editor.ts and formula-range.ts.
// Wrapped in an object so mutations are visible across module boundaries.
export const formulaUIState = {
    functionHTMLIndex: 0,
    rangeIndexes: [] as number[],
};

export function setFunctionHTMLIndex(value: number) {
    formulaUIState.functionHTMLIndex = value;
}

export function resetFunctionHTMLIndex() {
    formulaUIState.functionHTMLIndex = 0;
}

export function setRangeIndexes(value: number[]) {
    formulaUIState.rangeIndexes = value;
}

export function resetRangeIndexes() {
    formulaUIState.rangeIndexes = [];
}

// Plain (non-draft) view of the context. Formula evaluation reads cells one
// at a time; going through immer draft proxies makes each read several times
// slower and creates child drafts that the finalize pass must then walk.
export function snapshotContext(ctx: Context): Context {
    return isDraft(ctx) ? (current(ctx) as Context) : ctx;
}

// Adapts Context to the CellResolver interface expected by FormulaEngine.
// Reads exactly the context it is handed: pass `snapshotContext(ctx)` for a
// stable plain snapshot (correct for one dependency-ordered evaluation pass —
// freshly computed values travel via execFunctionGlobalData, which the engine
// checks before cell data), or the live ctx when interleaving writes with
// evaluations that must see them, e.g. calculateFormula's cell-order sweep.
export function createContextResolver(source: Context): CellResolver {
    const matrices = new Map<string, CellMatrix | null>();
    const dataFor = (sheetId: string) => {
        let matrix = matrices.get(sheetId);
        if (matrix === undefined) {
            matrix = getFlowdata(source, sheetId) ?? null;
            matrices.set(sheetId, matrix);
        }
        return matrix;
    };

    return {
        getCell(sheetId: string, row: number, col: number) {
            return dataFor(sheetId)?.[row]?.[col] ?? null;
        },
        getSheetIdByName(name: string) {
            return getSheetIdByName(source, name) ?? null;
        },
        getSheetData(sheetId: string) {
            return dataFor(sheetId);
        },
        getSheets() {
            return source.sheets.map((f) => ({
                id: f.id ?? '',
                name: f.name,
                calculationChain: f.calcChain ?? [],
                dynamicArrayCompute: f.dynamicArray_compute ?? [],
            }));
        },
    };
}

// FormulaCache is defined as class to avoid being frozen by immer
export class FormulaCache {
    // Shared state — delegated to engine so both FE and BE use the same cache
    get execFunctionGlobalData(): Record<string, unknown> {
        return this.engine.state.execFunctionGlobalData;
    }

    set execFunctionGlobalData(v: Record<string, unknown> | null | undefined) {
        this.engine.state.execFunctionGlobalData = (v as Record<string, unknown>) ?? {};
    }

    get formulaCellInfoMap(): FormulaCellInfoMap | null {
        return this.engine.state.formulaCellInfoMap;
    }

    set formulaCellInfoMap(v: FormulaCellInfoMap | null) {
        this.engine.state.formulaCellInfoMap = v;
        // The map is only ever reassigned to reset it (null or {}); the reverse
        // index mirrors the map, so it resets too and refills via setFormulaCellInfo.
        this.engine.state.dependencyIndex.clear();
    }

    // Reverse lookup cell → formulas reading it; lives in engine state next to
    // formulaCellInfoMap (so engine resets clear both) and is kept in lockstep
    // by setFormulaCellInfo and the setter above.
    get dependencyIndex(): DependencyIndex {
        return this.engine.state.dependencyIndex;
    }

    // UI-only state — stays on FormulaCache
    func_selectedrange?: Selection;

    data_parm_index: number;

    cellTextToIndexList: Record<string, FormulaDependency>;

    rangechangeindex?: number;

    selectingRangeIndex: number;

    rangeResizeObj?: unknown;

    rangeResize?: unknown;

    rangeResizeIndex?: number;

    rangeResizexy?: unknown;

    rangeResizeWinH?: unknown;

    rangeResizeWinW?: unknown;

    rangeResizeTo?: HTMLDivElement[];

    rangeSetValueTo?: Node | null;

    rangeIndex?: number;

    rangestart?: boolean;

    rangetosheet?: string;

    rangedrag_column_start?: boolean;

    rangedrag_row_start?: boolean;

    functionRangeIndex?: number[];

    functionlistMap: Record<string, unknown>;

    execFunctionExist?: CalcChainEntry[];

    // Cells an edit actually changed (set by deleteSelectedCellText). When present,
    // runExecFunction recomputes only these instead of every cell in the selection
    // rectangle — so clearing a huge, mostly-empty selection stays cheap.
    pendingChangedCells?: CalcChainEntry[];

    engine: FormulaEngine;

    constructor() {
        this.data_parm_index = 0;
        this.selectingRangeIndex = -1;
        this.functionlistMap = {};
        this.cellTextToIndexList = {};
        this.engine = new FormulaEngine();
    }

    updateFormulaCache(ctx: Context, history: History, type: 'undo' | 'redo', data?: CellMatrix) {
        function requestUpdate(value: unknown) {
            if (value instanceof Object) {
                const v = value as { r?: number; c?: number; id?: string };
                if (!isNil(v.r) && !isNil(v.c)) {
                    setFormulaCellInfo(
                        ctx,
                        {
                            r: v.r,
                            c: v.c,
                            id: v.id || history.options?.id || ctx.currentSheetId,
                        },
                        data,
                    );
                }
            }
        }

        const changesHistory = type === 'undo' ? history.inversePatches : history.patches;
        for (const patch of changesHistory) {
            if (isFormula(patch.value?.f) || patch.value === null || patch.path[5] === 'f') {
                requestUpdate({ r: patch.path[3], c: patch.path[4] });
            } else if (Array.isArray(patch.value)) {
                for (const value of patch.value) {
                    requestUpdate(value);
                }
            } else {
                requestUpdate(patch.value);
            }
        }
    }
}

// Make sure setFormulaObject() is executed *after* the cell modifications.
// `data` is a fast-path matrix; `dataSheetId` names the sheet it belongs to
// (defaults to the active sheet). It is only consulted for entries on that
// sheet — for other sheets' entries whose (r,c) also exists in this grid,
// getcellFormula would read the wrong sheet's cell, dropping or mis-parsing
// the formula (stale cross-sheet recalc).
export function setFormulaCellInfo(ctx: Context, formulaCell: FormulaCell, data?: CellMatrix, dataSheetId?: string) {
    const key = `r${formulaCell.r}c${formulaCell.c}i${formulaCell.id}`;
    const cellData = formulaCell.id === (dataSheetId ?? ctx.currentSheetId) ? data : undefined;
    const calc_funcStr = getcellFormula(ctx, formulaCell.r, formulaCell.c, formulaCell.id, cellData);
    if (isNil(calc_funcStr)) {
        delete ctx.formulaCache.formulaCellInfoMap?.[key];
        ctx.formulaCache.dependencyIndex.delete(key);
        return;
    }
    const txt1 = calc_funcStr.toUpperCase();
    const isOffsetFunc = txt1.indexOf('INDIRECT(') > -1 || txt1.indexOf('OFFSET(') > -1 || txt1.indexOf('INDEX(') > -1;

    const formulaDependency: FormulaDependency[] = [];
    if (isOffsetFunc) {
        isFunctionRange(ctx, calc_funcStr, formulaCell.id, (str_nb: string) => {
            const range = getcellrange(ctx, str_nb.trim(), formulaCell.id, cellData);
            if (!isNil(range)) {
                formulaDependency.push(range);
            }
        });
    } else if (!(calc_funcStr.substring(0, 2) === '="' && calc_funcStr.substring(calc_funcStr.length - 1, 1) === '"')) {
        // let formulaTextArray = calc_funcStr.split(/==|!=|<>|<=|>=|[,()=+-\/*%&^><]/g); // Cannot correctly split cases where ==, !=, - etc. appear between single or double quotes. This caused a bug where the formula value was not updated when the cell content of sheet name '1-2' in ='1-2'!A1 changed.
        // Fix: ='1-2'!A1+5 being split by calc_funcStr.split(/==|!=|<>|<=|>=|[,()=+-\/*%&^><]/g) into ["","'1","2'!A1",5] incorrectly
        let point = 0; // pointer
        let squote = -1; // single quote
        let dquote = -1; // double quotes
        const formulaTextArray = [];
        const sq_end_array = []; // Saves the paired single quotes in the index of formulaTextArray.
        const calc_funcStr_length = calc_funcStr.length;
        for (let j = 0; j < calc_funcStr_length; j += 1) {
            const char = calc_funcStr.charAt(j);
            if (char === "'" && dquote === -1) {
                // If it starts with a single quote
                if (squote === -1) {
                    if (point !== j) {
                        formulaTextArray.push(
                            ...calc_funcStr.substring(point, j).split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
                        );
                    }
                    squote = j;
                    point = j;
                } // end single quote
                else {
                    // If '' it represents an output of '
                    if (j < calc_funcStr_length - 1 && calc_funcStr.charAt(j + 1) === "'") {
                        j += 1;
                    } else {
                        // If the next character is not ', it means the end of a single quote
                        point = j + 1;
                        formulaTextArray.push(calc_funcStr.substring(squote, point));
                        sq_end_array.push(formulaTextArray.length - 1);
                        squote = -1;
                    }
                }
            } else if (char === '"' && squote === -1) {
                // If it starts with double quotes
                if (dquote === -1) {
                    if (point !== j) {
                        formulaTextArray.push(
                            ...calc_funcStr.substring(point, j).split(/==|!=|<>|<=|>=|[,()=+-/*%&^><]/),
                        );
                    }
                    dquote = j;
                    point = j;
                } else {
                    // If "" represents output"
                    if (j < calc_funcStr_length - 1 && calc_funcStr.charAt(j + 1) === '"') {
                        j += 1;
                    } else {
                        // end with double quotes
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
        // Concatenate each paired single-quoted segment with the following cell reference, e.g. ["'1-2'","!A1"] becomes ["'1-2'!A1"]
        for (let j = sq_end_array.length - 1; j >= 0; j -= 1) {
            if (sq_end_array[j] !== formulaTextArray.length - 1) {
                formulaTextArray[sq_end_array[j]] += formulaTextArray[sq_end_array[j] + 1];
                formulaTextArray.splice(sq_end_array[j] + 1, 1);
            }
        }
        // At this point =SUM('1-2'!A1:A2&"'1-2'!A2") is corrected from ["","SUM","'1","2'!A1:A2","",""'1","2'!A2""] to ["","SUM","","'1-2'!A1:A2","","",""'1-2'!A2""]

        for (let j = 0; j < formulaTextArray.length; j += 1) {
            const t = formulaTextArray[j];
            if (t.length <= 1) {
                continue;
            }

            if ((t.substring(0, 1) === '"' && t.substring(t.length - 1, 1) === '"') || !iscelldata(t)) {
                continue;
            }

            const range = getcellrange(ctx, t.trim(), formulaCell.id, cellData);

            if (isNil(range)) {
                continue;
            }

            formulaDependency.push(range);
        }
    }

    const item: FormulaCellInfo = {
        formulaDependency,
        calc_funcStr,
        key,
        r: formulaCell.r,
        c: formulaCell.c,
        id: formulaCell.id,
        parents: {},
        chidren: {},
        color: 'w',
    };

    if (!ctx.formulaCache.formulaCellInfoMap) ctx.formulaCache.formulaCellInfoMap = {};
    ctx.formulaCache.formulaCellInfoMap[key] = item;
    ctx.formulaCache.dependencyIndex.set(key, formulaDependency);
}

export function executeAffectedFormulas(
    ctx: Context,
    formulaRunList: FormulaCellInfo[],
    calcChains: FormulaCell[],
    resolver: CellResolver,
) {
    const calcChainSet = new Set<string>();
    for (const item of calcChains) {
        calcChainSet.add(`${item.r}_${item.c}_${item.id}`);
    }

    // Collected locally and assigned once: ctx is usually an immer draft, and
    // per-result pushes through the proxy each record a patch.
    const refreshed: Context['groupValuesRefreshData'] = [];

    for (let i = 0; i < formulaRunList.length; i += 1) {
        const formulaCell = formulaRunList[i];
        const { calc_funcStr } = formulaCell;

        const v = execfunction(
            ctx,
            calc_funcStr,
            formulaCell.r,
            formulaCell.c,
            formulaCell.id,
            calcChainSet,
            undefined,
            undefined,
            resolver,
        );

        refreshed.push({
            r: formulaCell.r,
            c: formulaCell.c,
            v: v[1],
            f: v[2],
            id: formulaCell.id,
        });

        ctx.formulaCache.execFunctionGlobalData[`${formulaCell.r}_${formulaCell.c}_${formulaCell.id}`] = {
            v: v[1],
            f: v[2],
        };
    }

    ctx.groupValuesRefreshData =
        ctx.groupValuesRefreshData.length > 0 ? ctx.groupValuesRefreshData.concat(refreshed) : refreshed;
}
