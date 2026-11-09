// The formula parser: it compiles formula text through the grammar into a function and evaluates it.
// It answers the grammar's callbacks for names, cell and range reads, and error literals, and asks the
// functions each evaluation hands it for cell values, so the same parser serves the editor and the
// server. The FormulaEngine owns one, for example, and turns each result into a value or an error string.

import type { CompiledFormula, FormulaArg, FormulaValue, ParseResult, ParserOptions, RangeCell } from '../types';
import errorParser, {
    ERROR,
    ERROR_CALC,
    ERROR_NAME,
    ERROR_REF,
    ERROR_VALUE,
    toFormulaError,
    UNSUPPORTED_ARRAY_OPERATION,
} from './error';
import { callFunction, evaluateByOperator } from './evaluate-by-operator/evaluate-by-operator';
import { Parser as GrammarParser } from './grammar-parser/grammar-parser';
import { extractLabel, offsetCoordinate, offsetRange, toLabel } from './helper/cell';
import { invertNumber, toNumber } from './helper/number';
import { trimEdges } from './helper/string';

type GrammarParserInstance = { parse: (expression: string) => CompiledFormula; yy: Record<string, unknown> };

// Excel's limit. The lexer and its error recovery cost a forged text its length squared, such as `a.a.a.…`, and every
// reader parses what a recompute reaches.
const MAX_FORMULA_LENGTH = 8192;

export class Parser {
    private parser: GrammarParserInstance;
    private variables: Record<string, FormulaArg>;
    private options: ParserOptions;

    public constructor() {
        this.parser = new GrammarParser();
        this.parser.yy = {
            toNumber,
            trimEdges,
            invertNumber,
            // An error typed into a formula, such as `#N/A`, is a value like a computed one, so ISERROR,
            // ERROR.TYPE or IFERROR around it can inspect it, as in Excel.
            errorValue: (errorName: string) => toFormulaError(Error(errorName)),
            callVariable: (variable: string) => this.callVariable(variable),
            evaluateByOperator,
            callFunction,
            cellValue: (value: string) => this.callCellValue(value),
            rangeValue: (start: string, end: string) => this.callRangeValue(start, end),
        };
        this.variables = Object.create(null);
        this.options = Object.create(null);

        this.setVariable('TRUE', true).setVariable('FALSE', false).setVariable('NULL', null);
    }

    public parse(expression: string, options: ParserOptions = {}): ParseResult {
        return this.evaluate(this.compile(expression), options);
    }

    // A syntax error is deferred to evaluation, where it surfaces like any other error.
    public compile(expression: string): CompiledFormula {
        if (expression === '') {
            return () => '';
        }
        try {
            return this.parseWithinLimit(expression);
        } catch (ex) {
            // A row delete writes #REF! where a reference stood, which not every place in the grammar takes.
            const failure = String(expression).includes(errorParser(ERROR_REF)) ? Error(ERROR_REF) : ex;
            return () => {
                throw failure;
            };
        }
    }

    public parses(expression: string): boolean {
        try {
            this.parseWithinLimit(expression);
            return true;
        } catch {
            return false;
        }
    }

    public evaluate(compiled: CompiledFormula, options: ParserOptions = {}): ParseResult {
        let result: unknown = null;
        let error: string | null = null;
        this.options = options;

        try {
            result = compiled();
        } catch (ex) {
            const message = ex instanceof Error ? errorParser(ex.message) : null;
            error = message ?? errorParser(ERROR);
        }

        if (result === UNSUPPORTED_ARRAY_OPERATION) {
            return { error: errorParser(ERROR_CALC), result: null, arrayOperation: true };
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
    public setVariable(name: string, value: FormulaArg): Parser {
        this.variables[name.toUpperCase()] = value;
        return this;
    }

    // `FormulaArg` because variables feed directly into the grammar's arithmetic/comparison
    // pipelines, which expect scalars or arrays (e.g. `setVariable('range', [1, 2, 3])` for
    // CORREL-style formulas).
    public getVariable(name: string): FormulaArg {
        return this.variables[name.toUpperCase()];
    }

    private parseWithinLimit(expression: string): CompiledFormula {
        if (expression.length > MAX_FORMULA_LENGTH) throw Error(ERROR);
        return this.parser.parse(expression);
    }

    // An unknown name is #NAME? in-band, like an unknown function, so IFERROR can trap it.
    private callVariable(name: string): FormulaArg {
        const value = this.getVariable(name);
        return value === undefined ? toFormulaError(Error(ERROR_NAME)) : value;
    }

    // Retrieve value by its label (`B3`, `B$3`, `$B$3`).
    private callCellValue(label: string): FormulaArg {
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
            return this.callVariable(label);
        }

        const { rowOffset = 0, colOffset = 0 } = this.options;
        const cellRow = offsetCoordinate(row, rowOffset, 'row');
        const cellColumn = offsetCoordinate(column, colOffset, 'column');
        if (cellRow == null || cellColumn == null) {
            throw Error(ERROR_REF);
        }

        return this.options.readCell?.({
            label: toLabel(cellRow, cellColumn),
            row: cellRow,
            column: cellColumn,
            sheetName,
        });
    }

    // Retrieve values by range label (`B3:A1`, `B$3:A1`, `B$3:$A1`, `$B$3:A$1`).
    private callRangeValue(startLabel: string, endLabel: string): FormulaValue[] | FormulaValue[][] {
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

        const { rowOffset = 0, colOffset = 0 } = this.options;
        const range = offsetRange([startRow, startColumn], [endRow, endColumn], rowOffset, colOffset);
        if (range == null) {
            throw Error(ERROR_REF);
        }
        const [[rowStart, colStart], [rowEnd, colEnd]] = range;

        const startCell: RangeCell = {
            row: rowStart,
            column: colStart,
            label: toLabel(rowStart, colStart),
            sheetName: startSheetName,
        };
        const endCell: RangeCell = { row: rowEnd, column: colEnd, label: toLabel(rowEnd, colEnd) };

        return this.options.readRange?.(startCell, endCell) ?? [];
    }
}
