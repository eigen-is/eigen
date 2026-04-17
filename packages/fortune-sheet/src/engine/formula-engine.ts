// @ts-ignore
import {ERROR_REF, Parser} from "./parser";
import type {Cell, FormulaDependency, FormulaCellInfoMap} from "../state/types";
import type {CellResolver, EvaluationResult, FormulaEngineState} from "./types";
import {getCalculationOrder} from "./dependency-graph";
import SSF from "./ssf";

export function isFormula(value: unknown): boolean {
    return typeof value === "string" && value.length > 1 && value[0] === "=";
}

// Matches a cell reference like A1, $B$3, AA100, A1:B3, or Sheet1!A1
const CELL_REF_RE =
    /^(?:(?:[A-Za-z0-9_\u00C0-\u02AF]+|'(?:(?!').|'')*')!)?\$?[A-Za-z]+\$?[0-9]+(?::\$?[A-Za-z]+\$?[0-9]+)?$/;

export function isCellReference(txt: string): boolean {
    if (txt.length === 0) return false;
    return CELL_REF_RE.test(txt);
}

function getCellValue(cell: Cell | null | undefined): unknown {
    if (cell == null) return undefined;
    if (cell.ct?.t === "n") {
        const n = Number(cell.v);
        return Number.isNaN(n) ? cell.v : n;
    }
    return cell.v;
}

function inferType(value: unknown): EvaluationResult["type"] {
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (value instanceof Date) return "date";
    if (typeof value === "string" && value.startsWith("#")) return "error";
    return "string";
}

export class FormulaEngine {
    state: FormulaEngineState;
    private parser: any;
    private currentResolver: CellResolver | null = null;

    constructor() {
        this.state = {
            execFunctionGlobalData: {},
            formulaCellInfoMap: null,
            execFunctionExist: undefined,
            cellTextToIndexList: {},
        };

        this.parser = new Parser();

        this.parser.on(
            "callCellValue",
            (cellCoord: any, options: any, done: any) => {
                const resolver = this.currentResolver!;
                const sheetId =
                    cellCoord.sheetName == null
                        ? options.sheetId
                        : resolver.getSheetIdByName(cellCoord.sheetName);
                if (sheetId == null) throw Error(ERROR_REF);

                const cacheKey = `${cellCoord.row.index}_${cellCoord.column.index}_${sheetId}`;
                const cached = this.state.execFunctionGlobalData[cacheKey];
                if (cached !== undefined) {
                    done(getCellValue(cached as Cell));
                    return;
                }

                const cell = resolver.getCell(
                    sheetId,
                    cellCoord.row.index,
                    cellCoord.column.index
                );
                done(getCellValue(cell));
            }
        );

        this.parser.on(
            "callRangeValue",
            (startCellCoord: any, endCellCoord: any, options: any, done: any) => {
                const resolver = this.currentResolver!;
                const sheetId =
                    startCellCoord.sheetName == null
                        ? options.sheetId
                        : resolver.getSheetIdByName(startCellCoord.sheetName);
                if (sheetId == null) throw Error(ERROR_REF);

                let startRow = startCellCoord.row.index;
                let endRow = endCellCoord.row.index;
                let startCol = startCellCoord.column.index;
                let endCol = endCellCoord.column.index;

                // Handle whole-row / whole-column references
                const emptyRow = startRow === -1 || endRow === -1;
                const emptyCol = startCol === -1 || endCol === -1;

                if (emptyRow) {
                    startRow = 0;
                    const sheetData = resolver.getSheetData(sheetId);
                    endRow = sheetData?.length ?? 0;
                }
                if (emptyCol) {
                    startCol = 0;
                    const sheetData = resolver.getSheetData(sheetId);
                    endCol = sheetData?.[0]?.length ?? 0;
                }
                if (emptyRow && emptyCol) throw Error(ERROR_REF);

                const fragment: unknown[][] = [];
                for (let row = startRow; row <= endRow; row++) {
                    const colFragment: unknown[] = [];
                    for (let col = startCol; col <= endCol; col++) {
                        const cacheKey = `${row}_${col}_${sheetId}`;
                        const cached = this.state.execFunctionGlobalData[cacheKey];
                        if (cached !== undefined) {
                            colFragment.push(getCellValue(cached as Cell));
                        } else {
                            const cell = resolver.getCell(sheetId, row, col);
                            colFragment.push(getCellValue(cell));
                        }
                    }
                    fragment.push(colFragment);
                }

                done(fragment);
            }
        );
    }

    evaluate(
        formula: string,
        sheetId: string,
        _row: number,
        _col: number,
        resolver: CellResolver
    ): EvaluationResult {
        this.currentResolver = resolver;
        try {
            const expression = formula.substring(1);
            const { error, result } = this.parser.parse(expression, { sheetId });

            if (error != null) {
                return { value: error, display: error, type: "error" };
            }

            const value = result instanceof Date ? result.toString() : result;
            const type = inferType(value);
            const display = value == null ? "" : String(value);

            return { value, display, type };
        } finally {
            this.currentResolver = null;
        }
    }

