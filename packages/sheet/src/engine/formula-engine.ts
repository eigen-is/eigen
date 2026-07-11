import { DependencyIndex } from './dependency-index';
import { ERROR_REF, Parser } from './parser';
import type {
    Cell,
    CellInfo,
    CellResolver,
    EvaluationResult,
    FormulaEngineState,
    ParserDoneCallback,
    ParserOptions,
    RangeCell,
} from './types';

export function isFormula(value: unknown): boolean {
    return typeof value === 'string' && value.length > 1 && value[0] === '=';
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
    if (cell.ct?.t === 'n') {
        const n = Number(cell.v);
        return Number.isNaN(n) ? cell.v : n;
    }
    return cell.v;
}

function inferType(value: unknown): EvaluationResult['type'] {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'date';
    if (typeof value === 'string' && value.startsWith('#')) return 'error';
    return 'string';
}

export class FormulaEngine {
    state: FormulaEngineState;
    private parser: Parser;
    private currentResolver: CellResolver | null = null;

    constructor() {
        this.state = {
            execFunctionGlobalData: {},
            formulaCellInfoMap: null,
            dependencyIndex: new DependencyIndex(),
            cellTextToIndexList: {},
        };

        this.parser = new Parser();

        this.parser.on('callCellValue', (cellCoord: CellInfo, options: ParserOptions, done: ParserDoneCallback) => {
            const resolver = this.currentResolver!;
            const sheetId =
                cellCoord.sheetName == null ? options.sheetId : resolver.getSheetIdByName(cellCoord.sheetName);
            if (sheetId == null) throw Error(ERROR_REF);

            const cacheKey = `${cellCoord.row.index}_${cellCoord.column.index}_${sheetId}`;
            const cached = this.state.execFunctionGlobalData[cacheKey];
            if (cached !== undefined) {
                done(getCellValue(cached as Cell));
                return;
            }

            const cell = resolver.getCell(sheetId, cellCoord.row.index, cellCoord.column.index);
            done(getCellValue(cell));
        });

        this.parser.on(
            'callRangeValue',
            (startCellCoord: RangeCell, endCellCoord: RangeCell, options: ParserOptions, done: ParserDoneCallback) => {
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
            },
        );
    }

    evaluate(formula: string, sheetId: string, _row: number, _col: number, resolver: CellResolver): EvaluationResult {
        this.currentResolver = resolver;
        try {
            const expression = formula.substring(1);
            const { error, result } = this.parser.parse(expression, { sheetId });

            if (error != null) {
                return { value: error, display: error, type: 'error' };
            }

            const raw = result instanceof Date ? result.toString() : result;
            // Cell-scoped formulas produce scalars. Range references can
            // surface arrays if a formula evaluates to a bare range — coerce
            // those (and any other non-primitive) to a string for storage.
            const value: Cell['v'] =
                typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
                    ? raw
                    : raw == null
                      ? undefined
                      : String(raw);
            const type = inferType(value);
            const display = value == null ? '' : String(value);

            return { value, display, type };
        } finally {
            this.currentResolver = null;
        }
    }
}
