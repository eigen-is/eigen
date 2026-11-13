// The speed workloads, built in code so they need nothing but the repo, and the child process that times one
// workload on one engine. A child builds a fresh engine per run, does the run up to three times and reports its
// fastest, so the first run warms the runtime up; it also reports the values of a sample of cells, which the run
// compares across engines before a time counts. A workload without an edit times the load and first compute; one
// with an edit times the edit and the recompute after it. formulajs takes part where the answers are plain calls.

import { parseArgs } from 'node:util';
import * as formulajs from '@formulajs/formulajs';
import type { ConfigParams } from 'hyperformula';
import type { CellEngine, Input, SheetInput, Value } from './engines';
import { formulajsValue, HyperFormulaEngine, OursEngine } from './engines';

export const ENGINES = ['ours', 'hyperformula', 'formulajs'] as const;
export type EngineName = (typeof ENGINES)[number];
type Cell = readonly [number, number, number];

export type Workload = {
    readonly name: string;
    // One sentence for the README on what the workload is.
    readonly what: string;
    readonly sheets: () => SheetInput[];
    readonly edit?: (engine: CellEngine) => void;
    // The cells whose values are compared across engines, after the timed step.
    readonly reads: () => readonly Cell[];
    // A setting HyperFormula's documentation advises for this workload.
    readonly hyperformula?: Partial<ConfigParams>;
    // formulajs: work out the inputs from the sheets, untimed, and return the timed calls, which answer the reads.
    readonly formulajs?: (sheets: readonly SheetInput[]) => () => Value[];
    // Report the memory the engine holds after the load instead of a time.
    readonly memory?: boolean;
};
export type Measured = { readonly ms: number; readonly values: readonly string[] };

const ROWS = 100_000;
const LOOKUPS = 2000;
const SUMS = 200;
const CRITERIA = 200;
// A child stops repeating a run once its runs took this long, so a slow engine is timed fewer times per process.
const ENOUGH_MS = 20_000;
const LOOKUP_INDEX: Partial<ConfigParams> = { useColumnIndex: true };

function grid(count: number, row: (r: number) => Input[]): SheetInput[] {
    return [{ name: 'Sheet1', rows: Array.from({ length: count }, (_, r) => row(r)) }];
}

function every(count: number, step: number, columns: readonly number[], shift = 0): Cell[] {
    const cells: Cell[] = [];
    for (let r = 0; r < count; r += step) for (const column of columns) cells.push([0, r + shift, column]);
    return cells;
}

// Column `column` of the first sheet, from row 0 down `count` rows.
function columnOf(sheets: readonly SheetInput[], column: number, count = sheets[0].rows.length): Input[] {
    return sheets[0].rows.slice(0, count).map((row) => row[column] ?? null);
}

function numbers(sheets: readonly SheetInput[], column: number, count?: number): number[] {
    return columnOf(sheets, column, count).map((input) => (typeof input === 'number' ? input : 0));
}

function texts(sheets: readonly SheetInput[], column: number, count?: number): string[] {
    return columnOf(sheets, column, count).map((input) => String(input ?? ''));
}

// 100,000 rows of two numbers and three formulas on each row.
function threeFormulas(): SheetInput[] {
    return grid(ROWS, (r) => {
        const n = r + 1;
        return [
            (r % 1000) + 0.5,
            (r * 7) % 13,
            `=A${n}*2+B${n}`,
            `=IF(C${n}>1000,C${n}-1000,C${n})`,
            `=ROUND(D${n}/3,2)`,
        ];
    });
}

// A long column of keys in A and values in B, and lookup formulas in F of the keys in E.
function lookups(sorted: boolean, formula: (n: number) => string): () => SheetInput[] {
    return () =>
        grid(ROWS, (r) => {
            const key = sorted ? r * 2 : (r * 7919) % ROWS;
            const row: Input[] = [key, r * 3];
            if (r < LOOKUPS) row.push(null, null, sorted ? r * 17 + 1 : (r * 37) % ROWS, formula(r + 1));
            return row;
        });
}

function lookupReads(): Cell[] {
    return every(LOOKUPS, 7, [5]);
}

// Keys and values as formulajs takes a table: a list of rows.
function table(sheets: readonly SheetInput[]): {
    readonly keys: number[];
    readonly rows: number[][];
    readonly wanted: number[];
} {
    const keys = numbers(sheets, 0);
    const values = numbers(sheets, 1);
    return { keys, rows: keys.map((key, i) => [key, values[i]]), wanted: numbers(sheets, 4, LOOKUPS) };
}

