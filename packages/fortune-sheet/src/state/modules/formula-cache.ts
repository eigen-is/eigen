import * as _ from "es-toolkit/compat";
import type {History, Selection} from "../types";
import type {Context} from "../context";
import {getFlowdata} from "../context";
import {getSheetIdByName} from "../utils";
import type {CalculationChainEntry, Cell, CellMatrix, CellResolver, FormulaCellInfoMap, FormulaDependency} from "../../engine/types";
import {FormulaEngine, isFormula} from "../../engine/formula-engine";
import {setFormulaCellInfo} from "./formulaHelper";

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

// Adapts Context to the CellResolver interface expected by FormulaEngine.
export function createContextResolver(ctx: Context): CellResolver {
    return {
        getCell(sheetId: string, row: number, col: number) {
            const flowdata = getFlowdata(ctx, sheetId);
            return flowdata?.[row]?.[col] ?? null;
        },
        getRange(sheetId: string, startRow: number, startCol: number, endRow: number, endCol: number) {
            const flowdata = getFlowdata(ctx, sheetId);
            const result: (Cell | null)[][] = [];
            for (let r = startRow; r <= endRow; r++) {
                const rowData: (Cell | null)[] = [];
                for (let c = startCol; c <= endCol; c++) {
                    rowData.push(flowdata?.[r]?.[c] ?? null);
                }
                result.push(rowData);
            }
            return result;
        },
        getSheetIdByName(name: string) {
            return getSheetIdByName(ctx, name) ?? null;
        },
        getSheetData(sheetId: string) {
            return getFlowdata(ctx, sheetId) ?? null;
        },
        getSheets() {
            return ctx.luckysheetfile.map(f => ({
                id: f.id ?? "",
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
    }

    // UI-only state — stays on FormulaCache
    func_selectedrange?: Selection;

    data_parm_index: number;

    cellTextToIndexList: Record<string, FormulaDependency>;

    rangechangeindex?: number;

    selectingRangeIndex: number;

    rangeResizeObj?: any;

    rangeResize?: any;

    rangeResizeIndex?: number;

    rangeResizexy?: any;

    rangeResizeWinH?: any;

    rangeResizeWinW?: any;

    rangeResizeTo?: any;

    rangeSetValueTo?: any;

    rangeIndex?: number;

    rangestart?: boolean;

    rangetosheet?: string;

    rangedrag_column_start?: boolean;

    rangedrag_row_start?: boolean;

    functionRangeIndex?: number[];

    functionlistMap: any;

    execFunctionExist?: CalculationChainEntry[];

    engine: FormulaEngine;

    constructor() {
        this.data_parm_index = 0;
        this.selectingRangeIndex = -1;
        this.functionlistMap = {};
        this.cellTextToIndexList = {};
        this.engine = new FormulaEngine();
    }

    updateFormulaCache(
        ctx: Context,
        history: History,
        type: "undo" | "redo",
        data?: CellMatrix
    ) {
        function requestUpdate(value: any) {
            if (value instanceof Object) {
                if (!_.isNil(value.r) && !_.isNil(value.c)) {
                    setFormulaCellInfo(
                        ctx,
                        {
                            r: value.r,
                            c: value.c,
                            id: value.id || history.options?.id || ctx.currentSheetId,
                        },
                        data
                    );
                }
            }
        }

        const changesHistory =
            type === "undo" ? history.inversePatches : history.patches;
        changesHistory.forEach((patch) => {
            if (
                isFormula(patch.value?.f) ||
                patch.value === null ||
                patch.path[5] === "f"
            ) {
                requestUpdate({r: patch.path[3], c: patch.path[4]});
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
