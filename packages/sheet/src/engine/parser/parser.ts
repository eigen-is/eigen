import { TinyEmitter } from 'tiny-emitter';
import type {
    CellInfo,
    FormulaArg,
    FormulaFunction,
    FormulaOutput,
    FormulaValue,
    ParseResult,
    ParserEventListener,
    ParserOptions,
    RangeCell,
} from '../types';
import errorParser, { ERROR, ERROR_NAME, ERROR_VALUE, isValidStrict as isErrorValid } from './error';
import evaluateByOperator from './evaluate-by-operator/evaluate-by-operator';
import { Parser as GrammarParser } from './grammar-parser/grammar-parser';
import { extractLabel, toLabel } from './helper/cell';
import { invertNumber, toNumber } from './helper/number';
import { trimEdges } from './helper/string';

type GrammarParserInstance = { parse: (expression: string) => unknown; yy: Record<string, unknown> };

class Parser {
    private parser: GrammarParserInstance;
    private variables: Record<string, unknown>;
    private functions: Record<string, FormulaFunction>;
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
            callFunction: (name: string, params: FormulaArg[]) => this._callFunction(name, params),
            cellValue: (value: string) => this._callCellValue(value),
            rangeValue: (start: string, end: string) => this._callRangeValue(start, end),
        };
        this.variables = Object.create(null);
        this.functions = Object.create(null);
        this.options = Object.create(null);

        this.setVariable('TRUE', true).setVariable('FALSE', false).setVariable('NULL', null);
    }

    on(event: string, listener: ParserEventListener): void {
        this.emitter.on(event, listener);
    }

    off(event: string, listener: ParserEventListener): void {
        this.emitter.off(event, listener);
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
            error = message ?? errorParser(ERROR)!;
        }

        if (result instanceof Error) {
            error = errorParser(result.message) || errorParser(ERROR);
            result = null;
        }

        return { error, result };
    }

    setVariable(name: string, value: unknown): Parser {
        this.variables[name] = value;
        return this;
    }

    getVariable(name: string): unknown {
        return this.variables[name];
    }

    setFunction(name: string, fn: FormulaFunction): Parser {
        this.functions[name] = fn;
        return this;
    }

    getFunction(name: string): FormulaFunction | undefined {
        return this.functions[name];
    }

    private emit(event: string, ...args: unknown[]): void {
        this.emitter.emit(event, ...args);
    }

    // Returns `FormulaArg` because variables registered via `setVariable` feed directly
    // into the grammar's arithmetic/comparison pipelines, which expect scalars or arrays
    // (e.g. `setVariable('range', [1, 2, 3])` for CORREL-style formulas).
    private _callVariable(name: string): FormulaArg {
        let value = this.getVariable(name);

        this.emit('callVariable', name, (newValue: unknown) => {
            if (newValue !== undefined) {
                value = newValue;
            }
        });

        if (value === undefined) {
            throw Error(ERROR_NAME);
        }

        return value as FormulaArg;
    }

    private _callFunction(name: string, params: FormulaArg[] = []): FormulaOutput {
        const fn = this.getFunction(name);
        let value: FormulaOutput | undefined;

        if (fn) {
            value = fn(params);
        }

        this.emit('callFunction', name, params, (newValue: FormulaOutput) => {
            if (newValue !== undefined) {
                value = newValue;
            }
        });

        return value === undefined ? evaluateByOperator(name, params) : value;
    }

    // Retrieve value by its label (`B3`, `B$3`, `B$3`, `$B$3`). Returns `FormulaArg`
    // because a user-defined variable (set via `setVariable`) may hold an array for
    // array-aware formulas like CORREL / LINEST.
    private _callCellValue(label: string): FormulaArg {
        const [row, column, sheetName] = extractLabel(label);
        if (column?.index === -1) {
            if (row?.isAbsolute || column?.isAbsolute) {
                throw Error(ERROR_NAME);
            }
            return (row?.index ?? 0) + 1;
        }
        if (row?.index === -1) {
            return this._callVariable(label);
        }

        let value: FormulaValue;
        const cell: CellInfo = { label: toLabel(row!, column!), row: row!, column: column!, sheetName };
        this.emit('callCellValue', cell, this.options, (_value: FormulaValue) => {
            value = _value;
        });

        return value;
    }

    // Retrieve values by range label (`B3:A1`, `B$3:A1`, `B$3:$A1`, `$B$3:A$1`).
    private _callRangeValue(startLabel: string, endLabel: string): FormulaValue[] | FormulaValue[][] {
        const [startRow, startColumn, startSheetName] = extractLabel(startLabel);
        const [endRow, endColumn, endSheetName] = extractLabel(endLabel);
        if (endSheetName != null && startSheetName !== endSheetName) {
            throw Error(ERROR_VALUE);
        }

        const [rowStart, rowEnd] = startRow!.index <= endRow!.index ? [startRow!, endRow!] : [endRow!, startRow!];
        const [colStart, colEnd] =
            startColumn!.index <= endColumn!.index ? [startColumn!, endColumn!] : [endColumn!, startColumn!];

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
        if (isErrorValid(errorName)) {
            throw Error(errorName);
        }

        throw Error(ERROR);
    }
}

export default Parser;
