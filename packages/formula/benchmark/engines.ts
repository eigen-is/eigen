// The engines the benchmark compares, behind one small interface: load sheets of cells, recalc, read a value,
// write a cell, insert rows or columns. Ours and HyperFormula hold cells; formulajs is a library of functions with
// no cells, so it gets a second, smaller interface: call one function with plain arguments. The speed, correctness
// and coverage runs drive every engine only through these, each in a process of its own.

import * as formulajs from '@formulajs/formulajs';
import type { ConfigParams, RawCellContent } from 'hyperformula';
import { DetailedCellError, HyperFormula } from 'hyperformula';
import type { Literal, SheetSource } from '../src/index';
import { Engine, errorOf } from '../src/index';
import { sheetFinder, storedText } from '../src/text';

// One cell as a person types it: a text that starts with = is a formula, any other text stays a text.
export type Input = number | string | boolean | null;
export type SheetInput = { readonly name: string; readonly rows: readonly (readonly Input[])[] };
export type Value = Literal | null;

export type CellEngine = {
    readonly name: string;
    load(sheets: readonly SheetInput[]): void;
    recalc(): void;
    read(sheet: number, row: number, column: number): Value;
    write(sheet: number, row: number, column: number, input: Input): void;
    insertLines(sheet: number, index: number, count: number, rows: boolean): void;
};

// The clock and the draw the oracle gives our engine: the recorder's date, 12 November 2026, and seed 7.
const NOW = 46338.5;
const SEED = 7;

export class OursEngine implements CellEngine {
    public readonly name = 'ours';
    private engine = new Engine([]);
    private ids: string[] = [];
    private find: (name: string) => { readonly id: string } | undefined = () => undefined;

    // A formula is turned into its stored text here, in the timed load, since that is where our engine parses.
    public load(sheets: readonly SheetInput[]): void {
        this.ids = sheets.map((_, i) => `s${i}`);
        this.find = sheetFinder(sheets.map((sheet, i) => ({ id: this.ids[i], name: sheet.name })));
        const sources: SheetSource[] = sheets.map((sheet, i) => {
            const cells: [number, number, Literal | null, string | null][] = [];
            for (const [row, inputs] of sheet.rows.entries()) {
                for (const [column, input] of inputs.entries()) {
                    if (input === null) continue;
                    const formula = typeof input === 'string' && input.startsWith('=');
                    cells.push(
                        formula ? [row, column, null, this.stored(input, row, column)] : [row, column, input, null],
                    );
                }
            }
            return {
                id: this.ids[i],
                name: sheet.name,
                cells: (sink) => {
                    for (const [row, column, value, formula] of cells) sink(row, column, value, formula);
                },
            };
        });
        this.engine = new Engine(sources);
    }

    public recalc(): void {
        this.engine.recalc(Number.POSITIVE_INFINITY, NOW, SEED);
    }

    public read(sheet: number, row: number, column: number): Value {
        return this.engine.valueOf(this.ids[sheet], row, column);
    }

    public write(sheet: number, row: number, column: number, input: Input): void {
        const id = this.ids[sheet];
        if (input === null) this.engine.clear(id, row, column);
        else if (typeof input === 'string' && input.startsWith('='))
            this.engine.setFormula(id, row, column, this.stored(input, row, column));
        else this.engine.setValue(id, row, column, input);
    }

    public insertLines(sheet: number, index: number, count: number, rows: boolean): void {
        this.engine.editLines({ insert: true, index, count, sheet: this.ids[sheet], rows });
    }

    private stored(typed: string, row: number, column: number): string {
        return storedText(typed, row, column, this.find);
    }
}

// HyperFormula's own guide to Excel compatibility, with Excel's grid size, since its default stops at 40,000 rows.
export const HYPERFORMULA_CONFIG: Partial<ConfigParams> = {
    licenseKey: 'gpl-v3',
    dateFormats: ['MM/DD/YYYY', 'MM/DD/YY', 'YYYY/MM/DD'],
    timeFormats: ['hh:mm', 'hh:mm:ss.sss'],
    currencySymbol: ['$', 'USD'],
    localeLang: 'en-US',
    functionArgSeparator: ',',
    decimalSeparator: '.',
    thousandSeparator: '',
    arrayColumnSeparator: ',',
    arrayRowSeparator: ';',
    nullYear: 30,
    caseSensitive: false,
    accentSensitive: true,
    ignorePunctuation: false,
    useWildcards: true,
    useRegularExpressions: false,
    matchWholeCell: true,
    useArrayArithmetic: true,
    ignoreWhiteSpace: 'any',
    evaluateNullToZero: true,
    leapYear1900: true,
    nullDate: { year: 1899, month: 12, day: 31 },
    smartRounding: true,
    maxRows: 1_048_576,
    maxColumns: 16_384,
};
// The same guide defines TRUE and FALSE as names, since Excel has them as words.
const HYPERFORMULA_NAMES = [
    { name: 'TRUE', expression: '=TRUE()' },
    { name: 'FALSE', expression: '=FALSE()' },
];

