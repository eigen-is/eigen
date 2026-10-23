import { DependencyIndex } from './dependency-index';
import { cellValue } from './format';
import { ERROR_REF, Parser } from './parser';
import { ERROR_VALUE } from './parser/error';
import { dateToSerial } from './parser/helper/number';
import type {
    Cell,
    CellInfo,
    CellResolver,
    CompiledFormula,
    EvaluationResult,
    FormulaEngineState,
    ParserDoneCallback,
    ParserOptions,
    RangeCell,
} from './types';

export function isFormula(value: unknown): boolean {
    return typeof value === 'string' && value.length > 1 && value[0] === '=';
}

function getCellValue(cell: Cell | null | undefined): unknown {
    if (cell?.ct?.t === 'n') {
        const n = Number(cell.v);
        return Number.isNaN(n) ? cell.v : n;
    }
    return cellValue(cell);
}

function inferType(value: unknown): EvaluationResult['type'] {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string' && value.startsWith('#')) return 'error';
    return 'string';
}

export class FormulaEngine {
    state: FormulaEngineState;
    private parser: Parser;
    private currentResolver: CellResolver | null = null;
    // The cells range reads have cost; a read that would pass `maxCellsRead` fails before it reads.
    cellsRead = 0;
    private readonly maxCellsRead: number;

    constructor({ maxCellsRead = Number.POSITIVE_INFINITY } = {}) {
        this.maxCellsRead = maxCellsRead;
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
                done(getCellValue(cached));
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
                if (emptyRow && emptyCol) throw Error(ERROR_REF);

                // The grid bounds every range, explicit endpoints included: an
                // unclamped `A1:XFD1048576` (a shape real xlsx files carry) is 17
                // billion cells. So `ROWS(A1:A100)` answers the grid row count, the
                // convention `ROWS(A:A)` already follows.
                const sheetData = resolver.getSheetData(sheetId);
                const lastRow = (sheetData?.length ?? 0) - 1;
                const lastCol = (sheetData?.[0]?.length ?? 0) - 1;
                if (emptyRow) startRow = 0;
                if (emptyCol) startCol = 0;
                endRow = emptyRow ? lastRow : Math.min(endRow, lastRow);
                endCol = emptyCol ? lastCol : Math.min(endCol, lastCol);
                if (endRow >= startRow && endCol >= startCol) {
                    this.cellsRead += (endRow - startRow + 1) * (endCol - startCol + 1);
                    if (this.cellsRead > this.maxCellsRead) throw Error(ERROR_VALUE);
                }

                const fragment: unknown[][] = [];
                for (let row = startRow; row <= endRow; row++) {
                    const colFragment: unknown[] = [];
                    for (let col = startCol; col <= endCol; col++) {
                        const cacheKey = `${row}_${col}_${sheetId}`;
                        const cached = this.state.execFunctionGlobalData[cacheKey];
                        if (cached !== undefined) {
                            colFragment.push(getCellValue(cached));
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

    evaluate(formula: string, sheetId: string, resolver: CellResolver): EvaluationResult {
        return this.evaluateCompiled(this.compile(formula), sheetId, resolver);
    }

    compile(formula: string): CompiledFormula {
        return this.parser.compile(formula.substring(1));
    }

    evaluateCompiled(
        compiled: CompiledFormula,
        sheetId: string,
        resolver: CellResolver,
        rowOffset = 0,
        colOffset = 0,
    ): EvaluationResult {
        this.currentResolver = resolver;
        try {
            const { error, result: evaluated } = this.parser.evaluate(compiled, { sheetId, rowOffset, colOffset });

            if (error != null) {
                return { value: error, display: error, type: 'error' };
            }

            // The engine has no spill, so an array result (a bare range, XLOOKUP's matched row,
            // TRANSPOSE) keeps its top-left value: the value Excel's spill anchor holds, so a recalc
            // of an imported anchor lands on Excel's cached value.
            let result = evaluated;
            while (Array.isArray(result)) result = result[0];

            if (result instanceof Date) {
                // A Date result stores as its Excel serial — the same convention the
                // parser's operators apply to Date operands. Stringifying it would
                // turn a DATE/EOMONTH/NOW cell into text on the xlsx round trip.
                const serial = dateToSerial(result);
                return { value: serial, display: String(serial), type: 'date' };
            }

            // Any other non-primitive is stored as its string.
            const value: Cell['v'] =
                typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
                    ? result
                    : result == null
                      ? undefined
                      : String(result);
            const type = inferType(value);
            const display = value == null ? '' : String(value);

            return { value, display, type };
        } finally {
            this.currentResolver = null;
        }
    }
}
