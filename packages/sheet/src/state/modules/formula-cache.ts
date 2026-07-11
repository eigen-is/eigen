import { isNil } from 'es-toolkit/compat';
import { current, isDraft } from 'immer';
import type { DependencyIndex } from '../../engine/dependency-index';
import { FormulaEngine, isFormula } from '../../engine/formula-engine';
import type {
    CalcChainEntry,
    CellMatrix,
    CellResolver,
    FormulaCellInfoMap,
    FormulaDependency,
} from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { History, Selection } from '../types';
import { getSheetIdByName } from '../utils';
import { setFormulaCellInfo } from './formulaHelper';

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
        changesHistory.forEach((patch) => {
            if (isFormula(patch.value?.f) || patch.value === null || patch.path[5] === 'f') {
                requestUpdate({ r: patch.path[3], c: patch.path[4] });
            } else if (Array.isArray(patch.value)) {
                patch.value.forEach((value) => {
                    requestUpdate(value);
                });
            } else {
                requestUpdate(patch.value);
            }
        });
    }
}
