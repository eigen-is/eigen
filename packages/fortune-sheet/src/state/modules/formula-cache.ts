import _ from "lodash";
import {ERROR_REF, Parser} from "../../engine/parser";
import type {Cell, CellMatrix, FormulaDependency, History, Selection,} from "../types";
import type {FormulaCellInfoMap} from "../types";
import type {Context} from "../context";
import {getFlowdata} from "../context";
import {getSheetIdByName} from "../utils";
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

export function parseElement(eleString: string) {
    return new DOMParser().parseFromString(eleString, "text/html").body
        .childNodes[0];
}

// FormulaCache is defined as class to avoid being frozen by immer
export class FormulaCache {
    parser: any;

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

    execFunctionExist?: any[];

    execFunctionGlobalData: any;

    formulaCellInfoMap: FormulaCellInfoMap | null;

    engine: FormulaEngine;

    constructor() {
        const that = this;
        this.data_parm_index = 0;
        this.selectingRangeIndex = -1;
        this.functionlistMap = {};
        this.execFunctionGlobalData = {};
        this.formulaCellInfoMap = null;
        this.cellTextToIndexList = {};
        this.parser = new Parser();
        this.engine = new FormulaEngine();
        this.parser.on(
            "callCellValue",
            (cellCoord: any, options: any, done: any) => {
                const context = that.parser.context as Context;
                const id =
                    cellCoord.sheetName == null
                        ? options.sheetId
                        : getSheetIdByName(context, cellCoord.sheetName);
                if (id == null) throw Error(ERROR_REF);
                const flowdata = getFlowdata(context, id);
                const cell =
                    context?.formulaCache.execFunctionGlobalData?.[
                        `${cellCoord.row.index}_${cellCoord.column.index}_${id}`
                        ] || flowdata?.[cellCoord.row.index]?.[cellCoord.column.index];
                const v = that.tryGetCellAsNumber(cell);
                done(v);
            }
        );

        this.parser.on(
            "callRangeValue",
            (startCellCoord: any, endCellCoord: any, options: any, done: any) => {
                const context = that.parser.context as Context;
                const id =
                    startCellCoord.sheetName == null
                        ? options.sheetId
                        : getSheetIdByName(context, startCellCoord.sheetName);
                if (id == null) throw Error(ERROR_REF);
                const flowdata = getFlowdata(context, id);
                const fragment = [];
                let startRow = startCellCoord.row.index;
                let endRow = endCellCoord.row.index;
                let startCol = startCellCoord.column.index;
                let endCol = endCellCoord.column.index;
                const emptyRow = startRow === -1 || endRow === -1;
                const emptyCol = startCol === -1 || endCol === -1;
                if (emptyRow) {
                    startRow = 0;
                    endRow = flowdata?.length ?? 0;
                }
                if (emptyCol) {
                    startCol = 0;
                    endCol = flowdata?.[0].length ?? 0;
                }
                if (emptyRow && emptyCol) throw Error(ERROR_REF);

                for (let row = startRow; row <= endRow; row += 1) {
                    const colFragment = [];

                    for (let col = startCol; col <= endCol; col += 1) {
                        const cell =
                            context?.formulaCache.execFunctionGlobalData?.[
                                `${row}_${col}_${id}`
                                ] || flowdata?.[row]?.[col];
                        const v = that.tryGetCellAsNumber(cell);
                        colFragment.push(v);
                    }
                    fragment.push(colFragment);
                }

                if (fragment) {
                    done(fragment);
                }
            }
        );
    }

    tryGetCellAsNumber(cell: Cell) {
        if (cell?.ct?.t === "n") {
            const n = Number(cell?.v);
            return Number.isNaN(n) ? cell.v : n;
        }
        return cell?.v;
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
