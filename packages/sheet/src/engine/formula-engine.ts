// The formula engine the editor and the server's recalc share. It owns one Parser, answers its cell and range reads
// from the CellResolver, and turns each result into a cell value, a display string and a type. An error a cell holds
// reads back as an error, so ISERROR and IFERROR see it.
// Every range read is clamped to the sheet's grid and counted against maxCellsRead. It also says when this build can't
// evaluate a formula's own text, which a recompute takes as no answer.

import { DependencyIndex } from './dependency-index';
import { cellValue } from './format';
import { inlineNames } from './formula-shift';
import { matrixWidth } from './formula-utils';
import { Parser } from './parser';
import errorParser, {
    ERROR,
    ERROR_NAME,
    ERROR_NUM,
    ERROR_REF,
    ERROR_VALUE,
    toFormulaError,
    UNSUPPORTED_FUNCTION,
    valueIsError,
} from './parser/error';
import { isRegisteredFunction } from './parser/evaluate-by-operator/evaluate-by-operator';
import { dateToSerial } from './parser/helper/number';
import type {
    Cell,
    CellInfo,
    CellMatrix,
    CellResolver,
    CompiledFormula,
    EvaluationResult,
    FormulaEngineState,
    FormulaValue,
    RangeCell,
} from './types';

// A cell holds an error as its text and a formula reads it back as formulajs's error object, which its functions
// recognize by identity. A `#NAME?` reads as an unsupported function, which no function traps, so no fallback passes.
function getCellValue(cell: Cell | null | undefined): FormulaValue {
    if (cell?.ct?.t === 'n') {
        const n = Number(cell.v);
        return Number.isNaN(n) ? cell.v : n;
    }
    const value = cellValue(cell);
    const text = cell?.ct?.t === 's' || cell?.ct?.t === 'inlineStr';
    if (typeof value !== 'string' || text || !valueIsError(value)) return value;
    return value === errorParser(ERROR_NAME) ? UNSUPPORTED_FUNCTION : toFormulaError(Error(value));
}

// A name as Excel spells one: a letter, `_` or `\` first, then letters, digits, `_`, `.`, `\` or `?`.
const NAME_RE = /^[\p{L}_\\][\p{L}\p{N}_.\\?]*$/u;