// Every answer is computed, as every formula is in the engines, and every `step`-th is kept for the comparison.
function sampled(answers: (i: number) => unknown, count: number, step: number): Value[] {
    const values: Value[] = [];
    for (let i = 0; i < count; i += 1) {
        const answer = answers(i);
        if (i % step === 0) values.push(formulajsValue(answer));
    }
    return values;
}

// The criteria data: amounts in A, ten keys in B, a number from 0 to 99 in C, and criteria for 200 formulas.
function criteria(formula: (n: number) => string): () => SheetInput[] {
    return () =>
        grid(ROWS, (r) => {
            const row: Input[] = [(r % 1000) / 4, `k${r % 10}`, r % 100];
            if (r < CRITERIA) row.push(null, `k${(r * 3) % 10}`, `>${r % 100}`, formula(r + 1));
            return row;
        });
}

function criteriaInputs(sheets: readonly SheetInput[]) {
    return {
        amounts: numbers(sheets, 0),
        keys: texts(sheets, 1),
        bands: numbers(sheets, 2),
        wantedKeys: texts(sheets, 4, CRITERIA),
        wantedBands: texts(sheets, 5, CRITERIA),
    };
}

export const WORKLOADS: readonly Workload[] = [
    {
        name: 'load and compute 300,000 formulas',
        what: '100,000 rows, each with two numbers and three formulas (arithmetic, IF, ROUND), loaded and computed.',
        sheets: threeFormulas,
        reads: () => every(ROWS, 97, [2, 3, 4]),
    },
    {
        name: 'edit a cell with 3 dependents',
        what: 'In that workbook, one number in row 50,001 changes, and the three formulas on its row recompute.',
        sheets: threeFormulas,
        edit: (engine) => engine.write(0, 50_000, 0, 7.25),
        reads: () => [[0, 50_000, 2], [0, 50_000, 3], [0, 50_000, 4], ...every(ROWS, 997, [4])],
    },
    {
        name: 'edit a cell read by 100,000 formulas',
        what: 'Cell A1 is read by 100,000 formulas (=B1*$A$1+1 and so on); A1 changes and every formula recomputes. This is a full recalculation.',
        sheets: () => grid(ROWS, (r) => [r === 0 ? 2 : null, r, `=B${r + 1}*$A$1+1`]),
        edit: (engine) => engine.write(0, 0, 0, 3),
        reads: () => every(ROWS, 97, [2]),
    },
    {
        name: 'load a chain of 100,000 formulas',
        what: 'A1 is 1 and each cell below adds 1 to the cell above it (=A1+1, =A2+1, ...), 100,000 cells deep.',
        sheets: () => grid(ROWS, (r) => [r === 0 ? 1 : `=A${r}+1`]),
        reads: () => [...every(ROWS, 997, [0]), [0, ROWS - 1, 0]],
    },
    {
        name: 'edit the start of a chain of 100,000',
        what: 'In that chain, A1 changes, so all 100,000 cells below it recompute in order.',
        sheets: () => grid(ROWS, (r) => [r === 0 ? 1 : `=A${r}+1`]),
        edit: (engine) => engine.write(0, 0, 0, 2),
        reads: () => [...every(ROWS, 997, [0]), [0, ROWS - 1, 0]],
    },
    {
        name: '200 sums of 90,000 cells each',
        what: '200 formulas =SUM(A1:A90000), =SUM(A2:A90001) and so on, over 100,000 numbers.',
        sheets: () => grid(ROWS, (r) => [(r % 100) + 0.25, r < SUMS ? `=SUM(A${r + 1}:A${r + 90_000})` : null]),
        reads: () => every(SUMS, 1, [1]),
        formulajs: (sheets) => {
            const values = numbers(sheets, 0);
            return () => sampled((i) => formulajs.SUM(values.slice(i, i + 90_000)), SUMS, 1);
        },
    },
    {
        name: 'running total down 20,000 rows',
        what: 'Each of 20,000 rows sums everything above it and itself: =SUM($A$1:A1), =SUM($A$1:A2) and so on.',
        sheets: () => grid(20_000, (r) => [(r % 10) + 1, `=SUM($A$1:A${r + 1})`]),
        reads: () => every(20_000, 50, [1]),
        formulajs: (sheets) => {
            const values = numbers(sheets, 0);
            return () => sampled((i) => formulajs.SUM(values.slice(0, i + 1)), 20_000, 50);
        },
    },
    {
        name: 'exact VLOOKUP, 2,000 over 100,000 rows',
        what: '2,000 formulas =VLOOKUP(E1,$A$1:$B$100000,2,FALSE) over 100,000 keys in no order.',
        sheets: lookups(false, (n) => `=VLOOKUP(E${n},$A$1:$B$100000,2,FALSE)`),
        reads: lookupReads,
        hyperformula: LOOKUP_INDEX,
        formulajs: (sheets) => {
            const { rows, wanted } = table(sheets);
            return () => sampled((i) => formulajs.VLOOKUP(wanted[i], rows, 2, false), LOOKUPS, 7);
        },
    },
    {
        name: 'approximate VLOOKUP, 2,000 over 100,000 rows',
        what: '2,000 formulas =VLOOKUP(E1,$A$1:$B$100000,2,TRUE) over 100,000 sorted keys; each key falls between two.',
        sheets: lookups(true, (n) => `=VLOOKUP(E${n},$A$1:$B$100000,2,TRUE)`),
        reads: lookupReads,
        hyperformula: LOOKUP_INDEX,
        formulajs: (sheets) => {
            const { rows, wanted } = table(sheets);
            return () => sampled((i) => formulajs.VLOOKUP(wanted[i], rows, 2, true), LOOKUPS, 7);
        },
    },
    {
        name: 'exact MATCH, 2,000 over 100,000 rows',
        what: '2,000 formulas =MATCH(E1,$A$1:$A$100000,0) over 100,000 keys in no order.',
        sheets: lookups(false, (n) => `=MATCH(E${n},$A$1:$A$100000,0)`),
        reads: lookupReads,
        hyperformula: LOOKUP_INDEX,
        formulajs: (sheets) => {
            const { keys, wanted } = table(sheets);
            return () => sampled((i) => formulajs.MATCH(wanted[i], keys, 0), LOOKUPS, 7);
        },
    },
    {
        name: 'approximate MATCH, 2,000 over 100,000 rows',
        what: '2,000 formulas =MATCH(E1,$A$1:$A$100000,1) over 100,000 sorted keys.',
        sheets: lookups(true, (n) => `=MATCH(E${n},$A$1:$A$100000,1)`),
        reads: lookupReads,
        hyperformula: LOOKUP_INDEX,
        formulajs: (sheets) => {
            const { keys, wanted } = table(sheets);
            return () => sampled((i) => formulajs.MATCH(wanted[i], keys, 1), LOOKUPS, 7);
        },
    },
    {
        name: 'exact XLOOKUP, 2,000 over 100,000 rows',
        what: '2,000 formulas =XLOOKUP(E1,$A$1:$A$100000,$B$1:$B$100000) over 100,000 keys in no order.',
        sheets: lookups(false, (n) => `=XLOOKUP(E${n},$A$1:$A$100000,$B$1:$B$100000)`),
        reads: lookupReads,
        hyperformula: LOOKUP_INDEX,
    },
    {
        name: 'SUMIFS, 200 over 100,000 rows',
        what: '200 formulas =SUMIFS($A$1:$A$100000,$B$1:$B$100000,E1,$C$1:$C$100000,F1), each with its own pair of criteria such as "k3" and ">37".',
        sheets: criteria((n) => `=SUMIFS($A$1:$A$100000,$B$1:$B$100000,E${n},$C$1:$C$100000,F${n})`),
        reads: () => every(CRITERIA, 1, [6]),
        formulajs: (sheets) => {
            const { amounts, keys, bands, wantedKeys, wantedBands } = criteriaInputs(sheets);
            return () =>
                sampled((i) => formulajs.SUMIFS(amounts, keys, wantedKeys[i], bands, wantedBands[i]), CRITERIA, 1);
        },
    },
    {
        name: 'COUNTIFS, 200 over 100,000 rows',
        what: '200 formulas =COUNTIFS($B$1:$B$100000,E1,$C$1:$C$100000,F1) on the same data.',
        sheets: criteria((n) => `=COUNTIFS($B$1:$B$100000,E${n},$C$1:$C$100000,F${n})`),
        reads: () => every(CRITERIA, 1, [6]),
        formulajs: (sheets) => {
            const { keys, bands, wantedKeys, wantedBands } = criteriaInputs(sheets);
            return () => sampled((i) => formulajs.COUNTIFS(keys, wantedKeys[i], bands, wantedBands[i]), CRITERIA, 1);
        },
    },
    {
        name: 'text functions on 100,000 rows',
        what: '100,000 formulas =UPPER(LEFT(A1,6))&"-"&LEN(TRIM(A1))&"-"&SUBSTITUTE(A1,"a","o") over short texts.',
        sheets: () =>
            grid(ROWS, (r) => [
                `item ${r}  alpha ${r % 3 === 0 ? 'Beta' : 'gamma'} `,
                `=UPPER(LEFT(A${r + 1},6))&"-"&LEN(TRIM(A${r + 1}))&"-"&SUBSTITUTE(A${r + 1},"a","o")`,
            ]),
        reads: () => every(ROWS, 97, [1]),
        formulajs: (sheets) => {
            const values = texts(sheets, 0);
            const joined = (text: string) =>
                [
                    formulajs.UPPER(formulajs.LEFT(text, 6)),
                    formulajs.LEN(formulajs.TRIM(text)),
                    formulajs.SUBSTITUTE(text, 'a', 'o'),
                ].join('-');
            return () => sampled((i) => joined(values[i]), ROWS, 97);
        },
    },
    {
        name: 'insert a row near the top',
        what: 'In the workbook of 300,000 formulas, one row is inserted above row 2, so every formula below it moves and its references change.',
        sheets: threeFormulas,
        edit: (engine) => engine.insertLines(0, 1, 1, true),
        reads: () => [[0, 0, 4], ...every(ROWS - 1, 97, [2, 3, 4], 2)],
    },
    {
        name: 'memory after loading 300,000 formulas',
        what: 'The memory the engine holds after the load and first compute of that workbook, in MB.',
        sheets: threeFormulas,
        reads: () => every(ROWS, 997, [4]),
        memory: true,
    },
];