    evaluateAll(
        cells: Array<{ r: number; c: number; id: string; f: string }>,
        resolver: CellResolver
    ): Map<string, EvaluationResult> {
        const results = new Map<string, EvaluationResult>();

        for (const cell of cells) {
            const result = this.evaluate(cell.f, cell.id, cell.r, cell.c, resolver);
            const key = `${cell.r}_${cell.c}_${cell.id}`;
            results.set(key, result);

            // Store in global data so subsequent formulas can reference this result
            if (result.type !== "error") {
                this.state.execFunctionGlobalData[key] = {
                    v: result.value,
                    ct: { t: result.type === "number" ? "n" : "s", fa: "General" },
                };
            }
        }

        return results;
    }

    getDependencies(formula: string, sheetId: string): FormulaDependency[] {
        const deps: FormulaDependency[] = [];

        const cellHandler = (cellCoord: any, options: any, done: any) => {
            const depSheetId = cellCoord.sheetName == null
                ? options.sheetId
                : sheetId;
            deps.push({
                row: [cellCoord.row.index, cellCoord.row.index],
                column: [cellCoord.column.index, cellCoord.column.index],
                sheetId: depSheetId,
            });
            done(0);
        };

        const rangeHandler = (
            startCellCoord: any,
            endCellCoord: any,
            options: any,
            done: any
        ) => {
            const depSheetId = startCellCoord.sheetName == null
                ? options.sheetId
                : sheetId;
            deps.push({
                row: [startCellCoord.row.index, endCellCoord.row.index],
                column: [startCellCoord.column.index, endCellCoord.column.index],
                sheetId: depSheetId,
            });
            done([[0]]);
        };

        const tempParser = new Parser();
        tempParser.on("callCellValue", cellHandler);
        tempParser.on("callRangeValue", rangeHandler);

        try {
            tempParser.parse(formula.substring(1), { sheetId });
        } catch {
            // Parse failure — return whatever deps were collected
        }

        return deps;
    }

    format(value: unknown, pattern: string): string {
        return SSF.format(pattern, value);
    }

    resetState(): void {
        this.state = {
            execFunctionGlobalData: {},
            formulaCellInfoMap: null,
            execFunctionExist: undefined,
            cellTextToIndexList: {},
        };
    }

    recalculateAll(resolver: CellResolver): Map<string, EvaluationResult> {
        this.resetState();

        // 1. Collect all formula cells from every sheet's calculationChain
        const formulaCellInfoMap: FormulaCellInfoMap = {};

        for (const sheet of resolver.getSheets()) {
            for (const entry of sheet.calculationChain) {
                const cell = resolver.getCell(entry.id, entry.r, entry.c);
                if (cell == null || !isFormula(cell.f)) continue;

                const key = `r${entry.r}c${entry.c}i${entry.id}`;
                const deps = this.getDependencies(cell.f!, entry.id);

                formulaCellInfoMap[key] = {
                    formulaDependency: deps,
                    calc_funcStr: cell.f!,
                    key,
                    r: entry.r,
                    c: entry.c,
                    id: entry.id,
                    parents: {},
                    chidren: {},
                    color: "w",
                };
            }
        }

        // 2. Build parent relationships using this codebase's convention:
        //    depKey.parents[info.key] = 1 means "info depends on depKey",
        //    so depKey must evaluate before info.
        for (const info of Object.values(formulaCellInfoMap)) {
            for (const dep of info.formulaDependency) {
                const depSheetId = dep.sheetId ?? info.id;
                for (let r = dep.row[0]; r <= dep.row[1]; r++) {
                    for (let c = dep.column[0]; c <= dep.column[1]; c++) {
                        const depKey = `r${r}c${c}i${depSheetId}`;
                        if (depKey in formulaCellInfoMap) {
                            formulaCellInfoMap[depKey].parents[info.key] = 1;
                            info.chidren[depKey] = 1;
                        }
                    }
                }
            }
        }

        // 3. Topological sort to get evaluation order
        const allFormulas = Object.values(formulaCellInfoMap);
        if (allFormulas.length === 0) {
            return new Map();
        }

        const ordered = getCalculationOrder(allFormulas, formulaCellInfoMap);

        // 4. Evaluate in dependency order, caching results for subsequent formulas
        const results = new Map<string, EvaluationResult>();

        for (const info of ordered) {
            const result = this.evaluate(
                info.calc_funcStr,
                info.id,
                info.r,
                info.c,
                resolver
            );

            const resultKey = `${info.r}_${info.c}_${info.id}`;
            results.set(resultKey, result);

            // Cache result so subsequent formulas can reference it
            if (result.type !== "error") {
                this.state.execFunctionGlobalData[resultKey] = {
                    v: result.value,
                    ct: {
                        t: result.type === "number" ? "n" : "s",
                        fa: "General",
                    },
                };
            }
        }

        return results;
    }
}