// The lookbehind starts a match only at a name's first letter. Without it a long name costs its length squared.
const FUNCTION_CALL_RE = /(?<![\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_.]*)\s*\(/gu;

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
    // Each sheet's width, by sheet id, for the resolver in `widthsOf`. A resolver hands out the same matrices for as
    // long as it is used, so their widths hold as long, and a range read needn't scan every row of its sheet.
    private widths = new Map<string, number>();
    private widthsOf: CellResolver | null = null;
    // The cells range reads have cost; a read that would pass `maxCellsRead` fails before it reads.
    private cellsRead = 0;
    private readonly maxCellsRead: number;

    public constructor({ maxCellsRead = Number.POSITIVE_INFINITY } = {}) {
        this.maxCellsRead = maxCellsRead;
        this.state = {
            formulaCellInfoMap: null,
            dependencyIndex: new DependencyIndex(),
        };

        this.parser = new Parser();
    }

    // True when the result says nothing because of the formula's own text: a parse failure, a function this build
    // lacks that the branch taken holds, or a name it can't resolve, whose #NAME? an IFERROR would trap into a fallback
    // nobody computed. A #NAME? read from another cell is the other cell's. A name Excel reads past its last column
    // (RhoCO2) is one the engine reads as a cell. A #REF! is an answer whatever else the text holds.
    public cantEvaluate(formula: string, { value }: EvaluationResult): boolean {
        if (value === errorParser(ERROR_REF)) return false;
        if (value === errorParser(ERROR) && !this.parser.parses(formula.substring(1))) return true;
        if (value === errorParser(ERROR_NAME)) {
            const calls = formula.replace(/"(?:[^"]|"")*"/g, '""').matchAll(FUNCTION_CALL_RE);
            for (const [, name] of calls) if (!isRegisteredFunction(name)) return true;
        }
        let unknown = false;
        inlineNames(formula, (name) => {
            if (NAME_RE.test(name) && this.parser.getVariable(name) === undefined) unknown = true;
            return undefined;
        });
        return unknown;
    }

    public assertWithinCellBudget(): void {
        if (this.cellsRead > this.maxCellsRead) throw new RangeError('Formula ranges read past the cell budget');
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
        const { error, result: evaluated } = this.parser.evaluate(compiled, {
            rowOffset,
            colOffset,
            readCell: (cell) => this.readCell(cell, sheetId, resolver),
            readRange: (start, end) => this.readRange(start, end, sheetId, resolver),
        });

        // The engine has no spill, so an array result keeps its top-left value, the one Excel's spill anchor holds.
        // That value may be an error a cell holds, as in `=A1:B2`.
        let result = evaluated;
        while (Array.isArray(result)) result = result[0];
        const failure = result instanceof Error ? (errorParser(result.message) ?? errorParser(ERROR)) : error;
        if (failure != null) {
            return { value: failure, display: failure, type: 'error' };
        }

        // A Date result stores as its Excel serial, as the parser's operators read a Date operand. As a string, a DATE
        // or EOMONTH cell would turn into text on the xlsx round trip.
        const serial = result instanceof Date ? dateToSerial(result) : result;
        // NaN and Infinity survive no JSON, so a tab and a joiner would hold different cells. Excel's word is #NUM!.
        if (typeof serial === 'number' && !Number.isFinite(serial)) {
            const overflow = errorParser(ERROR_NUM);
            return { value: overflow, display: overflow, type: 'error' };
        }
        if (result instanceof Date) return { value: serial, display: String(serial), type: 'date' };

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
    }

    private readCell(cell: CellInfo, formulaSheetId: string, resolver: CellResolver): FormulaValue {
        const sheetId = cell.sheetName == null ? formulaSheetId : resolver.getSheetIdByName(cell.sheetName);
        if (sheetId == null) throw Error(ERROR_REF);
        return getCellValue(resolver.getCell(sheetId, cell.row.index, cell.column.index));
    }

    private readRange(
        start: RangeCell,
        end: RangeCell,
        formulaSheetId: string,
        resolver: CellResolver,
    ): FormulaValue[][] {
        const sheetId = start.sheetName == null ? formulaSheetId : resolver.getSheetIdByName(start.sheetName);
        if (sheetId == null) throw Error(ERROR_REF);

        let startRow = start.row.index;
        let endRow = end.row.index;
        let startCol = start.column.index;
        let endCol = end.column.index;

        // A whole row or column (`3:3`, `A:A`) has no column or row index, so it spans the grid.
        const emptyRow = startRow === -1 || endRow === -1;
        const emptyCol = startCol === -1 || endCol === -1;
        if (emptyRow && emptyCol) throw Error(ERROR_REF);

        // The grid bounds every range, explicit endpoints included, because an unclamped `A1:XFD1048576` is 17 billion
        // cells. So `ROWS(A1:A100)` answers the grid's row count, as `ROWS(A:A)` does.
        const sheetData = resolver.getSheetData(sheetId);
        const lastRow = (sheetData?.length ?? 0) - 1;
        const lastCol = this.widthOf(resolver, sheetId, sheetData) - 1;
        if (emptyRow) startRow = 0;
        if (emptyCol) startCol = 0;
        endRow = emptyRow ? lastRow : Math.min(endRow, lastRow);
        endCol = emptyCol ? lastCol : Math.min(endCol, lastCol);
        if (endRow >= startRow && endCol >= startCol) {
            this.cellsRead += (endRow - startRow + 1) * (endCol - startCol + 1);
            if (this.cellsRead > this.maxCellsRead) throw Error(ERROR_VALUE);
        }

        const fragment: FormulaValue[][] = [];
        for (let row = startRow; row <= endRow; row++) {
            const colFragment: FormulaValue[] = [];
            for (let col = startCol; col <= endCol; col++) {
                colFragment.push(getCellValue(resolver.getCell(sheetId, row, col)));
            }
            fragment.push(colFragment);
        }
        return fragment;
    }

    // The number of columns a sheet has: its widest row's, as a stored matrix may lack rows, its first among them.
    private widthOf(resolver: CellResolver, sheetId: string, matrix: CellMatrix | null): number {
        if (this.widthsOf !== resolver) {
            this.widthsOf = resolver;
            this.widths.clear();
        }
        let width = this.widths.get(sheetId);
        if (width === undefined) {
            width = matrix ? matrixWidth(matrix) : 0;
            this.widths.set(sheetId, width);
        }
        return width;
    }
}