// A value as the engines are compared on it: numbers at 10 significant digits, since HyperFormula rounds what it
// gives out to 10 unless told otherwise.
function key(value: Value): string {
    if (typeof value === 'number') return String(Number(value.toPrecision(10)));
    if (value !== null && typeof value === 'object') return value.text;
    return JSON.stringify(value);
}

function heap(): number {
    if (process.versions.bun !== undefined) Bun.gc(true);
    else globalThis.gc?.();
    const { heapUsed, external } = process.memoryUsage();
    // Bun counts typed arrays in heapUsed; Node counts them in external.
    return process.versions.bun !== undefined ? heapUsed : heapUsed + external;
}

function makeEngine(name: EngineName, workload: Workload): CellEngine {
    return name === 'ours' ? new OursEngine() : new HyperFormulaEngine(workload.hyperformula);
}

// The fastest of up to `reps` runs, each timed by `run`, which builds what it needs untimed.
function fastest(reps: number, run: () => number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let rep = 0, spent = 0; rep < reps && spent < ENOUGH_MS; rep += 1) {
        const began = performance.now();
        best = Math.min(best, run());
        spent += performance.now() - began;
    }
    return best;
}

export function measure(workload: Workload, name: EngineName, reps: number): Measured | null {
    if (name === 'formulajs') {
        if (workload.formulajs === undefined || workload.memory) return null;
        const calls = workload.formulajs(workload.sheets());
        let values: Value[] = [];
        const ms = fastest(reps, () => {
            const start = performance.now();
            values = calls();
            return performance.now() - start;
        });
        return { ms, values: values.map(key) };
    }
    let engine = makeEngine(name, workload);
    const read = () => workload.reads().map(([sheet, row, column]) => key(engine.read(sheet, row, column)));
    if (workload.memory) {
        const before = heap();
        engine.load(workload.sheets());
        engine.recalc();
        return { ms: (heap() - before) / 1e6, values: read() };
    }
    const { edit } = workload;
    const ms = fastest(reps, () => {
        engine = makeEngine(name, workload);
        const sheets = workload.sheets();
        if (edit !== undefined) {
            engine.load(sheets);
            engine.recalc();
        }
        const start = performance.now();
        if (edit === undefined) engine.load(sheets);
        else edit(engine);
        engine.recalc();
        return performance.now() - start;
    });
    return { ms, values: read() };
}

// A child process: one workload on one engine, its fastest run and its values as one line of JSON. It checks its
// arguments itself, so that a Node bundle of this file runs it too.
const { values: child } = parseArgs({
    options: { workload: { type: 'string' }, engine: { type: 'string' }, reps: { type: 'string', default: '3' } },
    strict: false,
});
if (typeof child.workload === 'string') {
    const workload = WORKLOADS.find((candidate) => candidate.name === child.workload);
    const engine = ENGINES.find((name) => name === child.engine);
    if (workload === undefined || engine === undefined)
        throw new Error(`No workload ${child.workload} on ${child.engine}`);
    console.log(JSON.stringify(measure(workload, engine, Number(child.reps))));
}
