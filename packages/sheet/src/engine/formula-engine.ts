// The formula engine the editor and the server's recalc share. It owns one Parser, answers its cell and range reads
// from a computed value in execFunctionGlobalData first and the CellResolver after, and turns each result into a cell
// value, a display string and a type. An error a cell holds reads back as an error, so ISERROR and IFERROR see it.
// Every range read is clamped to the sheet's grid and counted against maxCellsRead.

import { DependencyIndex } from './dependency-index';
import { cellValue } from './format';
import { Parser } from './parser';
import errorParser, {
    ERROR,
    ERROR_NAME,
    ERROR_REF,
    ERROR_VALUE,
    toFormulaError,
    UNSUPPORTED_FUNCTION,
    valueIsError,
} from './parser/error';
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

// A cell holds an error as its text, such as `#DIV/0!`. A formula reads it back as an error object, formulajs's where
// it has one, because its functions recognize only those. A cell that holds such text as text stays text: a plain
// (`ct.t === 's'`) or a rich one. A `#NAME?` doesn't say whether it comes from a typo or stands in for a function the
// engine lacks. So it reads as the latter, which no function traps, because a fallback would read as the value Excel
// computed.
function getCellValue(cell: Cell | null | undefined): unknown {
    if (cell?.ct?.t === 'n') {
        const n = Number(cell.v);
        return Number.isNaN(n) ? cell.v : n;
    }
    const value = cellValue(cell);
    const text = cell?.ct?.t === 's' || cell?.ct?.t === 'inlineStr';
    if (typeof value !== 'string' || text || !valueIsError(value)) return value;
    return value === errorParser(ERROR_NAME) ? UNSUPPORTED_FUNCTION : toFormulaError(Error(value));
}

function inferType(value: unknown): EvaluationResult['type'] {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    // A text result that reads as an error is stored as one, as the editor's setCellValue stores it.
    if (typeof value === 'string' && valueIsError(value)) return 'error';
    return 'string';
}

export class FormulaEngine {
    public state: FormulaEngineState;
    private parser: Parser;
    private currentResolver: CellResolver | null = null;
    // The cells range reads have cost; a read that would pass `maxCellsRead` fails before it reads.
    public cellsRead = 0;
    private readonly maxCellsRead: number;

    public constructor({ maxCellsRead = Number.POSITIVE_INFINITY } = {}) {
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

                // A whole row or column (`3:3`, `A:A`) has no column or row index, so it spans the grid.
                const emptyRow = startRow === -1 || endRow === -1;
                const emptyCol = startCol === -1 || endCol === -1;
                if (emptyRow && emptyCol) throw Error(ERROR_REF);

                // The grid bounds every range, explicit endpoints included, because an unclamped `A1:XFD1048576`, a
                // shape real xlsx files carry, is 17 billion cells. So `ROWS(A1:A100)` answers the grid's row count,
                // as `ROWS(A:A)` does.
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

    // True for a name a formula may use bare, such as TRUE. The engine has no defined names, so any other is #NAME?.
    public isKnownName(name: string): boolean {
        return this.parser.getVariable(name) !== undefined;
    }

    public evaluate(formula: string, sheetId: string, resolver: CellResolver): EvaluationResult {
        return this.evaluateCompiled(this.compile(formula), sheetId, resolver);
    }

    public compile(formula: string): CompiledFormula {
        return this.parser.compile(formula.substring(1));
    }

    public evaluateCompiled(
        compiled: CompiledFormula,
        sheetId: string,
        resolver: CellResolver,
        rowOffset = 0,
        colOffset = 0,
    ): EvaluationResult {
        this.currentResolver = resolver;
        try {
            const { error, result: evaluated } = this.parser.evaluate(compiled, { sheetId, rowOffset, colOffset });

            // The engine has no spill, so an array result, such as a bare range or TRANSPOSE, keeps its top-left
            // value. That is the value Excel's spill anchor holds, so a recalc of an imported anchor lands on Excel's.
            // The value may be an error a cell holds, as in `=A1:B2`.
            let result = evaluated;
            while (Array.isArray(result)) result = result[0];
            const failure = result instanceof Error ? (errorParser(result.message) ?? errorParser(ERROR)) : error;
            if (failure != null) {
                return { value: failure, display: failure, type: 'error' };
            }

            if (result instanceof Date) {
                // A Date result stores as its Excel serial, as the parser's operators read a Date operand. As a string,
                // a DATE or EOMONTH cell would turn into text on the xlsx round trip.
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
