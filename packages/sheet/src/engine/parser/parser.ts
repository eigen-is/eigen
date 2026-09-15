import { TinyEmitter } from 'tiny-emitter';
import type {
    CellInfo,
    FormulaArg,
    FormulaValue,
    ParseResult,
    ParserEventListener,
    ParserOptions,
    RangeCell,
} from '../types';
import errorParser, { ERROR, ERROR_NAME, ERROR_VALUE, valueIsError } from './error';
import evaluateByOperator from './evaluate-by-operator/evaluate-by-operator';
import { Parser as GrammarParser } from './grammar-parser/grammar-parser';
import { extractLabel, toLabel } from './helper/cell';
import { invertNumber, toNumber } from './helper/number';
import { trimEdges } from './helper/string';

type GrammarParserInstance = { parse: (expression: string) => unknown; yy: Record<string, unknown> };

class Parser {
    private parser: GrammarParserInstance;
    private variables: Record<string, FormulaArg>;
    private options: ParserOptions;
    private emitter: TinyEmitter;

    constructor() {
        this.emitter = new TinyEmitter();
        this.parser = new GrammarParser();
        this.parser.yy = {
            toNumber,
            trimEdges,
            invertNumber,
            throwError: (errorName: string) => this._throwError(errorName),
            callVariable: (variable: string) => this._callVariable(variable),
            evaluateByOperator,
            callFunction: evaluateByOperator,
            cellValue: (value: string) => this._callCellValue(value),
            rangeValue: (start: string, end: string) => this._callRangeValue(start, end),
        };
        this.variables = Object.create(null);
        this.options = Object.create(null);

        this.setVariable('TRUE', true).setVariable('FALSE', false).setVariable('NULL', null);
    }

    on(event: string, listener: ParserEventListener): void {
        this.emitter.on(event, listener);
    }

    parse(expression: string, options: ParserOptions = {}): ParseResult {
        let result: unknown = null;
        let error: string | null = null;
        this.options = options;

        try {
            if (expression === '') {
                result = '';
            } else {
                result = this.parser.parse(expression);
            }
        } catch (ex) {
            const message = ex instanceof Error ? errorParser(ex.message) : null;
            error = message ?? errorParser(ERROR);
        }

        if (result instanceof Error) {
            error = errorParser(result.message) ?? errorParser(ERROR);
            result = null;
        }

        return { error, result };
    }

    // Folded like function names (evaluate-by-operator) and cell labels (helper/cell):
    // Excel writes bare TRUE/FALSE/NULL lower-cased into xlsx formula text, and both Excel
    // and Sheets resolve them case-insensitively.
    setVariable(name: string, value: FormulaArg): Parser {
        this.variables[name.toUpperCase()] = value;
        return this;
    }

    // `FormulaArg` because variables feed directly into the grammar's arithmetic/comparison
    // pipelines, which expect scalars or arrays (e.g. `setVariable('range', [1, 2, 3])` for
    // CORREL-style formulas).
    getVariable(name: string): FormulaArg {
        return this.variables[name.toUpperCase()];
    }

    private emit(event: string, ...args: unknown[]): void {
        this.emitter.emit(event, ...args);
    }

    private _callVariable(name: string): FormulaArg {
        const value = this.getVariable(name);
        if (value === undefined) {
            throw Error(ERROR_NAME);
        }

        return value;
    }

    // Retrieve value by its label (`B3`, `B$3`, `$B$3`).
    private _callCellValue(label: string): FormulaArg {
        const parsed = extractLabel(label);
        if (!parsed) {
            throw Error(ERROR);
        }

        const [row, column, sheetName] = parsed;
        if (column.index === -1) {
            if (row.isAbsolute || column.isAbsolute) {
                throw Error(ERROR_NAME);
            }
            return row.index + 1;
        }
        if (row.index === -1) {
            return this._callVariable(label);
        }

        let value: FormulaValue;
        const cell: CellInfo = { label: toLabel(row, column), row, column, sheetName };
        this.emit('callCellValue', cell, this.options, (_value: FormulaValue) => {
            value = _value;
        });

        return value;
    }

    // Retrieve values by range label (`B3:A1`, `B$3:A1`, `B$3:$A1`, `$B$3:A$1`).
    private _callRangeValue(startLabel: string, endLabel: string): FormulaValue[] | FormulaValue[][] {
        const start = extractLabel(startLabel);
        const end = extractLabel(endLabel);
        if (!start || !end) {
            throw Error(ERROR);
        }

        const [startRow, startColumn, startSheetName] = start;
        const [endRow, endColumn, endSheetName] = end;
        if (endSheetName != null && startSheetName !== endSheetName) {
            throw Error(ERROR_VALUE);
        }

        const [rowStart, rowEnd] = startRow.index <= endRow.index ? [startRow, endRow] : [endRow, startRow];
        const [colStart, colEnd] =
            startColumn.index <= endColumn.index ? [startColumn, endColumn] : [endColumn, startColumn];

        const startCell: RangeCell = {
            row: rowStart,
            column: colStart,
            label: toLabel(rowStart, colStart),
            sheetName: startSheetName,
        };
        const endCell: RangeCell = { row: rowEnd, column: colEnd, label: toLabel(rowEnd, colEnd) };

        let value: FormulaValue[] | FormulaValue[][] = [];

        this.emit(
            'callRangeValue',
            startCell,
            endCell,
            this.options,
            (_value: FormulaValue[] | FormulaValue[][] = []) => {
                value = _value;
            },
        );

        return value;
    }

    private _throwError(errorName: string): never {
        if (valueIsError(errorName)) {
            throw Error(errorName);
        }

        throw Error(ERROR);
    }
}

export default Parser;
