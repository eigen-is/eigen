// What each engine covers: how many of Excel's functions it registers, and a yes or no per language feature, each
// found by running a probe formula and reading the answer, never from a feature list. formulajs has no parser and
// no cells, so it has no language features; only its function names count. The run calls it in its own process.

import { HyperFormula } from 'hyperformula';
import { EXCEL_2007_FUNCTIONS, EXCEL_FUTURE_FUNCTIONS } from '../src/functions/excel-names';
import { FUNCTIONS } from '../src/index';
import type { CellEngine, Input, SheetInput, Value } from './engines';
import { formulajsNames, HyperFormulaEngine, OursEngine } from './engines';

export type FunctionCount = { readonly excel: number; readonly other: number };
export type Feature = {
    readonly name: string;
    readonly probe: string;
    readonly answers: Readonly<Record<'ours' | 'hyperformula', string>>;
    readonly passes: Readonly<Record<'ours' | 'hyperformula', boolean>>;
};
export type Coverage = {
    readonly excel: number;
    readonly functions: Readonly<Record<'ours' | 'hyperformula' | 'formulajs', FunctionCount>>;
    // Excel's functions that HyperFormula registers and ours does not, and the other way round.
    readonly onlyHyperformula: readonly string[];
    readonly onlyOurs: readonly string[];
    readonly features: readonly Feature[];
};

type Probe = {
    readonly name: string;
    readonly probe: string;
    readonly sheets: readonly SheetInput[];
    readonly edit?: (engine: CellEngine) => void;
    // The cell to read after the load and the edit, and the answer that means yes.
    readonly read: readonly [number, number, number];
    readonly wanted: (value: Value) => boolean;
};

function sheet(name: string, rows: readonly (readonly Input[])[]): SheetInput {
    return { name, rows };
}

const NUMBERS = [[1], [2], [3]];
const is = (wanted: number) => (value: Value) => value === wanted;

const PROBES: readonly Probe[] = [
    {
        name: 'An array answer spills into the cells below',
        probe: '=A1:A3*2 in C1, read C2',
        sheets: [sheet('Sheet1', [[1, null, '=A1:A3*2'], [2], [3]])],
        read: [0, 1, 2],
        wanted: is(4),
    },
    {
        name: 'Array arithmetic inside one formula',
        probe: '=SUM(A1:A3*{1;2;3})',
        sheets: [sheet('Sheet1', [[1, null, '=SUM(A1:A3*{1;2;3})'], [2], [3]])],
        read: [0, 0, 2],
        wanted: is(14),
    },
    {
        name: 'A dynamic-array function (FILTER)',
        probe: '=SUM(FILTER(A1:A3,A1:A3>1))',
        sheets: [sheet('Sheet1', [[1, null, '=SUM(FILTER(A1:A3,A1:A3>1))'], [2], [3]])],
        read: [0, 0, 2],
        wanted: is(5),
    },
    {
        name: 'Implicit intersection with @',
        probe: '=@A1:A3 in row 2',
        sheets: [sheet('Sheet1', [[1], [2, null, '=@A1:A3'], [3]])],
        read: [0, 1, 2],
        wanted: is(2),
    },
    {
        name: 'Structured table reference',
        probe: '=SUM(Table1[Qty])',
        sheets: [sheet('Sheet1', [['Qty', null, '=SUM(Table1[Qty])'], ...NUMBERS])],
        read: [0, 0, 2],
        wanted: is(6),
    },
    {
        name: 'LET',
        probe: '=LET(x,2,x*3)',
        sheets: [sheet('Sheet1', [['=LET(x,2,x*3)']])],
        read: [0, 0, 0],
        wanted: is(6),
    },
    {
        name: 'LAMBDA called in place',
        probe: '=LAMBDA(x,x+1)(2)',
        sheets: [sheet('Sheet1', [['=LAMBDA(x,x+1)(2)']])],
        read: [0, 0, 0],
        wanted: is(3),
    },
    {
        name: 'Whole-column reference',
        probe: '=SUM(A:A)',
        sheets: [sheet('Sheet1', [[1, null, '=SUM(A:A)'], [2], [3]])],
        read: [0, 0, 2],
        wanted: is(6),
    },
    {
        name: 'Reference to another sheet',
        probe: '=Sheet2!A1*2',
        sheets: [sheet('Sheet1', [['=Sheet2!A1*2']]), sheet('Sheet2', [[10]])],
        read: [0, 0, 0],
        wanted: is(20),
    },
    {
        name: '3-D reference across sheets',
        probe: '=SUM(Sheet2:Sheet3!A1)',
        sheets: [sheet('Sheet1', [['=SUM(Sheet2:Sheet3!A1)']]), sheet('Sheet2', [[10]]), sheet('Sheet3', [[5]])],
        read: [0, 0, 0],
        wanted: is(15),
    },
    {
        name: 'A circular reference is reported as an error',
        probe: '=B1 in A1, =A1 in B1',
        sheets: [sheet('Sheet1', [['=B1', '=A1']])],
        read: [0, 0, 0],
        wanted: (value) => value !== null && typeof value === 'object',
    },
    {
        name: 'A row insert rewrites the references',
        probe: '=A1*2 in B5, insert a row above row 1, read B6',
        sheets: [sheet('Sheet1', [[1], [], [], [], [null, '=A1*2']])],
        edit: (engine) => engine.insertLines(0, 0, 1, true),
        read: [0, 5, 1],
        wanted: is(2),
    },
    {
        name: 'A column insert rewrites the references',
        probe: '=A1*3 in D1, insert a column before A, read E1',
        sheets: [sheet('Sheet1', [[1, null, null, '=A1*3']])],
        edit: (engine) => engine.insertLines(0, 0, 1, false),
        read: [0, 0, 4],
        wanted: is(3),
    },
];

