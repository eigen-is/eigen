// The engines the benchmark compares, such as HyperFormula and IronCalc, behind one small interface: load sheets of
// cells, recalc, read a value, write a cell, insert rows or columns. The speed, correctness and coverage runs drive
// every engine only through it, each in a process of its own.

import * as fs from 'node:fs';
import { initSync, Model } from '@ironcalc/wasm';
import ironcalcWasm from '@ironcalc/wasm/wasm_bg.wasm' with { type: 'file' };
import type { ICellData, IWorksheetData } from '@univerjs/core';
import { CellValueType, LocaleType, mergeLocales, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { ALL_IMPLEMENTED_FUNCTIONS, UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import '@univerjs/engine-formula/facade';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import type { FWorksheet } from '@univerjs/sheets/facade';
import '@univerjs/sheets/facade';
import univerSheetsEnglish from '@univerjs/sheets/locale/en-US';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import '@univerjs/sheets-formula/facade';
import univerFormulaEnglish from '@univerjs/sheets-formula/locale/en-US';
import type { ConfigParams, RawCellContent } from 'hyperformula';
import { DetailedCellError, HyperFormula } from 'hyperformula';
import type { Literal, SheetSource } from '../src/index';
import { Engine, errorOf } from '../src/index';
import { sheetFinder, storedText } from '../src/text';

// One cell as a person types it: a text that starts with = is a formula, any other text stays a text.
export type Input = number | string | boolean | null;
export type SheetInput = { readonly name: string; readonly rows: readonly (readonly Input[])[] };
export type Value = Literal | null;

// Univer computes after a change on its own schedule, so its recalc returns a promise to wait for.
export type CellEngine = {
    load(sheets: readonly SheetInput[]): void;
    recalc(): void | Promise<void>;
    read(sheet: number, row: number, column: number): Value;
    write(sheet: number, row: number, column: number, input: Input): void;
    insertLines(sheet: number, index: number, count: number, rows: boolean): void;
};

// The clock and the draw the oracle gives our engine: the recorder's date, 12 November 2026, and seed 7.
const NOW = 46338.5;
const SEED = 7;

export class OursEngine implements CellEngine {
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

// IronCalc's WebAssembly module, compiled once per process before any clock runs.
initSync({ module: fs.readFileSync(new URL(ironcalcWasm, import.meta.url)) });
// Fifteen significant digits, as Excel keeps: IronCalc gives a value out only as formatted text.
const IRONCALC_DIGITS = '0.00000000000000E+0';
const IRONCALC_TYPES = { number: 1, text: 2, boolean: 4, error: 16 } as const;
// Its answers to a function it does not have: an unknown name, and a known one it does not implement.
export const IRONCALC_UNKNOWN: ReadonlySet<string> = new Set(['#NAME?', '#N/IMPL!']);

export class IronCalcEngine implements CellEngine {
    private model = new Model('Book1', 'en', 'UTC', 'en');

    // Automatic evaluation stays paused, as its documentation advises for many changes, so recalc evaluates once.
    // A new model has one sheet, which is renamed. Its rows and columns count from 1.
    public load(sheets: readonly SheetInput[]): void {
        this.model.free();
        this.model = new Model('Book1', 'en', 'UTC', 'en');
        this.model.pauseEvaluation();
        for (const [i, sheet] of sheets.entries()) {
            if (i > 0) this.model.newSheet();
            this.model.renameSheet(i, sheet.name);
        }
        for (const [i, sheet] of sheets.entries())
            for (const [row, inputs] of sheet.rows.entries())
                for (const [column, input] of inputs.entries())
                    if (input !== null) this.model.setUserInput(i, row + 1, column + 1, typed(input));
    }

    public recalc(): void {
        this.model.evaluate();
    }

    public read(sheet: number, row: number, column: number): Value {
        const [r, c] = [row + 1, column + 1];
        if (this.model.getCellContent(sheet, r, c) === '') return null;
        const type = this.model.getCellType(sheet, r, c);
        if (type === IRONCALC_TYPES.number) {
            this.model.updateRangeStyle({ sheet, row: r, column: c, width: 1, height: 1 }, 'num_fmt', IRONCALC_DIGITS);
            return Number(this.model.getFormattedCellValue(sheet, r, c));
        }
        const shown = this.model.getFormattedCellValue(sheet, r, c);
        if (type === IRONCALC_TYPES.boolean) return shown === 'TRUE';
        if (type === IRONCALC_TYPES.error) return errorOf(shown);
        return shown;
    }

    public write(sheet: number, row: number, column: number, input: Input): void {
        if (input === null) this.model.rangeClearContents(sheet, row + 1, column + 1, row + 1, column + 1);
        else this.model.setUserInput(sheet, row + 1, column + 1, typed(input));
    }

    public insertLines(sheet: number, index: number, count: number, rows: boolean): void {
        if (rows) this.model.insertRows(sheet, index + 1, count);
        else this.model.insertColumns(sheet, index + 1, count);
    }
}

// IronCalc takes every cell as typed text: the apostrophe keeps a text a text, as in Excel.
function typed(input: number | string | boolean): string {
    if (typeof input === 'boolean') return input ? 'TRUE' : 'FALSE';
    if (typeof input === 'number') return String(input);
    return input.startsWith('=') ? input : `'${input}`;
}

// Its English texts, which its sheets need even without a screen, as its Node guide registers them.
const UNIVER_LOCALES = { [LocaleType.EN_US]: mergeLocales(univerSheetsEnglish, univerFormulaEnglish) };
// Excel's grid, as HyperFormula gets.
const UNIVER_GRID = { rowCount: 1_048_576, columnCount: 16_384 };

export class UniverEngine implements CellEngine {
    private univer: Univer | undefined;
    private api: FUniver | undefined;
    private sheets: FWorksheet[] = [];

    // A new Univer per load, its formula plugins in the current process as its Node guide sets them up, and the
    // workbook as one snapshot, its bulk load. It computes the formulas after the snapshot, which recalc waits for.
    public load(sheets: readonly SheetInput[]): void {
        this.univer?.dispose();
        this.univer = new Univer({ locale: LocaleType.EN_US, locales: UNIVER_LOCALES });
        this.univer.registerPlugin(UniverFormulaEnginePlugin);
        this.univer.registerPlugin(UniverSheetsPlugin);
        this.univer.registerPlugin(UniverSheetsFormulaPlugin);
        this.api = FUniver.newAPI(this.univer);
        const ids = sheets.map((_, i) => `sheet${i}`);
        const data: Record<string, Partial<IWorksheetData>> = {};
        for (const [i, sheet] of sheets.entries()) {
            const cellData: Record<number, Record<number, ICellData>> = {};
            for (const [row, inputs] of sheet.rows.entries()) {
                const line: Record<number, ICellData> = {};
                for (const [column, input] of inputs.entries()) if (input !== null) line[column] = univerCell(input);
                cellData[row] = line;
            }
            data[ids[i]] = { id: ids[i], name: sheet.name, cellData, ...UNIVER_GRID };
        }
        const book = this.api.createWorkbook({ id: 'book', name: 'book', sheetOrder: ids, sheets: data });
        this.sheets = ids.flatMap((id) => book.getSheetBySheetId(id) ?? []);
    }

    public async recalc(): Promise<void> {
        await this.api?.getFormula().onCalculationResultApplied();
    }

    // The raw value keeps every digit; the cell's own value is rounded to 12, and a value spilled from an array has
    // only that one. An error comes out as its text, so a formula's text that names one is read as the error.
    public read(sheet: number, row: number, column: number): Value {
        const range = this.sheets[sheet].getRange(row, column);
        const data = range.getCellData();
        const value = range.getRawValue() ?? data?.v;
        if (value === undefined || value === null) return null;
        if (data?.t === CellValueType.BOOLEAN) return value === true || value === 1;
        if (data?.t === CellValueType.NUMBER) return Number(value);
        if (typeof value !== 'string') return value;
        const error = errorOf(value);
        return data?.f && error.code !== 0 ? error : value;
    }

    public write(sheet: number, row: number, column: number, input: Input): void {
        const range = this.sheets[sheet].getRange(row, column);
        if (input === null) range.clearContent();
        else range.setValue(univerCell(input));
    }

    public insertLines(sheet: number, index: number, count: number, rows: boolean): void {
        if (rows) this.sheets[sheet].insertRows(index, count);
        else this.sheets[sheet].insertColumns(index, count);
    }
}

function univerCell(input: number | string | boolean): ICellData {
    if (typeof input === 'number') return { v: input, t: CellValueType.NUMBER };
    if (typeof input === 'boolean') return { v: input ? 1 : 0, t: CellValueType.BOOLEAN };
    return input.startsWith('=') ? { f: input } : { v: input, t: CellValueType.FORCE_STRING };
}

// Every name Univer registers a function under.
export function univerNames(): string[] {
    return ALL_IMPLEMENTED_FUNCTIONS.map(([, name]) => String(name));
}

// IronCalc lists no names, so a name counts when =NAME() answers anything but its errors for a missing function.
export function ironcalcNames(names: Iterable<string>): string[] {
    const model = new Model('Book1', 'en', 'UTC', 'en');
    model.pauseEvaluation();
    const all = [...names];
    for (const [i, name] of all.entries()) model.setUserInput(0, i + 1, 1, `=${name}()`);
    model.evaluate();
    return all.filter((_, i) => !IRONCALC_UNKNOWN.has(model.getFormattedCellValue(0, i + 1, 1)));
}