export class HyperFormulaEngine implements CellEngine {
    public readonly name = 'hyperformula';
    private engine = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });
    private ids: number[] = [];

    // `extra` is a setting its documentation advises for a workload, such as the column index for lookups.
    public constructor(private readonly extra: Partial<ConfigParams> = {}) {}

    // buildFromSheets is its bulk load, and it computes every formula before it returns.
    public load(sheets: readonly SheetInput[]): void {
        this.engine.destroy();
        const contents: Record<string, RawCellContent[][]> = {};
        for (const sheet of sheets) contents[sheet.name] = sheet.rows.map((inputs) => inputs.map(raw));
        this.engine = HyperFormula.buildFromSheets(
            contents,
            { ...HYPERFORMULA_CONFIG, ...this.extra },
            HYPERFORMULA_NAMES,
        );
        this.ids = sheets.map((sheet) => this.engine.getSheetId(sheet.name) ?? -1);
    }

    public recalc(): void {}

    public read(sheet: number, row: number, column: number): Value {
        const value = this.engine.getCellValue({ sheet: this.ids[sheet], row, col: column });
        return value instanceof DetailedCellError ? errorOf(value.value) : value;
    }

    public write(sheet: number, row: number, column: number, input: Input): void {
        this.engine.setCellContents({ sheet: this.ids[sheet], row, col: column }, raw(input));
    }

    public insertLines(sheet: number, index: number, count: number, rows: boolean): void {
        if (rows) this.engine.addRows(this.ids[sheet], [index, count]);
        else this.engine.addColumns(this.ids[sheet], [index, count]);
    }
}

// HyperFormula reads a typed text as a number or a date where it can; the apostrophe keeps it a text, as in Excel.
function raw(input: Input): RawCellContent {
    return typeof input === 'string' && !input.startsWith('=') ? `'${input}` : input;
}

// A formulajs function by Excel's name: NORM.DIST is the DIST member of its NORM export.
export function formulajsFunction(name: string): ((...args: unknown[]) => unknown) | undefined {
    let found: unknown = formulajs;
    for (const part of name.split('.')) {
        if (found === null || (typeof found !== 'object' && typeof found !== 'function')) return undefined;
        found = Reflect.get(found, part);
    }
    return typeof found === 'function' ? (...args: unknown[]) => Reflect.apply(found, undefined, args) : undefined;
}

// Every name formulajs exports a function under, the dotted ones included.
export function formulajsNames(): string[] {
    const names: string[] = [];
    const walk = (from: object, prefix: string) => {
        for (const [key, value] of Object.entries(from)) {
            if (key === 'default') continue;
            const name = prefix === '' ? key : `${prefix}.${key}`;
            if (typeof value === 'function') names.push(name);
            if (value !== null && (typeof value === 'object' || typeof value === 'function')) walk(value, name);
        }
    };
    walk(formulajs, '');
    return [...new Set(names)].sort();
}

// A formulajs answer as a cell value: an Error is the error its message names, and a Date, which formulajs builds in
// local time, is Excel's day number.
export function formulajsValue(answer: unknown): Value {
    if (answer === null || answer === undefined) return null;
    if (typeof answer === 'number' || typeof answer === 'string' || typeof answer === 'boolean') return answer;
    if (answer instanceof Error) return errorOf(answer.message);
    if (answer instanceof Date) {
        const local = Date.UTC(
            answer.getFullYear(),
            answer.getMonth(),
            answer.getDate(),
            answer.getHours(),
            answer.getMinutes(),
            answer.getSeconds(),
            answer.getMilliseconds(),
        );
        return (local - Date.UTC(1899, 11, 30)) / 86_400_000;
    }
    return String(answer);
}