function shown(value: Value): string {
    if (value === null) return 'blank';
    if (typeof value === 'object') return value.text;
    return typeof value === 'string' ? `"${value}"` : String(value);
}

function count(names: Iterable<string>, excel: ReadonlySet<string>): FunctionCount {
    const unique = new Set([...names].map((name) => name.toUpperCase()));
    const known = [...unique].filter((name) => excel.has(name)).length;
    return { excel: known, other: unique.size - known };
}

export function coverage(): Coverage {
    const excel = new Set([...EXCEL_FUTURE_FUNCTIONS, ...EXCEL_2007_FUNCTIONS]);
    const hyperformula = HyperFormula.getRegisteredFunctionNames('enGB');
    const ours = new Set(FUNCTIONS.keys());
    const theirs = new Set(hyperformula.map((name) => name.toUpperCase()));
    const features = PROBES.map(({ name, probe, sheets, edit, read, wanted }) => {
        const run = (engine: CellEngine) => {
            try {
                engine.load(sheets);
                engine.recalc();
                edit?.(engine);
                engine.recalc();
                const value = engine.read(...read);
                return { answer: shown(value), passes: wanted(value) };
            } catch (error) {
                return { answer: `throws: ${String(error).slice(0, 60)}`, passes: false };
            }
        };
        const [oursRun, theirRun] = [run(new OursEngine()), run(new HyperFormulaEngine())];
        return {
            name,
            probe,
            answers: { ours: oursRun.answer, hyperformula: theirRun.answer },
            passes: { ours: oursRun.passes, hyperformula: theirRun.passes },
        };
    });
    return {
        excel: excel.size,
        functions: {
            ours: count(ours, excel),
            hyperformula: count(hyperformula, excel),
            formulajs: count(formulajsNames(), excel),
        },
        onlyHyperformula: [...theirs].filter((name) => excel.has(name) && !ours.has(name)).sort(),
        onlyOurs: [...ours].filter((name) => excel.has(name) && !theirs.has(name)).sort(),
        features,
    };
}
